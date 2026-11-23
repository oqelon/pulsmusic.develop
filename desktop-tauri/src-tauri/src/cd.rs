// Запись аудио-CD и «WAV для CD» — перенос burn.js, cdwav.js и local:piece из Electron-версии.
//
// • Кусок звука (cd_piece): окно просит [s, e) секунд трека — программа сама разжимает его своим движком (любой
//   формат, который «Пульс» играет: FLAC, MP3, AAC, ALAC, WAV, AIFF, OGG, APE, WavPack, DSD, образы дисков) и отдаёт
//   WAV 44,1 кГц / 24 бит ровно с s. Окно (src/services/cdburn.js, без изменений) дальше делает то же, что раньше:
//   громкость, 16 бит, склейка кусков по номерам отсчётов. Для 44,1 кГц / 16 бит звук переходит бит в бит.
//   Формат, который движок не разжимает (Opus, WebM), отдаётся файлом целиком — как раньше, его разбирает окно.
// • Запись диска (cd_*): звук уже в формате CD (окно присылает 16 бит стерео кусками) → временная папка → на Mac
//   служба записи дисков (DiscRecording) напрямую из osascript (cd-mac/dr.js: этапы и процент от самой службы, пауза
//   между треками любой длины, «без пауз», извлечь/оставить, закрыть/оставить открытым); если сценарий не запустился
//   до начала записи — как раньше, drutil burn -audio. На Windows — служба записи дисков Windows (IMAPI2), cd-ps/*.ps1.
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


// ——————————————————— Windows: служба записи дисков (IMAPI2) через PowerShell — сценарии из burn.js без изменений ———————————————————
#[cfg(target_os = "windows")]
const PS_LIST: &str = include_str!("cd-ps/list.ps1");
#[cfg(target_os = "windows")]
const PS_BURN: &str = include_str!("cd-ps/burn.ps1");
#[cfg(target_os = "windows")]
const PS_EJECT: &str = include_str!("cd-ps/eject.ps1");

