// PULSE Audio Engine — собственный звуковой движок «Пульса» (Tauri-версия).
//
// Зачем: в WebKit звук <audio> идёт в эквалайзер (Web Audio) через внутренний буфер, и после перемотки ещё звучит
// уже подготовленный старый фрагмент. Здесь звук от файла до колонок — наш: при перемотке буфер сбрасывается
// сразу, и старые данные больше не играют.
//
// Устройство:
//  • голос (Voice) — один «плеер»: свой поток декодирования (Symphonia), пересчёт частоты под устройство (Rubato),
//    небольшой буфер готового звука (~0,35 с). Голосов несколько — так работает плавный переход между треками;
//  • вывод (CPAL) — один поток на устройство; в нём голоса смешиваются, затем общая обработка: предусиление,
//    10-полосный эквалайзер, лимитер — как была цепочка Web Audio в «Пульсе»;
//  • источники — те же, что у <audio>: pulseya:// (Яндекс: кэш, прогрев, расшифровка — yastream.rs) и pulsefile://
//    (свои файлы — localfile.rs). Чего Symphonia не умеет (например, Opus), окно играет по-старому через <audio>;
//  • окно управляет голосами командами engine_* и получает события «pulse-engine» (загрузился, играет, ждёт данные,
//    закончился, ошибка, позиция).

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use serde::Serialize;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymErr;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::{Time, TimeBase};
use tauri::Emitter;

/// Сколько готового звука держит голос (секунд). Меньше — быстрее реакция, больше — запас при нагрузке.
const AHEAD: f64 = 0.35;
/// Плавность громкости: смена громкости, пауза, старт и перемотка — без щелчков (секунд).
const RAMP: f32 = 0.006;
const TAP: usize = 4096;

fn f32_get(a: &AtomicU32) -> f32 { f32::from_bits(a.load(Ordering::Relaxed)) }
fn f32_set(a: &AtomicU32, v: f32) { a.store(v.to_bits(), Ordering::Relaxed) }
fn f64_get(a: &AtomicU64) -> f64 { f64::from_bits(a.load(Ordering::Relaxed)) }
fn f64_set(a: &AtomicU64, v: f64) { a.store(v.to_bits(), Ordering::Relaxed) }

enum Cmd { Open(String, f64), Seek(f64), Stop }

pub struct Voice {
    pub id: u32,
    /// готовый звук: стерео, частота устройства, чередование L R L R
    buf: Mutex<VecDeque<f32>>,
    playing: AtomicBool,
    /// идёт перемотка: вывод не берёт звук из буфера, пока декодер не встанет на новое место
    seeking: AtomicBool,
    vol: AtomicU32,
    rate: AtomicU32,
    /// с какого места трека (секунды) начинается звук в буфере после последней перемотки
    base: AtomicU64,
    /// сколько кадров вывод взял из буфера после последней перемотки
    consumed: AtomicU64,
    dur: AtomicU64,
    gen: AtomicU64,
    eof: AtomicBool,
    ended: AtomicBool,
    starved: AtomicBool,
    loaded: AtomicBool,
    /// текущая громкость вывода (меняет только поток вывода) и какую перемотку он уже видел
    cur_gain: AtomicU32,
    cb_gen: AtomicU64,
    error: Mutex<Option<(String, String)>>,
    tx: Mutex<Sender<Cmd>>,
    // для событий
    ev_loaded: AtomicBool,
    ev_ended: AtomicBool,
    ev_starved: AtomicBool,
    ev_err: AtomicBool,
    ev_t: AtomicU64,
}

impl Voice {
    pub fn position(&self, out_rate: u32) -> f64 {
        let r = f32_get(&self.rate).max(0.25) as f64;
        f64_get(&self.base) + self.consumed.load(Ordering::Relaxed) as f64 / out_rate.max(1) as f64 * r
    }
    fn flush(&self) {
        if let Ok(mut b) = self.buf.lock() { b.clear(); }
        self.consumed.store(0, Ordering::Relaxed);
        self.gen.fetch_add(1, Ordering::Relaxed);
        self.eof.store(false, Ordering::Relaxed);
        self.ended.store(false, Ordering::Relaxed);
        self.ev_ended.store(false, Ordering::Relaxed);
        self.starved.store(false, Ordering::Relaxed);
    }
}

#[derive(Clone, Copy, Default)]
struct EqParams { on: bool, g: [f32; 10], pre: f32, lim: bool, ver: u64 }

pub struct Shared {
    voices: Mutex<Vec<Arc<Voice>>>,
    voices_ver: AtomicU64,
    out_rate: AtomicU32,
    eq: Mutex<EqParams>,
    tap: Mutex<(Vec<f32>, usize)>,
    device: Mutex<String>,
    device_now: Mutex<String>,
    next_id: AtomicU32,
    out_tx: Mutex<Option<Sender<String>>>,
}

pub struct Engine { pub sh: Arc<Shared>, app: Option<tauri::AppHandle> }

static ENGINE: OnceLock<Engine> = OnceLock::new();

pub fn get() -> Option<&'static Engine> { ENGINE.get() }

/// Запустить движок (один раз): вывод на устройство и поток событий для окна.
pub fn start(app: Option<tauri::AppHandle>) -> &'static Engine {
    ENGINE.get_or_init(|| {
        let sh = Arc::new(Shared {
            voices: Mutex::new(Vec::new()),
            voices_ver: AtomicU64::new(1),
            out_rate: AtomicU32::new(48000),
            eq: Mutex::new(EqParams { pre: 1.0, ver: 1, ..Default::default() }),
            tap: Mutex::new((vec![0.0; TAP], 0)),
            device: Mutex::new(String::new()),
            device_now: Mutex::new(String::new()),
            next_id: AtomicU32::new(1),
            out_tx: Mutex::new(None),
        });
        let (tx, rx) = channel::<String>();
        if let Ok(mut t) = sh.out_tx.lock() { *t = Some(tx); }
        let s2 = sh.clone();
        std::thread::Builder::new().name("pulse-out".into()).spawn(move || output_thread(s2, rx)).ok();
        if let Some(a) = app.clone() {
            let s3 = sh.clone();
            std::thread::Builder::new().name("pulse-events".into()).spawn(move || event_thread(s3, a)).ok();
        }
        Engine { sh, app }
    })
}

