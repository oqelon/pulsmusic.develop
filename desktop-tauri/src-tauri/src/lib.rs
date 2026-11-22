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

mod lab;
mod localfile;
mod resp;
mod yastream;

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::http::{header, Response, StatusCode};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

// токен Яндекса — в Связке ключей macOS (Windows: диспетчер учётных данных), отдельно от Electron-версии
const KEY_SERVICE: &str = "ru.pulse.desktop.tauritest";
const KEY_USER: &str = "yandex-token";
const CHUNK: u64 = 4 * 1024 * 1024;
const AUDIO_EXT: &[&str] = &["flac", "mp3", "m4a", "m4b", "aac", "mp4", "ogg", "oga", "opus", "webm", "weba", "wav", "aif", "aiff", "alac", "caf", "wv", "ape"];

static PICK_SEQ: AtomicU64 = AtomicU64::new(1);

// имя тестового файла: только латиница, цифры, «-», «_», «.»; без путей
fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() < 80 && !s.starts_with('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn lab_media(app: &tauri::AppHandle) -> Option<PathBuf> { app.path().resource_dir().ok().map(|d| d.join("lab-media")) }

// pulsetest://localhost/test/<имя> — тестовые файлы «Лаборатории» (этап 2)
fn serve_test(app: &tauri::AppHandle, path: &str, range: Option<String>) -> Response<Vec<u8>> {
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

#[tauri::command]
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

/// → (токен, как прочитали — для журнала)
fn token_get(app: &tauri::AppHandle) -> (String, String) {
    match keyring::Entry::new(KEY_SERVICE, KEY_USER).and_then(|e| e.get_password()) {
        Ok(t) if !t.is_empty() => return (t.clone(), format!("Связка ключей: токен есть (длина {})", t.len())),
        Ok(_) | Err(keyring::Error::NoEntry) => {}
        Err(e) => {
            let f = token_file(app).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
            let f = f.trim().to_string();
            return (f.clone(), format!("Связка ключей: ошибка «{e}»; запасной файл: {}", if f.is_empty() { "пусто".to_string() } else { format!("токен есть (длина {})", f.len()) }));
        }
    }
    let f = token_file(app).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    let f = f.trim().to_string();
    if !f.is_empty() { return (f.clone(), format!("Связка ключей: пусто; запасной файл: токен есть (длина {})", f.len())); }
    (String::new(), "Связка ключей: токена нет".into())
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
#[tauri::command]
fn token_set(app: tauri::AppHandle, token: String) -> Result<String, String> {
    let t = token.trim();
    if t.len() > 4096 { return Err("слишком длинный токен".into()); }
    let e = keyring::Entry::new(KEY_SERVICE, KEY_USER).map_err(|e| e.to_string());
    if t.is_empty() {
        if let Ok(e) = &e { let _ = e.delete_credential(); }
        let _ = write_token_file(&app, "");
        return Ok("удалён".into());
    }
    // в Связку ключей — и сразу проверяем, что читается обратно
    let kc = e.and_then(|e| { e.set_password(t).map_err(|x| x.to_string())?; e.get_password().map_err(|x| x.to_string()) });
    match kc {
        Ok(back) if back == t => { let _ = write_token_file(&app, ""); Ok(format!("Связка ключей (длина {})", t.len())) }
        Ok(_) => { write_token_file(&app, t)?; Ok("Связка ключей вернула другое значение — сохранён в запасной файл".into()) }
        Err(x) => { write_token_file(&app, t)?; Ok(format!("Связка ключей: ошибка «{x}» — сохранён в запасной файл")) }
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
    let (t, info) = token_get(&app);
    let tok = serde_json::to_string(&t).unwrap_or_else(|_| "\"\"".into());
    let info = serde_json::to_string(&info).unwrap_or_else(|_| "\"\"".into());
    let b = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .title("Пульс")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1040.0, 680.0)
        .initialization_script(format!("window.__PULSE_TOKEN__ = {tok}; window.__PULSE_TOKEN_INFO__ = {info};"));
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    b.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(m) = lab_media(app.handle()) { lab::setup(m); }
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
        .invoke_handler(tauri::generate_handler![pick_files, save_report, env_info, open_ui, ya_fmt, lab_streams, lab_ya_log, ya_add, token_set, ya_login])
        .run(tauri::generate_context!())
        .expect("не удалось запустить Пульс (Tauri)");
}

#[cfg(test)]
mod tests {
    #[test]
    fn token_from_redirect() {
        use super::token_from_url as t;
        assert_eq!(t("https://music.yandex.ru/#access_token=y0_AgAAAAB-xyz_123&token_type=bearer&expires_in=31536000"), Some("y0_AgAAAAB-xyz_123".into()));
        assert_eq!(t("https://music.yandex.ru/#access_token=short"), None);
        assert_eq!(t("https://oauth.yandex.ru/authorize?response_type=token"), None);
        assert_eq!(t("https://x/#access_token=bad<script>alert(1)"), None);
    }
}
