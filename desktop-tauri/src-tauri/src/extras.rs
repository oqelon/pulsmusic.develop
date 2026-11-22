// Остальное из главного процесса Electron-версии: статус в Discord (discord.js), счётчик «Сейчас онлайн»
// (online.js), режим разработчика (dev:unlock), сведения о компьютере для облегчённых эффектов (perf), работа от
// батареи (power), проверка CORS для живого фона (audio:cors).

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

// ════════════════════════════ Discord ════════════════════════════
// Связь — только с приложением Discord на этом же компьютере, через его локальный канал ($TMPDIR/discord-ipc-N).
// Ни входа в Discord, ни токенов. Номер приложения «Пульс» в Discord (Application ID) — из /s/config сервера «Пульса».
// Обновления не чаще раза в 1,5 с; Discord не запущен — тихо пробуем раз в 20 с, пока статус включён.

const SITE: &str = "https://oqelon.github.io/pulsmusic.develop/pc/";
const ICON: &str = "https://raw.githubusercontent.com/oqelon/pulsmusic.develop/main/docs/assets/pulse-discord-2.png";

enum Cmd { Enable(bool), Set(Value), AppId(String) }
struct Dc { tx: Sender<Cmd>, state: Mutex<String> }
static DC: OnceLock<Dc> = OnceLock::new();

fn pad(s: &str, n: usize) -> String {
    let t: String = s.trim().chars().take(n).collect();
    if t.chars().count() < 2 { format!("{t}  ").chars().take(2).collect() } else { t }
}

/// что показать: { title, artist, album, cover, dur, pos, playing, yid, albumId } или None
pub fn activity(t: &Value, legacy: bool) -> Option<Value> {
    if !t["playing"].as_bool().unwrap_or(false) { return None; }
    let title = t["title"].as_str().unwrap_or("");
    if title.is_empty() { return None; }
    let cover = t["cover"].as_str().filter(|c| c.starts_with("https://") && c.len() <= 256).map(|c| sized_400(c)).unwrap_or_else(|| ICON.to_string());
    let artist = t["artist"].as_str().filter(|s| !s.is_empty()).unwrap_or("Неизвестный исполнитель");
    let album = t["album"].as_str().filter(|s| !s.is_empty()).unwrap_or(title);
    let mut a = json!({ "type": 2, "details": pad(title, 128), "state": pad(artist, 128), "instance": false,
        "assets": { "large_image": cover, "large_text": pad(album, 128), "small_image": ICON, "small_text": "Пульс" },
        "buttons": [{ "label": "Скачать «Пульс»", "url": SITE }] });
    if !legacy { a["status_display_type"] = json!(1); }
    let digits = |v: &Value| { let s = match v { Value::String(s) => s.clone(), Value::Number(n) => n.to_string(), _ => String::new() }; if !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()) { Some(s) } else { None } };
    if let Some(y) = digits(&t["yid"]) {
        let alb = digits(&t["albumId"]).map(|a| format!("album/{a}/")).unwrap_or_default();
        a["buttons"].as_array_mut().unwrap().push(json!({ "label": "Открыть в Яндекс Музыке", "url": format!("https://music.yandex.ru/{alb}track/{y}") }));
    }
    let dur = t["dur"].as_f64().unwrap_or(0.0);
    if dur > 0.0 {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
        let pos = t["pos"].as_f64().unwrap_or(0.0).clamp(0.0, dur);
        a["timestamps"] = json!({ "start": (now - pos * 1000.0).round() as i64, "end": (now + (dur - pos) * 1000.0).round() as i64 });
    }
    Some(a)
}
/// …/1000x1000 → …/400x400 (быстрее грузится у Discord)
fn sized_400(c: &str) -> String {
    let (head, q) = match c.find('?') { Some(i) => (&c[..i], &c[i..]), None => (c, "") };
    if let Some(i) = head.rfind('/') {
        let last = &head[i + 1..];
        if let Some((w, h)) = last.split_once('x') { if !w.is_empty() && !h.is_empty() && w.chars().all(|x| x.is_ascii_digit()) && h.chars().all(|x| x.is_ascii_digit()) { return format!("{}/400x400{q}", &head[..i]); } }
    }
    c.to_string()
}

