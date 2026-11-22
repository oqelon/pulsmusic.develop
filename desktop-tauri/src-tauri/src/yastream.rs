// Звук Яндекса через саму программу: адрес pulseya://s/<id> (перенос yastream.js из Electron-версии).
// • Без потерь (FLAC) Яндекс отдаёт зашифрованным (AES-CTR, ключ приходит вместе со ссылкой под токен пользователя) —
//   здесь он расшифровывается на лету, кусками, по мере того как плеер просит данные. На диск ничего не пишется.
// • Обычные ссылки тоже идут через эту схему: окно всегда может подключить к звуку эквалайзер (Web Audio).
// • Перемотка: плеер просит кусок с любого места, счётчик AES-CTR сдвигается на нужный блок.
// Отличие от Electron: ответ своей схемы в Tauri отдаётся целиком, поэтому открытый запрос («bytes=0-») режем на
// куски по 2 МБ — плеер сам попросит следующий. Это заменяет прежнее «не быстрее 3 МБ/с». Явный запрос («bytes=a-b»)
// отдаётся полностью. У сервера звук берётся блоками по 256 КБ через кэш (см. ниже).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use aes::{Aes128, Aes256};
use ctr::cipher::{KeyIvInit, StreamCipher, StreamCipherSeek};
use serde::Serialize;
use tauri::http::{header, Response, StatusCode};

use crate::resp::{self, Want};

const LIFE: Duration = Duration::from_secs(6 * 3600);
const MAX: usize = 300;
pub const CHUNK: u64 = 2 * 1024 * 1024;

struct Entry {
    urls: Vec<String>,
    key: Option<Vec<u8>>,
    mime: &'static str,
    chunk: u64,
    t: Instant,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub struct Fmt {
    pub codec: &'static str,
    pub sr: u32,
    pub bits: u32,
}

fn reg() -> &'static Mutex<HashMap<String, Entry>> {
    static R: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}
fn fmts() -> &'static Mutex<HashMap<String, Fmt>> {
    static F: OnceLock<Mutex<HashMap<String, Fmt>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(HashMap::new()))
}
fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    // соединение прямое, без системного прокси — как было в Electron-версии
    C.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("http-клиент")
    })
}

fn mime_of(codec: &str) -> &'static str {
    match codec.to_ascii_lowercase().as_str() {
        "flac" => "audio/flac",
        "flac-mp4" | "aac" | "he-aac" | "aac-mp4" | "he-aac-mp4" => "audio/mp4",
        _ => "audio/mpeg",
    }
}

/// Ссылка Яндекса: только https и только его домены.
pub fn yandex_host(u: &str) -> bool {
    let Ok(x) = reqwest::Url::parse(u) else { return false };
    if x.scheme() != "https" { return false; }
    let h = x.host_str().unwrap_or("").to_ascii_lowercase();
    ["yandex.net", "yandex.ru", "yandex.com", "yastatic.net"].iter().any(|d| h == *d || h.ends_with(&format!(".{d}")))
}

fn allowed(u: &str) -> bool {
    yandex_host(u) || crate::lab::local_source(u)
}

fn parse_key(k: Option<&str>) -> Option<Vec<u8>> {
    let k = k?.trim();
    if !(k.len() == 32 || k.len() == 64) || !k.bytes().all(|c| c.is_ascii_hexdigit()) { return None; }
    (0..k.len()).step_by(2).map(|i| u8::from_str_radix(&k[i..i + 2], 16).ok()).collect()
}

