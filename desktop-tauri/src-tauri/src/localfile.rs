// Своя музыка: адреса pulsefile://a/<id> (звук) и pulsefile://c/<id> (обложка) — перенос отдачи из local.js.
// Отдаются только зарегистрированные файлы: по такому адресу нельзя прочитать произвольный файл с диска.
// Здесь только отдача. Разбор папок, теги, CUE, ISO, APE/WavPack, AIFF и куски для записи CD — этап 6.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tauri::http::{Response, StatusCode};

use crate::resp;

/// За один ответ — не больше 4 МБ: плеер сам попросит следующий кусок.
const CHUNK: u64 = 4 * 1024 * 1024;
/// Без Range целиком отдаём только небольшие файлы.
const WHOLE_MAX: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug)]
pub enum Src {
    /// обычный файл
    File(PathBuf),
    /// кусок другого файла (трек внутри ISO; «сырой» звук аудио-CD из BIN — тогда `wav`: спереди заголовок WAV
    /// 44,1 кГц / 16 бит / стерео). `ext` — расширение виртуального файла, по нему выбирается тип.
    Slice { src: PathBuf, off: u64, size: u64, wav: bool, ext: String },
}

fn files() -> &'static Mutex<HashMap<String, Src>> {
    static F: OnceLock<Mutex<HashMap<String, Src>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(HashMap::new()))
}
fn covers() -> &'static Mutex<HashMap<String, PathBuf>> {
    static C: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register(id: &str, s: Src) { if let Ok(mut m) = files().lock() { m.insert(id.to_string(), s); } }
pub fn register_cover(id: &str, p: PathBuf) { if let Ok(mut m) = covers().lock() { m.insert(id.to_string(), p); } }
#[allow(dead_code)]
pub fn forget(id: &str) { if let Ok(mut m) = files().lock() { m.remove(id); } }

pub fn mime_of_ext(ext: &str) -> &'static str {
    match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "m4a" | "m4b" | "mp4" | "alac" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/ogg",
        "webm" | "weba" => "audio/webm",
        "wav" => "audio/wav",
        "aif" | "aiff" | "aifc" => "audio/aiff",
        _ => "application/octet-stream",
    }
}

fn ext_of(p: &std::path::Path) -> String { p.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default() }

// заголовок WAV для «сырого» звука аудио-CD: 44,1 кГц, 16 бит, стерео
pub fn wav_head(n: u64) -> [u8; 44] {
    let n32 = n.min(u32::MAX as u64 - 36) as u32;
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + n32).to_le_bytes());
    h[8..16].copy_from_slice(b"WAVEfmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&2u16.to_le_bytes());
    h[24..28].copy_from_slice(&44100u32.to_le_bytes());
    h[28..32].copy_from_slice(&176400u32.to_le_bytes());
    h[32..34].copy_from_slice(&4u16.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&n32.to_le_bytes());
    h
}

/// Открытый источник: длина и чтение куска с любого места.
struct Opened { len: u64, f: File, off: u64, head: Option<[u8; 44]> }
impl Opened {
    fn open(s: &Src) -> std::io::Result<Opened> {
        match s {
            Src::File(p) => { let f = File::open(p)?; let len = f.metadata()?.len(); Ok(Opened { len, f, off: 0, head: None }) }
            Src::Slice { src, off, size, wav, .. } => {
                let f = File::open(src)?;
                let real = f.metadata()?.len();
                let size = (*size).min(real.saturating_sub(*off));
                let head = if *wav { Some(wav_head(size)) } else { None };
                Ok(Opened { len: size + if *wav { 44 } else { 0 }, f, off: *off, head })
            }
        }
    }
    fn read(&mut self, mut pos: u64, n: u64) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::with_capacity(n as usize);
        let end = (pos + n).min(self.len);
        if let Some(h) = &self.head {
            if pos < 44 { let e = end.min(44); out.extend_from_slice(&h[pos as usize..e as usize]); pos = e; }
        }
        if pos < end {
            let hl = if self.head.is_some() { 44 } else { 0 };
            self.f.seek(SeekFrom::Start(self.off + pos - hl))?;
            let need = (end - pos) as usize;
            let at = out.len();
            out.resize(at + need, 0);
            self.f.read_exact(&mut out[at..])?;
        }
        Ok(out)
    }
}

