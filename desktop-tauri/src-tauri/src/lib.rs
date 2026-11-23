// Пульс на Tauri 2 — ТЕСТОВАЯ сборка (миграция с Electron).
//
// Этап 2: окно «Лаборатория звука» и схема pulsetest:// (тестовые файлы) — проверка звука WebKit на macOS.
// Этап 3: звук «Пульса» отдаёт Rust, а не Node:
//  • pulseya://s/<id>  — звук Яндекса: запрос к серверу кусками, расшифровка FLAC (AES-CTR) на лету (yastream.rs);
//  • pulsefile://a/<id> и pulsefile://c/<id> — свои файлы и обложки, в том числе кусок образа диска как WAV (localfile.rs).
// Этап 4: окно «Пульс» — интерфейс 0.38.0 без изменений и настоящий Яндекс: тот же yandex.js в окне (мост
// pulse-bridge.js, запросы через tauri-plugin-http), ссылки на звук — в pulseya://, токен — в Связке ключей.
//
// Чего здесь ещё нет (следующие этапы): перенос данных (этап 5), разбор своих папок,
// CD, Discord, обновления (этап 6). Данные этой сборки хранятся отдельно (ru.pulse.desktop.tauritest) — обычный
// «Пульс» на Electron, его настройки, лайки и токен она не видит и не трогает.

mod apewv;
mod cd;
mod dsd;
mod engine;
mod extras;
mod flacw;
mod lab;
mod ldb;
mod library;
mod localfile;
mod migrate;
mod resp;
mod secrets;
mod updater;
mod yastream;

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::http::{header, Response, StatusCode};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

// токен Яндекса — в Связке ключей macOS (Windows: диспетчер учётных данных), отдельно от Electron-версии
/// выпускная сборка (при сборке задан PULSE_RELEASE): без «Лаборатории», тестовых файлов и тестового канала
/// обновлений; окно «Пульса» открывается сразу. Тестовые сборки — как раньше.
pub const RELEASE: bool = option_env!("PULSE_RELEASE").is_some();
const KEY_USER: &str = "yandex-token";
const CHUNK: u64 = 4 * 1024 * 1024;
// 0.44.1 ровно то, что разбирает медиатека (library::audio_codec): раньше тут были mp4, alac и caf — выбрать их было
// можно, но в «Мою музыку» они не попадали (а CAF на Windows не играет вовсе)
const AUDIO_EXT: &[&str] = &["flac", "mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "webm", "weba", "wav", "aif", "aiff", "aifc", "wv", "ape", "dsf", "dff"];

static PICK_SEQ: AtomicU64 = AtomicU64::new(1);

// имя тестового файла: только латиница, цифры, «-», «_», «.»; без путей
fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() < 80 && !s.starts_with('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn lab_media(app: &tauri::AppHandle) -> Option<PathBuf> { app.path().resource_dir().ok().map(|d| d.join("lab-media")) }

// pulsetest://localhost/test/<имя> — тестовые файлы «Лаборатории» (этап 2)
fn serve_test(app: &tauri::AppHandle, path: &str, range: Option<String>) -> Response<Vec<u8>> {
    if RELEASE { return resp::plain(StatusCode::NOT_FOUND, "нет"); }
    let n = path.trim_start_matches('/').strip_prefix("test/").unwrap_or("");
    if !safe_name(n) { return resp::plain(StatusCode::NOT_FOUND, "нет такого файла"); }
    let Some(fp) = lab_media(app).map(|d| d.join(n)) else { return resp::plain(StatusCode::NOT_FOUND, "нет папки") };
    let mut f = match File::open(&fp) { Ok(f) => f, Err(_) => return resp::plain(StatusCode::NOT_FOUND, "файл не открывается") };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let ext = fp.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
    let ct = match ext.as_str() { "opus" => "audio/ogg; codecs=opus", "wv" => "audio/x-wavpack", "enc" => "application/octet-stream", e => localfile::mime_of_ext(e) };
    let (start, end, partial) = match range.as_deref().and_then(resp::parse_want) {
        Some(w) => match resp::resolve(w, len) { Some((a, b)) => (a, resp::cap_end(w, a, b, CHUNK), true), None => return resp::not_satisfiable(&len.to_string()) },
        None => (0, len.saturating_sub(1), false),
    };
    let n = if len == 0 { 0 } else { end - start + 1 };
    let mut buf = vec![0u8; n as usize];
    if n > 0 && (f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut buf).is_err()) {
        return resp::plain(StatusCode::INTERNAL_SERVER_ERROR, "ошибка чтения");
    }
    resp::media(ct, buf, if partial { Some((start, len.to_string())) } else { None }, "no-store")
}

fn range_of(req: &tauri::http::Request<Vec<u8>>) -> Option<String> {
    req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

// выбрать свои файлы: окно получает только номер, имя и адрес pulsefile://, путь остаётся в программе
#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let picked = app.dialog().file().set_title("Выберите музыку для проверки").add_filter("Музыка", AUDIO_EXT).blocking_pick_files();
    let Some(list) = picked else { return Ok(vec![]) };
    let mut out = Vec::new();
    for fp in list.into_iter().take(50) {
        let Ok(p) = fp.into_path() else { continue };
        let id = format!("pick-{}", PICK_SEQ.fetch_add(1, Ordering::Relaxed));
        let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        localfile::register(&id, localfile::Src::File(p));
        out.push(serde_json::json!({ "id": id, "name": name, "size": size, "url": format!("pulsefile://a/{id}") }));
    }
    Ok(out)
}

#[tauri::command]
async fn save_report(app: tauri::AppHandle, text: String) -> Result<bool, String> {
    if text.len() > 5 * 1024 * 1024 { return Err("отчёт слишком большой".into()); }
    let Some(fp) = app.dialog().file().set_title("Сохранить отчёт").set_file_name("pulse-tauri-audio-report.txt").blocking_save_file() else { return Ok(false) };
    let p = fp.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command(async)]
fn env_info(app: tauri::AppHandle) -> serde_json::Value {
    let mut os_ver = String::new();
    #[cfg(target_os = "macos")]
    {
        if let Ok(o) = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output() {
            os_ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
        }
    }
    serde_json::json!({ "os": std::env::consts::OS, "osVersion": os_ver, "arch": std::env::consts::ARCH, "app": app.package_info().version.to_string(), "build": option_env!("PULSE_BUILD").unwrap_or("местная"), "tauri": tauri::VERSION })
}

// Запасное место, если Связка ключей не сработала: файл в папке данных этой тестовой программы, доступ только у
// владельца (0600). Используется, только когда Связка ключей отказала, — и об этом пишется в журнал лаборатории.
fn token_file(app: &tauri::AppHandle) -> Option<PathBuf> { app.path().app_data_dir().ok().map(|d| d.join("yandex-token")) }

/// → (токен, как прочитали — для журнала). Где хранится — secrets.rs (Mac — защищённый файл, Windows — Диспетчер учётных данных)
fn token_get(app: &tauri::AppHandle) -> (String, String) {
    let w = secrets::place();
    match secrets::get(KEY_USER) {
        Ok(Some(t)) => return (t.clone(), format!("{w}: токен есть (длина {})", t.len())),
        Ok(None) => {}
        Err(e) => {
            let f = token_file(app).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
            let f = f.trim().to_string();
            return (f.clone(), format!("{w}: ошибка «{e}»; запасной файл: {}", if f.is_empty() { "пусто".to_string() } else { format!("токен есть (длина {})", f.len()) }));
        }
    }
    let f = token_file(app).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let f = f.trim().to_string();
    if !f.is_empty() { return (f.clone(), format!("{w}: пусто; запасной файл: токен есть (длина {})", f.len())); }
    (String::new(), format!("{w}: токена нет"))
}

fn write_token_file(app: &tauri::AppHandle, t: &str) -> Result<(), String> {
    let p = token_file(app).ok_or("нет папки данных")?;
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    if t.is_empty() { let _ = std::fs::remove_file(&p); return Ok(()); }
    std::fs::write(&p, t).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)); }
    Ok(())
}

