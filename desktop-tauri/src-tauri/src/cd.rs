// Запись аудио-CD и «WAV для CD» — перенос burn.js, cdwav.js и local:piece из Electron-версии.
//
// • Кусок звука (cd_piece): окно просит [s, e) секунд трека — программа сама разжимает его своим движком (любой
//   формат, который «Пульс» играет: FLAC, MP3, AAC, ALAC, WAV, AIFF, OGG, APE, WavPack, DSD, образы дисков) и отдаёт
//   WAV 44,1 кГц / 24 бит ровно с s. Окно (src/services/cdburn.js, без изменений) дальше делает то же, что раньше:
//   громкость, 16 бит, склейка кусков по номерам отсчётов. Для 44,1 кГц / 16 бит звук переходит бит в бит.
//   Формат, который движок не разжимает (Opus, WebM), отдаётся файлом целиком — как раньше, его разбирает окно.
// • Запись диска (cd_*): звук уже в формате CD (окно присылает 16 бит стерео кусками) → временная папка → drutil
//   burn -audio (встроенная утилита macOS). Windows (IMAPI2) в Tauri-версии ещё нет.
// • «WAV для CD» (cdw_*): файл пишется во временный «.имя.wav.pulse-part» в выбранной папке, после записи
//   открывается заново и проверяется (RIFF/WAVE, PCM 16 бит, 44 100 Гц, 2 канала, размер, читается до конца), и
//   только потом переименовывается. Исходные файлы не трогаются никогда.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

const RATE: u32 = 44100;
const BYTERATE: u32 = RATE * 4;
const ALIGN: u64 = 4;
const PART: &str = ".pulse-part";

fn rnd_hex(n: usize) -> String { let mut b = vec![0u8; n]; let _ = getrandom::getrandom(&mut b); b.iter().map(|x| format!("{x:02x}")).collect() }

/// заголовок WAV: fmt 1 — PCM, 3 — float
pub fn wav_header(data: u64, ch: u16, rate: u32, bits: u16, fmt: u16) -> [u8; 44] {
    let n = data.min(u32::MAX as u64 - 36) as u32;
    let ba = ch * bits / 8;
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + n).to_le_bytes());
    h[8..16].copy_from_slice(b"WAVEfmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&fmt.to_le_bytes());
    h[22..24].copy_from_slice(&ch.to_le_bytes());
    h[24..28].copy_from_slice(&rate.to_le_bytes());
    h[28..32].copy_from_slice(&(rate * ba as u32).to_le_bytes());
    h[32..34].copy_from_slice(&ba.to_le_bytes());
    h[34..36].copy_from_slice(&bits.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&n.to_le_bytes());
    h
}

// ——————————————————— кусок звука ———————————————————

/// [флаг][данные]: флаг 1 — WAV 44,1 кГц / 24 бит ровно с s (кусок), 0 — файл целиком (его разберёт окно)
pub fn piece(file: &str, s: f64, e: f64) -> Result<Vec<u8>, String> {
    let url = format!("pulsefile://a/{file}");
    let src = crate::localfile::get(file).ok_or("файл больше не в списке — добавьте его снова")?;
    match crate::engine::render_piece(&url, s.max(0.0), if e > s { e } else { 0.0 }, RATE) {
        Ok([l, r]) => {
            let n = l.len();
            let mut out = Vec::with_capacity(1 + 44 + n * 6);
            out.push(1u8);
            out.extend_from_slice(&wav_header(n as u64 * 6, 2, RATE, 24, 1));
            for i in 0..n {
                for v in [l[i], r[i]] {
                    let x = (v as f64 * 8_388_608.0).round().clamp(-8_388_608.0, 8_388_607.0) as i32;
                    out.extend_from_slice(&x.to_le_bytes()[..3]);
                }
            }
            Ok(out)
        }
        Err(m) => {
            // движок этот формат не разжимает — файл целиком, как было в Electron-версии
            let mut o = crate::localfile::Opened::open(&src).map_err(|e| match e.kind() {
                std::io::ErrorKind::PermissionDenied => "нет доступа к файлу — разрешите «Пульсу» доступ к папке в настройках конфиденциальности".to_string(),
                std::io::ErrorKind::NotFound => "файл не найден — его переместили или удалили".to_string(),
                _ => format!("файл не открылся: {e}"),
            })?;
            if o.len > 1536 * 1024 * 1024 { return Err(format!("файл слишком большой для этого формата ({m})")); }
            let mut out = vec![0u8];
            out.extend(o.read(0, o.len).map_err(|e| format!("файл не прочитался: {e}"))?);
            Ok(out)
        }
    }
}