fn new_id() -> String {
    let mut b = [0u8; 12];
    if getrandom::getrandom(&mut b).is_err() {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) ^ ((std::process::id() as u128) << 64);
        b.copy_from_slice(&n.to_le_bytes()[..12]);
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Ссылки (и ключ, если звук зашифрован) → адрес для плеера.
/// Этап 4: вызывается из yandex.js (команда ya_add).
pub fn add(urls: Vec<String>, key: Option<String>, codec: Option<String>) -> Result<String, String> {
    add_as(new_id(), urls, key, codec, CHUNK)
}

pub fn add_as(id: String, urls: Vec<String>, key: Option<String>, codec: Option<String>, chunk: u64) -> Result<String, String> {
    let urls: Vec<String> = urls.into_iter().filter(|u| allowed(u)).collect();
    if urls.is_empty() { return Err("Нет ссылки на звук".into()); }
    let mut r = reg().lock().map_err(|_| "реестр недоступен")?;
    let now = Instant::now();
    r.retain(|_, v| now.duration_since(v.t) < LIFE);
    while r.len() >= MAX {
        let Some(old) = r.iter().min_by_key(|(_, v)| v.t).map(|(k, _)| k.clone()) else { break };
        r.remove(&old);
    }
    r.insert(id.clone(), Entry {
        urls,
        key: parse_key(key.as_deref()),
        mime: mime_of(codec.as_deref().unwrap_or("")),
        chunk: chunk.max(64 * 1024),
        t: now,
    });
    Ok(format!("pulseya://s/{id}"))
}

/// Что узнали о звуке по первым байтам (частота, разрядность).
pub fn fmt_of(url: &str) -> Option<Fmt> {
    let id = url.trim_start_matches("pulseya://s/").trim_start_matches("http://pulseya.localhost/s/");
    fmts().lock().ok()?.get(id).copied()
}

// формат звука по первым байтам: частота и разрядность (FLAC — из STREAMINFO, AAC — из описания в MP4,
// MP3 — из заголовка кадра). Яндекс сам их не сообщает, а показать «24 бит · 48 кГц» хочется честно
pub fn sniff(b: &[u8]) -> Option<Fmt> {
    if let Some(f) = sniff_box(b) { return Some(f); }
    // MP4, FLAC и OGG — не MP3, даже если в звуке случайно найдётся похожий заголовок кадра
    let other = (b.len() >= 8 && &b[4..8] == b"ftyp") || b.starts_with(b"fLaC") || b.starts_with(b"OggS");
    if other { None } else { sniff_mp3(b) }
}

/// FLAC и AAC — по описанию звука. Его можно искать в любом куске: в MP4 без «faststart» описание (moov) лежит
/// в конце файла, и плеер первым делом просит именно этот кусок.
pub fn sniff_box(b: &[u8]) -> Option<Fmt> {
    // ищем все вхождения: случайные байты «fLaC»/«mp4a» внутри звука отсеиваются проверкой структуры
    let all = |tag: &'static [u8]| b.windows(4).enumerate().filter(move |(_, w)| *w == tag).map(|(k, _)| k);
    // i — заголовок блока STREAMINFO: тип 0, длина 34
    let streaminfo = |i: usize| -> Option<Fmt> {
        if b.len() < i + 4 + 18 || (b[i] & 0x7f) != 0 || b[i + 1] != 0 || b[i + 2] != 0 || b[i + 3] != 34 { return None; }
        let o = i + 4 + 10;
        let sr = ((b[o] as u32) << 12) | ((b[o + 1] as u32) << 4) | ((b[o + 2] as u32) >> 4);
        let bits = ((((b[o + 2] & 1) as u32) << 4) | ((b[o + 3] as u32) >> 4)) + 1;
        if (8000..=768_000).contains(&sr) && (4..=32).contains(&bits) { Some(Fmt { codec: "FLAC", sr, bits }) } else { None }
    };
    // FLAC в MP4: после «dfLa» — версия (4 байта), дальше как в FLAC
    for d in all(b"dfLa") { if let Some(f) = streaminfo(d + 8) { return Some(f); } }
    for k in all(b"fLaC") { if let Some(f) = streaminfo(k + 4) { return Some(f); } }
    for m in all(b"mp4a") {
        if b.len() >= m + 32 && m >= 4 {
            let size = u32::from_be_bytes([b[m - 4], b[m - 3], b[m - 2], b[m - 1]]);
            let sr = u16::from_be_bytes([b[m + 28], b[m + 29]]) as u32;
            if (36..1 << 20).contains(&size) && (8000..=96_000).contains(&sr) { return Some(Fmt { codec: "AAC", sr, bits: 0 }); }
        }
    }
    None
}

/// MP3 — по заголовку кадра; только в начале файла (в середине такие байты встречаются случайно).
pub fn sniff_mp3(b: &[u8]) -> Option<Fmt> {
    const MP3_SR: [u32; 3] = [44100, 48000, 32000];
    let lim = b.len().min(8192);
    let mut k = 0;
    while k + 4 < lim {
        if b[k] == 0xff && (b[k + 1] & 0xe6) == 0xe2 {
            let v = (b[k + 1] >> 3) & 3;
            let sri = ((b[k + 2] >> 2) & 3) as usize;
            if sri < 3 && v != 1 { return Some(Fmt { codec: "MP3", sr: MP3_SR[sri] / if v == 3 { 1 } else if v == 2 { 2 } else { 4 }, bits: 0 }); }
        }
        k += 1;
    }
    None
}

/// Расшифровать кусок, начинающийся с байта `pos` файла (блок AES — 16 байт, счётчик — номер блока, nonce из нулей).
pub fn decrypt_at(key: &[u8], pos: u64, buf: &mut [u8]) -> Result<(), String> {
    let iv = [0u8; 16];
    match key.len() {
        16 => { let mut c = ctr::Ctr128BE::<Aes128>::new_from_slices(key, &iv).map_err(|_| "ключ не подошёл".to_string())?; c.seek(pos); c.apply_keystream(buf); }
        32 => { let mut c = ctr::Ctr128BE::<Aes256>::new_from_slices(key, &iv).map_err(|_| "ключ не подошёл".to_string())?; c.seek(pos); c.apply_keystream(buf); }
        n => return Err(format!("ключ {n} байт")),
    }
    Ok(())
}

// «bytes a-b/total» → (a, total как строка)
fn content_range(v: &str) -> Option<(u64, String)> {
    let r = v.trim().strip_prefix("bytes ")?;
    let (ab, total) = r.split_once('/')?;
    let (a, _) = ab.split_once('-')?;
    Some((a.trim().parse().ok()?, total.trim().to_string()))
}

/// Журнал запросов плеера (для диагностики в лаборатории): что просил, что отдали, сколько заняло.
#[derive(Clone, Serialize)]
pub struct LogRow { pub id: String, pub at_ms: u64, pub asked: String, pub status: u16, pub served: String, pub bytes: usize, pub ms: u64 }
fn log() -> &'static Mutex<std::collections::VecDeque<LogRow>> {
    static L: OnceLock<Mutex<std::collections::VecDeque<LogRow>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(std::collections::VecDeque::new()))
}
fn t0() -> Instant { static T: OnceLock<Instant> = OnceLock::new(); *T.get_or_init(Instant::now) }
pub fn log_of(id: &str) -> Vec<LogRow> { log().lock().map(|l| l.iter().filter(|r| r.id == id).cloned().collect()).unwrap_or_default() }