// сохранить токен (пустой — удалить), как secret:set в Electron-версии. → куда сохранилось (для журнала)
#[tauri::command(async)]
fn token_set(app: tauri::AppHandle, token: String) -> Result<String, String> {
    let t = token.trim();
    if t.len() > 4096 { return Err("слишком длинный токен".into()); }
    let w = secrets::place();
    if t.is_empty() {
        let _ = secrets::set(KEY_USER, "");
        let _ = write_token_file(&app, "");
        return Ok("удалён".into());
    }
    // в хранилище — и сразу проверяем, что читается обратно
    match secrets::set(KEY_USER, t).and_then(|_| secrets::get(KEY_USER)) {
        Ok(Some(back)) if back == t => { let _ = write_token_file(&app, ""); Ok(format!("{w} (длина {})", t.len())) }
        Ok(_) => { write_token_file(&app, t)?; Ok(format!("{w} вернул другое значение — сохранён в запасной файл")) }
        Err(x) => { write_token_file(&app, t)?; Ok(format!("{w}: ошибка «{x}» — сохранён в запасной файл")) }
    }
}

// ссылки на звук Яндекса (и ключ) → адрес pulseya:// (как ys.add в Electron-версии)
#[tauri::command]
fn ya_add(urls: Vec<String>, key: Option<String>, codec: Option<String>) -> Result<String, String> { yastream::add(urls, key, codec) }

// частота и разрядность играющего трека Яндекса (как ya:fmt в Electron-версии)
#[tauri::command]
fn ya_fmt(url: String) -> Option<yastream::Fmt> { yastream::fmt_of(&url) }

// тестовые потоки «Яндекса» для лаборатории
#[tauri::command]
fn lab_streams() -> Vec<serde_json::Value> {
    lab::STREAMS.iter().map(|s| serde_json::json!({ "id": s.id, "name": s.name, "url": format!("pulseya://s/{}", s.id), "plain": s.plain, "encrypted": s.key.is_some(), "chunk": s.chunk, "diag": s.diag })).collect()
}

// журнал запросов плеера к pulseya:// (диагностика)
#[tauri::command]
fn lab_ya_log(id: String) -> Vec<yastream::LogRow> { yastream::log_of(&id) }

// последние треки Яндекса, которые играл «Пульс» (опыт с перемоткой в лаборатории)
#[tauri::command]
fn lab_ya_recent() -> Vec<String> { yastream::recent(3) }

// последние запросы плеера ко всем трекам Яндекса (диагностика перемотки)
#[tauri::command]
fn lab_ya_log_last() -> Vec<yastream::LogRow> { yastream::log_last(150) }

// токен из адреса, на который Яндекс возвращает после входа: «…#access_token=<токен>&token_type=…»
fn token_from_url(u: &str) -> Option<String> {
    let i = u.find("access_token=")? + "access_token=".len();
    let t: String = u[i..].chars().take_while(|c| *c != '&' && *c != '#').collect();
    let ok = (10..=300).contains(&t.len()) && t.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if ok { Some(t) } else { None }
}

// Вход в Яндекс прямо в программе: окно с той же страницей oauth.yandex.ru, что открывалась в браузере (тот же
// client_id). Когда Яндекс возвращает на адрес с access_token, программа сама забирает токен — копировать и вставлять
// ничего не нужно. Окно входа — обычная страница Яндекса, доступа к программе у неё нет; токен сохраняется в
// Связку ключей, окно «Пульса» открывается заново и входит с ним.
#[tauri::command]
async fn ya_login(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("login") { let _ = w.show(); let _ = w.set_focus(); return Ok(()); }
    let url = "https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d".parse::<tauri::Url>().map_err(|e| e.to_string())?;
    let h = app.clone();
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(url))
        .title("Вход в Яндекс Музыку")
        .inner_size(520.0, 760.0)
        .devtools(!RELEASE)
        .on_navigation(move |u| {
            let Some(t) = token_from_url(u.as_str()) else { return true };
            if done.swap(true, Ordering::SeqCst) { return false; }
            let saved = token_set(h.clone(), t).is_ok();
            let h2 = h.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(w) = h2.get_webview_window("login") { let _ = w.close(); }
                if !saved { return; }
                // окно «Пульса» — заново: токен передаётся в окно только при его открытии
                if let Some(m) = h2.get_webview_window("main") { let _ = m.destroy(); }
                let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(300))).await;
                let _ = open_ui(h2.clone()).await;
            });
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_ui(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); return Ok(()); }
    // токен — один раз в окно при открытии (как preload.js в Electron читал его из зашифрованного хранилища);
    // мост (pulse-bridge.js) забирает его и убирает из window
    // перенос из Electron (если ещё не был) — до открытия окна: окно сразу получает перенесённые данные
    { let a = app.clone(); let _ = tauri::async_runtime::spawn_blocking(move || migrate::auto(&a)).await; }
    let mig = migrate::window_script(&app);
    let (t, info) = token_get(&app);
    let tok = serde_json::to_string(&t).unwrap_or_else(|_| "\"\"".into());
    let info = serde_json::to_string(&info).unwrap_or_else(|_| "\"\"".into());
    let (x, y, w, h, max) = win_bounds(&app);
    let b = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .title("Пульс")
        .inner_size(w, h)
        .position(x, y)
        .min_inner_size(1040.0, 680.0)
        .initialization_script(format!("window.__PULSE_TOKEN__ = {tok}; window.__PULSE_TOKEN_INFO__ = {info}; {mig}"))
        // как hardenWindow в Electron-версии (security.js): окно «Пульса» никуда не уходит со своей страницы —
        // случайный переход (перетащенная картинка, ссылка) перезагрузил бы интерфейс. Ссылки наружу — в браузер.
        .on_navigation({ let h = app.clone(); move |u| nav_guard(&h, u) })
        // 0.44.1 инструменты разработчика в выпуске закрыты: правой кнопкой не открыть «Проверить элемент» (там видны код
        // и токен окна). Открываются только после пароля разработчика (dev_devtools — окно открывается заново с ними)
        .devtools(!RELEASE || DEVTOOLS.load(Ordering::SeqCst));
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    // Windows: своя шапка, как в Electron (titleBarStyle hidden + кнопки поверх) — рамку убираем, кнопки рисует мост
    #[cfg(target_os = "windows")]
    let b = b.decorations(false).shadow(true);
    let win = b.build().map_err(|e| e.to_string())?;
    if max { let _ = win.maximize(); }
    // закрытие — запомнить размер и место (как window.json в Electron-версии)
    { let w2 = win.clone(); let a2 = app.clone(); win.on_window_event(move |e| { if matches!(e, tauri::WindowEvent::CloseRequested { .. }) { win_save(&a2, &w2); } }); }
    Ok(())
}