// ——————————————————— запись диска (macOS: drutil) ———————————————————

struct Job { id: String, dir: PathBuf, n: u32, parts: HashMap<u32, u64>, burning: bool }
static JOB: Mutex<Option<Job>> = Mutex::new(None);
fn job() -> std::sync::MutexGuard<'static, Option<Job>> { JOB.lock().unwrap_or_else(|e| e.into_inner()) }
fn root() -> PathBuf { std::env::temp_dir().join("pulse-cd") }

pub fn cleanup_all() { let _ = std::fs::remove_dir_all(root()); }
fn cleanup() { if let Some(j) = job().take() { let _ = std::fs::remove_dir_all(&j.dir); } }

fn out(cmd: &str, args: &[&str]) -> (i32, String) {
    match std::process::Command::new(cmd).args(args).output() {
        Ok(o) => (o.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))),
        Err(e) => (-1, e.to_string()),
    }
}

/// «Type: CD-R  …», «Space Free: 79:59:74» → (носитель, свободно секторов)
fn mac_status(txt: &str) -> (&'static str, u64) {
    let g = |k: &str| -> String {
        let Some(i) = txt.find(&format!("{k}:")) else { return String::new() };
        let rest = txt[i + k.len() + 1..].trim_start_matches([' ', '\t']);
        let line = rest.split('\n').next().unwrap_or("");
        line.split("  ").next().unwrap_or("").trim().to_string()
    };
    let (ty, wr) = (g("Type"), g("Writability"));
    let free = txt.find("Space Free:").map(|i| txt[i + 11..].trim_start()).and_then(|r| {
        let t: Vec<u64> = r.split(|c: char| !c.is_ascii_digit()).take(3).filter_map(|x| x.parse().ok()).collect();
        (t.len() == 3).then(|| (t[0] * 60 + t[1]) * 75 + t[2])
    }).unwrap_or(0);
    let media = if ty.is_empty() || ty.to_lowercase().contains("no media") { "none" }
        else if !ty.to_uppercase().starts_with("CD-R") { "notcd" }
        else if wr.to_lowercase().contains("blank") { "blank" }
        else if ty.to_uppercase().contains("CD-RW") { "rw" }
        else { "used" };
    (media, free)
}

pub fn drives() -> Value {
    if !cfg!(target_os = "macos") { return json!({ "ok": false, "err": "Запись дисков в Tauri-версии пока есть только на Mac" }); }
    let (code, list) = out("/usr/bin/drutil", &["list"]);
    if code != 0 { return json!({ "ok": true, "drives": [] }); }
    let mut v = Vec::new();
    for row in list.lines() {
        let t = row.trim();
        let Some(n) = t.split_whitespace().next().filter(|x| x.chars().all(|c| c.is_ascii_digit())) else { continue };
        let name = t[n.len()..].split_whitespace().collect::<Vec<_>>().join(" ");
        let (_, st) = out("/usr/bin/drutil", &["-drive", n, "status"]);
        let (media, free) = mac_status(&st);
        v.push(json!({ "id": n, "name": name, "letter": "", "media": media, "mins": free / 75 / 60 }));
    }
    json!({ "ok": true, "drives": v })
}