impl Engine {
    pub fn create(&self) -> u32 {
        let id = self.sh.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = channel::<Cmd>();
        let v = Arc::new(Voice {
            id,
            buf: Mutex::new(VecDeque::new()),
            playing: AtomicBool::new(false),
            seeking: AtomicBool::new(false),
            vol: AtomicU32::new(1f32.to_bits()),
            rate: AtomicU32::new(1f32.to_bits()),
            base: AtomicU64::new(0f64.to_bits()),
            consumed: AtomicU64::new(0),
            dur: AtomicU64::new(f64::NAN.to_bits()),
            gen: AtomicU64::new(0),
            eof: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            starved: AtomicBool::new(false),
            loaded: AtomicBool::new(false),
            cur_gain: AtomicU32::new(0f32.to_bits()),
            cb_gen: AtomicU64::new(0),
            error: Mutex::new(None),
            tx: Mutex::new(tx),
            ev_loaded: AtomicBool::new(false),
            ev_ended: AtomicBool::new(false),
            ev_starved: AtomicBool::new(false),
            ev_err: AtomicBool::new(false),
            ev_t: AtomicU64::new(0),
        });
        let (v2, sh2) = (v.clone(), self.sh.clone());
        std::thread::Builder::new().name(format!("pulse-dec-{id}")).spawn(move || decoder_thread(v2, sh2, rx)).ok();
        if let Ok(mut l) = self.sh.voices.lock() { l.push(v); }
        self.sh.voices_ver.fetch_add(1, Ordering::Relaxed);
        id
    }
    fn voice(&self, id: u32) -> Option<Arc<Voice>> { self.sh.voices.lock().ok()?.iter().find(|v| v.id == id).cloned() }
    fn send(&self, id: u32, c: Cmd) { if let Some(v) = self.voice(id) { if let Ok(t) = v.tx.lock() { let _ = t.send(c); } } }

    pub fn drop_voice(&self, id: u32) {
        self.send(id, Cmd::Stop);
        if let Ok(mut l) = self.sh.voices.lock() { l.retain(|v| v.id != id); }
        self.sh.voices_ver.fetch_add(1, Ordering::Relaxed);
    }
    pub fn open(&self, id: u32, url: String, start: f64) {
        if let Some(v) = self.voice(id) {
            v.playing.store(false, Ordering::Relaxed);
            v.loaded.store(false, Ordering::Relaxed);
            v.ev_loaded.store(false, Ordering::Relaxed);
            v.ev_err.store(false, Ordering::Relaxed);
            if let Ok(mut e) = v.error.lock() { *e = None; }
            f64_set(&v.dur, f64::NAN);
            f64_set(&v.base, start.max(0.0));
            v.flush();
        }
        self.send(id, Cmd::Open(url, start));
    }
    pub fn play(&self, id: u32) {
        if let Some(v) = self.voice(id) {
            if v.ended.load(Ordering::Relaxed) { return; }
            v.playing.store(true, Ordering::Relaxed);
        }
    }
    pub fn pause(&self, id: u32) { if let Some(v) = self.voice(id) { v.playing.store(false, Ordering::Relaxed); } }
    /// Перемотка: старый звук выбрасывается сразу (вывод больше его не возьмёт), декодер встаёт на новое место.
    pub fn seek(&self, id: u32, t: f64) {
        if let Some(v) = self.voice(id) {
            v.seeking.store(true, Ordering::Relaxed);
            f64_set(&v.base, t.max(0.0));
            v.flush();
            if let Ok(tx) = v.tx.lock() { let _ = tx.send(Cmd::Seek(t.max(0.0))); }
        }
    }
    pub fn volume(&self, id: u32, x: f32) { if let Some(v) = self.voice(id) { f32_set(&v.vol, x.clamp(0.0, 1.0)); } }
    pub fn rate(&self, id: u32, r: f32) {
        if let Some(v) = self.voice(id) {
            // позиция считается от base: фиксируем её на момент смены скорости
            let rate = self.sh.out_rate.load(Ordering::Relaxed);
            let pos = v.position(rate);
            f64_set(&v.base, pos); v.consumed.store(0, Ordering::Relaxed);
            f32_set(&v.rate, r.clamp(0.5, 2.0));
        }
    }
    pub fn state(&self, id: u32) -> Option<VoiceState> {
        let v = self.voice(id)?;
        let rate = self.sh.out_rate.load(Ordering::Relaxed);
        Some(VoiceState {
            t: v.position(rate),
            d: f64_get(&v.dur),
            playing: v.playing.load(Ordering::Relaxed),
            loaded: v.loaded.load(Ordering::Relaxed),
            ended: v.ended.load(Ordering::Relaxed),
            waiting: v.starved.load(Ordering::Relaxed) || v.seeking.load(Ordering::Relaxed),
            error: v.error.lock().ok().and_then(|e| e.clone()).map(|(k, m)| format!("{k}: {m}")),
        })
    }
    pub fn set_eq(&self, on: bool, g: Vec<f32>, pre: f32, lim: bool) {
        if let Ok(mut e) = self.sh.eq.lock() {
            let mut gg = [0f32; 10];
            for (i, x) in g.iter().take(10).enumerate() { gg[i] = x.clamp(-12.0, 12.0); }
            *e = EqParams { on, g: gg, pre: pre.clamp(0.05, 4.0), lim, ver: e.ver + 1 };
        }
    }
    /// Последние ~2048 сэмплов общей шины (моно) — для живого фона и визуализаторов.
    pub fn tap(&self, n: usize) -> Vec<f32> {
        let Ok(t) = self.sh.tap.lock() else { return vec![] };
        let n = n.min(TAP);
        let (b, w) = (&t.0, t.1);
        (0..n).map(|i| b[(w + TAP - n + i) % TAP]).collect()
    }
    pub fn out_rate(&self) -> u32 { self.sh.out_rate.load(Ordering::Relaxed) }
    pub fn set_device(&self, name: String) {
        if let Ok(mut d) = self.sh.device.lock() { *d = name.clone(); }
        if let Ok(t) = self.sh.out_tx.lock() { if let Some(t) = t.as_ref() { let _ = t.send(name); } }
    }
    pub fn device_now(&self) -> String { self.sh.device_now.lock().map(|d| d.clone()).unwrap_or_default() }
    #[allow(dead_code)]
    pub fn has_app(&self) -> bool { self.app.is_some() }
}