/// Размер и место окна (window.json: x, y, w, h, max — в точках экрана, как у Electron): прошлые — только если окно
/// хотя бы наполовину видно на одном из экранов; иначе — 1440×900 по центру основного экрана. Первый запуск —
/// размер из Electron-версии (её файл только читается).
fn win_bounds(app: &tauri::AppHandle) -> (f64, f64, f64, f64, bool) {
    let read = |p: PathBuf| -> Option<serde_json::Value> { std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()) };
    let st = read(data_dir(app).join("window.json")).or_else(|| migrate::electron_dir().and_then(|d| read(d.join("window.json")))).unwrap_or(serde_json::Value::Null);
    let mons: Vec<(f64, f64, f64, f64)> = app.available_monitors().unwrap_or_default().iter().map(|m| {
        let sf = m.scale_factor(); let p = m.position(); let z = m.size();
        (p.x as f64 / sf, p.y as f64 / sf, z.width as f64 / sf, z.height as f64 / sf)
    }).collect();
    let prim = app.primary_monitor().ok().flatten().map(|m| { let sf = m.scale_factor(); let p = m.position(); let z = m.size(); (p.x as f64 / sf, p.y as f64 / sf, z.width as f64 / sf, z.height as f64 / sf) })
        .or_else(|| mons.first().copied()).unwrap_or((0.0, 0.0, 1440.0, 900.0));
    let (w0, h0) = (1440f64.min(prim.2), 900f64.min(prim.3 - 40.0).max(680.0));
    let def = (prim.0 + (prim.2 - w0) / 2.0, prim.1 + (prim.3 - h0) / 2.0, w0, h0);
    let max = st["max"].as_bool().unwrap_or(false);
    let (Some(x), Some(y), Some(w), Some(h)) = (st["x"].as_f64(), st["y"].as_f64(), st["w"].as_f64(), st["h"].as_f64()) else { return (def.0, def.1, def.2, def.3, max) };
    if w < 200.0 || h < 200.0 { return (def.0, def.1, def.2, def.3, max); }
    let vis = |d: &(f64, f64, f64, f64)| ((x + w).min(d.0 + d.2) - x.max(d.0)).max(0.0) * ((y + h).min(d.1 + d.3) - y.max(d.1)).max(0.0);
    match mons.iter().max_by(|a, b| vis(a).total_cmp(&vis(b))) {
        Some(d) if vis(d) >= w * h * 0.5 && y >= d.1 - 8.0 => {
            let (w, h) = (w.min(d.2), h.min(d.3));
            (x.clamp(d.0, d.0 + d.2 - w), y.clamp(d.1, d.1 + d.3 - h), w, h, max)
        }
        _ => (def.0, def.1, def.2, def.3, max),
    }
}
fn win_save(app: &tauri::AppHandle, w: &tauri::WebviewWindow) {
    let sf = w.scale_factor().unwrap_or(1.0);
    let max = w.is_maximized().unwrap_or(false);
    if w.is_minimized().unwrap_or(false) { return; }
    let (Ok(p), Ok(z)) = (w.outer_position(), w.inner_size()) else { return };
    let d = data_dir(app);
    let _ = std::fs::create_dir_all(&d);
    let mut v = serde_json::json!({ "x": (p.x as f64 / sf).round(), "y": (p.y as f64 / sf).round(), "w": (z.width as f64 / sf).round(), "h": (z.height as f64 / sf).round(), "max": max });
    // развёрнутое окно: прежний обычный размер не теряем
    if max { if let Some(o) = std::fs::read_to_string(d.join("window.json")).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) { for k in ["x", "y", "w", "h"] { v[k] = o[k].clone(); } } }
    let _ = std::fs::write(d.join("window.json"), v.to_string());
}

const EXT_HOSTS: [&str; 6] = ["yandex.ru", "yandex.com", "github.com", "lrclib.net", "oqelon.github.io", "t.me"];
static NAV_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
fn nav_guard(app: &tauri::AppHandle, u: &tauri::Url) -> bool {
    let host = u.host_str().unwrap_or("");
    let own = matches!(u.scheme(), "about" | "data" | "blob")
        || (u.scheme() == "tauri" && host == "localhost")
        || (matches!(u.scheme(), "http" | "https") && host == "tauri.localhost");
    if own { return true; }
    let ext = u.scheme() == "https" && EXT_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}")));
    let short: String = u.as_str().chars().take(160).collect();
    eprintln!("[pulse] переход окна остановлен: {short}{}", if ext { " (открыт в браузере)" } else { "" });
    if let Ok(mut l) = NAV_LOG.lock() { l.push(format!("{} {short}{}", chrono_now(), if ext { " → в браузере" } else { "" })); let n = l.len(); if n > 40 { l.drain(..n - 40); } }
    if ext { use tauri_plugin_opener::OpenerExt; let _ = app.opener().open_url(u.as_str(), None::<&str>); }
    false
}
fn chrono_now() -> String {
    let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{:02}:{:02}:{:02} UTC", (s / 3600) % 24, (s / 60) % 60, s % 60)
}
#[tauri::command] fn lab_nav_log() -> Vec<String> { NAV_LOG.lock().map(|l| l.clone()).unwrap_or_default() }