pub fn begin(n: u32) -> Value {
    if job().as_ref().map_or(false, |j| j.burning) { return json!({ "ok": false, "err": "Уже идёт запись" }); }
    cleanup();
    let id = format!("{:x}{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0), rnd_hex(2));
    let dir = root().join(format!("job-{id}"));
    if let Err(e) = std::fs::create_dir_all(&dir) { return json!({ "ok": false, "err": e.to_string() }); }
    *job() = Some(Job { id: id.clone(), dir, n: n.clamp(1, 99), parts: HashMap::new(), burning: false });
    json!({ "ok": true, "id": id })
}

/// один трек (16 бит, 44,1 кГц, стерео, длина кратна сектору 2352): целиком (mode 0) или кусками (1 — дописать, 2 — последний)
pub fn put(id: &str, i: u32, data: &[u8], mode: u32) -> Value {
    let mut g = job();
    let Some(j) = g.as_mut().filter(|j| j.id == id) else { return json!({ "ok": false, "err": "Нет задания" }) };
    let name = format!("{:02}", i + 1);
    let fin = j.dir.join(format!("{name}.wav"));
    let part = j.dir.join(format!("{name}.wav.part"));
    let r = (|| -> Result<Value, String> {
        if mode == 0 {
            if data.is_empty() || data.len() % 2352 != 0 { return Ok(json!({ "ok": false, "err": "Неверный размер" })); }
            let mut f = File::create(&fin).map_err(|e| e.to_string())?;
            f.write_all(&wav_header(data.len() as u64, 2, RATE, 16, 1)).and_then(|_| f.write_all(data)).map_err(|e| e.to_string())?;
            return Ok(json!({ "ok": true }));
        }
        if !j.parts.contains_key(&i) { std::fs::write(&part, wav_header(0, 2, RATE, 16, 1)).map_err(|e| e.to_string())?; j.parts.insert(i, 0); }
        if !data.is_empty() {
            let mut f = std::fs::OpenOptions::new().append(true).open(&part).map_err(|e| e.to_string())?;
            f.write_all(data).map_err(|e| e.to_string())?;
            *j.parts.get_mut(&i).unwrap() += data.len() as u64;
        }
        if mode == 2 {
            let n = j.parts.remove(&i).unwrap_or(0);
            if n == 0 || n % 2352 != 0 { let _ = std::fs::remove_file(&part); return Ok(json!({ "ok": false, "err": "Неверный размер" })); }
            let mut f = std::fs::OpenOptions::new().write(true).open(&part).map_err(|e| e.to_string())?;
            f.seek(SeekFrom::Start(0)).and_then(|_| f.write_all(&wav_header(n, 2, RATE, 16, 1))).map_err(|e| e.to_string())?;
            drop(f);
            std::fs::rename(&part, &fin).map_err(|e| e.to_string())?;
        }
        Ok(json!({ "ok": true }))
    })();
    r.unwrap_or_else(|e| json!({ "ok": false, "err": e }))
}

/// запись: drutil burn -audio (прогресс — через emit)
pub fn burn(id: &str, o: &Value, emit: &dyn Fn(Value)) -> Value {
    if !cfg!(target_os = "macos") { return json!({ "ok": false, "err": "Запись дисков в Tauri-версии пока есть только на Mac" }); }
    let (dir, n) = {
        let mut g = job();
        let Some(j) = g.as_mut().filter(|j| j.id == id) else { return json!({ "ok": false, "err": "Нет задания" }) };
        if j.burning { return json!({ "ok": false, "err": "Уже идёт запись" }); }
        j.burning = true;
        (j.dir.clone(), j.n)
    };
    let speed = o["speed"].as_f64().unwrap_or(0.0).clamp(0.0, 52.0) as u32;
    let drive = match &o["drive"] { Value::String(s) if !s.is_empty() => s.clone(), Value::Number(x) => x.to_string(), _ => "1".into() };
    let mut args: Vec<String> = vec!["-drive".into(), drive, "burn".into(), "-audio".into(), "-noverify".into()];
    if speed > 0 { args.push("-speed".into()); args.push(format!("{speed}x")); }
    if o["erase"].as_bool().unwrap_or(false) { args.push("-erase".into()); }
    args.push(dir.to_string_lossy().to_string());
    emit(json!({ "stage": "prepare" }));
    emit(json!({ "stage": "write", "track": 0, "n": n }));
    let res = (|| -> Result<(), String> {
        let mut ch = std::process::Command::new("/usr/bin/drutil").args(&args)
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        let mut err = ch.stderr.take().unwrap();
        let errt = std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
        let mut so = ch.stdout.take().unwrap();
        let mut all = String::new();
        let mut buf = [0u8; 4096];
        loop {
            let k = so.read(&mut buf).unwrap_or(0);
            if k == 0 { break; }
            let t = String::from_utf8_lossy(&buf[..k]).to_string();
            if let Some(p) = last_pct(&t) { emit(json!({ "stage": "write", "pct": p.min(100) })); }
            all.push_str(&t);
        }
        let st = ch.wait().map_err(|e| e.to_string())?;
        let es = errt.join().unwrap_or_default();
        if !st.success() {
            let msg = format!("{all}{es}");
            let last = msg.trim().lines().last().unwrap_or("").trim().to_string();
            return Err(if last.is_empty() { "Не удалось записать диск".into() } else { last });
        }
        Ok(())
    })();
    cleanup();
    match res { Ok(()) => json!({ "ok": true }), Err(e) => json!({ "ok": false, "err": e }) }
}
fn last_pct(t: &str) -> Option<u32> {
    let b = t.as_bytes();
    let mut best = None;
    for (i, &c) in b.iter().enumerate() {
        if c != b'%' { continue; }
        let mut k = i; while k > 0 && b[k - 1].is_ascii_digit() && i - k < 3 { k -= 1; }
        if k < i { best = t[k..i].parse().ok(); }
    }
    best
}

pub fn eject(drive: &str) -> bool {
    if !cfg!(target_os = "macos") { return false; }
    let d = if drive.is_empty() { "1" } else { drive };
    out("/usr/bin/drutil", &["-drive", d, "eject"]).0 == 0
}
/// отмена — только пока идёт подготовка звука: прерванная запись портит CD-R
pub fn cancel() -> bool { if job().as_ref().map_or(false, |j| j.burning) { return false; } cleanup(); true }

// ——————————————————— «WAV для CD» ———————————————————

struct WJob { f: Option<File>, tmp: PathBuf, dst: PathBuf, dir: PathBuf, bytes: u64, mode: String }
static WJOBS: Mutex<Option<HashMap<String, WJob>>> = Mutex::new(None);
fn wjobs<R>(f: impl FnOnce(&mut HashMap<String, WJob>) -> R) -> R { let mut g = WJOBS.lock().unwrap_or_else(|e| e.into_inner()); f(g.get_or_insert_with(HashMap::new)) }

/// имя без запрещённых в Windows и macOS символов
pub fn safe_name(s: &str) -> String {
    let mut n: String = s.chars().map(|c| if "\\/:*?\"<>|".contains(c) || (c as u32) < 0x20 { ' ' } else { c }).collect();
    n = n.split_whitespace().collect::<Vec<_>>().join(" ");
    n = n.trim_end_matches(['.', ' ']).to_string();
    if n.is_empty() { n = "Трек".into(); }
    let l = n.to_lowercase();
    if ["con", "prn", "aux", "nul"].contains(&l.as_str()) || ((l.starts_with("com") || l.starts_with("lpt")) && l.len() == 4 && l.as_bytes()[3].is_ascii_digit()) { n = format!("_{n}"); }
    n.chars().take(150).collect()
}
fn free_name(dir: &Path, base: &str) -> Result<PathBuf, String> {
    for k in 2..1000 { let p = dir.join(format!("{base} ({k}).wav")); if !p.exists() { return Ok(p); } }
    Err("слишком много файлов с таким именем".into())
}
/// брошенные временные файлы (выключили компьютер посреди записи) — старше 6 часов
pub fn clean_parts(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().to_string();
        if !(n.starts_with('.') && n.ends_with(PART)) { continue; }
        let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).map_or(false, |d| d.as_secs() > 6 * 3600);
        if old { let _ = std::fs::remove_file(e.path()); }
    }
}