#[derive(Serialize, Clone)]
pub struct VoiceState { pub t: f64, pub d: f64, pub playing: bool, pub loaded: bool, pub ended: bool, pub waiting: bool, pub error: Option<String> }

pub fn devices() -> Vec<String> {
    let host = cpal::default_host();
    host.output_devices().map(|it| it.filter_map(|d| d.name().ok()).collect()).unwrap_or_default()
}

// ——————————————————————————— источники звука ———————————————————————————

/// Яндекс: байты трека из yastream (кэш блоков, прогрев, расшифровка). Обрыв связи — 3 повтора.
struct YaSource { id: String, pos: u64, len: u64 }
impl YaSource {
    fn open(id: &str) -> Result<Self, String> {
        let (total, _) = tauri::async_runtime::block_on(crate::yastream::read_range(id, 0, 0))?;
        Ok(YaSource { id: id.to_string(), pos: 0, len: total })
    }
}
impl Read for YaSource {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.len || out.is_empty() { return Ok(0); }
        let n = (out.len() as u64).min(self.len - self.pos).min(256 * 1024);
        let mut last = String::new();
        for k in 0..4 {
            match tauri::async_runtime::block_on(crate::yastream::read_range(&self.id, self.pos, self.pos + n - 1)) {
                Ok((_, d)) if !d.is_empty() => { let m = d.len().min(out.len()); out[..m].copy_from_slice(&d[..m]); self.pos += m as u64; return Ok(m); }
                Ok(_) => return Ok(0),
                Err(e) => { last = e; std::thread::sleep(Duration::from_millis(300 * (k + 1))); }
            }
        }
        Err(std::io::Error::new(std::io::ErrorKind::Other, format!("сеть: {last}")))
    }
}
impl Seek for YaSource {
    fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> {
        let np = match p { SeekFrom::Start(x) => x as i64, SeekFrom::End(x) => self.len as i64 + x, SeekFrom::Current(x) => self.pos as i64 + x };
        if np < 0 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "до начала файла")); }
        self.pos = np as u64; Ok(self.pos)
    }
}
impl MediaSource for YaSource { fn is_seekable(&self) -> bool { true } fn byte_len(&self) -> Option<u64> { Some(self.len) } }

/// Свой файл (или кусок образа) из localfile.rs.
struct LocalSource { o: crate::localfile::Opened, pos: u64 }
impl Read for LocalSource {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.o.len || out.is_empty() { return Ok(0); }
        let n = (out.len() as u64).min(self.o.len - self.pos);
        let d = self.o.read(self.pos, n)?;
        out[..d.len()].copy_from_slice(&d); self.pos += d.len() as u64; Ok(d.len())
    }
}
impl Seek for LocalSource {
    fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> {
        let np = match p { SeekFrom::Start(x) => x as i64, SeekFrom::End(x) => self.o.len as i64 + x, SeekFrom::Current(x) => self.pos as i64 + x };
        if np < 0 { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "до начала файла")); }
        self.pos = np as u64; Ok(self.pos)
    }
}
impl MediaSource for LocalSource { fn is_seekable(&self) -> bool { true } fn byte_len(&self) -> Option<u64> { Some(self.o.len) } }

/// Адрес окна → источник и подсказка формата. Err(("unsupported", …)) — окно сыграет сам (<audio>).
fn open_source(url: &str) -> Result<(Box<dyn MediaSource>, Hint), (String, String)> {
    let u = url.split('#').next().unwrap_or(url);
    let tail = |pfx: &[&str]| pfx.iter().find_map(|p| u.strip_prefix(p)).map(|s| s.split(['/', '?']).next().unwrap_or("").to_string());
    let bad = |m: &str| ("unsupported".to_string(), m.to_string());
    if let Some(id) = tail(&["pulseya://s/", "http://pulseya.localhost/s/"]) {
        let mut h = Hint::new();
        match crate::yastream::mime_of_id(&id).unwrap_or("audio/mpeg") { "audio/mp4" => { h.with_extension("mp4"); } "audio/flac" => { h.with_extension("flac"); } _ => { h.with_extension("mp3"); } }
        let s = YaSource::open(&id).map_err(|e| ("network".to_string(), e))?;
        return Ok((Box::new(s), h));
    }
    if let Some(id) = tail(&["pulsefile://a/", "http://pulsefile.localhost/a/"]) {
        let src = crate::localfile::get(&id).ok_or_else(|| ("missing".to_string(), "файл больше не в списке".to_string()))?;
        let ext = match &src { crate::localfile::Src::File(p) => p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default(), crate::localfile::Src::Slice { wav: true, .. } => "wav".into(), crate::localfile::Src::Slice { ext, .. } => ext.to_lowercase() };
        if matches!(ext.as_str(), "opus" | "webm" | "weba" | "wv" | "ape") { return Err(bad("формат играет окно")); }
        let o = crate::localfile::Opened::open(&src).map_err(|e| ("missing".to_string(), e.to_string()))?;
        let mut h = Hint::new(); h.with_extension(&ext);
        return Ok((Box::new(LocalSource { o, pos: 0 }), h));
    }
    Err(bad("адрес не для движка"))
}