fn frame(op: i32, v: &Value) -> Vec<u8> {
    let j = serde_json::to_vec(v).unwrap_or_default();
    let mut b = Vec::with_capacity(8 + j.len());
    b.extend_from_slice(&op.to_le_bytes());
    b.extend_from_slice(&(j.len() as i32).to_le_bytes());
    b.extend_from_slice(&j);
    b
}

#[cfg(unix)]
type Sock = std::os::unix::net::UnixStream;
#[cfg(unix)]
fn connect_pipe() -> Option<Sock> {
    let base = std::env::var("XDG_RUNTIME_DIR").or_else(|_| std::env::var("TMPDIR")).unwrap_or_else(|_| "/tmp".into());
    (0..10).find_map(|i| Sock::connect(std::path::Path::new(&base).join(format!("discord-ipc-{i}"))).ok())
}
#[cfg(not(unix))]
type Sock = std::fs::File;
#[cfg(not(unix))]
fn connect_pipe() -> Option<Sock> {
    (0..10).find_map(|i| std::fs::OpenOptions::new().read(true).write(true).open(format!(r"\\?\pipe\discord-ipc-{i}")).ok())
}

fn set_state(s: &str, emit: &dyn Fn(&str)) {
    if let Some(d) = DC.get() {
        let mut g = d.state.lock().unwrap_or_else(|e| e.into_inner());
        if *g != s { *g = s.to_string(); drop(g); emit(s); }
    }
}

fn discord_loop(rx: Receiver<Cmd>, emit: Box<dyn Fn(&str) + Send>) {
    let (mut enabled, mut app_id, mut want, mut legacy) = (false, String::new(), Value::Null, false);
    let mut sock: Option<Sock> = None;
    let (mut ready, mut buf) = (false, Vec::<u8>::new());
    let mut next_try = Instant::now();
    let mut send_at: Option<Instant> = None;
    let mut force = false;
    let mut last_sent = String::new();
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Cmd::Enable(v)) => { enabled = v; next_try = Instant::now(); send_at = Some(Instant::now() + Duration::from_millis(50)); force = true; }
            Ok(Cmd::Set(t)) => { want = t; if send_at.is_none() { send_at = Some(Instant::now() + Duration::from_millis(1500)); } }
            Ok(Cmd::AppId(id)) => { if id != app_id { app_id = id; sock = None; ready = false; buf.clear(); last_sent.clear(); next_try = Instant::now(); } }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let drop_sock = |sock: &mut Option<Sock>, ready: &mut bool, buf: &mut Vec<u8>, last: &mut String| { *sock = None; *ready = false; buf.clear(); last.clear(); };
        // выключили — убираем статус и отключаемся
        if !enabled && sock.is_some() && send_at.is_none() { drop_sock(&mut sock, &mut ready, &mut buf, &mut last_sent); }
        if sock.is_none() {
            if app_id.is_empty() { set_state("noid", &*emit); continue; }
            if !enabled { set_state("off", &*emit); continue; }
            if Instant::now() < next_try { continue; }
            match connect_pipe() {
                Some(mut s) => {
                    #[cfg(unix)] { let _ = s.set_read_timeout(Some(Duration::from_millis(50))); }
                    if s.write_all(&frame(0, &json!({ "v": 1, "client_id": app_id }))).is_ok() { sock = Some(s); set_state("wait", &*emit); }
                    else { next_try = Instant::now() + Duration::from_secs(20); set_state("wait", &*emit); }
                }
                None => { next_try = Instant::now() + Duration::from_secs(20); set_state("wait", &*emit); continue; }
            }
        }
        // чтение ответов Discord
        let mut closed = false;
        if let Some(s) = sock.as_mut() {
            let mut tmp = [0u8; 8192];
            match s.read(&mut tmp) {
                Ok(0) => closed = true,
                Ok(k) => buf.extend_from_slice(&tmp[..k]),
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(_) => closed = true,
            }
        }
        while buf.len() >= 8 && !closed {
            let op = i32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
            let len = i32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]).max(0) as usize;
            if buf.len() < 8 + len { break; }
            let m: Value = serde_json::from_slice(&buf[8..8 + len]).unwrap_or(Value::Null);
            buf.drain(..8 + len);
            match op {
                3 => { if let Some(s) = sock.as_mut() { let _ = s.write_all(&frame(4, &m)); } }
                2 => {
                    closed = true;
                    if m["message"].as_str().map_or(false, |x| x.to_lowercase().replace(['_', ' '], "").contains("clientid")) { set_state("badid", &*emit); app_id.clear(); }
                }
                1 => {
                    if m["evt"] == "READY" { ready = true; set_state("on", &*emit); send_at = Some(Instant::now()); force = true; }
                    else if m["evt"] == "ERROR" && !legacy { legacy = true; send_at = Some(Instant::now()); force = true; }
                }
                _ => {}
            }
        }
        if closed { drop_sock(&mut sock, &mut ready, &mut buf, &mut last_sent); next_try = Instant::now() + Duration::from_secs(20); if !app_id.is_empty() { set_state(if enabled { "wait" } else { "off" }, &*emit); } continue; }
        // отправка статуса
        if let Some(at) = send_at {
            if Instant::now() >= at && ready {
                send_at = None;
                let act = if enabled { activity(&want, legacy) } else { None };
                let key = act.as_ref().map(|a| format!("{}|{}|{}|{}", a["details"], a["state"], a["assets"]["large_image"], a["timestamps"]["start"].as_i64().map(|x| x / 2000).unwrap_or(0))).unwrap_or_else(|| "-".into());
                if force || key != last_sent {
                    last_sent = key;
                    let mut args = json!({ "pid": std::process::id() });
                    if let Some(a) = act { args["activity"] = a; }
                    let nonce = format!("{:x}{:x}", std::process::id(), Instant::now().elapsed().as_nanos() ^ std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
                    let ok = sock.as_mut().map_or(false, |s| s.write_all(&frame(1, &json!({ "cmd": "SET_ACTIVITY", "args": args, "nonce": nonce }))).is_ok());
                    if !ok { drop_sock(&mut sock, &mut ready, &mut buf, &mut last_sent); next_try = Instant::now() + Duration::from_secs(20); }
                }
                force = false;
                if !enabled { std::thread::sleep(Duration::from_millis(400)); drop_sock(&mut sock, &mut ready, &mut buf, &mut last_sent); }
            }
        }
    }
}

