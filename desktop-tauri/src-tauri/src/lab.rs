// ТОЛЬКО ДЛЯ ТЕСТОВОЙ СБОРКИ. Перед выпуском этот модуль убирается.
// Маленький «сервер Яндекса» на 127.0.0.1: отдаёт зашифрованные тестовые файлы с поддержкой Range — так весь путь
// pulseya:// (запрос к серверу кусками → расшифровка → плеер WebKit) проверяется на Mac без настоящего Яндекса и без
// токена. Принимает соединения только с этого же компьютера и отдаёт только файлы из папки lab-media.

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};

static PORT: AtomicU16 = AtomicU16::new(0);

/// Ссылка ведёт на наш тестовый сервер? (Только его порт, только 127.0.0.1, только http.)
pub fn local_source(u: &str) -> bool {
    let p = PORT.load(Ordering::Relaxed);
    p != 0 && u.starts_with(&format!("http://127.0.0.1:{p}/"))
}

fn safe(n: &str) -> bool {
    !n.is_empty() && n.len() < 80 && !n.starts_with('.') && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn handle(mut s: TcpStream, dir: PathBuf) -> std::io::Result<()> {
    s.set_read_timeout(Some(std::time::Duration::from_secs(10)))?;
    let mut rd = BufReader::new(s.try_clone()?);
    let mut line = String::new();
    rd.read_line(&mut line)?;
    let path = line.split_whitespace().nth(1).unwrap_or("/").trim_start_matches('/').to_string();
    let mut range = None;
    loop {
        let mut h = String::new();
        if rd.read_line(&mut h)? == 0 || h == "\r\n" || h == "\n" { break; }
        if let Some((k, v)) = h.split_once(':') { if k.trim().eq_ignore_ascii_case("range") { range = Some(v.trim().to_string()); } }
    }
    let fp = dir.join(&path);
    let f = if safe(&path) { std::fs::File::open(&fp).ok() } else { None };
    let Some(mut f) = f else {
        return s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    };
    let len = f.metadata()?.len();
    let (a, b, part) = match range.as_deref().and_then(crate::resp::parse_want) {
        Some(w) => match crate::resp::resolve(w, len) {
            Some((a, b)) => (a, b, true),
            None => return s.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()),
        },
        None => (0, len.saturating_sub(1), false),
    };
    let n = if len == 0 { 0 } else { b - a + 1 };
    let mut buf = vec![0u8; n as usize];
    f.seek(SeekFrom::Start(a))?;
    f.read_exact(&mut buf)?;
    let head = if part {
        format!("HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Length: {n}\r\nContent-Range: bytes {a}-{b}/{len}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n")
    } else {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {n}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n")
    };
    s.write_all(head.as_bytes())?;
    s.write_all(&buf)?;
    s.flush()
}

/// Запустить тестовый сервер для папки `dir` (один раз). Возвращает порт.
pub fn start_server_at(dir: PathBuf) -> u16 {
    let p = PORT.load(Ordering::Relaxed);
    if p != 0 { return p; }
    let l = TcpListener::bind("127.0.0.1:0").expect("тестовый сервер");
    let port = l.local_addr().map(|a| a.port()).unwrap_or(0);
    PORT.store(port, Ordering::Relaxed);
    std::thread::spawn(move || {
        for c in l.incoming().flatten() {
            let d = dir.clone();
            std::thread::spawn(move || { let _ = handle(c, d); });
        }
    });
    port
}

pub struct LabStream { pub id: &'static str, pub name: &'static str, pub file: &'static str, pub key: Option<&'static str>, pub codec: &'static str, pub plain: &'static str, pub bad_first: bool, pub chunk: u64, pub diag: bool }