// ——————————————————————————— декодер ———————————————————————————

struct Track {
    format: Box<dyn FormatReader>,
    dec: Box<dyn Decoder>,
    track_id: u32,
    sr: u32,
    tb: Option<TimeBase>,
    /// после перемотки: пропустить звук до этого места (точная перемотка)
    skip_until: Option<f64>,
    rs: Option<(SincFixedIn<f32>, u32, u32, f32)>, // ресемплер, вход, выход, скорость
    pend: [Vec<f32>; 2],                            // вход ресемплера, ещё не набравший кусок
}

fn open_track(url: &str) -> Result<(Track, f64), (String, String)> {
    let (src, hint) = open_source(url)?;
    let mss = MediaSourceStream::new(src, Default::default());
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
        .map_err(|e| ("unsupported".to_string(), format!("формат: {e}")))?;
    let format = probed.format;
    let (track_id, p) = {
        let tr = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL).ok_or(("unsupported".to_string(), "нет звуковой дорожки".to_string()))?;
        (tr.id, tr.codec_params.clone())
    };
    let dec = symphonia::default::get_codecs().make(&p, &DecoderOptions::default()).map_err(|e| ("unsupported".to_string(), format!("кодек: {e}")))?;
    let sr = p.sample_rate.unwrap_or(44100);
    let dur = match (p.n_frames, p.time_base) {
        (Some(n), Some(tb)) => { let t = tb.calc_time(n); t.seconds as f64 + t.frac }
        (Some(n), None) => n as f64 / sr as f64,
        _ => f64::NAN,
    };
    Ok((Track { format, dec, track_id, sr, tb: p.time_base, skip_until: None, rs: None, pend: [Vec::new(), Vec::new()] }, dur))
}

fn sinc() -> SincInterpolationParameters {
    SincInterpolationParameters { sinc_len: 128, f_cutoff: 0.95, interpolation: SincInterpolationType::Cubic, oversampling_factor: 128, window: WindowFunction::BlackmanHarris2 }
}
const RS_CHUNK: usize = 1024;

impl Track {
    /// Стерео-кадры → частота устройства и скорость → в буфер голоса.
    fn emit(&mut self, v: &Voice, l: &[f32], r: &[f32], out_rate: u32, last: bool) {
        let rate = f32_get(&v.rate);
        if self.sr == out_rate && (rate - 1.0).abs() < 1e-4 && self.rs.is_none() {
            push(v, l, r);
            return;
        }
        // нужен ресемплер (или сменились частота устройства / скорость)
        let need_new = match &self.rs { Some((_, i, o, _)) => *i != self.sr || *o != out_rate, None => true };
        if need_new {
            let ratio = out_rate as f64 / self.sr as f64;
            match SincFixedIn::<f32>::new(ratio, 2.5, sinc(), RS_CHUNK, 2) { Ok(r) => self.rs = Some((r, self.sr, out_rate, 1.0)), Err(_) => { push(v, l, r); return; } }
        }
        if let Some((rs, _, _, cur)) = self.rs.as_mut() {
            if (*cur - rate).abs() > 1e-4 { let _ = rs.set_resample_ratio_relative(1.0 / rate.max(0.25) as f64, true); *cur = rate; }
        }
        self.pend[0].extend_from_slice(l);
        self.pend[1].extend_from_slice(r);
        let Some((rs, _, _, _)) = self.rs.as_mut() else { return };
        loop {
            let need = rs.input_frames_next();
            if self.pend[0].len() < need { break; }
            let a: Vec<f32> = self.pend[0].drain(..need).collect();
            let b: Vec<f32> = self.pend[1].drain(..need).collect();
            if let Ok(o) = rs.process(&[a, b], None) { push(v, &o[0], &o[1]); }
        }
        if last && !self.pend[0].is_empty() {
            let a = std::mem::take(&mut self.pend[0]);
            let b = std::mem::take(&mut self.pend[1]);
            if let Ok(o) = rs.process_partial(Some(&[a, b]), None) { push(v, &o[0], &o[1]); }
        }
    }
    fn reset_rs(&mut self) {
        if let Some((rs, _, _, _)) = self.rs.as_mut() { rs.reset(); }
        self.pend[0].clear(); self.pend[1].clear();
    }
}

// счётчики для проверок и журнала: пакеты, ошибки декодирования, чужие дорожки, выданные кадры
pub static DBG: [AtomicU64; 4] = [AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0), AtomicU64::new(0)];
fn dbg(i: usize, n: u64) { DBG[i].fetch_add(n, Ordering::Relaxed); }

fn push(v: &Voice, l: &[f32], r: &[f32]) {
    dbg(3, l.len() as u64);
    if l.is_empty() { return; }
    if let Ok(mut b) = v.buf.lock() {
        b.reserve(l.len() * 2);
        for i in 0..l.len() { b.push_back(l[i]); b.push_back(r[i]); }
    }
}

fn set_err(v: &Voice, k: &str, m: String) {
    eprintln!("[engine] голос {}: {k}: {m}", v.id);
    if let Ok(mut e) = v.error.lock() { *e = Some((k.to_string(), m)); }
    v.playing.store(false, Ordering::Relaxed);
}