// ——— этап 5: перенос данных из Electron (migrate.rs) ———
async fn reopen_ui(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(m) = app.get_webview_window("main") { let _ = m.destroy(); }
    let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(300))).await;
    open_ui(app).await
}
#[tauri::command(async)] fn migrate_status(app: tauri::AppHandle) -> serde_json::Value { migrate::status(&app) }
#[tauri::command] fn migrate_applied(app: tauri::AppHandle, stamp: String, before: String, n: u64, bad: Vec<String>) -> Result<(), String> { migrate::applied(&app, stamp, before, n, bad) }
#[tauri::command] fn migrate_restored(app: tauri::AppHandle) -> Result<(), String> { migrate::restored(&app) }
/// «Перенести заново»: новая копия и чтение Electron, окно «Пульса» открывается заново и получает данные
#[tauri::command]
async fn migrate_rerun(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || migrate::prepare(&a)).await.map_err(|e| e.to_string())??;
    if app.get_webview_window("main").is_some() { reopen_ui(app).await?; }
    Ok(r)
}
/// «Вернуть, как было до переноса»
#[tauri::command]
async fn migrate_restore(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let a = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || migrate::restore(&a)).await.map_err(|e| e.to_string())??;
    reopen_ui(app).await?;
    Ok(r)
}
// аккаунт «Пульса» (друзья, чаты, «Искра») — как social:get / social:set в Electron-версии (main.js)
const SOCIAL_URL: &str = "https://pulse-online.pulsmusic.workers.dev";
#[tauri::command(async)]
fn social_get(app: tauri::AppHandle) -> serde_json::Value {
    let mut v = migrate::social_read(&app);
    if !v.is_object() { v = serde_json::json!({}); }
    v["url"] = serde_json::json!(SOCIAL_URL);
    v
}
#[tauri::command]
fn social_set(app: tauri::AppHandle, patch: serde_json::Value) -> Result<bool, String> {
    let mut cur = migrate::social_try_read(&app)?;   // не прочиталось — не пишем: иначе затёрли бы ключ друзей
    if !cur.is_object() { cur = serde_json::json!({}); }
    for k in ["session", "key", "devId", "me", "old"] {
        if let Some(s) = patch.get(k).and_then(|x| x.as_str()) { if s.len() < 200_000 { cur[k] = serde_json::json!(s); } }
    }
    migrate::social_write(&app, &cur).map(|_| true)
}
/// 0.44.1 прежние ключи переписки этого компьютера — «Открыть старые сообщения» в чате
#[tauri::command(async)]
fn social_old(app: tauri::AppHandle) -> serde_json::Value { migrate::social_old(&app) }