pub fn serve(section: &str, id: &str, range: Option<String>) -> Response<Vec<u8>> {
    if section == "c" {
        let p = covers().lock().ok().and_then(|m| m.get(id).cloned());
        let Some(p) = p else { return resp::plain(StatusCode::NOT_FOUND, "нет обложки") };
        let ct = match ext_of(&p).to_ascii_lowercase().as_str() { "png" => "image/png", "webp" => "image/webp", "gif" => "image/gif", "bmp" => "image/bmp", _ => "image/jpeg" };
        return match std::fs::read(&p) { Ok(b) => resp::media(ct, b, None, "max-age=86400"), Err(_) => resp::plain(StatusCode::NOT_FOUND, "нет обложки") };
    }
    if section != "a" { return resp::plain(StatusCode::NOT_FOUND, "нет такого раздела"); }
    let s = files().lock().ok().and_then(|m| m.get(id).cloned());
    let Some(s) = s else { return resp::plain(StatusCode::NOT_FOUND, "файл больше не в списке") };
    let ct = match &s { Src::File(p) => mime_of_ext(&ext_of(p)), Src::Slice { wav: true, .. } => "audio/wav", Src::Slice { ext, .. } => mime_of_ext(ext) };
    let mut o = match Opened::open(&s) { Ok(o) => o, Err(e) => return resp::plain(StatusCode::NOT_FOUND, &format!("файл не открывается: {e}")) };
    let len = o.len;
    let (start, end, partial) = match range.as_deref().and_then(resp::parse_want) {
        Some(w) => match resp::resolve(w, len) { Some((a, b)) => (a, b.min(a + CHUNK - 1), true), None => return resp::not_satisfiable(&len.to_string()) },
        None if len > WHOLE_MAX => (0, CHUNK.min(len).saturating_sub(1), true),
        None => (0, len.saturating_sub(1), false),
    };
    let n = if len == 0 { 0 } else { end - start + 1 };
    match o.read(start, n) {
        Ok(b) => resp::media(ct, b, if partial { Some((start, len.to_string())) } else { None }, "no-store"),
        Err(e) => resp::plain(StatusCode::INTERNAL_SERVER_ERROR, &format!("ошибка чтения: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::header;

    fn lab(name: &str) -> PathBuf { format!("{}/../lab-media/{}", env!("CARGO_MANIFEST_DIR"), name).into() }

    #[test]
    fn plain_file_ranges() {
        register("f1", Src::File(lab("mp3-320.mp3")));
        let all = std::fs::read(lab("mp3-320.mp3")).unwrap();
        let r = serve("a", "f1", None);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.body(), &all);
        assert_eq!(r.headers().get(header::CONTENT_TYPE).unwrap(), "audio/mpeg");
        let r = serve("a", "f1", Some("bytes=100-199".into()));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body().as_slice(), &all[100..200]);
        assert_eq!(r.headers().get(header::CONTENT_RANGE).unwrap().to_str().unwrap(), format!("bytes 100-199/{}", all.len()));
        let r = serve("a", "f1", Some("bytes=-16".into()));
        assert_eq!(r.body().as_slice(), &all[all.len() - 16..]);
        let r = serve("a", "f1", Some(format!("bytes={}-", all.len())));
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(serve("a", "nope", None).status(), StatusCode::NOT_FOUND);
        assert_eq!(serve("x", "f1", None).status(), StatusCode::NOT_FOUND);
    }

    // «сырой» звук CD → WAV: заголовок спереди + те же байты
    #[test]
    fn cd_slice_as_wav() {
        let raw = std::fs::read(lab("cd-raw.bin")).unwrap();
        register("cd", Src::Slice { src: lab("cd-raw.bin"), off: 0, size: raw.len() as u64, wav: true, ext: "wav".into() });
        let r = serve("a", "cd", None);
        let b = r.body();
        assert_eq!(b.len(), raw.len() + 44);
        assert_eq!(&b[..4], b"RIFF");
        assert_eq!(&b[44..], raw.as_slice());
        assert_eq!(&b[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes([b[24], b[25], b[26], b[27]]), 44100);
        assert_eq!(u32::from_le_bytes([b[40], b[41], b[42], b[43]]) as usize, raw.len());
        // кусок через границу заголовка
        let whole = b.clone();
        let r = serve("a", "cd", Some("bytes=40-60".into()));
        assert_eq!(r.body().as_slice(), &whole[40..=60]);
        // кусок из середины большого файла со смещением
        register("cd2", Src::Slice { src: lab("cd-raw.bin"), off: 1000, size: 5000, wav: false, ext: "flac".into() });
        let r = serve("a", "cd2", Some("bytes=10-19".into()));
        assert_eq!(r.body().as_slice(), &raw[1010..1020]);
        assert_eq!(r.headers().get(header::CONTENT_TYPE).unwrap(), "audio/flac");
    }

    #[test]
    fn cover() {
        register_cover("k", lab("cover.jpg"));
        let r = serve("c", "k", None);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers().get(header::CONTENT_TYPE).unwrap(), "image/jpeg");
        assert_eq!(serve("c", "zz", None).status(), StatusCode::NOT_FOUND);
    }
}