fn decoder_thread(v: Arc<Voice>, sh: Arc<Shared>, rx: Receiver<Cmd>) {
    let mut cur: Option<Track> = None;
    loop {
        let out_rate = sh.out_rate.load(Ordering::Relaxed);
        let ahead = (out_rate as f64 * AHEAD) as usize * 2;
        let buffered = v.buf.lock().map(|b| b.len()).unwrap_or(0);
        let busy = cur.is_some() && !v.eof.load(Ordering::Relaxed) && buffered < ahead && !v.error.lock().map(|e| e.is_some()).unwrap_or(false);
        // команды: все, что накопились (несколько перемоток подряд — важна последняя)
        let first = if busy { rx.try_recv().map_err(|e| match e { std::sync::mpsc::TryRecvError::Empty => RecvTimeoutError::Timeout, _ => RecvTimeoutError::Disconnected }) } else { rx.recv_timeout(Duration::from_millis(15)) };
        let mut cmds = Vec::new();
        match first { Ok(c) => cmds.push(c), Err(RecvTimeoutError::Disconnected) => return, Err(RecvTimeoutError::Timeout) => {} }
        while let Ok(c) = rx.try_recv() { cmds.push(c); }
        let mut open: Option<(String, f64)> = None;
        let mut seek: Option<f64> = None;
        for c in cmds {
            match c {
                Cmd::Stop => { return; }
                Cmd::Open(u, t) => { open = Some((u, t)); seek = None; }
                Cmd::Seek(t) => { seek = Some(t); }
            }
        }
        if let Some((u, start)) = open {
            cur = None;
            match open_track(&u) {
                Ok((t, dur)) => {
                    f64_set(&v.dur, dur);
                    cur = Some(t);
                    if start > 0.05 { seek = Some(start); } else { f64_set(&v.base, 0.0); }
                    v.loaded.store(true, Ordering::Relaxed);
                }
                Err((k, m)) => { set_err(&v, &k, m); continue; }
            }
        }
        if let (Some(t), Some(tr)) = (seek, cur.as_mut()) {
            let to = SeekTo::Time { time: Time::from(t.max(0.0)), track_id: Some(tr.track_id) };
            match tr.format.seek(SeekMode::Accurate, to) {
                Ok(_) => { tr.dec.reset(); tr.reset_rs(); tr.skip_until = Some(t); }
                Err(e) => {
                    // перемотка за конец или ошибка формата — встаём в начало, если просили 0, иначе считаем концом
                    if t < 0.5 { let _ = tr.format.seek(SeekMode::Coarse, SeekTo::Time { time: Time::from(0.0), track_id: Some(tr.track_id) }); tr.dec.reset(); tr.reset_rs(); }
                    else { eprintln!("[engine] перемотка: {e}"); v.eof.store(true, Ordering::Relaxed); }
                }
            }
            // всё, что декодер успел положить до перемотки, — выбрасываем; вывод снова берёт звук с нового места
            if let Ok(mut b) = v.buf.lock() { b.clear(); }
            f64_set(&v.base, t.max(0.0));
            v.consumed.store(0, Ordering::Relaxed);
            v.gen.fetch_add(1, Ordering::Relaxed);
            v.seeking.store(false, Ordering::Relaxed);
        } else if seek.is_some() {
            v.seeking.store(false, Ordering::Relaxed);
        }
        if !busy && seek.is_none() { continue; }
        let Some(tr) = cur.as_mut() else { continue };
        // один пакет
        let pkt = match tr.format.next_packet() {
            Ok(p) => p,
            Err(SymErr::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => { tr.emit(&v, &[], &[], out_rate, true); v.eof.store(true, Ordering::Relaxed); continue; }
            Err(SymErr::ResetRequired) => { tr.dec.reset(); continue; }
            Err(SymErr::IoError(e)) => { set_err(&v, "network", e.to_string()); continue; }
            Err(e) => { set_err(&v, "decode", e.to_string()); continue; }
        };
        dbg(0, 1);
        if pkt.track_id() != tr.track_id { dbg(2, 1); continue; }
        let pkt_t = match tr.tb { Some(tb) => { let t = tb.calc_time(pkt.ts()); t.seconds as f64 + t.frac } None => pkt.ts() as f64 / tr.sr as f64 };
        let decoded = match tr.dec.decode(&pkt) {
            Ok(b) => b,
            Err(SymErr::DecodeError(e)) => { dbg(1, 1); if DBG[1].load(Ordering::Relaxed) < 5 { eprintln!("[engine] декодер: {e}"); } continue; }
            Err(e) => { set_err(&v, "decode", e.to_string()); continue; }
        };
        let spec = *decoded.spec();
        let ch = spec.channels.count().max(1);
        if spec.rate != 0 && spec.rate != tr.sr { tr.sr = spec.rate; }
        let mut sb = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        sb.copy_interleaved_ref(decoded);
        let s = sb.samples();
        let frames = s.len() / ch;
        let mut from = 0usize;
        if let Some(until) = tr.skip_until {
            let skip = ((until - pkt_t) * tr.sr as f64).round();
            if skip >= frames as f64 { continue; }
            if skip > 0.0 { from = skip as usize; }
            tr.skip_until = None;
        }
        let n = frames - from;
        let mut l = Vec::with_capacity(n);
        let mut r = Vec::with_capacity(n);
        for i in from..frames {
            let a = s[i * ch];
            let b = if ch > 1 { s[i * ch + 1] } else { a };
            l.push(a); r.push(b);
        }
        tr.emit(&v, &l, &r, out_rate, false);
    }
}

// ——————————————————————————— вывод: смешение, эквалайзер, лимитер ———————————————————————————

#[derive(Clone, Copy, Default)]
struct Bq { b0: f32, b1: f32, b2: f32, a1: f32, a2: f32 }
#[derive(Clone, Copy, Default)]
struct BqS { z1: f32, z2: f32 }
impl Bq {
    // RBJ Audio EQ Cookbook — те же фильтры, что BiquadFilterNode в Web Audio (полки — наклон S = 1)
    fn make(kind: u8, f: f32, q: f32, gain_db: f32, sr: f32) -> Bq {
        let a = 10f32.powf(gain_db / 40.0);
        let w = 2.0 * std::f32::consts::PI * (f / sr).min(0.49);
        let (sn, cs) = (w.sin(), w.cos());
        let (b0, b1, b2, a0, a1, a2);
        match kind {
            0 => { // нижняя полка
                let al = sn / 2.0 * 2f32.sqrt(); let s = 2.0 * a.sqrt() * al;
                b0 = a * ((a + 1.0) - (a - 1.0) * cs + s); b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cs); b2 = a * ((a + 1.0) - (a - 1.0) * cs - s);
                a0 = (a + 1.0) + (a - 1.0) * cs + s; a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cs); a2 = (a + 1.0) + (a - 1.0) * cs - s;
            }
            2 => { // верхняя полка
                let al = sn / 2.0 * 2f32.sqrt(); let s = 2.0 * a.sqrt() * al;
                b0 = a * ((a + 1.0) + (a - 1.0) * cs + s); b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cs); b2 = a * ((a + 1.0) + (a - 1.0) * cs - s);
                a0 = (a + 1.0) - (a - 1.0) * cs + s; a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cs); a2 = (a + 1.0) - (a - 1.0) * cs - s;
            }
            _ => { // колокол
                let al = sn / (2.0 * q);
                b0 = 1.0 + al * a; b1 = -2.0 * cs; b2 = 1.0 - al * a; a0 = 1.0 + al / a; a1 = -2.0 * cs; a2 = 1.0 - al / a;
            }
        }
        Bq { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
    }
    #[inline]
    fn run(&self, s: &mut BqS, x: f32) -> f32 {
        let y = self.b0 * x + s.z1;
        s.z1 = self.b1 * x - self.a1 * y + s.z2;
        s.z2 = self.b2 * x - self.a2 * y;
        y
    }
}
const EQ_F: [f32; 10] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];