/// Тестовые «потоки Яндекса»: как приходят от get-file-info (зашифрованный FLAC в MP4) и обычные AAC/MP3.
pub const STREAMS: &[LabStream] = &[
    LabStream { id: "lab-flac16", name: "Яндекс FLAC 16/44 (зашифрован, AES-128)", file: "ya-flac-mp4-16-44.enc", key: Some("00112233445566778899aabbccddeeff"), codec: "flac-mp4", plain: "flac-in-mp4.m4a", bad_first: false, chunk: 256 * 1024, diag: false },
    LabStream { id: "lab-flac24", name: "Яндекс FLAC 24/96 (зашифрован, AES-256)", file: "ya-flac-mp4-24-96.enc", key: Some("0f1e2d3c4b5a69788796a5b4c3d2e1f00102030405060708090a0b0c0d0e0f10"), codec: "flac-mp4", plain: "ya-flac-mp4-24-96.plain.m4a", bad_first: false, chunk: 256 * 1024, diag: false },
    LabStream { id: "lab-aac", name: "Яндекс AAC 256 (без шифрования)", file: "aac-256.m4a", key: None, codec: "aac-mp4", plain: "aac-256.m4a", bad_first: false, chunk: 256 * 1024, diag: false },
    LabStream { id: "lab-mp3", name: "Яндекс MP3 320 (без шифрования)", file: "mp3-320.mp3", key: None, codec: "mp3", plain: "mp3-320.mp3", bad_first: false, chunk: 256 * 1024, diag: false },
    LabStream { id: "lab-retry", name: "Первая ссылка не работает → запасная", file: "ya-flac-mp4-16-44.enc", key: Some("00112233445566778899aabbccddeeff"), codec: "flac-mp4", plain: "flac-in-mp4.m4a", bad_first: true, chunk: 256 * 1024, diag: false },
    // диагностика запуска (этап 3, отчёт 22.11): MP4 с описанием в конце и в начале, куски 256 КБ и 2 МБ (как с настоящим Яндексом)
    LabStream { id: "diag-end-256", name: "24/96, описание в конце, куски 256 КБ", file: "ya-flac-mp4-24-96.enc", key: Some("0f1e2d3c4b5a69788796a5b4c3d2e1f00102030405060708090a0b0c0d0e0f10"), codec: "flac-mp4", plain: "ya-flac-mp4-24-96.plain.m4a", bad_first: false, chunk: 256 * 1024, diag: true },
    LabStream { id: "diag-end-2m", name: "24/96, описание в конце, куски 2 МБ", file: "ya-flac-mp4-24-96.enc", key: Some("0f1e2d3c4b5a69788796a5b4c3d2e1f00102030405060708090a0b0c0d0e0f10"), codec: "flac-mp4", plain: "ya-flac-mp4-24-96.plain.m4a", bad_first: false, chunk: 2 * 1024 * 1024, diag: true },
    LabStream { id: "diag-fast-256", name: "24/96, описание в начале, куски 256 КБ", file: "ya-flac-mp4-24-96-fast.enc", key: Some("0f1e2d3c4b5a69788796a5b4c3d2e1f00102030405060708090a0b0c0d0e0f10"), codec: "flac-mp4", plain: "ya-flac-mp4-24-96-fast.plain.m4a", bad_first: false, chunk: 256 * 1024, diag: true },
    LabStream { id: "diag-fast-2m", name: "24/96, описание в начале, куски 2 МБ", file: "ya-flac-mp4-24-96-fast.enc", key: Some("0f1e2d3c4b5a69788796a5b4c3d2e1f00102030405060708090a0b0c0d0e0f10"), codec: "flac-mp4", plain: "ya-flac-mp4-24-96-fast.plain.m4a", bad_first: false, chunk: 2 * 1024 * 1024, diag: true },
];

/// При запуске: сервер + регистрация тестовых потоков и своих файлов (постоянные адреса — их знает демо-интерфейс).
pub fn setup(media: PathBuf) {
    let port = start_server_at(media.clone());
    for s in STREAMS {
        let mut urls = Vec::new();
        if s.bad_first { urls.push(format!("http://127.0.0.1:{port}/missing-{}", s.file)); }
        urls.push(format!("http://127.0.0.1:{port}/{}", s.file));
        // обычные тестовые — кусками по 256 КБ (файлы маленькие, а проверить нужно много кусков и перемотку)
        let _ = crate::yastream::add_as(s.id.into(), urls, s.key.map(|k| k.to_string()), Some(s.codec.into()), s.chunk);
    }
    use crate::localfile::{register, register_cover, Src};
    let raw = media.join("cd-raw.bin");
    let size = std::fs::metadata(&raw).map(|m| m.len()).unwrap_or(0);
    register("lab-cd", Src::Slice { src: raw, off: 0, size, wav: true, ext: "wav".into() });
    register("lab-aiff", Src::File(media.join("aiff-16-44.aif")));
    register("lab-flac", Src::File(media.join("flac-24-96.flac")));
    register("lab-webm", Src::File(media.join("webm-opus.webm")));
    register("lab-opus-long", Src::File(media.join("opus-long.opus")));
    register_cover("lab-cover", media.join("cover.jpg"));
}