pub fn wav_open(dir: &str, name: &str, mode: &str) -> Value {
    let d = PathBuf::from(dir);
    if dir.is_empty() || !d.is_absolute() { return json!({ "ok": false, "err": "не выбрана папка для сохранения" }); }
    if !d.is_dir() { return json!({ "ok": false, "err": "папка для сохранения не найдена" }); }
    let base = safe_name(name);
    let mut dst = d.join(format!("{base}.wav"));
    if dst.exists() {
        if mode == "skip" { return json!({ "ok": true, "skip": true, "path": dst.to_string_lossy() }); }
        if mode != "replace" { match free_name(&d, &base) { Ok(p) => dst = p, Err(e) => return json!({ "ok": false, "err": e }) } }
    }
    let tmp = d.join(format!(".{base}.{}{PART}", rnd_hex(3)));
    let f = match std::fs::OpenOptions::new().write(true).read(true).create_new(true).open(&tmp) {
        Ok(mut f) => match f.write_all(&wav_header(0, 2, RATE, 16, 1)) { Ok(()) => f, Err(e) => { let _ = std::fs::remove_file(&tmp); return json!({ "ok": false, "err": io_err(&e) }); } },
        Err(e) => return json!({ "ok": false, "err": io_err(&e) }),
    };
    let id = rnd_hex(16);
    wjobs(|m| m.insert(id.clone(), WJob { f: Some(f), tmp, dst: dst.clone(), dir: d, bytes: 0, mode: mode.to_string() }));
    json!({ "ok": true, "id": id, "path": dst.to_string_lossy() })
}
fn io_err(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => "нет прав на запись в эту папку".into(),
        _ if e.raw_os_error() == Some(28) => "на диске не хватает места".into(),
        _ => format!("не удалось создать файл: {e}"),
    }
}
pub fn wav_write(id: &str, data: &[u8]) -> Value {
    let r = wjobs(|m| -> Result<(), String> {
        let j = m.get_mut(id).ok_or("файл уже закрыт")?;
        if data.len() as u64 % ALIGN != 0 { return Err("кусок звука неполный".into()); }
        let f = j.f.as_mut().ok_or("файл уже закрыт")?;
        f.seek(SeekFrom::Start(44 + j.bytes)).and_then(|_| f.write_all(data)).map_err(|e| if e.raw_os_error() == Some(28) { "на диске не хватает места".to_string() } else { format!("ошибка записи: {e}") })?;
        j.bytes += data.len() as u64;
        Ok(())
    });
    match r { Ok(()) => json!({ "ok": true }), Err(e) => { wav_abort(id); json!({ "ok": false, "err": e }) } }
}