// ——— «Своя музыка» (library.rs): библиотека, папки, просмотр, события окну ———
struct LibState { lib: library::Lib, path: PathBuf, cov: PathBuf, scanning: Option<(usize, usize, String)>, busy: bool, again: bool, sig: u64 }
static LIB: std::sync::Mutex<Option<LibState>> = std::sync::Mutex::new(None);
fn lib_emit(app: &tauri::AppHandle, k: &str, v: serde_json::Value) { let _ = tauri::Emitter::emit(app, "pulse-local", serde_json::json!({ "k": k, "v": v })); }
/// файлы и обложки библиотеки → адреса pulsefile://a/<id> и /c/<id>
fn lib_register(l: &library::Lib) {
    let vfs = l.v["vfs"].as_object().cloned().unwrap_or_default();
    for (id, p) in l.v["files"].as_object().into_iter().flatten() {
        let Some(p) = p.as_str() else { continue };
        let src = match vfs.get(p) {
            Some(v) => localfile::Src::Slice { src: PathBuf::from(v["src"].as_str().unwrap_or("")), off: v["off"].as_u64().unwrap_or(0), size: v["size"].as_u64().unwrap_or(0), wav: v["wav"].as_bool().unwrap_or(false), ext: p.rsplit('.').next().unwrap_or("").to_string() },
            None => localfile::Src::File(PathBuf::from(p)),
        };
        localfile::register(id, src);
    }
    for (id, p) in l.v["covers"].as_object().into_iter().flatten() { if let Some(p) = p.as_str() { localfile::register_cover(id, PathBuf::from(p)); } }
}
/// подпись содержимого папок (сколько файлов, их даты и размеры) — пересмотр, только если что-то изменилось
fn lib_sig(roots: &[String]) -> u64 {
    let mut all = vec![]; for r in roots { library::walk(r, &mut all, 0); }
    let mut h: u64 = all.len() as u64;
    for e in &all { h = h.wrapping_mul(1_000_003).wrapping_add(e.s).wrapping_add(e.m as u64).wrapping_add(e.p.len() as u64); }
    h
}
fn lib_start(app: &tauri::AppHandle) {
    let Ok(dd) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dd);
    let path = dd.join("local-library.json"); let cov = dd.join("local-covers");
    // первый запуск: библиотека, перенесённая из Electron (этап 5) — те же номера треков, обложки — из копии
    if !path.exists() {
        if let Ok(t) = std::fs::read_to_string(dd.join("electron-local-library.json")) {
            let mut t = t;
            if let Some(ed) = migrate::electron_dir() {
                let old = ed.join("local-covers").to_string_lossy().to_string();
                if dd.join("electron-local-covers").is_dir() && !cov.exists() { let _ = std::fs::rename(dd.join("electron-local-covers"), &cov); }
                let new = cov.to_string_lossy().to_string();
                // пути внутри JSON экранированы так же (в путях Mac нет символов, которые JSON экранирует)
                t = t.replace(&old, &new);
            }
            let _ = std::fs::write(&path, t);
        }
    }
    let lib = library::Lib::load(&path);
    lib_register(&lib);
    let roots = lib.roots();
    if let Ok(mut g) = LIB.lock() { *g = Some(LibState { lib, path, cov, scanning: None, busy: false, again: false, sig: 0 }); }
    lib_emit(app, "changed", serde_json::json!(0));
    // после запуска — тихо проверяем, не добавилось ли что-то; дальше — раз в минуту по подписи папок
    let h = app.clone();
    std::thread::Builder::new().name("pulse-library".into()).spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        if !roots.is_empty() { lib_scan(&h); }
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            let (roots, sig) = match LIB.lock() { Ok(g) => match g.as_ref() { Some(s) => (s.lib.roots(), s.sig), None => continue }, Err(_) => continue };
            if roots.is_empty() { continue; }
            if lib_sig(&roots) != sig { lib_scan(&h); }
        }
    }).ok();
}
fn lib_scan(app: &tauri::AppHandle) {
    {
        let Ok(mut g) = LIB.lock() else { return }; let Some(s) = g.as_mut() else { return };
        if s.busy { s.again = true; return; }
        s.busy = true; s.scanning = Some((0, 0, String::new()));
    }
    lib_emit(app, "progress", serde_json::json!({ "done": 0, "total": 0, "name": "" }));
    loop {
        // копия данных — просмотр идёт без замка (окно в это время получает прежний список)
        let (mut lib, cov) = { let g = LIB.lock().unwrap(); let s = g.as_ref().unwrap(); (library::Lib { v: s.lib.v.clone() }, s.cov.clone()) };
        let roots = lib.roots();
        let a = app.clone(); let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
        let mut prog = |d: usize, t: usize, n: &str| {
            if let Ok(mut g) = LIB.lock() { if let Some(s) = g.as_mut() { s.scanning = Some((d, t, n.to_string())); } }
            if last.elapsed().as_millis() >= 400 { last = std::time::Instant::now(); lib_emit(&a, "progress", serde_json::json!({ "done": d, "total": t, "name": n })); }
        };
        let thumb = |src: &std::path::Path, dst: &std::path::Path| -> bool {
            #[cfg(target_os = "macos")]
            { std::process::Command::new("/usr/bin/sips").args(["-Z", "400", "-s", "format", "jpeg", "-s", "formatOptions", "86"]).arg(src).arg("--out").arg(dst).output().map(|o| o.status.success() && dst.exists()).unwrap_or(false) }
            #[cfg(not(target_os = "macos"))]
            { let _ = (src, dst); false }
        };
        let log = |m: String| eprintln!("[pulse] {m}");
        let mut cx = library::Ctx { cov_dir: cov, progress: &mut prog, thumb: &thumb, log: &log };
        lib.scan(&mut cx);
        let sig = lib_sig(&roots);
        lib_register(&lib);
        let again = {
            let mut g = LIB.lock().unwrap(); let s = g.as_mut().unwrap();
            // пока шёл просмотр, папки могли поменять (добавили/убрали) — берём новый список папок и смотрим ещё раз
            let changed_roots = s.lib.roots() != roots;
            let (roots_now, hidden) = (s.lib.v["roots"].clone(), s.lib.v["hidden"].clone());
            s.lib.v = lib.v; s.lib.v["roots"] = roots_now; s.lib.v["hidden"] = hidden; s.sig = sig;
            let _ = s.lib.save(&s.path);
            let ag = s.again || changed_roots; s.again = false;
            if !ag { s.busy = false; s.scanning = None; }
            ag
        };
        if !again { break; }
    }
    lib_emit(app, "progress", serde_json::Value::Null);
    lib_emit(app, "changed", serde_json::json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)));
}
fn lib_bg_scan(app: &tauri::AppHandle) { let h = app.clone(); std::thread::spawn(move || lib_scan(&h)); }
#[tauri::command(async)]
fn local_list() -> serde_json::Value {
    match LIB.lock() { Ok(g) => match g.as_ref() { Some(s) => s.lib.list(s.scanning.clone()), None => serde_json::json!({ "roots": [], "tracks": [], "scanning": null, "hidden": 0 }) }, Err(_) => serde_json::json!({ "roots": [], "tracks": [] }) }
}
fn lib_add(app: &tauri::AppHandle, paths: Vec<String>) -> usize {
    let n = { let Ok(mut g) = LIB.lock() else { return 0 }; let Some(s) = g.as_mut() else { return 0 }; let n = s.lib.add_roots(&paths); if n > 0 { let _ = s.lib.save(&s.path); } n };
    if n > 0 { lib_bg_scan(app); }
    n
}
#[tauri::command]
async fn local_pick(app: tauri::AppHandle) -> usize {
    let Some(list) = app.dialog().file().set_title("Папка с музыкой").blocking_pick_folders() else { return 0 };
    let paths: Vec<String> = list.into_iter().filter_map(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string()).collect();
    lib_add(&app, paths)
}
#[tauri::command]
async fn local_pick_files(app: tauri::AppHandle) -> usize {
    let mut ext: Vec<&str> = AUDIO_EXT.to_vec(); ext.push("cue");
    let Some(list) = app.dialog().file().set_title("Файлы с музыкой").add_filter("Музыка", &ext).blocking_pick_files() else { return 0 };
    let paths: Vec<String> = list.into_iter().take(500).filter_map(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string()).collect();
    lib_add(&app, paths)
}
#[tauri::command(async)]
fn local_add(app: tauri::AppHandle, paths: Vec<String>) -> usize { lib_add(&app, paths.into_iter().take(200).collect()) }
#[tauri::command(async)]
fn local_remove(app: tauri::AppHandle, root: String) -> bool {
    let ch = { let Ok(mut g) = LIB.lock() else { return false }; let Some(s) = g.as_mut() else { return false }; let c = s.lib.remove_root(&root); if c { let _ = s.lib.save(&s.path); } c };
    if ch { lib_bg_scan(&app); }
    true
}
#[tauri::command]
fn local_rescan(app: tauri::AppHandle) -> bool { lib_bg_scan(&app); true }
#[tauri::command(async)]
fn local_hide(app: tauri::AppHandle, ids: Vec<String>) -> usize {
    let n = { let Ok(mut g) = LIB.lock() else { return 0 }; let Some(s) = g.as_mut() else { return 0 }; let n = s.lib.hide(&ids); if n > 0 { let _ = s.lib.save(&s.path); } n };
    if n > 0 { lib_emit(&app, "changed", serde_json::json!(1)); }
    n
}
#[tauri::command(async)]
fn local_unhide(app: tauri::AppHandle) -> usize {
    let n = { let Ok(mut g) = LIB.lock() else { return 0 }; let Some(s) = g.as_mut() else { return 0 }; let n = s.lib.v["hidden"].as_array().map(|a| a.len()).unwrap_or(0); s.lib.v["hidden"] = serde_json::json!([]); let _ = s.lib.save(&s.path); n };
    if n > 0 { lib_bg_scan(&app); }
    n
}
#[tauri::command(async)]
fn local_reveal(id: String) -> bool {
    let p = LIB.lock().ok().and_then(|g| g.as_ref().and_then(|s| s.lib.path_of(&id)));
    let Some(p) = p else { return false };
    #[cfg(target_os = "macos")] { let _ = std::process::Command::new("/usr/bin/open").arg("-R").arg(&p).spawn(); }
    #[cfg(target_os = "windows")] { let _ = std::process::Command::new("explorer").arg(format!("/select,{p}")).spawn(); }
    true
}