pub async fn serve(id: &str, range: Option<String>) -> Response<Vec<u8>> {
    let start = Instant::now();
    let r = serve_inner(id, range.clone()).await;
    if let Ok(mut l) = log().lock() {
        if l.len() >= 600 { l.pop_front(); }
        l.push_back(LogRow {
            id: id.to_string(),
            at_ms: start.duration_since(t0()).as_millis() as u64,
            asked: range.unwrap_or_else(|| "—".into()),
            status: r.status().as_u16(),
            served: r.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string(),
            bytes: r.body().len(),
            ms: start.elapsed().as_millis() as u64,
        });
    }
    r
}

// ——— кэш расшифрованного звука блоками по 256 КБ ———
// Плеер WebKit (AVFoundation) сначала разбирает MP4 десятками крошечных запросов по 4–8 байт (заголовки, описание
// звука в начале или в конце файла), а потом просит звук кусками по ~400 КБ с явными границами. Каждый крошечный
// запрос напрямую к Яндексу — это лишняя поездка по сети (у Яндекса 50–150 мс), старт трека растянулся бы на секунды.
// Поэтому у сервера берём сразу блок 256 КБ, расшифровываем и держим в памяти: мелкие запросы отдаются из него мгновенно.
// Явно запрошенный кусок отдаётся целиком: AVFoundation недостающее не дозапрашивает (проверено на Mac 22.11 —
// урезанный ответ останавливал звук).
const BLOCK: u64 = 256 * 1024;
const BLOCKS_PER_TRACK: usize = 640; // до 160 МБ на трек (трек прогревается целиком, см. prefetch)
const TRACKS_CACHED: usize = 3; // играющий, затухающий при кроссфейде, следующий
// Прогрев (по просьбе 22.11 после проверки на Mac: перемотка срабатывала через 1–2 с): как только известна длина
// трека, программа в фоне скачивает его целиком кусками по 2 МБ и держит расшифрованным в памяти — перемотка в
// любое место берёт звук из памяти. На диск ничего не пишется. Одновременно прогреваются не больше 2 треков,
// треки больше 160 МБ не прогреваются (берутся по мере надобности, как раньше).
const PREFETCH_RUN: u64 = 8; // блоков за запрос (2 МБ)
const PREFETCH_MAX: u64 = 160 * 1024 * 1024;
const PREFETCH_PARALLEL: usize = 2;
const FIRST_RUN: u64 = 4; // первый запрос трека — 1 МБ: заголовки MP4 и начало звука сразу
const EXPLICIT_MAX: u64 = 64 * 1024 * 1024;