pub fn discord_start(app: tauri::AppHandle, social_url: &'static str) {
    if DC.get().is_some() { return; }
    let (tx, rx) = channel();
    let _ = DC.set(Dc { tx: tx.clone(), state: Mutex::new("off".into()) });
    let a = app.clone();
    let emit: Box<dyn Fn(&str) + Send> = Box::new(move |s: &str| { let _ = tauri::Emitter::emit(&a, "pulse-discord", s); });
    let _ = std::thread::Builder::new().name("pulse-discord".into()).spawn(move || discord_loop(rx, emit));
    // номер приложения в Discord — с сервера «Пульса», раз в 6 часов
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(c) = reqwest::Client::new().get(format!("{social_url}/s/config")).timeout(Duration::from_secs(10)).send().await {
                if let Ok(v) = c.bytes().await.map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice::<Value>(&b).map_err(|e| e.to_string())) {
                    let id = v["discord"].as_str().unwrap_or("").to_string();
                    let ok = (15..=22).contains(&id.len()) && id.chars().all(|c| c.is_ascii_digit());
                    let _ = tx.send(Cmd::AppId(if ok { id } else { String::new() }));
                }
            }
            tokio_sleep(6 * 3600 * 1000).await;
        }
    });
}
pub fn discord_enable(v: bool) -> String { if let Some(d) = DC.get() { let _ = d.tx.send(Cmd::Enable(v)); } discord_state() }
pub fn discord_set(t: Value) -> String { if let Some(d) = DC.get() { let _ = d.tx.send(Cmd::Set(if t.is_object() { t } else { Value::Null })); } discord_state() }
pub fn discord_state() -> String { DC.get().map(|d| d.state.lock().map(|g| g.clone()).unwrap_or_default()).unwrap_or_else(|| "off".into()) }

async fn tokio_sleep(ms: u64) { let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms))).await; }