// ——— DSD (dsd.rs): сведения о файле и «Сохранить как FLAC/WAV» (PCM 24 бит) ———
fn dsd_open(id: &str) -> Result<dsd::Reader, String> {
    let src = localfile::get(id).ok_or("файл больше не в списке")?;
    let o = localfile::Opened::open(&src).map_err(|e| e.to_string())?;
    dsd::Reader::open(Box::new(localfile::Reader::new(o)))
}
#[tauri::command(async)]
fn dsd_info(id: String) -> Result<serde_json::Value, String> {
    let r = dsd_open(&id)?; let i = &r.info;
    Ok(serde_json::json!({ "kind": i.kind, "grade": i.grade(), "fs": i.fs, "channels": i.channels, "duration": i.duration(), "outRate": i.out_rate }))
}
/// APE и WavPack: формат и длительность (лаборатория)
#[tauri::command(async)]
fn pack_info(id: String) -> Result<serde_json::Value, String> {
    let src = localfile::get(&id).ok_or("файл больше не в списке")?;
    let o = localfile::Opened::open(&src).map_err(|e| e.to_string())?;
    let r = apewv::Reader::open(Box::new(localfile::Reader::new(o)))?;
    let i = &r.info;
    Ok(serde_json::json!({ "kind": i.codec, "rate": i.rate, "bits": i.bits, "float": i.float, "channels": i.channels, "duration": i.duration(), "lossy": i.lossy, "level": i.level }))
}
#[tauri::command]
async fn dsd_convert(app: tauri::AppHandle, id: String, fmt: String) -> Result<Option<String>, String> {
    let fmt = if fmt == "wav" { "wav" } else { "flac" };
    let name = match localfile::get(&id) { Some(localfile::Src::File(p)) => p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "DSD".into()), _ => "DSD".into() };
    let Some(fp) = app.dialog().file().set_title(if fmt == "wav" { "Сохранить как WAV (24 бит)" } else { "Сохранить как FLAC (24 бит)" }).set_file_name(format!("{name}.{fmt}")).add_filter(fmt.to_uppercase(), &[fmt]).blocking_save_file() else { return Ok(None) };
    let out = fp.into_path().map_err(|e| e.to_string())?;
    let (a, o2, id2) = (app.clone(), out.clone(), id.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut r = dsd_open(&id2)?;
        let tmp = o2.with_extension(format!("{fmt}.part"));
        let mut f = std::io::BufWriter::new(std::fs::File::create(&tmp).map_err(|e| e.to_string())?);
        let mut last = 0.0f64;
        let mut prog = |p: f64| { if p - last >= 0.01 || p >= 1.0 { last = p; let _ = tauri::Emitter::emit(&a, "pulse-dsd", serde_json::json!({ "id": id2, "p": p.min(1.0) })); } };
        let res = if fmt == "wav" { dsd::to_wav(&mut r, &mut f, &mut prog) } else { dsd::to_flac(&mut r, &mut f, &mut prog) };
        drop(f);
        match res { Ok(_) => std::fs::rename(&tmp, &o2).map_err(|e| e.to_string()), Err(e) => { let _ = std::fs::remove_file(&tmp); Err(e) } }
    }).await.map_err(|e| e.to_string())??;
    Ok(Some(out.display().to_string()))
}

// ——— PULSE Audio Engine: команды окна (см. engine.rs) ———
fn eng() -> Result<&'static engine::Engine, String> { engine::get().ok_or_else(|| "движок не запущен".to_string()) }
#[tauri::command] fn engine_create() -> Result<u32, String> { Ok(eng()?.create()) }
#[tauri::command] fn engine_drop(v: u32) -> Result<(), String> { eng()?.drop_voice(v); Ok(()) }
#[tauri::command] fn engine_open(v: u32, url: String, start: f64) -> Result<(), String> { eng()?.open(v, url, start); Ok(()) }
#[tauri::command] fn engine_play(v: u32) -> Result<(), String> { eng()?.play(v); Ok(()) }
#[tauri::command] fn engine_pause(v: u32) -> Result<(), String> { eng()?.pause(v); Ok(()) }
#[tauri::command] fn engine_seek(v: u32, t: f64) -> Result<(), String> { eng()?.seek(v, t); Ok(()) }
#[tauri::command] fn engine_volume(v: u32, x: f32) -> Result<(), String> { eng()?.volume(v, x); Ok(()) }
#[tauri::command] fn engine_rate(v: u32, r: f32) -> Result<(), String> { eng()?.rate(v, r); Ok(()) }
#[tauri::command] fn engine_state(v: u32) -> Result<Option<engine::VoiceState>, String> { Ok(eng()?.state(v)) }
#[tauri::command] fn engine_eq(on: bool, g: Vec<f32>, pre: f32, lim: bool) -> Result<(), String> { eng()?.set_eq(on, g, pre, lim); Ok(()) }
// 0.44 сигнал для визуализаторов (~30 раз в секунду) — сырыми байтами (f32, little-endian), а не JSON-массивом из 2048
// чисел; и не в главном потоке (там же окно). В интерфейсе — new Float32Array(ответ), см. engineAudio.js tap()
#[tauri::command(async)] fn engine_tap(n: usize) -> Result<tauri::ipc::Response, String> { let v = eng()?.tap(n); let mut b = Vec::with_capacity(v.len() * 4); for x in v { b.extend_from_slice(&x.to_le_bytes()); } Ok(tauri::ipc::Response::new(b)) }
#[tauri::command] fn engine_stats() -> Result<serde_json::Value, String> { Ok(eng()?.stats()) }
#[tauri::command] fn engine_info() -> Result<serde_json::Value, String> { let e = eng()?; Ok(serde_json::json!({ "rate": e.out_rate(), "device": e.device_now(), "want": e.device_want(), "err": e.device_err() })) }
/// 0.44.1 устройства вывода с форматом и занятостью (вкладка «Звук» → «Профессиональный вывод»)
#[tauri::command(async)] fn engine_devices_info() -> Vec<serde_json::Value> { engine::devices_info() }
#[tauri::command(async)] fn engine_devices() -> Vec<String> { engine::devices() }   // перебор устройств вывода бывает долгим — не в главном потоке
#[tauri::command] fn engine_set_device(name: String) -> Result<(), String> { eng()?.set_device(name); Ok(()) }

// ——— обновления по воздуху (updater.rs), тот же формат ответов, что у upd:* в Electron-версии
#[tauri::command]
async fn upd_check(app: tauri::AppHandle) -> serde_json::Value {
    let cur = app.package_info().version.to_string();
    match updater::check(cur.clone()).await { Ok(v) => serde_json::json!({ "ok": true, "v": v }), Err(e) => serde_json::json!({ "ok": false, "error": e, "current": cur }) }
}
fn upd_progress(app: &tauri::AppHandle) -> impl Fn(f64, &str) + Send + Sync + 'static {
    let a = app.clone();
    move |f: f64, label: &str| { let _ = tauri::Emitter::emit(&a, "pulse-upd", serde_json::json!({ "f": f, "label": label })); }
}
#[tauri::command]
async fn upd_prepare(app: tauri::AppHandle) -> serde_json::Value {
    match updater::prepare(app.package_info().version.to_string(), upd_progress(&app)).await { Ok(v) => serde_json::json!({ "ok": true, "v": v }), Err(e) => serde_json::json!({ "ok": false, "error": e }) }
}
#[tauri::command]
async fn upd_install(app: tauri::AppHandle) -> serde_json::Value {
    let p = upd_progress(&app);
    match updater::prepare(app.package_info().version.to_string(), upd_progress(&app)).await {
        Ok(v) => { p(1.0, if v["admin"] == true { "Перезапуск — macOS попросит пароль, чтобы заменить программу" } else { "Перезапускаю" }); serde_json::json!({ "ok": true, "v": v }) }
        Err(e) => serde_json::json!({ "ok": false, "error": e }),
    }
}
#[tauri::command] fn upd_restart(app: tauri::AppHandle) { updater::restart(&app); }
#[tauri::command] fn upd_ready() -> serde_json::Value { updater::ready() }
/// лаборатория: тестовый канал обновлений (адрес тестовой ленты или null — обычный канал)
#[tauri::command] fn upd_test_feed(url: Option<String>) -> Result<serde_json::Value, String> {
    updater::set_test_feed(url)?;
    Ok(serde_json::json!({ "feed": updater::test_feed(), "build": updater::build_no() }))
}