type Blk = std::sync::Arc<Vec<u8>>;
struct Cache { total: Option<u64>, blocks: HashMap<u64, Blk>, order: std::collections::VecDeque<u64>, used: Instant }
fn caches() -> &'static Mutex<HashMap<String, Cache>> {
    static C: OnceLock<Mutex<HashMap<String, Cache>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}
fn cache_total(id: &str) -> Option<u64> { caches().lock().ok()?.get(id)?.total }
fn cache_take(id: &str, idx: u64) -> Option<Blk> {
    let mut m = caches().lock().ok()?;
    let c = m.get_mut(id)?;
    let b = c.blocks.get(&idx)?.clone();
    c.used = Instant::now();
    if let Some(p) = c.order.iter().position(|x| *x == idx) { c.order.remove(p); }
    c.order.push_back(idx);
    Some(b)
}
fn cache_put(id: &str, total: u64, idx: u64, b: Blk) {
    let Ok(mut m) = caches().lock() else { return };
    if !m.contains_key(id) {
        while m.len() >= TRACKS_CACHED {
            let Some(old) = m.iter().min_by_key(|(_, c)| c.used).map(|(k, _)| k.clone()) else { break };
            m.remove(&old);
        }
        m.insert(id.to_string(), Cache { total: None, blocks: HashMap::new(), order: Default::default(), used: Instant::now() });
    }
    let c = m.get_mut(id).unwrap();
    c.total = Some(total);
    c.used = Instant::now();
    if c.blocks.insert(idx, b).is_none() { c.order.push_back(idx); }
    while c.order.len() > BLOCKS_PER_TRACK { if let Some(x) = c.order.pop_front() { c.blocks.remove(&x); } }
}

enum FetchErr { NotSatisfiable(String), Other(String) }

fn warming() -> &'static Mutex<std::collections::VecDeque<String>> {
    static W: OnceLock<Mutex<std::collections::VecDeque<String>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(Default::default()))
}
fn has_block(id: &str, i: u64) -> bool { caches().lock().map(|m| m.get(id).map(|c| c.blocks.contains_key(&i)).unwrap_or(false)).unwrap_or(false) }

/// Прогреть трек целиком в фоне (один раз на трек; самый старый прогрев останавливается, если их больше 2).
fn prefetch(id: &str, urls: Vec<String>, key: Option<Vec<u8>>, total: u64) {
    if total == 0 || total > PREFETCH_MAX { return; }
    {
        let Ok(mut w) = warming().lock() else { return };
        if w.iter().any(|x| x == id) { return; }
        w.push_back(id.to_string());
        while w.len() > PREFETCH_PARALLEL { w.pop_front(); }
    }
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let n = total.div_ceil(BLOCK);
        let mut i = 0u64;
        let mut fails = 0;
        while i < n {
            // остановлен (начался прогрев других треков) или трек выпал из памяти
            let alive = warming().lock().map(|w| w.iter().any(|x| *x == id)).unwrap_or(false);
            if !alive || cache_total(&id).is_none() { break; }
            if has_block(&id, i) { i += 1; continue; }
            let mut j = i;
            while j + 1 < n && j + 1 - i < PREFETCH_RUN && !has_block(&id, j + 1) { j += 1; }
            match blocks(&id, &urls, &key, i, j).await {
                Ok(_) => { i = j + 1; fails = 0; }
                Err(_) => { fails += 1; if fails >= 3 { break; } }
            }
        }
        if let Ok(mut w) = warming().lock() { w.retain(|x| *x != id); }
    });
}