struct Master {
    ver: u64, rate: u32, p: EqParams, bq: [Bq; 10], st: [[BqS; 10]; 2], pre: f32, pre_t: f32, lim_g: f32,
    snap: Vec<Arc<Voice>>, snap_ver: u64, mix: Vec<f32>,
}
impl Master {
    fn new() -> Self { Master { ver: 0, rate: 0, p: EqParams::default(), bq: [Bq::default(); 10], st: [[BqS::default(); 10]; 2], pre: 1.0, pre_t: 1.0, lim_g: 1.0, snap: Vec::new(), snap_ver: 0, mix: Vec::new() } }
    fn refresh(&mut self, sh: &Shared, rate: u32) {
        if let Ok(e) = sh.eq.try_lock() {
            if e.ver != self.ver || rate != self.rate {
                self.ver = e.ver; self.rate = rate; self.p = *e;
                for i in 0..10 { self.bq[i] = Bq::make(if i == 0 { 0 } else if i == 9 { 2 } else { 1 }, EQ_F[i], 1.1, if self.p.on { self.p.g[i] } else { 0.0 }, rate as f32); }
                self.pre_t = if self.p.on { self.p.pre } else { 1.0 };
            }
        }
        let v = sh.voices_ver.load(Ordering::Relaxed);
        if v != self.snap_ver { if let Ok(l) = sh.voices.try_lock() { self.snap = l.clone(); self.snap_ver = v; } }
    }
    /// Смешать голоса в стерео-кадры (self.mix), обработать общей шиной.
    fn render(&mut self, sh: &Shared, frames: usize, rate: u32) {
        self.refresh(sh, rate);
        self.mix.clear(); self.mix.resize(frames * 2, 0.0);
        let step = 1.0 / (RAMP * rate as f32);
        for v in &self.snap {
            let playing = v.playing.load(Ordering::Relaxed) && !v.seeking.load(Ordering::Relaxed);
            let target = if playing { f32_get(&v.vol) } else { 0.0 };
            let mut g = f32_get(&v.cur_gain);
            let gen = v.gen.load(Ordering::Relaxed);
            if gen != v.cb_gen.load(Ordering::Relaxed) { v.cb_gen.store(gen, Ordering::Relaxed); g = 0.0; } // после перемотки — мягкое начало
            if !playing && g <= 0.0 { f32_set(&v.cur_gain, 0.0); continue; }
            let Ok(mut b) = v.buf.try_lock() else { continue };
            let avail = b.len() / 2;
            let n = avail.min(frames);
            for (i, (l, r)) in b.drain(..n * 2).collect::<Vec<f32>>().chunks_exact(2).map(|c| (c[0], c[1])).enumerate() {
                if g < target { g = (g + step).min(target); } else if g > target { g = (g - step).max(target); }
                self.mix[i * 2] += l * g; self.mix[i * 2 + 1] += r * g;
            }
            drop(b);
            f32_set(&v.cur_gain, g);
            if playing || g > 0.0 { v.consumed.fetch_add(n as u64, Ordering::Relaxed); }
            if n < frames && playing {
                if v.eof.load(Ordering::Relaxed) { if avail == 0 || n == avail { v.ended.store(true, Ordering::Relaxed); v.playing.store(false, Ordering::Relaxed); } }
                else if v.loaded.load(Ordering::Relaxed) { v.starved.store(true, Ordering::Relaxed); }
            } else if n > 0 { v.starved.store(false, Ordering::Relaxed); }
        }
        // общая шина: предусиление → эквалайзер → лимитер
        let eq = self.p.on && self.p.g.iter().any(|x| x.abs() > 0.01);
        let lim = self.p.lim && eq;
        let (att, rel) = (1.0 - (-1.0 / (0.002 * rate as f32)).exp(), 1.0 - (-1.0 / (0.12 * rate as f32)).exp());
        let th = 0.891f32; // −1 дБ
        for i in 0..frames {
            self.pre += (self.pre_t - self.pre) * 0.002;
            let mut l = self.mix[i * 2] * self.pre;
            let mut r = self.mix[i * 2 + 1] * self.pre;
            if eq {
                for k in 0..10 { l = self.bq[k].run(&mut self.st[0][k], l); r = self.bq[k].run(&mut self.st[1][k], r); }
            }
            if lim {
                let env = l.abs().max(r.abs());
                let want = if env > th { th / env } else { 1.0 };
                self.lim_g += (want - self.lim_g) * if want < self.lim_g { att } else { rel };
                l *= self.lim_g; r *= self.lim_g;
            }
            self.mix[i * 2] = l.clamp(-1.0, 1.0);
            self.mix[i * 2 + 1] = r.clamp(-1.0, 1.0);
        }
        if let Ok(mut t) = sh.tap.try_lock() {
            let (ref mut b, ref mut w) = *t;
            for i in 0..frames { b[*w] = (self.mix[i * 2] + self.mix[i * 2 + 1]) * 0.5; *w = (*w + 1) % TAP; }
        }
    }
}

