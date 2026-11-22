// Пульс на Tauri 2 — ТЕСТОВАЯ сборка этапа 2 миграции (проверка совместимости звука на macOS).
//
// Что здесь есть:
//  • окно «Лаборатория звука» (lab.html) — автоматические и ручные проверки воспроизведения;
//  • своя схема pulsetest:// — отдаёт тестовые файлы и выбранные вами файлы по кускам (Range), как в «Пульсе»
//    это делают pulsefile:// и pulseya://. Так проверяется главный риск: играет ли WKWebView звук со своей схемы;
//  • окно «Пульс» — настоящий интерфейс 0.38.0 без изменений, с подставными (демо) данными вместо Яндекса.
//
// Чего здесь нет (сознательно, это следующие этапы): Яндекс, вход, свои папки, Discord, запись CD, обновления.
// Данные этой сборки хранятся отдельно (идентификатор ru.pulse.desktop.tauritest) — установленный «Пульс»
// на Electron, его настройки, лайки и токен она не видит и не трогает.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::http::{header, Response, StatusCode};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

// подставной window.pulse для окна интерфейса (демо-треки играют тестовые файлы через pulsetest://)
const DEMO_BRIDGE: &str = include_str!("../../ui-extra/demo-bridge.js");
// за один ответ — не больше 4 МБ (плеер сам попросит следующий кусок)
const CHUNK: u64 = 4 * 1024 * 1024;
// без Range целиком отдаём только небольшие файлы
const WHOLE_MAX: u64 = 64 * 1024 * 1024;
const AUDIO_EXT: &[&str] = &["flac", "mp3", "m4a", "m4b", "aac", "mp4", "ogg", "oga", "opus", "webm", "weba", "wav", "aif", "aiff", "alac", "caf", "wv", "ape"];

#[derive(Default)]
struct Picked {
    files: Mutex<HashMap<String, PathBuf>>,
    seq: AtomicU64,
}

fn mime_of(p: &str) -> &'static str {
    let ext = p.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "m4a" | "m4b" | "mp4" | "aac" | "alac" => "audio/mp4",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/ogg; codecs=opus",
        "webm" | "weba" => "audio/webm",
        "wav" => "audio/wav",
        "aif" | "aiff" => "audio/aiff",
        "caf" => "audio/x-caf",
        _ => "application/octet-stream",
    }
}

// имя тестового файла: только латиница, цифры, «-», «_», «.»; без путей
fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() < 80 && !s.starts_with('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn plain(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

// «bytes=a-b», «bytes=a-», «bytes=-n» → (начало, конец включительно); None — заголовок непонятный
fn parse_range(v: &str, len: u64) -> Option<(u64, u64)> {
    let r = v.trim().strip_prefix("bytes=")?.split(',').next()?.trim();
    let (a, b) = r.split_once('-')?;
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 || len == 0 { return None; }
        return Some((len.saturating_sub(n), len - 1));
    }
    let start: u64 = a.parse().ok()?;
    let end: u64 = if b.is_empty() { len.saturating_sub(1) } else { b.parse::<u64>().ok()?.min(len.saturating_sub(1)) };
    Some((start, end))
}

fn serve(app: &tauri::AppHandle, path: &str, range: Option<String>) -> Response<Vec<u8>> {
    let file: Option<PathBuf> = if let Some(n) = path.strip_prefix("/test/") {
        if safe_name(n) { app.path().resource_dir().ok().map(|d| d.join("lab-media").join(n)) } else { None }
    } else if let Some(id) = path.strip_prefix("/u/") {
        app.state::<Picked>().files.lock().ok().and_then(|m| m.get(id).cloned())
    } else {
        None
    };
    let Some(fp) = file else { return plain(StatusCode::NOT_FOUND, "нет такого файла") };
    let mut f = match File::open(&fp) { Ok(f) => f, Err(_) => return plain(StatusCode::NOT_FOUND, "файл не открывается") };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let ct = mime_of(&fp.to_string_lossy());

    let (start, end, partial) = match range.as_deref().and_then(|r| parse_range(r, len)) {
        Some((s, e)) => {
            if s >= len || s > e {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(Vec::new())
                    .unwrap();
            }
            (s, e.min(s + CHUNK - 1), true)
        }
        None if len > WHOLE_MAX => (0, CHUNK.min(len) - 1, true),
        None => (0, len.saturating_sub(1), false),
    };
    let n = if len == 0 { 0 } else { end - start + 1 };
    let mut buf = vec![0u8; n as usize];
    if n > 0 && (f.seek(SeekFrom::Start(start)).is_err() || f.read_exact(&mut buf).is_err()) {
        return plain(StatusCode::INTERNAL_SERVER_ERROR, "ошибка чтения");
    }
    let mut b = Response::builder()
        .status(if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::CONTENT_TYPE, ct)
        .header(header::CONTENT_LENGTH, n.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges")
        .header(header::CACHE_CONTROL, "no-store");
    if partial {
        b = b.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    b.body(buf).unwrap()
}

// выбрать свои файлы для проверки: окно получает только номер и имя, путь остаётся в программе
#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Выберите музыку для проверки")
        .add_filter("Музыка", AUDIO_EXT)
        .blocking_pick_files();
    let Some(list) = picked else { return Ok(vec![]) };
    let st = app.state::<Picked>();
    let mut out = Vec::new();
    for fp in list.into_iter().take(50) {
        let Ok(p) = fp.into_path() else { continue };
        let id = st.seq.fetch_add(1, Ordering::Relaxed).to_string();
        let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        if let Ok(mut m) = st.files.lock() { m.insert(id.clone(), p); }
        out.push(serde_json::json!({ "id": id, "name": name, "size": size }));
    }
    Ok(out)
}

// сохранить отчёт проверки туда, куда скажете
#[tauri::command]
async fn save_report(app: tauri::AppHandle, text: String) -> Result<bool, String> {
    if text.len() > 5 * 1024 * 1024 { return Err("отчёт слишком большой".into()); }
    let Some(fp) = app.dialog().file().set_title("Сохранить отчёт").set_file_name("pulse-tauri-audio-report.txt").blocking_save_file() else { return Ok(false) };
    let p = fp.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(true)
}

// сведения о системе для отчёта
#[tauri::command]
fn env_info(app: tauri::AppHandle) -> serde_json::Value {
    let mut os_ver = String::new();
    #[cfg(target_os = "macos")]
    {
        if let Ok(o) = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output() {
            os_ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
        }
    }
    serde_json::json!({
        "os": std::env::consts::OS,
        "osVersion": os_ver,
        "arch": std::env::consts::ARCH,
        "app": app.package_info().version.to_string(),
        "tauri": tauri::VERSION,
    })
}

// открыть настоящий интерфейс «Пульса» (0.38.0) с демо-данными
#[tauri::command]
async fn open_ui(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let b = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .title("Пульс")
        .inner_size(1440.0, 900.0)
        .min_inner_size(1040.0, 680.0)
        .initialization_script(DEMO_BRIDGE);
    // как в Electron-версии: своя шапка, системные кнопки окна поверх интерфейса
    #[cfg(target_os = "macos")]
    let b = b.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    b.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Picked::default())
        .register_asynchronous_uri_scheme_protocol("pulsetest", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let path = req.uri().path().to_string();
            let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()).map(|s| s.to_string());
            std::thread::spawn(move || responder.respond(serve(&app, &path, range)));
        })
        .invoke_handler(tauri::generate_handler![pick_files, save_report, env_info, open_ui])
        .run(tauri::generate_context!())
        .expect("не удалось запустить Пульс (Tauri)");
}