/// Байты [a, b] файла от сервера (по запасным ссылкам), расшифрованные. → (длина файла, данные с позиции a)
async fn fetch_run(urls: &[String], key: &Option<Vec<u8>>, a: u64, b: u64) -> Result<(u64, Vec<u8>), FetchErr> {
    let mut last = String::new();
    for src in urls {
        let r = client().get(src).header(header::RANGE, format!("bytes={a}-{b}")).send().await;
        let up = match r { Ok(x) => x, Err(e) => { last = e.to_string(); continue; } };
        let st = up.status();
        if st == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            let total = up.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(|v| v.rsplit('/').next()).unwrap_or("*").to_string();
            return Err(FetchErr::NotSatisfiable(total));
        }
        if !st.is_success() { last = format!("HTTP {}", st.as_u16()); continue; }
        let partial = st == reqwest::StatusCode::PARTIAL_CONTENT;
        let cr = up.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(content_range);
        let body = match up.bytes().await { Ok(x) => x.to_vec(), Err(e) => { last = e.to_string(); continue; } };
        let (total, mut data) = if partial {
            let Some((s0, t)) = cr else { last = "нет Content-Range".into(); continue };
            let Ok(t) = t.parse::<u64>() else { last = "неизвестна длина файла".into(); continue };
            if s0 != a { last = format!("сервер прислал кусок с {s0} вместо {a}"); continue; }
            (t, body)
        } else {
            // сервер не умеет куски и прислал файл целиком — вырезаем сами
            let len = body.len() as u64;
            if a >= len { return Err(FetchErr::NotSatisfiable(len.to_string())); }
            (len, body[a as usize..=(b.min(len - 1)) as usize].to_vec())
        };
        if let Some(k) = key { decrypt_at(k, a, &mut data).map_err(FetchErr::Other)?; }
        return Ok((total, data));
    }
    Err(FetchErr::Other(last))
}

/// Блоки i0..=i1 (из кэша или от сервера). → (длина файла, блоки)
async fn blocks(id: &str, urls: &[String], key: &Option<Vec<u8>>, i0: u64, i1: u64) -> Result<(u64, HashMap<u64, Blk>), FetchErr> {
    let mut have = HashMap::new();
    let mut missing = Vec::new();
    for i in i0..=i1 { match cache_take(id, i) { Some(b) => { have.insert(i, b); } None => missing.push(i) } }
    let mut total = cache_total(id);
    // подряд идущие недостающие блоки — одним запросом
    let mut k = 0;
    while k < missing.len() {
        let r0 = missing[k];
        let mut r1 = r0;
        while k + 1 < missing.len() && missing[k + 1] == r1 + 1 { k += 1; r1 += 1; }
        k += 1;
        let mut b = r1 * BLOCK + BLOCK - 1;
        if let Some(t) = total { if r0 * BLOCK >= t { return Err(FetchErr::NotSatisfiable(t.to_string())); } b = b.min(t - 1); }
        let (t, data) = fetch_run(urls, key, r0 * BLOCK, b).await?;
        total = Some(t);
        // формат звука: по первому блоку, а если описание лежит дальше (MP4 без faststart) — по любому
        if let Ok(mut f) = fmts().lock() {
            if !f.contains_key(id) {
                let x = if r0 == 0 { sniff(&data[..data.len().min(BLOCK as usize)]) } else { sniff_box(&data) };
                if let Some(x) = x { if f.len() > MAX { f.clear(); } f.insert(id.to_string(), x); }
            }
        }
        for (j, part) in data.chunks(BLOCK as usize).enumerate() {
            let blk: Blk = std::sync::Arc::new(part.to_vec());
            cache_put(id, t, r0 + j as u64, blk.clone());
            have.insert(r0 + j as u64, blk);
        }
    }
    Ok((total.unwrap_or(0), have))
}