fn build_stream(sh: Arc<Shared>, name: &str) -> Result<(cpal::Stream, String), String> {
    let host = cpal::default_host();
    let dev = if name.is_empty() { host.default_output_device() } else { host.output_devices().ok().and_then(|mut it| it.find(|d| d.name().map(|n| n == name).unwrap_or(false))).or_else(|| host.default_output_device()) };
    let dev = dev.ok_or("нет устройства вывода")?;
    let dname = dev.name().unwrap_or_default();
    let cfg = dev.default_output_config().map_err(|e| e.to_string())?;
    let rate = cfg.sample_rate().0;
    let ch = cfg.channels() as usize;
    sh.out_rate.store(rate, Ordering::Relaxed);
    let scfg: cpal::StreamConfig = cfg.clone().into();
    let err = |e: cpal::StreamError| eprintln!("[engine] вывод: {e}");
    macro_rules! mk {
        ($t:ty, $conv:expr) => {{
            let sh2 = sh.clone();
            let mut m = Master::new();
            dev.build_output_stream(&scfg, move |data: &mut [$t], _| {
                let frames = data.len() / ch.max(1);
                m.render(&sh2, frames, rate);
                for i in 0..frames {
                    let (l, r) = (m.mix[i * 2], m.mix[i * 2 + 1]);
                    for c in 0..ch { data[i * ch + c] = $conv(if ch == 1 { (l + r) * 0.5 } else if c == 0 { l } else if c == 1 { r } else { 0.0 }); }
                }
            }, err, None)
        }};
    }
    let stream = match cfg.sample_format() {
        cpal::SampleFormat::F32 => mk!(f32, |x: f32| x),
        cpal::SampleFormat::I16 => mk!(i16, |x: f32| (x * 32767.0) as i16),
        cpal::SampleFormat::U16 => mk!(u16, |x: f32| ((x * 0.5 + 0.5) * 65535.0) as u16),
        cpal::SampleFormat::I32 => mk!(i32, |x: f32| (x as f64 * 2147483647.0) as i32),
        f => return Err(format!("формат вывода {f:?} не поддержан")),
    }.map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, dname))
}

fn output_thread(sh: Arc<Shared>, rx: Receiver<String>) {
    let mut want = String::new();
    let mut stream: Option<cpal::Stream> = None;
    let mut last_default = String::new();
    loop {
        if stream.is_none() {
            match build_stream(sh.clone(), &want) {
                Ok((s, n)) => { stream = Some(s); if let Ok(mut d) = sh.device_now.lock() { *d = n.clone(); } last_default = n; }
                Err(e) => { eprintln!("[engine] устройство: {e}"); }
            }
        }
        match rx.recv_timeout(Duration::from_millis(1500)) {
            Ok(n) => { want = n; stream = None; }
            Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {
                // «по умолчанию»: если в системе выбрали другое устройство (AirPods и т. п.) — переходим на него
                if want.is_empty() {
                    let d = cpal::default_host().default_output_device().and_then(|d| d.name().ok()).unwrap_or_default();
                    if !d.is_empty() && d != last_default { stream = None; }
                }
                if stream.is_none() { continue; }
            }
        }
    }
}

// ——————————————————————————— события для окна ———————————————————————————