/// проверка готового файла: заголовок по чанкам (как любой проигрыватель) и данные до конца
pub fn verify(file: &Path, expect: u64) -> String {
    let Ok(mut f) = File::open(file) else { return "файл не открывается".into() };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    if size < 44 { return "файл слишком короткий".into(); }
    let mut h = vec![0u8; size.min(4096) as usize];
    if f.read_exact(&mut h).is_err() { return "файл не читается".into(); }
    let le16 = |o: usize| u16::from_le_bytes([h[o], h[o + 1]]) as u64;
    let le32 = |o: usize| u32::from_le_bytes([h[o], h[o + 1], h[o + 2], h[o + 3]]) as u64;
    if &h[0..4] != b"RIFF" || &h[8..12] != b"WAVE" { return "нет заголовка RIFF/WAVE".into(); }
    if le32(4) != size - 8 { return "размер в заголовке RIFF не совпадает с файлом".into(); }
    let (mut o, mut fmt, mut data) = (12usize, None, None);
    while o + 8 <= h.len() && data.is_none() {
        let id = &h[o..o + 4]; let len = le32(o + 4);
        if id == b"fmt " && o + 24 <= h.len() { fmt = Some((le16(o + 8), le16(o + 10), le32(o + 12), le32(o + 16), le16(o + 20), le16(o + 22))); }
        if id == b"data" { data = Some((o as u64 + 8, len)); }
        o += 8 + len as usize + (len as usize & 1);
    }
    let Some((tag, ch, sr, br, al, bits)) = fmt else { return "нет описания формата (fmt)".into() };
    if tag != 1 { return format!("звук не в PCM (код формата {tag})"); }
    if bits != 16 { return format!("разрядность {bits} бит вместо 16"); }
    if sr != RATE as u64 { return format!("частота {sr} Гц вместо 44 100"); }
    if ch != 2 { return format!("каналов: {ch} вместо 2"); }
    if br != BYTERATE as u64 || al != ALIGN { return "неверный поток данных в заголовке".into(); }
    let Some((off, len)) = data else { return "нет блока со звуком (data)".into() };
    if len != expect { return format!("записано {len} байт звука вместо {expect}"); }
    if off + len != size { return "размер блока со звуком не совпадает с файлом".into(); }
    if len == 0 { return "в файле нет звука".into(); }
    if len % ALIGN != 0 { return "данные обрываются посреди отсчёта".into(); }
    if f.seek(SeekFrom::Start(off)).is_err() { return "файл не читается до конца".into(); }
    let mut b = vec![0u8; 1 << 20];
    let mut left = len;
    while left > 0 { match f.read(&mut b) { Ok(0) | Err(_) => return "файл не читается до конца".into(), Ok(k) => left = left.saturating_sub(k as u64) } }
    String::new()
}