async fn serve_inner(id: &str, range: Option<String>) -> Response<Vec<u8>> {
    let (urls, key, mime, chunk) = {
        let Ok(r) = reg().lock() else { return resp::plain(StatusCode::INTERNAL_SERVER_ERROR, "реестр") };
        match r.get(id) {
            Some(e) => (e.urls.clone(), e.key.clone(), e.mime, e.chunk),
            None => return resp::plain(StatusCode::NOT_FOUND, "нет такого звука"),
        }
    };
    let fail = |e: FetchErr| match e {
        FetchErr::NotSatisfiable(t) => resp::not_satisfiable(&t),
        FetchErr::Other(m) => { eprintln!("[pulseya] {m}"); resp::plain(StatusCode::BAD_GATEWAY, &format!("звук не загрузился: {m}")) }
    };
    let asked = range.as_deref().and_then(resp::parse_want);
    // длина файла ещё неизвестна — узнаём, загрузив первый нужный блок
    let total = match cache_total(id) {
        Some(t) => t,
        None => {
            let first = match asked { Some(Want::From(s, _)) => s / BLOCK, _ => 0 };
            match blocks(id, &urls, &key, first, first + FIRST_RUN - 1).await {
                Ok((t, _)) => t,
                // трек короче 1 МБ — сервер ответил «нет такого куска»: берём один блок
                Err(FetchErr::NotSatisfiable(_)) => match blocks(id, &urls, &key, first, first).await { Ok((t, _)) => t, Err(e) => return fail(e) },
                Err(e) => return fail(e),
            }
        }
    };
    if total == 0 { return resp::not_satisfiable("0"); }
    prefetch(id, urls.clone(), key.clone(), total);
    // что отдаём: «bytes=a-» — до 2 МБ (плеер попросит дальше сам); «bytes=a-b» — ровно столько, сколько просили
    let (a, b, whole) = match asked {
        None => if total <= chunk { (0, total - 1, true) } else { (0, chunk - 1, false) },
        Some(Want::From(s, _)) if s >= total => return resp::not_satisfiable(&total.to_string()),
        Some(Want::From(s, None)) => (s, (s + chunk - 1).min(total - 1), false),
        Some(Want::From(s, Some(e))) => (s, e.min(total - 1).min(s + EXPLICIT_MAX - 1), false),
        Some(Want::Suffix(n)) => (total - n.min(total).min(EXPLICIT_MAX), total - 1, false),
    };
    let (i0, i1) = (a / BLOCK, b / BLOCK);
    let have = match blocks(id, &urls, &key, i0, i1).await { Ok((_, h)) => h, Err(e) => return fail(e) };
    let mut out = Vec::with_capacity((b - a + 1) as usize);
    for i in i0..=i1 {
        let Some(blk) = have.get(&i) else { return resp::plain(StatusCode::BAD_GATEWAY, "звук не загрузился: блок потерян") };
        let bs = i * BLOCK;
        let from = a.max(bs) - bs;
        let to = (b.min(bs + BLOCK - 1) - bs + 1).min(blk.len() as u64);
        if from >= to { return resp::plain(StatusCode::BAD_GATEWAY, "звук не загрузился: короткий блок"); }
        out.extend_from_slice(&blk[from as usize..to as usize]);
    }
    resp::media(mime, out, if whole { None } else { Some((a, total.to_string())) }, "no-store")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
    fn pt() -> Vec<u8> { (0..5000u32).map(|i| ((i * 7 + 3) & 255) as u8).collect() }

    // векторы получены Node.js тем же способом, что расшифровывает Electron-версия (crypto aes-*-ctr, iv из нулей)
    #[test]
    fn decrypt_matches_node() {
        let cases: [(&str, &[(u64, &str)]); 2] = [
            ("00112233445566778899aabbccddeeff", &[(0, "feeeeab6552fcd"), (1, "eeeab6552fcd14"), (15, "47f7ae484804d9"), (16, "f7ae484804d9d5"), (17, "ae484804d9d58c"), (1000, "b57603ebaef3b5"), (4093, "6a362ee4a7e7d7")]),
            ("0f1e2d3c4b5a69788796a5b4c3d2e1f00102030405060708090a0b0c0d0e0f10", &[(0, "bd271d7b108964"), (1, "271d7b108964d7"), (15, "ba348cca401552"), (16, "348cca401552b6"), (17, "8cca401552b62c"), (1000, "08fab54aed05bf"), (4093, "d8285273edfd74")]),
        ];
        let p = pt();
        for (k, list) in cases {
            let key = parse_key(Some(k)).unwrap();
            for (off, want) in list {
                // шифрование и расшифровка в CTR одинаковы: шифруем кусок открытого текста с места off
                let mut b = p[*off as usize..*off as usize + 7].to_vec();
                decrypt_at(&key, *off, &mut b).unwrap();
                assert_eq!(hex(&b), *want, "ключ {} байт, место {}", key.len(), off);
            }
        }
    }

    #[test]
    fn keys_and_hosts() {
        assert!(parse_key(Some("zz112233445566778899aabbccddeeff")).is_none());
        assert!(parse_key(Some("0011")).is_none());
        assert_eq!(parse_key(Some("00112233445566778899aabbccddeeff")).unwrap().len(), 16);
        assert!(yandex_host("https://s123.storage.yandex.net/get-mp3/x"));
        assert!(yandex_host("https://strm-m9-12.strm.yandex.net/a"));
        assert!(!yandex_host("http://s123.storage.yandex.net/x"));
        assert!(!yandex_host("https://yandex.net.evil.com/x"));
        assert!(!yandex_host("https://evilyandex.net/x"));
        assert!(add(vec!["https://example.com/a".into()], None, None).is_err());
    }

    fn lab(name: &str) -> Vec<u8> { std::fs::read(format!("{}/../lab-media/{}", env!("CARGO_MANIFEST_DIR"), name)).unwrap() }

    #[test]
    fn sniff_formats() {
        assert_eq!(sniff(&lab("flac-in-mp4.m4a")), Some(Fmt { codec: "FLAC", sr: 44100, bits: 16 }));
        assert_eq!(sniff(&lab("ya-flac-mp4-24-96.plain.m4a")), Some(Fmt { codec: "FLAC", sr: 96000, bits: 24 }));
        assert_eq!(sniff(&lab("flac-24-192.flac")), Some(Fmt { codec: "FLAC", sr: 192000, bits: 24 }));
        assert_eq!(sniff(&lab("aac-256.m4a")).map(|f| (f.codec, f.sr)), Some(("AAC", 44100)));
        assert_eq!(sniff(&lab("mp3-320.mp3")).map(|f| (f.codec, f.sr)), Some(("MP3", 44100)));
        // описание в конце файла (MP4 без faststart): находится в последнем куске, а в куске из середины звука — нет
        let p = lab("ya-flac-mp4-24-96.plain.m4a");
        assert_eq!(sniff_box(&p[p.len() - 4000..]), Some(Fmt { codec: "FLAC", sr: 96000, bits: 24 }));
        assert_eq!(sniff_box(&p[100_000..900_000]), None);
        let f = lab("flac-24-192.flac");
        assert_eq!(sniff_box(&f[200_000..]), None);
        // начало MP4 без описания — не принимаем случайные байты звука за MP3
        assert_eq!(sniff(&p[..200_000]), None);
    }

    // весь путь: локальный «сервер Яндекса» с Range → кусками, с разных мест → расшифровка → совпадает с исходником
    #[test]
    fn full_path_through_http() {
        let port = crate::lab::start_server_at(format!("{}/../lab-media", env!("CARGO_MANIFEST_DIR")).into());
        let plain = lab("ya-flac-mp4-24-96.plain.m4a");
        let url = add_as("t-24".into(), vec![format!("http://127.0.0.1:{port}/missing.enc"), format!("http://127.0.0.1:{port}/ya-flac-mp4-24-96.enc")],
            Some("0f1e2d3c4b5a69788796a5b4c3d2e1f00102030405060708090a0b0c0d0e0f10".into()), Some("flac-mp4".into()), 100_000).unwrap();
        assert_eq!(url, "pulseya://s/t-24");
        tauri::async_runtime::block_on(async {
            // подряд с начала: «bytes=0-», затем каждый следующий кусок
            let mut got = Vec::new();
            let mut pos = 0u64;
            loop {
                let r = serve("t-24", Some(format!("bytes={pos}-"))).await;
                assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
                let cr = r.headers().get(header::CONTENT_RANGE).unwrap().to_str().unwrap().to_string();
                assert!(cr.ends_with(&format!("/{}", plain.len())), "{cr}");
                let b = r.body().clone();
                assert!(!b.is_empty() && b.len() <= 100_000);
                got.extend_from_slice(&b);
                pos += b.len() as u64;
                if pos >= plain.len() as u64 { break; }
            }
            assert!(got == plain, "расшифровка подряд не совпала");
            // перемотка: куски с неровных мест
            for (a, b) in [(17u64, 1000u64), (99_999, 100_050), (777_777, 800_000), (plain.len() as u64 - 33, plain.len() as u64 - 1)] {
                let r = serve("t-24", Some(format!("bytes={a}-{b}"))).await;
                assert_eq!(r.body().as_slice(), &plain[a as usize..=b as usize], "кусок {a}-{b}");
            }
            // хвост и запрос без Range
            let r = serve("t-24", Some("bytes=-10".into())).await;
            assert_eq!(r.body().as_slice(), &plain[plain.len() - 10..]);
            let r = serve("t-24", None).await;
            assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
            assert_eq!(r.body().as_slice(), &plain[..100_000]);
            // за пределами файла
            let r = serve("t-24", Some(format!("bytes={}-", plain.len() + 5))).await;
            assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
            // явный запрос больше куска — отдаётся ЦЕЛИКОМ (ошибка tauri-test-3: урезанный ответ останавливал звук)
            let r = serve("t-24", Some("bytes=44-428452".into())).await;
            assert_eq!(r.body().len(), 428_409);
            assert_eq!(r.body().as_slice(), &plain[44..=428_452]);
        });
        assert_eq!(fmt_of(&url), Some(Fmt { codec: "FLAC", sr: 96000, bits: 24 }));
    }

    // как разбирает MP4 плеер WebKit: десятки крошечных запросов → к серверу уходят единицы (кэш блоков)
    #[test]
    fn tiny_requests_use_cache() {
        let port = crate::lab::start_server_at(format!("{}/../lab-media", env!("CARGO_MANIFEST_DIR")).into());
        let plain = lab("ya-flac-mp4-24-96-fast.plain.m4a");
        let n = plain.len() as u64;
        add_as("t-hits".into(), vec![format!("http://127.0.0.1:{port}/ya-flac-mp4-24-96-fast.enc")],
            Some("0f1e2d3c4b5a69788796a5b4c3d2e1f00102030405060708090a0b0c0d0e0f10".into()), Some("flac-mp4".into()), CHUNK).unwrap();
        let before = crate::lab::hits().lock().unwrap().get("ya-flac-mp4-24-96-fast.enc").copied().unwrap_or(0);
        tauri::async_runtime::block_on(async {
            let mut asks: Vec<(u64, u64)> = vec![(0, 1), (0, 7), (28, 35), (36, 43), (144, 151), (1143, 1150), (8, 27)];
            for k in 0..60u64 { asks.push((44 + k * 13, 44 + k * 13 + 7)); }
            asks.push((n - 90, n - 1));
            for (a, b) in asks {
                let r = serve("t-hits", Some(format!("bytes={a}-{b}"))).await;
                assert_eq!(r.body().as_slice(), &plain[a as usize..=b as usize], "кусок {a}-{b}");
            }
        });
        let after = crate::lab::hits().lock().unwrap().get("ya-flac-mp4-24-96-fast.enc").copied().unwrap_or(0);
        // 1 МБ в начале, хвост и фоновый прогрев остатка (файл 1,4 МБ) — не больше 3 запросов
        assert!(after - before <= 3, "к серверу ушло {} запросов вместо 1–3", after - before);
    }

    // прогрев: после первого запроса трек целиком оказывается в памяти, перемотка в любое место — без сервера
    #[test]
    fn prefetch_whole_track() {
        let port = crate::lab::start_server_at(format!("{}/../lab-media", env!("CARGO_MANIFEST_DIR")).into());
        let plain = std::fs::read(format!("{}/../lab-media/flac-in-mp4.m4a", env!("CARGO_MANIFEST_DIR"))).unwrap();
        add_as("t-warm".into(), vec![format!("http://127.0.0.1:{port}/ya-flac-mp4-16-44.enc")],
            Some("00112233445566778899aabbccddeeff".into()), Some("flac-mp4".into()), CHUNK).unwrap();
        tauri::async_runtime::block_on(async {
            let _ = serve("t-warm", Some("bytes=0-1".into())).await;
            let n = (plain.len() as u64).div_ceil(BLOCK);
            let t0 = Instant::now();
            // другие тесты тоже прогревают треки (одновременно — не больше 2): если прогрев сняли, запрос плеера запустит его снова
            while (0..n).any(|i| !has_block("t-warm", i)) && t0.elapsed() < Duration::from_secs(8) {
                std::thread::sleep(Duration::from_millis(30));
                let _ = serve("t-warm", Some("bytes=0-1".into())).await;
            }
            assert!((0..n).all(|i| has_block("t-warm", i)), "трек не прогрелся");
            let r = serve("t-warm", Some(format!("bytes=100000-{}", plain.len() - 1))).await;
            assert_eq!(r.body().as_slice(), &plain[100_000..]);
        });
    }
}