#[derive(Serialize, Clone)]
struct Ev { v: u32, k: &'static str, t: f64, d: f64, e: Option<String> }

fn event_thread(sh: Arc<Shared>, app: tauri::AppHandle) {
    let t0 = Instant::now();
    loop {
        std::thread::sleep(Duration::from_millis(50));
        let rate = sh.out_rate.load(Ordering::Relaxed);
        let list = sh.voices.lock().map(|l| l.clone()).unwrap_or_default();
        let now = t0.elapsed().as_millis() as u64;
        for v in list {
            let t = v.position(rate);
            let d = f64_get(&v.dur);
            let mut send = |k: &'static str, e: Option<String>| { let _ = app.emit("pulse-engine", Ev { v: v.id, k, t, d, e }); };
            if v.loaded.load(Ordering::Relaxed) && !v.ev_loaded.swap(true, Ordering::Relaxed) { send("loaded", None); }
            if let Some((k, m)) = v.error.lock().ok().and_then(|e| e.clone()) { if !v.ev_err.swap(true, Ordering::Relaxed) { send("error", Some(format!("{k}|{m}"))); } }
            if v.ended.load(Ordering::Relaxed) && !v.ev_ended.swap(true, Ordering::Relaxed) { send("ended", None); }
            let st = v.starved.load(Ordering::Relaxed);
            if st != v.ev_starved.swap(st, Ordering::Relaxed) { send(if st { "waiting" } else { "playing" }, None); }
            if v.playing.load(Ordering::Relaxed) && now.saturating_sub(v.ev_t.load(Ordering::Relaxed)) >= 250 { v.ev_t.store(now, Ordering::Relaxed); send("time", None); }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lab(n: &str) -> std::path::PathBuf { format!("{}/../lab-media/{}", env!("CARGO_MANIFEST_DIR"), n).into() }

    // декодер без устройства вывода: открываем, перематываем, проверяем, что после перемотки звучит НОВОЕ место
    #[test]
    fn seek_is_exact_and_flushes() {
        crate::localfile::register("eng-tone", crate::localfile::Src::File(lab("seek-tone.m4a")));
        let (tx, rx) = channel::<Cmd>();
        let sh = Arc::new(Shared { voices: Mutex::new(vec![]), voices_ver: AtomicU64::new(1), out_rate: AtomicU32::new(48000), eq: Mutex::new(EqParams { pre: 1.0, ver: 1, ..Default::default() }), tap: Mutex::new((vec![0.0; TAP], 0)), device: Mutex::new(String::new()), device_now: Mutex::new(String::new()), next_id: AtomicU32::new(1), out_tx: Mutex::new(None) });
        let v = Arc::new(Voice { id: 99, buf: Mutex::new(VecDeque::new()), playing: AtomicBool::new(false), seeking: AtomicBool::new(false), vol: AtomicU32::new(1f32.to_bits()), rate: AtomicU32::new(1f32.to_bits()), base: AtomicU64::new(0), consumed: AtomicU64::new(0), dur: AtomicU64::new(f64::NAN.to_bits()), gen: AtomicU64::new(0), eof: AtomicBool::new(false), ended: AtomicBool::new(false), starved: AtomicBool::new(false), loaded: AtomicBool::new(false), cur_gain: AtomicU32::new(0), cb_gen: AtomicU64::new(0), error: Mutex::new(None), tx: Mutex::new(tx.clone()), ev_loaded: AtomicBool::new(false), ev_ended: AtomicBool::new(false), ev_starved: AtomicBool::new(false), ev_err: AtomicBool::new(false), ev_t: AtomicU64::new(0) });
        let (v2, sh2) = (v.clone(), sh.clone());
        std::thread::spawn(move || decoder_thread(v2, sh2, rx));
        tx.send(Cmd::Open("pulsefile://a/eng-tone".into(), 0.0)).unwrap();
        let wait_fill = |v: &Voice| { let t0 = Instant::now(); while v.buf.lock().unwrap().len() < 30000 && t0.elapsed() < Duration::from_secs(5) { std::thread::sleep(Duration::from_millis(5)); } };
        wait_fill(&v);
        assert!(v.loaded.load(Ordering::Relaxed), "не открылся: {:?}", v.error.lock().unwrap());
        assert!((f64_get(&v.dur) - 30.0).abs() < 0.2, "длительность {}", f64_get(&v.dur));
        // частота тона в буфере → секунда трека (300 + 60·с Гц), по пересечениям нуля
        let sec_now = |v: &Voice| -> f64 {
            let b = v.buf.lock().unwrap();
            let l: Vec<f32> = b.iter().step_by(2).take(9600).cloned().collect();
            let z = l.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count() as f64;
            let hz = z / (l.len() as f64 / 48000.0);
            (hz - 300.0) / 60.0
        };
        let dbgs = || format!("пакеты {}, ошибки {}, чужие {}, кадры {}, eof {}, буфер {}, ошибка {:?}", DBG[0].load(Ordering::Relaxed), DBG[1].load(Ordering::Relaxed), DBG[2].load(Ordering::Relaxed), DBG[3].load(Ordering::Relaxed), v.eof.load(Ordering::Relaxed), v.buf.lock().unwrap().len(), v.error.lock().unwrap());
        assert!(sec_now(&v).abs() < 0.6, "в начале звучит секунда {}; {}", sec_now(&v), dbgs());
        for target in [20.3, 5.3, 27.3, 12.3] {
            v.seeking.store(true, Ordering::Relaxed); v.flush();
            tx.send(Cmd::Seek(target)).unwrap();
            let t0 = Instant::now();
            while v.seeking.load(Ordering::Relaxed) && t0.elapsed() < Duration::from_secs(3) { std::thread::sleep(Duration::from_millis(1)); }
            wait_fill(&v);
            let s = sec_now(&v);
            assert!((s - target.floor()).abs() < 0.6, "перемотка на {target}: звучит секунда {s}");
            assert!((v.position(48000) - target).abs() < 0.01);
        }
        tx.send(Cmd::Stop).unwrap();
    }

    // каждый формат: открыть и раскодировать первые пакеты (без потоков)
    #[test]
    fn decode_formats() {
        let mut bad = Vec::new();
        for f in ["mp3-320.mp3", "aac-256.m4a", "flac-16-44.flac", "flac-24-96.flac", "flac-in-mp4.m4a", "alac-16-44.m4a", "wav-16-44.wav", "ogg-vorbis.ogg", "aiff-16-44.aif", "seek-tone.m4a"] {
            let id = format!("dec-{f}");
            crate::localfile::register(&id, crate::localfile::Src::File(lab(f)));
            let r = (|| -> Result<(usize, usize, String), String> {
                let (mut t, d) = open_track(&format!("pulsefile://a/{id}")).map_err(|(k, m)| format!("{k}: {m}"))?;
                let (mut frames, mut errs, mut first) = (0usize, 0usize, String::new());
                for _ in 0..60 {
                    let p = match t.format.next_packet() { Ok(p) => p, Err(e) => { if first.is_empty() { first = format!("next_packet: {e}"); } break; } };
                    if p.track_id() != t.track_id { continue; }
                    match t.dec.decode(&p) { Ok(b) => frames += b.frames(), Err(e) => { errs += 1; if first.is_empty() { first = format!("decode: {e}"); } } }
                }
                Ok((frames, errs, format!("{first}; длина {d:.2}")))
            })();
            match r { Ok((fr, _, _)) if fr > 1000 => {}, Ok((fr, er, m)) => bad.push(format!("{f}: кадров {fr}, ошибок {er}, {m}")), Err(e) => bad.push(format!("{f}: {e}")) }
        }
        assert!(bad.is_empty(), "не декодируются: {bad:#?}");
    }

    #[test]
    fn eq_flat_is_transparent() {
        let b = Bq::make(1, 1000.0, 1.1, 0.0, 48000.0);
        let mut s = BqS::default();
        for i in 0..1000 { let x = (i as f32 * 0.1).sin(); let y = b.run(&mut s, x); assert!((x - y).abs() < 1e-4); }
    }
}