pub fn wav_finish(id: &str, expect: u64) -> Value {
    let Some(mut j) = wjobs(|m| m.remove(id)) else { return json!({ "ok": false, "err": "файл уже закрыт" }) };
    let r = (|| -> Result<PathBuf, String> {
        let mut f = j.f.take().ok_or("файл уже закрыт")?;
        f.seek(SeekFrom::Start(0)).and_then(|_| f.write_all(&wav_header(j.bytes, 2, RATE, 16, 1))).map_err(|e| e.to_string())?;
        let _ = f.sync_all();
        drop(f);
        let bad = verify(&j.tmp, expect);
        if !bad.is_empty() { return Err(format!("проверка не пройдена: {bad}")); }
        let mut dst = j.dst.clone();
        if j.mode != "replace" && dst.exists() { dst = free_name(&j.dir, &dst.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default())?; }
        std::fs::rename(&j.tmp, &dst).map_err(|e| e.to_string())?;
        Ok(dst)
    })();
    match r {
        Ok(dst) => json!({ "ok": true, "path": dst.to_string_lossy(), "bytes": j.bytes, "sec": j.bytes as f64 / BYTERATE as f64 }),
        Err(e) => { let _ = std::fs::remove_file(&j.tmp); json!({ "ok": false, "err": e }) }
    }
}
pub fn wav_abort(id: &str) -> bool {
    if let Some(j) = wjobs(|m| m.remove(id)) { drop(j.f); let _ = std::fs::remove_file(&j.tmp); }
    true
}
/// при выходе: недописанные файлы и временная папка записи диска
pub fn on_exit() {
    let all: Vec<WJob> = wjobs(|m| m.drain().map(|(_, v)| v).collect());
    for j in all { drop(j.f); let _ = std::fs::remove_file(&j.tmp); }
    cleanup_all();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drutil_status_parsed() {
        let blank = "   Vendor   Product           Rev \n   HL-DT-ST DVDRW  GX40N      RQ00\n\n           Type: CD-R                 Name: /dev/disk4\n       Sessions: 0                  Tracks: 0 \n   Overwritable:   00:00:00         blocks:        0 /   0.00MB /   0.00MiB\n     Space Free:   79:59:74         blocks:   359849 / 736.97MB / 702.83MiB\n     Space Used:   00:00:00         blocks:        0 /   0.00MB /   0.00MiB\n    Writability: appendable, blank, overwritable\n";
        assert_eq!(mac_status(blank), ("blank", (79 * 60 + 59) * 75 + 74));
        assert_eq!(mac_status("  Type: No Media Inserted\n").0, "none");
        assert_eq!(mac_status("  Type: DVD+R   Name: x\n Writability: blank\n").0, "notcd");
        assert_eq!(mac_status("  Type: CD-RW   Name: x\n Writability: appendable\n").0, "rw");
        assert_eq!(last_pct("Burning... 12%\rBurning... 57%"), Some(57));
    }

    #[test]
    fn wav_written_and_verified() {
        let dir = std::env::temp_dir().join(format!("pulse-cdw-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let o = wav_open(&dir.to_string_lossy(), "01: Трек/«тест»?", "number");
        assert_eq!(o["ok"], true, "{o}");
        let id = o["id"].as_str().unwrap().to_string();
        let pcm = vec![1u8; 2352 * 10];
        assert_eq!(wav_write(&id, &pcm)["ok"], true);
        assert_eq!(wav_write(&id, &pcm)["ok"], true);
        let f = wav_finish(&id, 2352 * 20);
        assert_eq!(f["ok"], true, "{f}");
        let p = PathBuf::from(f["path"].as_str().unwrap());
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "01 Трек «тест».wav");
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 44 + 2352 * 20);
        // второй с тем же именем — с номером; «Пропустить» — пропуск
        let o2 = wav_open(&dir.to_string_lossy(), "01: Трек/«тест»?", "number");
        assert!(o2["path"].as_str().unwrap().ends_with("01 Трек «тест» (2).wav"));
        wav_abort(o2["id"].as_str().unwrap());
        assert_eq!(wav_open(&dir.to_string_lossy(), "01: Трек/«тест»?", "skip")["skip"], true);
        // не то число байт — файл не сохраняется
        let o3 = wav_open(&dir.to_string_lossy(), "x", "number");
        let id3 = o3["id"].as_str().unwrap().to_string();
        wav_write(&id3, &pcm);
        assert_eq!(wav_finish(&id3, 999)["ok"], false);
        assert!(!dir.join("x.wav").exists());
        let left: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.ends_with(PART)).collect();
        assert!(left.is_empty(), "остались временные файлы: {left:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_name("a/b:c*d?"), "a b c d");
        assert_eq!(safe_name("  ..  "), "Трек");
        assert_eq!(safe_name("CON"), "_CON");
        assert_eq!(safe_name("Трек."), "Трек");
    }
}