#[cfg(target_os = "windows")]
fn ps(script: &str, env: &[(&str, String)], on_line: &mut dyn FnMut(&str)) -> (i32, Vec<String>, String) {
    use std::io::BufRead;
    use std::os::windows::process::CommandExt;
    let _ = std::fs::create_dir_all(root());
    let f = root().join(format!("pulse-{}.ps1", rnd_hex(5)));
    let mut body = vec![0xEF, 0xBB, 0xBF];
    body.extend_from_slice(script.as_bytes());
    if let Err(e) = std::fs::write(&f, body) { return (-1, Vec::new(), e.to_string()); }
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File"]).arg(&f)
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).creation_flags(0x0800_0000);
    for (k, v) in env { cmd.env(k, v); }
    let mut ch = match cmd.spawn() { Ok(c) => c, Err(e) => { let _ = std::fs::remove_file(&f); return (-1, Vec::new(), e.to_string()); } };
    let mut err = ch.stderr.take().unwrap();
    let et = std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
    let mut lines = Vec::new();
    for l in std::io::BufReader::new(ch.stdout.take().unwrap()).split(b'\n').map_while(Result::ok) {
        let l = String::from_utf8_lossy(&l).trim().trim_start_matches('\u{feff}').to_string();
        if !l.is_empty() { on_line(&l); lines.push(l); }
    }
    let code = ch.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    let _ = std::fs::remove_file(&f);
    (code, lines, et.join().unwrap_or_default().trim().to_string())
}
#[cfg(target_os = "windows")]
fn win_drives() -> Value {
    let (_, lines, _) = ps(PS_LIST, &[], &mut |_| {});
    let v: Vec<Value> = lines.iter().filter_map(|l| l.strip_prefix("DRIVE|")).map(|l| {
        let a: Vec<&str> = l.split('|').collect();
        let g = |i: usize| a.get(i).copied().unwrap_or("");
        let speeds: Vec<u32> = g(5).split(',').filter_map(|x| x.trim().parse().ok()).filter(|&x| x > 0).collect();
        json!({ "id": g(0), "name": if g(1).is_empty() { "Привод" } else { g(1) }, "letter": g(2).trim_end_matches('\\'), "media": g(3), "mins": g(4).parse::<u64>().unwrap_or(0) / 75 / 60,
            "speeds": speeds, "max": g(6).parse::<u32>().unwrap_or(0), "sao": g(7) == "1",
            // паузу длиннее 2 с Windows пишет и «трек за треком» (тишина в конце трека); «за один проход» диск всегда закрывается
            "padGap": true, "daoCloses": true })
    }).collect();
    json!({ "ok": true, "drives": v })
}
#[cfg(target_os = "windows")]
fn win_err(code: &str) -> Option<&'static str> {
    Some(match code {
        "0xC0AA0202" => "Диск не чистый — вставьте чистый CD-R или CD-RW",
        "0xC0AA0204" => "В приводе нет диска",
        "0xC0AA0205" => "Привод не может записать такой диск",
        "0xC0AA0206" => "Нет доступа к приводу — его занимает другая программа",
        "0xC0AA0209" => "Диск закончился — треки не поместились",
        "0xC0AA0405" => "Звука больше, чем помещается на диск",
        "0xC0AA0210" => "Привод занят другой программой",
        _ => return None,
    })
}
#[cfg(target_os = "windows")]
fn win_burn(dir: &Path, o: &Value, speed: u32, emit: &dyn Fn(Value)) -> Result<(), String> {
    let drive = o["drive"].as_str().unwrap_or("").to_string();
    let mut err = String::new();
    let opt = Opts::of(o);
    // пауза: 2 с ставит сам привод при записи «трек за треком»; длиннее — тишина в конце трека; короче (и «без пауз») —
    // «диск за один проход» (RawCD), тишина — тоже в конце трека
    let dao = opt.gap < 2.0;
    let extra = if dao { opt.gap } else { opt.gap - 2.0 };
    pad_tracks(dir, "pcm", 0, extra).map_err(|e| format!("Не удалось подготовить паузы: {e}"))?;
    let b = |x: bool| if x { "1".to_string() } else { "0".to_string() };
    let env = [("PULSE_CD_ID", drive), ("PULSE_CD_DIR", dir.to_string_lossy().to_string()), ("PULSE_CD_SPEED", speed.to_string()), ("PULSE_CD_ERASE", b(o["erase"].as_bool().unwrap_or(false))),
        ("PULSE_CD_EJECT", b(opt.eject)), ("PULSE_CD_CLOSE", b(opt.close || dao)), ("PULSE_CD_DAO", b(dao))];
    let (code, lines, e2) = ps(PS_BURN, &env, &mut |l| {
        let a: Vec<&str> = l.split('|').collect();
        match a[0] {
            "STAGE" => emit(json!({ "stage": a.get(1).copied().unwrap_or("") })),
            "TRACK" => emit(json!({ "stage": "write", "track": a.get(1).and_then(|x| x.parse::<u32>().ok()).unwrap_or(0), "n": a.get(2).and_then(|x| x.parse::<u32>().ok()).unwrap_or(0) })),
            // «диск за один проход» пишется одним куском — служба хода не сообщает, окно считает по времени
            "WRITEALL" => emit(json!({ "stage": "write", "all": true, "n": a.get(1).and_then(|x| x.parse::<u32>().ok()).unwrap_or(0), "sectors": a.get(2).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0) })),
            "ERR" => { let c = a.get(1).copied().unwrap_or(""); err = match win_err(c) { Some(m) => m.to_string(), None => format!("{} ({c})", if a.len() > 2 { a[2..].join("|") } else { "Ошибка записи".into() }) }; }
            _ => {}
        }
    });
    if code != 0 || !lines.iter().any(|l| l == "DONE") { return Err(if !err.is_empty() { err } else if !e2.is_empty() { e2.lines().last().unwrap_or("").to_string() } else { "Не удалось записать диск".into() }); }
    Ok(())
}