// ——— запись CD и «WAV для CD» (cd.rs): перенос burn.js, cdwav.js, local:piece
fn data_dir(app: &tauri::AppHandle) -> PathBuf { app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("pulse-tauri")) }
#[tauri::command]
async fn cd_piece(file: String, s: f64, e: f64) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || cd::piece(&file, s, e)).await.map_err(|e| e.to_string())?.map(tauri::ipc::Response::new)
}
#[tauri::command] async fn cd_drives() -> serde_json::Value { tauri::async_runtime::spawn_blocking(cd::drives).await.unwrap_or_else(|e| serde_json::json!({ "ok": false, "err": e.to_string() })) }
#[tauri::command(async)] fn cd_begin(n: u32) -> serde_json::Value { cd::begin(n) }
fn raw_body<'a>(r: &'a tauri::ipc::Request<'_>) -> &'a [u8] { match r.body() { tauri::ipc::InvokeBody::Raw(b) => b, _ => &[] } }
fn hdr(r: &tauri::ipc::Request<'_>, k: &str) -> String { r.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string() }
// куски звука для записи — запись на диск не в главном потоке (асинхронная команда с Request обязана возвращать Result)
#[tauri::command]
async fn cd_put(request: tauri::ipc::Request<'_>) -> Result<serde_json::Value, String> {
    Ok(cd::put(&hdr(&request, "x-id"), hdr(&request, "x-i").parse().unwrap_or(0), raw_body(&request), hdr(&request, "x-mode").parse().unwrap_or(0)))
}
#[tauri::command]
async fn cd_burn(app: tauri::AppHandle, id: String, o: serde_json::Value) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || cd::burn(&id, &o, &|v| { let _ = tauri::Emitter::emit(&app, "pulse-cd", v); })).await.unwrap_or_else(|e| serde_json::json!({ "ok": false, "err": e.to_string() }))
}
#[tauri::command] async fn cd_eject(d: String) -> bool { tauri::async_runtime::spawn_blocking(move || cd::eject(&d)).await.unwrap_or(false) }
#[tauri::command] fn cd_cancel() -> bool { cd::cancel() }
fn adhoc(paths: Vec<String>) -> serde_json::Value {
    let (mut ok, mut bad) = (Vec::new(), Vec::new());
    for p in paths.into_iter().take(2000) {
        let v = library::adhoc_one(&p);
        if let Some(f) = v["file"].as_str() { localfile::register(f, localfile::Src::File(PathBuf::from(&p))); ok.push(v); } else { bad.push(v); }
    }
    serde_json::json!({ "ok": ok, "bad": bad })
}
const CDW_EXT: &[&str] = &["flac", "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "ape", "wv", "aiff", "aif", "aifc", "webm", "dsf", "dff"];   // 0.44.1 без WMA: его не разжимает ни движок, ни окно
#[tauri::command]
async fn cdw_pick_files(app: tauri::AppHandle) -> serde_json::Value {
    let Some(list) = app.dialog().file().set_title("Аудиофайлы").add_filter("Аудио", CDW_EXT).blocking_pick_files() else { return serde_json::Value::Null };
    let paths: Vec<String> = list.into_iter().filter_map(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string()).collect();
    tauri::async_runtime::spawn_blocking(move || adhoc(paths)).await.unwrap_or(serde_json::Value::Null)
}
#[tauri::command]
async fn cdw_pick_folder(app: tauri::AppHandle) -> serde_json::Value {
    let Some(d) = app.dialog().file().set_title("Папка с музыкой").blocking_pick_folder().and_then(|f| f.into_path().ok()) else { return serde_json::Value::Null };
    let root = d.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || { let mut v = adhoc(library::folder_audio(&root)); v["folder"] = serde_json::json!(root); v }).await.unwrap_or(serde_json::Value::Null)
}
#[tauri::command]
async fn cdw_add_paths(paths: Vec<String>) -> serde_json::Value { tauri::async_runtime::spawn_blocking(move || adhoc(paths)).await.unwrap_or(serde_json::Value::Null) }
#[tauri::command]
async fn cdw_pick_out(app: tauri::AppHandle, cur: Option<String>) -> Option<String> {
    let mut d = app.dialog().file().set_title("Куда сохранить WAV").set_can_create_directories(true);
    if let Some(c) = cur.filter(|c| !c.is_empty()) { d = d.set_directory(c); }
    let p = d.blocking_pick_folder().and_then(|f| f.into_path().ok())?;
    cd::clean_parts(&p);
    Some(p.to_string_lossy().to_string())
}
#[tauri::command(async)] fn cdw_open(dir: String, name: String, mode: Option<String>) -> serde_json::Value { cd::wav_open(&dir, &name, mode.as_deref().unwrap_or("number")) }
#[tauri::command] async fn cdw_write(request: tauri::ipc::Request<'_>) -> Result<serde_json::Value, String> { Ok(cd::wav_write(&hdr(&request, "x-id"), raw_body(&request))) }
#[tauri::command(async)] fn cdw_finish(id: String, n: u64) -> serde_json::Value { cd::wav_finish(&id, n) }
#[tauri::command] fn cdw_abort(id: String) -> bool { cd::wav_abort(&id) }
#[tauri::command]
fn cdw_reveal(p: String) -> bool {
    let pb = PathBuf::from(&p);
    if !pb.is_absolute() { return false; }
    #[cfg(target_os = "macos")] { let mut c = std::process::Command::new("/usr/bin/open"); if p.to_lowercase().ends_with(".wav") { c.arg("-R"); } let _ = c.arg(&pb).spawn(); }
    #[cfg(target_os = "windows")] { let _ = if p.to_lowercase().ends_with(".wav") { std::process::Command::new("explorer").arg(format!("/select,{p}")).spawn() } else { std::process::Command::new("explorer").arg(&pb).spawn() }; }
    true
}