// ════════════════════════════ «Сейчас онлайн» ════════════════════════════
// Раз в 5 минут программа отмечается на счётчике: только случайный номер этой копии «Пульса» и слово 'pc'.
// Номер — тот же, что у Electron-версии на этом компьютере (если он есть), чтобы одна копия не считалась дважды.
// Адрес счётчика — поле online в latest.json обновлений.

static ONLINE_URL: Mutex<String> = Mutex::new(String::new());
const FEED: &str = "https://github.com/oqelon/pulsmusic.develop/releases/latest/download/latest.json";

fn online_ok(u: &str) -> String {
    let Some(rest) = u.strip_prefix("https://") else { return String::new() };
    let host = rest.split('/').next().unwrap_or("");
    if host.ends_with(".workers.dev") && !u.contains('?') && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') { format!("https://{host}") } else { String::new() }
}
fn online_id(data: &std::path::Path, electron: Option<std::path::PathBuf>) -> String {
    let ok = |v: &str| v.len() == 32 && v.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    let f = data.join("online-id");
    if let Ok(v) = std::fs::read_to_string(&f) { if ok(v.trim()) { return v.trim().to_string(); } }
    let v = electron.and_then(|d| std::fs::read_to_string(d.join("online-id")).ok()).map(|s| s.trim().to_string()).filter(|s| ok(s))
        .unwrap_or_else(|| { let mut b = [0u8; 16]; let _ = getrandom::getrandom(&mut b); b.iter().map(|x| format!("{x:02x}")).collect() });
    let _ = std::fs::create_dir_all(data);
    let _ = std::fs::write(&f, &v);
    v
}
async fn online_feed() -> Option<String> {
    let r = reqwest::Client::new().get(format!("{FEED}?t={}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0))).timeout(Duration::from_secs(15)).send().await.ok()?;
    if !r.status().is_success() { return None; }
    let v: Value = serde_json::from_slice(&r.bytes().await.ok()?).ok()?;
    Some(online_ok(v["online"].as_str().unwrap_or("")))
}
pub fn online_start(data: std::path::PathBuf, electron: Option<std::path::PathBuf>) {
    let id = online_id(&data, electron);
    tauri::async_runtime::spawn(async move {
        tokio_sleep(15000).await;
        let mut last_feed = Instant::now() - Duration::from_secs(7 * 3600);
        loop {
            if last_feed.elapsed() > Duration::from_secs(6 * 3600) {
                if let Some(u) = online_feed().await { *ONLINE_URL.lock().unwrap_or_else(|e| e.into_inner()) = u; }
                last_feed = Instant::now();
            }
            let url = ONLINE_URL.lock().map(|g| g.clone()).unwrap_or_default();
            if !url.is_empty() {
                let _ = reqwest::Client::new().post(format!("{url}/ping")).header("content-type", "application/json")
                    .body(json!({ "id": id, "p": "pc" }).to_string()).timeout(Duration::from_secs(10)).send().await;
            }
            tokio_sleep(5 * 60 * 1000).await;
        }
    });
}
pub async fn online_count() -> Value {
    if !dev_ok() { return json!({ "ok": false, "error": "После перезапуска введите пароль разработчика ещё раз" }); }
    let mut url = ONLINE_URL.lock().map(|g| g.clone()).unwrap_or_default();
    if url.is_empty() { url = online_feed().await.unwrap_or_default(); }
    if url.is_empty() { return json!({ "ok": false, "none": true }); }
    let r = match reqwest::Client::new().get(format!("{url}/online?t={}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0))).timeout(Duration::from_secs(10)).send().await {
        Ok(r) => r, Err(_) => return json!({ "ok": false, "error": "Счётчик недоступен" }),
    };
    if !r.status().is_success() { return json!({ "ok": false, "error": format!("Счётчик ответил {}", r.status().as_u16()) }); }
    let v: Value = r.bytes().await.ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    let n = |k: &str| v[k].as_f64().unwrap_or(0.0);
    json!({ "ok": true, "v": { "total": n("total"), "pc": n("pc"), "mobile": n("mobile"), "at": if n("at") > 0.0 { n("at") } else { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0) } } })
}

// ════════════════════════════ режим разработчика ════════════════════════════
// Пароль в коде не хранится — только его отпечаток PBKDF2-SHA256 (соль + 210 000 повторов), тот же, что в Electron-версии.
// После 5 неверных попыток — пауза 60 с. Разблокировка действует до перезапуска.

const DEV_SALT: &str = "27afa81e579664c7131b22f453af8dfd";
const DEV_HASH: &str = "f4c252ebf9b79edb6d829f200965c3cf2421babafddd929f226f16f80d620c0e";
const DEV_ITER: u32 = 210_000;
static DEV_OK: AtomicBool = AtomicBool::new(false);
static DEV_FAILS: AtomicU64 = AtomicU64::new(0);
static DEV_LOCK: AtomicU64 = AtomicU64::new(0);

fn unhex(s: &str) -> Vec<u8> { (0..s.len() / 2).filter_map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()).collect() }
pub fn dev_ok() -> bool { DEV_OK.load(Ordering::Relaxed) }
pub fn dev_check(pw: &str) -> bool {
    let mut k = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(pw.as_bytes(), &unhex(DEV_SALT), DEV_ITER, &mut k);
    let want = unhex(DEV_HASH);
    want.len() == 32 && k.iter().zip(&want).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0
}
pub fn dev_unlock(pw: &str) -> Value {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let until = DEV_LOCK.load(Ordering::Relaxed);
    if now < until { return json!({ "ok": false, "wait": (until - now).div_ceil(1000) }); }
    if dev_check(pw) { DEV_FAILS.store(0, Ordering::Relaxed); DEV_OK.store(true, Ordering::Relaxed); return json!({ "ok": true }); }
    let f = DEV_FAILS.fetch_add(1, Ordering::Relaxed) + 1;
    if f >= 5 { DEV_FAILS.store(0, Ordering::Relaxed); DEV_LOCK.store(now + 60_000, Ordering::Relaxed); return json!({ "ok": false, "wait": 60 }); }
    json!({ "ok": false, "left": 5 - f })
}

// ════════════════════════════ компьютер и питание ════════════════════════════
// По этому интерфейс сам выбирает «облегчённые эффекты». Видеокарту WebKit выбирает сам (на Mac она есть всегда),
// поэтому причины — память, процессор и то, что интерфейс сам заметил медленную работу (perf:slow).

fn perf_file(data: &std::path::Path) -> std::path::PathBuf { data.join("perf.json") }
fn memo(data: &std::path::Path) -> Value { std::fs::read_to_string(perf_file(data)).ok().and_then(|s| serde_json::from_str(&s).ok()).filter(|v: &Value| v.is_object()).unwrap_or_else(|| json!({})) }
fn save_memo(data: &std::path::Path, v: &Value) { let _ = std::fs::create_dir_all(data); let _ = std::fs::write(perf_file(data), v.to_string()); }
pub fn perf_slow(data: &std::path::Path, v: bool) { let mut m = memo(data); m["slow"] = json!(v); save_memo(data, &m); }
pub fn perf_unsafe(data: &std::path::Path) { let mut m = memo(data); for k in ["safeLeft", "fails", "gpuCrash"] { m[k] = json!(0); } m["slow"] = json!(false); save_memo(data, &m); }

fn ram_gb() -> u64 {
    #[cfg(target_os = "macos")]
    { if let Ok(o) = std::process::Command::new("/usr/sbin/sysctl").args(["-n", "hw.memsize"]).output() { if let Ok(b) = String::from_utf8_lossy(&o.stdout).trim().parse::<u64>() { return (b as f64 / 1_073_741_824.0).round() as u64; } } }
    0
}
/// от батареи? (macOS: pmset -g batt → «Now drawing from 'Battery Power'»)
pub fn on_battery() -> bool {
    #[cfg(target_os = "macos")]
    { if let Ok(o) = std::process::Command::new("/usr/bin/pmset").args(["-g", "batt"]).output() { return String::from_utf8_lossy(&o.stdout).contains("'Battery Power'"); } }
    false
}
pub fn perf(data: &std::path::Path) -> Value {
    let m = memo(data);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    let ram = ram_gb();
    let mut reasons: Vec<String> = Vec::new();
    if ram > 0 && ram <= 4 { reasons.push(format!("мало памяти ({ram} ГБ)")); }
    if cores > 0 && cores <= 4 { reasons.push(format!("процессор на {cores} потока")); }
    if m["slow"].as_bool().unwrap_or(false) { reasons.push("интерфейс шёл медленно в прошлый раз".into()); }
    let weak = (ram > 0 && ram <= 4) || (cores > 0 && cores <= 2);
    json!({ "tier": if reasons.is_empty() { "normal" } else { "lite" }, "reasons": reasons, "gpu": if cfg!(target_arch = "aarch64") && cfg!(target_os = "macos") { "Apple" } else { "" },
        "mac": false, "ram": ram, "cores": cores, "weak": weak, "soft": false, "battery": on_battery(), "safe": false, "gpuCrash": false })
}
/// от батареи / от сети: событие pulse-power при смене (проверка раз в 20 с)
pub fn power_watch(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new().name("pulse-power".into()).spawn(move || {
        let mut last = on_battery();
        loop {
            std::thread::sleep(Duration::from_secs(20));
            let now = on_battery();
            if now != last { last = now; let _ = tauri::Emitter::emit(&app, "pulse-power", now); }
        }
    });
}

// ════════════════════════════ живой фон: CORS ════════════════════════════
// Можно ли «послушать» звук трека (разрешает ли сервер Яндекса чтение звука странице). Нет — звук не трогаем.
pub async fn audio_cors(url: &str) -> bool {
    let ok_host = |h: &str| h == "yandex.net" || h == "yandex.ru" || h.ends_with(".yandex.net") || h.ends_with(".yandex.ru");
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").split(':').next().unwrap_or("");
    if !ok_host(host) { return false; }
    let Ok(r) = reqwest::Client::new().get(url).header("Origin", "null").header("Range", "bytes=0-1").timeout(Duration::from_secs(6)).send().await else { return false };
    r.headers().get("access-control-allow-origin").and_then(|v| v.to_str().ok()) == Some("*")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_password_hash_matches_electron() {
        // отпечаток из main.js; пароля здесь нет — проверяем, что неверный не подходит, а схема PBKDF2 та же
        assert!(!dev_check(""));
        assert!(!dev_check("password"));
        let mut k = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<sha2::Sha256>(b"test", &unhex("00112233"), 1000, &mut k);
        // тот же вектор, что даёт Node: crypto.pbkdf2Sync('test', Buffer.from('00112233','hex'), 1000, 32, 'sha256')
        assert_eq!(k.iter().map(|x| format!("{x:02x}")).collect::<String>(), "b5e1b9ccbec127245d1c91377065cc120cc3518b21fc766a1c45d333e1c41d3e");
    }

    #[test]
    fn discord_activity_like_electron() {
        assert!(activity(&json!({ "playing": false, "title": "x" }), false).is_none());
        let a = activity(&json!({ "playing": true, "title": "Песня", "artist": "", "cover": "https://avatars.yandex.net/get-music-content/1/2/1000x1000", "yid": "123", "albumId": 45, "dur": 200, "pos": 50 }), false).unwrap();
        assert_eq!(a["details"], "Песня");
        assert_eq!(a["state"], "Неизвестный исполнитель");
        assert_eq!(a["assets"]["large_image"], "https://avatars.yandex.net/get-music-content/1/2/400x400");
        assert_eq!(a["buttons"][1]["url"], "https://music.yandex.ru/album/45/track/123");
        assert_eq!(a["status_display_type"], 1);
        let s = a["timestamps"]["start"].as_i64().unwrap(); let e = a["timestamps"]["end"].as_i64().unwrap();
        assert_eq!(e - s, 200_000);
        let b = activity(&json!({ "playing": true, "title": "Я", "cover": "file:///x.jpg" }), true).unwrap();
        assert_eq!(b["details"], "Я ");
        assert_eq!(b["assets"]["large_image"], ICON);
        assert!(b.get("status_display_type").is_none());
    }

    #[test]
    fn online_url_checked() {
        assert_eq!(online_ok("https://pulse-online.pulsmusic.workers.dev"), "https://pulse-online.pulsmusic.workers.dev");
        assert_eq!(online_ok("https://evil.com"), "");
        assert_eq!(online_ok("http://x.workers.dev"), "");
        assert_eq!(online_ok("https://x.workers.dev?a=1"), "");
    }
}