pub fn drives() -> Value {
    #[cfg(target_os = "windows")]
    { return win_drives(); }
    #[allow(unreachable_code)]
    if !cfg!(target_os = "macos") { return json!({ "ok": false, "err": "Запись дисков есть только на Windows и Mac" }); }
    if let Some(v) = mac_dr_drives() { return json!({ "ok": true, "drives": v }); }
    let (code, list) = out("/usr/bin/drutil", &["list"]);
    if code != 0 { return json!({ "ok": true, "drives": [] }); }
    let mut v = Vec::new();
    for row in list.lines() {
        let t = row.trim();
        let Some(n) = t.split_whitespace().next().filter(|x| x.chars().all(|c| c.is_ascii_digit())) else { continue };
        let name = t[n.len()..].split_whitespace().collect::<Vec<_>>().join(" ");
        let (_, st) = out("/usr/bin/drutil", &["-drive", n, "status"]);
        let (media, free) = mac_status(&st);
        v.push(json!({ "id": n, "name": name, "letter": "", "media": media, "mins": free / 75 / 60, "speeds": [], "max": 0, "sao": false, "open": true }));
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
    // Mac (drutil) берёт WAV, Windows (IMAPI2) — «сырой» звук .pcm без заголовка
    let (ext, head) = if cfg!(windows) { ("pcm", false) } else { ("wav", true) };
    let fin = j.dir.join(format!("{name}.{ext}"));
    let part = j.dir.join(format!("{name}.{ext}.part"));
    let hdr = |n: u64| -> Vec<u8> { if head { wav_header(n, 2, RATE, 16, 1).to_vec() } else { Vec::new() } };
    let r = (|| -> Result<Value, String> {
        if mode == 0 {
            if data.is_empty() || data.len() % 2352 != 0 { return Ok(json!({ "ok": false, "err": "Неверный размер" })); }
            let mut f = File::create(&fin).map_err(|e| e.to_string())?;
            f.write_all(&hdr(data.len() as u64)).and_then(|_| f.write_all(data)).map_err(|e| e.to_string())?;
            return Ok(json!({ "ok": true }));
        }
        if !j.parts.contains_key(&i) { std::fs::write(&part, hdr(0)).map_err(|e| e.to_string())?; j.parts.insert(i, 0); }
        if !data.is_empty() {
            let mut f = std::fs::OpenOptions::new().append(true).open(&part).map_err(|e| e.to_string())?;
            f.write_all(data).map_err(|e| e.to_string())?;
            *j.parts.get_mut(&i).unwrap() += data.len() as u64;
        }
        if mode == 2 {
            let n = j.parts.remove(&i).unwrap_or(0);
            if n == 0 || n % 2352 != 0 { let _ = std::fs::remove_file(&part); return Ok(json!({ "ok": false, "err": "Неверный размер" })); }
            if head {
                let mut f = std::fs::OpenOptions::new().write(true).open(&part).map_err(|e| e.to_string())?;
                f.seek(SeekFrom::Start(0)).and_then(|_| f.write_all(&hdr(n))).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&part, &fin).map_err(|e| e.to_string())?;
        }
        Ok(json!({ "ok": true }))
    })();
    r.unwrap_or_else(|e| json!({ "ok": false, "err": e }))
}

/// запись: drutil burn -audio (прогресс — через emit)
pub fn burn(id: &str, o: &Value, emit: &dyn Fn(Value)) -> Value {
    if !cfg!(any(target_os = "macos", target_os = "windows")) { return json!({ "ok": false, "err": "Запись дисков есть только на Windows и Mac" }); }
    let (dir, n) = {
        let mut g = job();
        let Some(j) = g.as_mut().filter(|j| j.id == id) else { return json!({ "ok": false, "err": "Нет задания" }) };
        if j.burning { return json!({ "ok": false, "err": "Уже идёт запись" }); }
        j.burning = true;
        (j.dir.clone(), j.n)
    };
    let speed = o["speed"].as_f64().unwrap_or(0.0).clamp(0.0, 52.0) as u32;
    let drive = match &o["drive"] { Value::String(s) if !s.is_empty() => s.clone(), Value::Number(x) => x.to_string(), _ => "1".into() };
    #[cfg(target_os = "windows")]
    {
        let _ = &drive;
        emit(json!({ "stage": "prepare" }));
        let r = win_burn(&dir, o, speed, emit);
        cleanup();
        return match r { Ok(()) => json!({ "ok": true }), Err(e) => json!({ "ok": false, "err": e }) };
    }
    #[allow(unreachable_code)]
    let opt = Opts::of(o);
    emit(json!({ "stage": "prepare", "n": n }));
    let res = match mac_dr_burn(&drive, &dir, speed, &opt, o["erase"].as_bool().unwrap_or(false), n, emit) {
        // сценарий не дошёл до записи (служба недоступна из osascript) — пишем по-старому, drutil (только паузы 2 с)
        Err(DrErr::NoStart(why)) => {
            eprintln!("[cd] DiscRecording из osascript не запустился: {why}; запись через drutil");
            if (opt.gap - 2.0).abs() > 0.01 { Err("Эта версия macOS не дала записать с выбранной паузой — выберите паузу 2 секунды".to_string()) }
            else { drutil_burn(&drive, &dir, speed, &opt, o["erase"].as_bool().unwrap_or(false), n, emit) }
        }
        Err(DrErr::Fail(e)) => Err(e),
        Ok(()) => Ok(()),
    };
    cleanup();
    match res { Ok(()) => json!({ "ok": true }), Err(e) => json!({ "ok": false, "err": e }) }
}

/// параметры записи из окна: извлечь после записи, закрыть диск, пауза между треками (с)
struct Opts { eject: bool, close: bool, gap: f64 }
impl Opts {
    fn of(o: &Value) -> Self {
        let gap = o["gap"].as_f64().unwrap_or(2.0);
        Opts { eject: o["eject"].as_bool().unwrap_or(true), close: o["close"].as_bool().unwrap_or(true), gap: if gap.is_finite() { gap.clamp(0.0, 60.0) } else { 2.0 } }
    }
}

/// тишина в конце треков (кроме последнего): sec секунд, целыми секторами; head — длина заголовка (44 у WAV)
fn pad_tracks(dir: &Path, ext: &str, head: u64, sec: f64) -> Result<(), String> {
    let sectors = (sec * 75.0).round() as u64;
    if sectors == 0 { return Ok(()); }
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().map(|e| e.path())
        .filter(|p| p.extension().map_or(false, |x| x.eq_ignore_ascii_case(ext))).collect();
    files.sort();
    let last = files.len().saturating_sub(1);
    for f in &files[..last] {
        let mut h = std::fs::OpenOptions::new().append(true).open(f).map_err(|e| e.to_string())?;
        h.write_all(&vec![0u8; (sectors * 2352) as usize]).map_err(|e| e.to_string())?;
        if head > 0 {
            let len = h.metadata().map_err(|e| e.to_string())?.len() - head;
            drop(h);
            let mut w = std::fs::OpenOptions::new().write(true).open(f).map_err(|e| e.to_string())?;
            w.seek(SeekFrom::Start(0)).and_then(|_| w.write_all(&wav_header(len, 2, RATE, 16, 1))).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ——— Mac: служба записи дисков из osascript ———
const DR_JS: &str = include_str!("cd-mac/dr.js");
enum DrErr { NoStart(String), Fail(String) }
fn dr_script() -> Result<PathBuf, String> {
    let _ = std::fs::create_dir_all(root());
    let f = root().join("dr.js");
    if std::fs::read_to_string(&f).ok().as_deref() != Some(DR_JS) { std::fs::write(&f, DR_JS).map_err(|e| e.to_string())?; }
    Ok(f)
}
/// osascript со сценарием: каждая строка вывода — сразу в on_line (вывод сценария не копится: он пишет напрямую в дескриптор)
fn dr_run(args: &[String], on_line: &mut dyn FnMut(&str)) -> Result<(i32, String), String> {
    use std::io::BufRead;
    let f = dr_script()?;
    let mut ch = std::process::Command::new("/usr/bin/osascript").arg("-l").arg("JavaScript").arg(&f).args(args)
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let mut err = ch.stderr.take().unwrap();
    let et = std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
    for l in std::io::BufReader::new(ch.stdout.take().unwrap()).lines().map_while(Result::ok) { let l = l.trim(); if !l.is_empty() { on_line(l); } }
    let code = ch.wait().map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
    Ok((code, et.join().unwrap_or_default()))
}
fn mac_dr_drives() -> Option<Vec<Value>> {
    if !cfg!(target_os = "macos") { return None; }
    let mut v = Vec::new(); let mut end = false;
    let r = dr_run(&["list".into()], &mut |l| {
        if let Some(j) = l.strip_prefix("DRIVE|") { if let Ok(x) = serde_json::from_str::<Value>(j) { v.push(x); } }
        if l == "END" { end = true; }
    });
    if r.is_err() || !end { return None; }
    Some(v)
}
/// одна строка «STATE|этап|процент|трек|треков» → событие для окна
fn dr_state(l: &str) -> Option<Value> {
    let a: Vec<&str> = l.strip_prefix("STATE|")?.split('|').collect();
    let stage = *a.first()?;
    let pct = a.get(1).and_then(|x| x.parse::<f64>().ok()).filter(|p| *p >= 0.0);
    let track = a.get(2).and_then(|x| x.parse::<u32>().ok()).unwrap_or(0);
    let n = a.get(3).and_then(|x| x.parse::<u32>().ok()).unwrap_or(0);
    let mut v = json!({ "stage": stage, "track": track, "n": n });
    if let Some(p) = pct { v["pct"] = json!((p * 10.0).round() / 10.0); v["of"] = json!("job"); }
    Some(v)
}
fn dr_err(l: &str) -> Option<String> {
    let a: Vec<&str> = l.strip_prefix("ERR|")?.splitn(2, '|').collect();
    let (code, txt) = (a.first().copied().unwrap_or(""), a.get(1).copied().unwrap_or("").trim());
    let known = match code {
        "0x80020022" => Some("В приводе нет диска"),
        "0x80020026" => Some("Диск не чистый — вставьте чистый CD-R или CD-RW"),
        "0x80020025" | "0x80020027" => Some("Диск закончился — треки не поместились"),
        "0x80020024" => Some("Привод занят другой программой"),
        "0x80020062" => Some("Привод не умеет писать диск за один проход — выберите паузу 2 секунды"),
        _ => None,
    };
    Some(match known { Some(m) => m.to_string(), None if !txt.is_empty() => if code.is_empty() { txt.to_string() } else { format!("{txt} ({code})") }, None => format!("Не удалось записать диск ({code})") })
}
fn mac_dr_burn(drive: &str, dir: &Path, speed: u32, opt: &Opts, erase: bool, n: u32, emit: &dyn Fn(Value)) -> Result<(), DrErr> {
    let args: Vec<String> = vec!["burn".into(), drive.to_string(), dir.to_string_lossy().to_string(), speed.to_string(),
        if opt.eject { "1" } else { "0" }.into(), if opt.close { "1" } else { "0" }.into(), format!("{}", opt.gap), if erase { "1" } else { "0" }.into()];
    let (mut done, mut err, mut nostart) = (false, None::<String>, None::<String>);
    let (code, es) = dr_run(&args, &mut |l| {
        if let Some(mut v) = dr_state(l) { if v["n"].as_u64().unwrap_or(0) == 0 { v["n"] = json!(n); } emit(v); }
        else if l == "DONE" { done = true; }
        else if let Some(e) = dr_err(l) { err = Some(e); }
        else if let Some(x) = l.strip_prefix("NOSTART|") { nostart = Some(x.to_string()); }
    }).map_err(DrErr::NoStart)?;
    if done && code == 0 { return Ok(()); }
    if let Some(x) = nostart { return Err(DrErr::NoStart(x)); }
    if code == 3 { return Err(DrErr::NoStart(es.trim().to_string())); }
    Err(DrErr::Fail(err.unwrap_or_else(|| { let l = es.trim().lines().last().unwrap_or("").trim().to_string(); if l.is_empty() { "Не удалось записать диск".into() } else { l } })))
}
/// запасной путь: drutil. Вывод — через псевдотерминал (script): иначе drutil копит его и ход приходит кусками
fn drutil_burn(drive: &str, dir: &Path, speed: u32, opt: &Opts, erase: bool, n: u32, emit: &dyn Fn(Value)) -> Result<(), String> {
    // номер привода для drutil; путь от службы (её список) — первый привод
    let dn = if !drive.is_empty() && drive.chars().all(|c| c.is_ascii_digit()) { drive } else { "1" };
    let mut args: Vec<String> = vec!["-q".into(), "/dev/null".into(), "/usr/bin/drutil".into(), "-drive".into(), dn.to_string(), "burn".into(), "-audio".into(), "-noverify".into()];
    if speed > 0 { args.push("-speed".into()); args.push(format!("{speed}x")); }
    if erase { args.push("-erase".into()); }
    if !opt.eject { args.push("-mount".into()); }
    if !opt.close { args.push("-appendable".into()); }
    args.push(dir.to_string_lossy().to_string());
    emit(json!({ "stage": "write", "track": 0, "n": n }));
    let mut ch = std::process::Command::new("/usr/bin/script").args(&args)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let mut err = ch.stderr.take().unwrap();
    let errt = std::thread::spawn(move || { let mut s = String::new(); let _ = err.read_to_string(&mut s); s });
    let mut so = ch.stdout.take().unwrap();
    let mut all = String::new();
    let mut buf = [0u8; 4096];
    loop {
        let k = so.read(&mut buf).unwrap_or(0);
        if k == 0 { break; }
        let t = String::from_utf8_lossy(&buf[..k]).to_string();
        if let Some(p) = last_pct(&t) { emit(json!({ "stage": if t.to_lowercase().contains("clos") || t.to_lowercase().contains("finish") { "finish" } else { "write" }, "pct": p.min(100), "of": "job" })); }
        all.push_str(&t);
    }
    let st = ch.wait().map_err(|e| e.to_string())?;
    let es = errt.join().unwrap_or_default();
    // script возвращает код drutil; на всякий случай смотрим и на текст
    if !st.success() || all.to_lowercase().contains("burn failed") {
        let msg = format!("{all}{es}");
        let last = msg.trim().lines().last().unwrap_or("").trim().to_string();
        return Err(if last.is_empty() { "Не удалось записать диск".into() } else { last });
    }
    Ok(())
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
    #[cfg(target_os = "windows")]
    { let (_, l, _) = ps(PS_EJECT, &[("PULSE_CD_ID", drive.to_string())], &mut |_| {}); return l.iter().any(|x| x == "DONE"); }
    #[allow(unreachable_code)]
    if !cfg!(target_os = "macos") { return false; }
    if !drive.is_empty() && !drive.chars().all(|c| c.is_ascii_digit()) {
        let mut ok = false;
        if dr_run(&["eject".into(), drive.to_string()], &mut |l| if l == "DONE" { ok = true; }).is_ok() && ok { return true; }
    }
    let d = if drive.is_empty() || !drive.chars().all(|c| c.is_ascii_digit()) { "1" } else { drive };
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
    fn burn_options_and_gaps() {
        let o = Opts::of(&json!({}));
        assert!(o.eject && o.close && (o.gap - 2.0).abs() < 1e-9);
        let o = Opts::of(&json!({ "eject": false, "close": false, "gap": 0 }));
        assert!(!o.eject && !o.close && o.gap == 0.0);
        assert_eq!(Opts::of(&json!({ "gap": 999 })).gap, 60.0);
        // этапы и ход от службы записи
        let v = dr_state("STATE|write|41.5|3|12").unwrap();
        assert_eq!((v["stage"].as_str(), v["pct"].as_f64(), v["track"].as_u64(), v["n"].as_u64()), (Some("write"), Some(41.5), Some(3), Some(12)));
        assert!(dr_state("STATE|prepare|-1|0|5").unwrap().get("pct").is_none());
        assert_eq!(dr_err("ERR|0x80020022|No media").unwrap(), "В приводе нет диска");
        assert_eq!(dr_err("ERR||Привод не найден").unwrap(), "Привод не найден");
        assert!(dr_err("ERR|0x8002FFFF|Something odd").unwrap().contains("0x8002FFFF"));
        // пауза: тишина в конце всех треков, кроме последнего; у WAV заголовок пересчитан
        let dir = std::env::temp_dir().join(format!("pulse-cdpad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir); std::fs::create_dir_all(&dir).unwrap();
        for i in 1..=3 { let mut f = File::create(dir.join(format!("{i:02}.wav"))).unwrap(); f.write_all(&wav_header(2352 * 10, 2, RATE, 16, 1)).unwrap(); f.write_all(&vec![7u8; 2352 * 10]).unwrap(); }
        pad_tracks(&dir, "wav", 44, 3.0).unwrap();
        for (i, want) in [(1, 10 + 225), (2, 10 + 225), (3, 10)] {
            let b = std::fs::read(dir.join(format!("{i:02}.wav"))).unwrap();
            assert_eq!(b.len() as u64, 44 + want * 2352, "трек {i}");
            assert_eq!(u32::from_le_bytes([b[40], b[41], b[42], b[43]]) as u64, want * 2352, "заголовок трека {i}");
            assert!(b[44 + 2352 * 10..].iter().all(|&x| x == 0));
        }
        pad_tracks(&dir, "wav", 44, 0.0).unwrap();
        assert_eq!(std::fs::metadata(dir.join("03.wav")).unwrap().len(), 44 + 2352 * 10);
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