// ——— Discord, «Сейчас онлайн», режим разработчика, сведения о компьютере (extras.rs)
#[tauri::command] fn discord_enable(v: bool) -> String { extras::discord_enable(v) }
#[tauri::command] fn discord_set(t: serde_json::Value) -> String { extras::discord_set(t) }
#[tauri::command] fn discord_state() -> String { extras::discord_state() }
#[tauri::command] async fn online_get() -> serde_json::Value { extras::online_count().await }
#[tauri::command] async fn dev_unlock(pw: String) -> serde_json::Value { tauri::async_runtime::spawn_blocking(move || extras::dev_unlock(&pw)).await.unwrap_or_else(|_| serde_json::json!({ "ok": false })) }
/// окно «Пульса» с инструментами разработчика (в выпуске — только после пароля разработчика)
static DEVTOOLS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[tauri::command]
async fn dev_devtools(app: tauri::AppHandle, window: tauri::WebviewWindow) -> serde_json::Value {
    if !extras::dev_ok() { return serde_json::json!({ "ok": false }); }
    if !RELEASE || DEVTOOLS.load(Ordering::SeqCst) || window.label() != "main" { window.open_devtools(); return serde_json::json!({ "ok": true }); }
    // выпуск: окно создано без инструментов — открываем его заново уже с ними
    DEVTOOLS.store(true, Ordering::SeqCst);
    let h = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(m) = h.get_webview_window("main") { let _ = m.destroy(); }
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(300))).await;
        if open_ui(h.clone()).await.is_ok() { if let Some(m) = h.get_webview_window("main") { m.open_devtools(); } }
    });
    serde_json::json!({ "ok": true, "reopen": true })
}
#[tauri::command] async fn perf_info(app: tauri::AppHandle) -> serde_json::Value { let d = data_dir(&app); tauri::async_runtime::spawn_blocking(move || extras::perf(&d)).await.unwrap_or(serde_json::Value::Null) }
#[tauri::command] fn perf_slow(app: tauri::AppHandle, v: bool) -> bool { extras::perf_slow(&data_dir(&app), v); true }
#[tauri::command] fn perf_unsafe(app: tauri::AppHandle) -> bool { extras::perf_unsafe(&data_dir(&app)); true }
#[tauri::command] fn perf_relaunch(app: tauri::AppHandle) { app.restart(); }
#[tauri::command] async fn audio_cors(url: String) -> bool { extras::audio_cors(&url).await }
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> serde_json::Value {
    let b = updater::build_no();
    serde_json::json!({ "version": if b > 0 { format!("{} (Tauri, тест №{b})", app.package_info().version) } else { app.package_info().version.to_string() }, "engine": "tauri", "tauri": tauri::VERSION, "electron": "", "packaged": true })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            secrets::init(data_dir(app.handle()));   // до всего, что читает токен и ключи друзей
            if !RELEASE { if let Some(m) = lab_media(app.handle()) { lab::setup(m); } }
            else { let h = app.handle().clone(); tauri::async_runtime::spawn(async move { let _ = open_ui(h).await; }); }
            engine::start(Some(app.handle().clone()));
            // этап 5: перенос данных из Electron-версии — сам при первом запуске (решение владельца)
            let h = app.handle().clone();
            std::thread::Builder::new().name("pulse-migrate".into()).spawn(move || { migrate::auto(&h); lib_start(&h); if RELEASE { migrate::remove_electron(&h); } }).ok();
            // этап 6.3: временные файлы прошлой записи CD, Discord, «Сейчас онлайн», батарея
            cd::cleanup_all();
            extras::discord_start(app.handle().clone(), SOCIAL_URL);
            extras::online_start(data_dir(app.handle()), migrate::electron_dir());
            extras::power_watch(app.handle().clone());
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("pulsetest", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let path = req.uri().path().to_string();
            let range = range_of(&req);
            tauri::async_runtime::spawn_blocking(move || responder.respond(serve_test(&app, &path, range)));
        })
        .register_asynchronous_uri_scheme_protocol("pulsefile", |_ctx, req, responder| {
            let (sec, rest) = resp::split_uri(req.uri());
            let id = rest.split('/').next().unwrap_or("").to_string();
            let range = range_of(&req);
            tauri::async_runtime::spawn_blocking(move || responder.respond(localfile::serve(&sec, &id, range)));
        })
        .register_asynchronous_uri_scheme_protocol("pulseya", |_ctx, req, responder| {
            let (sec, rest) = resp::split_uri(req.uri());
            let id = rest.split('/').next().unwrap_or("").to_string();
            let range = range_of(&req);
            tauri::async_runtime::spawn(async move {
                let r = if sec == "s" { yastream::serve(&id, range).await } else { resp::plain(StatusCode::NOT_FOUND, "нет такого раздела") };
                responder.respond(r);
            });
        })
        .invoke_handler(tauri::generate_handler![pick_files, save_report, env_info, open_ui, ya_fmt, lab_streams, lab_ya_log, lab_ya_log_last, lab_ya_recent, lab_nav_log, local_list, local_pick, local_pick_files, local_add, local_remove, local_rescan, local_hide, local_unhide, local_reveal, dsd_info, pack_info, dsd_convert, migrate_status, migrate_applied, migrate_restored, migrate_rerun, migrate_restore, social_get, social_set, social_old, ya_add, token_set, ya_login, engine_create, engine_drop, engine_open, engine_play, engine_pause, engine_seek, engine_volume, engine_rate, engine_state, engine_eq, engine_tap, engine_info, engine_stats, engine_devices, engine_devices_info, engine_set_device, upd_check, upd_prepare, upd_install, upd_restart, upd_ready, upd_test_feed, cd_piece, cd_drives, cd_begin, cd_put, cd_burn, cd_eject, cd_cancel, cdw_pick_files, cdw_pick_folder, cdw_add_paths, cdw_pick_out, cdw_open, cdw_write, cdw_finish, cdw_abort, cdw_reveal, discord_enable, discord_set, discord_state, online_get, dev_unlock, dev_devtools, perf_info, perf_slow, perf_unsafe, perf_relaunch, audio_cors, app_version])
        .build(tauri::generate_context!())
        .expect("не удалось запустить Пульс (Tauri)")
        .run(|app, ev| match ev {
            tauri::RunEvent::Exit => { cd::on_exit(); updater::on_exit(); }
            // нажали на значок в Dock, а окна нет — открыть «Пульс» (в тестовой сборке окно открывается из лаборатории)
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows: false, .. } if RELEASE => { let h = app.clone(); tauri::async_runtime::spawn(async move { let _ = open_ui(h).await; }); }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn picker_formats_are_indexed() {
        // всё, что можно выбрать в «Добавить файлы», медиатека правда разбирает
        for e in super::AUDIO_EXT { assert!(crate::library::audio_codec(e).is_some(), "{e}: выбрать можно, а в медиатеку не попадёт"); }
    }
    #[test]
    fn token_from_redirect() {
        use super::token_from_url as t;
        assert_eq!(t("https://music.yandex.ru/#access_token=y0_AgAAAAB-xyz_123&token_type=bearer&expires_in=31536000"), Some("y0_AgAAAAB-xyz_123".into()));
        assert_eq!(t("https://music.yandex.ru/#access_token=short"), None);
        assert_eq!(t("https://oauth.yandex.ru/authorize?response_type=token"), None);
        assert_eq!(t("https://x/#access_token=bad<script>alert(1)"), None);
    }
}
