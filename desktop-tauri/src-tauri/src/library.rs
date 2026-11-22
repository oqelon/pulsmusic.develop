// «Своя музыка» — перенос local.js (Electron) на Rust. Та же логика и тот же формат данных:
//  • музыка никуда не копируется: запоминаем выбранные папки и найденное в них (local-library.json — тот же вид,
//    что у Electron-версии, поэтому её библиотека переносится как есть: те же номера треков «loc:…», лайки и
//    плейлисты со своей музыкой остаются рабочими);
//  • окно получает звук и обложки по адресам pulsefile://a/<id> и pulsefile://c/<id> (localfile.rs) — отдаются
//    только найденные в выбранных папках файлы;
//  • теги читаем сами, как local.js: FLAC (STREAMINFO, Vorbis-комментарии, картинка, встроенный CUE), MP3 (ID3v2
//    2.2–2.4, ID3v1, длительность по Xing/VBRI/битрейту; «латиница» в русских файлах — это Windows-1251), Ogg
//    (Vorbis, Opus), M4A (AAC, ALAC), WAV, AIFF, APE/WavPack (заголовки и APEv2), DSD (DSF/DFF);
//  • CUE (UTF-8 / Windows-1251 / UTF-16), альбомы одним файлом, образы ISO 9660/Joliet и BIN/IMG+CUE;
//  • обложка: из файла (лицевая) или из папки (cover/folder/front…, подпапки Scans/Covers, папка выше для CD1/CD2).
//
// Модуль без зависимостей от Tauri (проверяется отдельно); команды окна — в lib.rs.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

pub const PV: u64 = 4;
const MAX_FILES: usize = 60000;
const MAX_DEPTH: usize = 14;
pub const VSEP: &str = "::";

pub fn audio_codec(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "flac" => "FLAC", "mp3" => "MP3", "m4a" | "m4b" | "aac" => "AAC", "ogg" | "oga" => "OGG", "opus" => "OPUS", "wav" => "WAV",
        "webm" | "weba" => "WEBM", "ape" => "APE", "wv" => "WavPack", "aif" | "aiff" | "aifc" => "AIFF", "dsf" => "DSF", "dff" => "DFF",
        _ => return None,
    })
}
fn is_img(name: &str) -> bool { let l = name.to_lowercase(); [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"].iter().any(|e| l.ends_with(e)) }
fn ext_of(p: &str) -> String { let b = p.rsplit(['/', '\\']).next().unwrap_or(p); match b.rfind('.') { Some(i) if i > 0 => b[i + 1..].to_lowercase(), _ => String::new() } }
fn base(p: &str) -> &str { p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(p) }
fn dirname(p: &str) -> String { let t = p.trim_end_matches(['/', '\\']); match t.rfind(['/', '\\']) { Some(0) => "/".into(), Some(i) => t[..i].to_string(), None => ".".into() } }
fn stem(p: &str) -> String { let b = base(p); match b.rfind('.') { Some(i) if i > 0 => b[..i].to_string(), _ => b.to_string() } }
fn join(d: &str, n: &str) -> String { if d.ends_with('/') { format!("{d}{n}") } else { format!("{d}/{n}") } }

// ——— SHA-1 (номера файлов те же, что у Electron: sha1(путь в нижнем регистре)[..16]) ———
pub fn sha1_hex(data: &[u8]) -> String {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let ml = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec(); msg.push(0x80); while msg.len() % 64 != 56 { msg.push(0); } msg.extend_from_slice(&ml.to_be_bytes());
    for ch in msg.chunks(64) {
        let mut w = [0u32; 80];
        for i in 0..16 { w[i] = u32::from_be_bytes([ch[i * 4], ch[i * 4 + 1], ch[i * 4 + 2], ch[i * 4 + 3]]); }
        for i in 16..80 { w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1); }
        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, &wi) in w.iter().enumerate() {
            let (f, k) = match i { 0..=19 => ((b & c) | (!b & d), 0x5A827999), 20..=39 => (b ^ c ^ d, 0x6ED9EBA1), 40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC), _ => (b ^ c ^ d, 0xCA62C1D6u32) };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(wi);
            e = d; d = c; c = b.rotate_left(30); b = a; a = t;
        }
        h[0] = h[0].wrapping_add(a); h[1] = h[1].wrapping_add(b); h[2] = h[2].wrapping_add(c); h[3] = h[3].wrapping_add(d); h[4] = h[4].wrapping_add(e);
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}
pub fn fid(p: &str) -> String { sha1_hex(p.to_lowercase().as_bytes())[..16].to_string() }

// ——— текст ———
const CP1251: [u16; 128] = [0x402,0x403,0x201A,0x453,0x201E,0x2026,0x2020,0x2021,0x20AC,0x2030,0x409,0x2039,0x40A,0x40C,0x40B,0x40F,0x452,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,0xFFFD,0x2122,0x459,0x203A,0x45A,0x45C,0x45B,0x45F,0xA0,0x40E,0x45E,0x408,0xA4,0x490,0xA6,0xA7,0x401,0xA9,0x404,0xAB,0xAC,0xAD,0xAE,0x407,0xB0,0xB1,0x406,0x456,0x491,0xB5,0xB6,0xB7,0x451,0x2116,0x454,0xBB,0x458,0x405,0x455,0x457,0x410,0x411,0x412,0x413,0x414,0x415,0x416,0x417,0x418,0x419,0x41A,0x41B,0x41C,0x41D,0x41E,0x41F,0x420,0x421,0x422,0x423,0x424,0x425,0x426,0x427,0x428,0x429,0x42A,0x42B,0x42C,0x42D,0x42E,0x42F,0x430,0x431,0x432,0x433,0x434,0x435,0x436,0x437,0x438,0x439,0x43A,0x43B,0x43C,0x43D,0x43E,0x43F,0x440,0x441,0x442,0x443,0x444,0x445,0x446,0x447,0x448,0x449,0x44A,0x44B,0x44C,0x44D,0x44E,0x44F];
pub fn cp1251(b: &[u8]) -> String { b.iter().map(|&c| if c < 0x80 { c as char } else { char::from_u32(CP1251[(c - 0x80) as usize] as u32).unwrap_or('\u{FFFD}') }).collect() }
fn utf16(b: &[u8], le: bool) -> String { let u: Vec<u16> = b.chunks_exact(2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect(); String::from_utf16_lossy(&u) }
pub fn text_auto(b: &[u8]) -> String {
    if b.starts_with(&[0xef, 0xbb, 0xbf]) { return String::from_utf8_lossy(&b[3..]).into(); }
    if b.starts_with(&[0xff, 0xfe]) { return utf16(&b[2..], true); }
    match std::str::from_utf8(b) { Ok(s) => s.to_string(), Err(_) => cp1251(b) }
}
fn clean(s: &str) -> String { s.trim_end_matches('\0').chars().map(|c| if (c as u32) < 0x20 { ' ' } else { c }).collect::<String>().trim().to_string() }
fn first0(s: String) -> String { s.split('\0').next().unwrap_or("").to_string() }

// ——— чтение ———
pub trait Rs: Read + Seek {}
impl<T: Read + Seek> Rs for T {}
fn read_at(r: &mut dyn Rs, pos: u64, len: usize) -> Vec<u8> {
    let mut b = vec![0u8; len];
    if r.seek(SeekFrom::Start(pos)).is_err() { return vec![]; }
    let mut got = 0; while got < len { match r.read(&mut b[got..]) { Ok(0) | Err(_) => break, Ok(n) => got += n } }
    b.truncate(got); b
}
fn u32be(b: &[u8], o: usize) -> u32 { b.get(o..o + 4).map(|x| u32::from_be_bytes(x.try_into().unwrap())).unwrap_or(0) }
fn u32le(b: &[u8], o: usize) -> u32 { b.get(o..o + 4).map(|x| u32::from_le_bytes(x.try_into().unwrap())).unwrap_or(0) }
fn u16be(b: &[u8], o: usize) -> u16 { b.get(o..o + 2).map(|x| u16::from_be_bytes(x.try_into().unwrap())).unwrap_or(0) }
fn u16le(b: &[u8], o: usize) -> u16 { b.get(o..o + 2).map(|x| u16::from_le_bytes(x.try_into().unwrap())).unwrap_or(0) }
fn latin(b: &[u8]) -> String { b.iter().map(|&c| c as char).collect() }

#[derive(Default, Debug, Clone)]
pub struct Pic { pub ty: u32, pub mime: String, pub data: Vec<u8> }
#[derive(Default, Debug)]
pub struct Meta { pub codec: String, pub sr: u32, pub ch: u32, pub bits: u32, pub dur: f64, pub kbps: u32, pub vbr: bool, pub tags: BTreeMap<String, String>, pub pic: Option<Pic> }

fn emb_rank(t: u32) -> f64 { match t { 3 => 0.0, 0 => 0.5, 4 | 5 | 6 => 7.0, 1 | 2 => 8.0, _ => 2.5 } }
fn better(cur: &Option<Pic>, t: u32) -> bool { cur.as_ref().map(|c| emb_rank(t) < emb_rank(c.ty)).unwrap_or(true) }
fn img_ext(d: &[u8]) -> &'static str {
    if d.len() < 12 { return ""; }
    if d[0] == 0xff && d[1] == 0xd8 { ".jpg" } else if d[0] == 0x89 && &d[1..4] == b"PNG" { ".png" } else if &d[0..4] == b"RIFF" && &d[8..12] == b"WEBP" { ".webp" } else if &d[0..3] == b"GIF" { ".gif" } else if d[0] == 0x42 && d[1] == 0x4d { ".bmp" } else { "" }
}
fn find_img(b: &[u8], from: usize) -> Option<usize> { (from..b.len().saturating_sub(4).min(from + 4096)).find(|&i| (b[i] == 0xff && b[i + 1] == 0xd8 && b[i + 2] == 0xff) || (b[i] == 0x89 && b[i + 1] == 0x50 && b[i + 2] == 0x4e)) }
fn pic_block(b: &[u8]) -> Option<Pic> {
    let mut o = 0; let ty = u32be(b, o); o += 4; let ml = u32be(b, o) as usize; o += 4; let mime = latin(b.get(o..o + ml)?); o += ml;
    let dl = u32be(b, o) as usize; o += 4 + dl + 16; let n = u32be(b, o) as usize; o += 4;
    if n > 100 && o + n <= b.len() { Some(Pic { ty, mime, data: b[o..o + n].to_vec() }) } else { None }
}
fn b64(s: &str) -> Vec<u8> {
    let mut out = Vec::new(); let mut acc = 0u32; let mut n = 0;
    for c in s.bytes() { let v = match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' | b'-' => 62, b'/' | b'_' => 63, _ => continue }; acc = (acc << 6) | v as u32; n += 6; if n >= 8 { n -= 8; out.push((acc >> n) as u8); } }
    out
}
fn vorbis_comments(b: &[u8], mut o: usize, m: &mut Meta) {
    let vl = u32le(b, o) as usize; o += 4 + vl; let n = u32le(b, o); o += 4;
    for _ in 0..n {
        if o + 4 > b.len() { break; }
        let l = u32le(b, o) as usize; o += 4; let Some(item) = b.get(o..o + l) else { break }; o += l;
        let Some(e) = item.iter().position(|&c| c == b'=') else { continue };
        let key = latin(&item[..e]).to_uppercase();
        if key == "METADATA_BLOCK_PICTURE" || key == "COVERART" {
            let raw = b64(&latin(&item[e + 1..]));
            let pic = if key == "COVERART" { Some(Pic { ty: 3, mime: "image/jpeg".into(), data: raw }) } else { pic_block(&raw) };
            if let Some(p) = pic { if p.data.len() > 100 && better(&m.pic, p.ty) { m.pic = Some(p); } }
        } else if !m.tags.contains_key(&key) { m.tags.insert(key, String::from_utf8_lossy(&item[e + 1..]).to_string()); }
    }
}
fn syncsafe(b: &[u8], o: usize) -> usize { b.get(o..o + 4).map(|x| ((x[0] as usize & 0x7f) << 21) | ((x[1] as usize & 0x7f) << 14) | ((x[2] as usize & 0x7f) << 7) | (x[3] as usize & 0x7f)).unwrap_or(0) }

fn flac_meta(r: &mut dyn Rs, size: u64) -> Option<Meta> {
    let mut pos = 0u64; let h = read_at(r, 0, 10);
    if h.starts_with(b"ID3") { pos = 10 + syncsafe(&h, 6) as u64; }
    if read_at(r, pos, 4) != b"fLaC" { return None; }
    pos += 4; let mut m = Meta { codec: "FLAC".into(), ..Default::default() }; let mut last = false; let mut guard = 0;
    while !last && guard < 64 && pos < size {
        guard += 1;
        let bh = read_at(r, pos, 4); if bh.len() < 4 { break; }
        last = bh[0] & 0x80 != 0; let ty = bh[0] & 0x7f; let len = ((bh[1] as usize) << 16) | ((bh[2] as usize) << 8) | bh[3] as usize; pos += 4;
        if ty == 0 && len >= 18 {
            let b = read_at(r, pos, 18);
            if b.len() == 18 {
                m.sr = ((b[10] as u32) << 12) | ((b[11] as u32) << 4) | (b[12] as u32 >> 4); m.ch = ((b[12] as u32 >> 1) & 7) + 1; m.bits = (((b[12] as u32 & 1) << 4) | (b[13] as u32 >> 4)) + 1;
                let total = (b[13] as u64 & 0x0f) * 4294967296 + u32be(&b, 14) as u64; if m.sr > 0 { m.dur = total as f64 / m.sr as f64; }
            }
        } else if ty == 4 && len < 32 << 20 { let b = read_at(r, pos, len); vorbis_comments(&b, 0, &mut m); }
        else if ty == 6 && len < 32 << 20 && !m.pic.as_ref().map(|p| p.ty == 3).unwrap_or(false) { if let Some(p) = pic_block(&read_at(r, pos, len)) { if better(&m.pic, p.ty) { m.pic = Some(p); } } }
        pos += len as u64;
    }
    if m.dur > 0.0 { m.kbps = ((size * 8) as f64 / m.dur / 1000.0).round() as u32; }
    Some(m)
}

fn id3_text(b: &[u8], enc: u8) -> String {
    let s = match enc {
        1 => { let le = !(b.len() >= 2 && b[0] == 0xfe && b[1] == 0xff); let body = if b.len() >= 2 && (b[0] == 0xff || b[0] == 0xfe) { &b[2..] } else { b }; utf16(body, le) }
        2 => utf16(b, false),
        3 => String::from_utf8_lossy(b).to_string(),
        _ => cp1251(b), // «латиница» по стандарту, но русские файлы почти всегда в Windows-1251
    };
    clean(&first0(s))
}
fn de_unsync(b: &[u8]) -> Vec<u8> { let mut o = Vec::with_capacity(b.len()); let mut i = 0; while i < b.len() { o.push(b[i]); if b[i] == 0xff && b.get(i + 1) == Some(&0) { i += 1; } i += 1; } o }
fn id3_map(id: &str) -> Option<&'static str> {
    Some(match id { "TIT2" | "TT2" => "TITLE", "TPE1" | "TP1" => "ARTIST", "TPE2" | "TP2" => "ALBUMARTIST", "TALB" | "TAL" => "ALBUM", "TRCK" | "TRK" => "TRACKNUMBER", "TPOS" | "TPA" => "DISCNUMBER", "TYER" | "TYE" | "TDRC" => "DATE", "TCON" | "TCO" => "GENRE", _ => return None })
}
/// ID3v2 в начале: теги и картинка; → размер тега (с заголовком)
fn id3v2(r: &mut dyn Rs, at: u64, m: &mut Meta) -> u64 {
    let h = read_at(r, at, 10);
    if !h.starts_with(b"ID3") || h.len() < 10 { return 0; }
    let ver = h[3]; let tsize = syncsafe(&h, 6); let start = 10 + tsize as u64 + if h[5] & 0x10 != 0 { 10 } else { 0 };
    let mut b = read_at(r, at + 10, tsize.min(32 << 20)); let mut o = 0usize;
    let unsync_all = h[5] & 0x80 != 0;
    if unsync_all && ver < 4 { b = de_unsync(&b); }
    if h[5] & 0x40 != 0 && ver >= 3 { o += if ver == 4 { syncsafe(&b, 0) } else { u32be(&b, 0) as usize + 4 }; }
    let small = ver == 2;
    while o + if small { 6 } else { 10 } < b.len() {
        let id = latin(&b[o..o + if small { 3 } else { 4 }]);
        if !id.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) { break; }
        let len = if small { ((b[o + 3] as usize) << 16) | ((b[o + 4] as usize) << 8) | b[o + 5] as usize } else if ver == 4 { syncsafe(&b, o + 4) } else { u32be(&b, o + 4) as usize };
        let fl = if small { 0 } else { b[o + 9] };
        o += if small { 6 } else { 10 }; if len == 0 || o + len > b.len() { break; }
        let mut f: Vec<u8> = b[o..o + len].to_vec(); o += len;
        if ver == 4 { if fl & 0x04 != 0 || fl & 0x08 != 0 { continue; } if fl & 0x40 != 0 { f.remove(0); } if fl & 0x01 != 0 && f.len() >= 4 { f.drain(..4); } if fl & 0x02 != 0 || unsync_all { f = de_unsync(&f); } }
        else if ver == 3 { if fl & 0x40 != 0 || fl & 0x80 != 0 { continue; } if fl & 0x20 != 0 && !f.is_empty() { f.remove(0); } }
        if f.is_empty() { continue; }
        if let Some(k) = id3_map(&id) { let v = id3_text(&f[1..], f[0]); if !v.is_empty() && !m.tags.contains_key(k) { m.tags.insert(k.into(), v); } }
        else if (id == "APIC" || id == "PIC") && !m.pic.as_ref().map(|p| p.ty == 3).unwrap_or(false) {
            let enc = f[0]; let mut p; let mime;
            if id == "PIC" { mime = format!("image/{}", latin(&f[1..4.min(f.len())]).to_lowercase().replace("jpg", "jpeg")); p = 4; }
            else { let z = f[1..].iter().position(|&c| c == 0).map(|x| x + 1).unwrap_or(1); mime = latin(&f[1..z]); p = z + 1; }
            if p >= f.len() { continue; }
            let ty = f[p] as u32; p += 1;
            if enc == 1 || enc == 2 { while p + 1 < f.len() && (f[p] != 0 || f[p + 1] != 0) { p += 2; } p += 2; } else { p = f[p.min(f.len())..].iter().position(|&c| c == 0).map(|x| p + x + 1).unwrap_or(p); }
            let mut data = f.get(p..).unwrap_or(&[]).to_vec();
            if img_ext(&data).is_empty() { if let Some(at) = find_img(&f, 1) { data = f[at..].to_vec(); } }
            if data.len() > 100 && better(&m.pic, ty) { m.pic = Some(Pic { ty, mime: if mime.is_empty() { "image/jpeg".into() } else { mime }, data }); }
        }
    }
    start
}
fn mp3_meta(r: &mut dyn Rs, size: u64) -> Meta {
    let mut m = Meta { codec: "MP3".into(), ..Default::default() };
    let start = id3v2(r, 0, &mut m);
    if !m.tags.contains_key("TITLE") && size > 128 {
        let t = read_at(r, size - 128, 128);
        if t.starts_with(b"TAG") && t.len() == 128 {
            let g = |a: usize, b2: usize| clean(&cp1251(&t[a..b2]));
            m.tags.insert("TITLE".into(), g(3, 33)); m.tags.entry("ARTIST".into()).or_insert(g(33, 63)); m.tags.entry("ALBUM".into()).or_insert(g(63, 93)); m.tags.entry("DATE".into()).or_insert(g(93, 97));
            if t[125] == 0 && t[126] != 0 { m.tags.insert("TRACKNUMBER".into(), t[126].to_string()); }
        }
    }
    let b = read_at(r, start, 64 * 1024);
    let mut i = 0;
    while i + 4 < b.len() {
        if b[i] != 0xff || b[i + 1] & 0xe0 != 0xe0 { i += 1; continue; }
        let v = (b[i + 1] >> 3) & 3; let layer = (b[i + 1] >> 1) & 3; let bi = (b[i + 2] >> 4) as usize; let si = ((b[i + 2] >> 2) & 3) as usize; let mono = (b[i + 3] >> 6) == 3;
        if v == 1 || layer != 1 || bi == 0 || bi == 15 || si == 3 { i += 1; continue; }
        let v1 = v == 3; let srs = if v1 { [44100, 48000, 32000] } else if v == 2 { [22050, 24000, 16000] } else { [11025, 12000, 8000] };
        let brs: [u32; 15] = if v1 { [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] } else { [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
        m.sr = srs[si]; let spf = if v1 { 1152.0 } else { 576.0 }; m.ch = if mono { 1 } else { 2 };
        let xo = i + 4 + if v1 { if mono { 17 } else { 32 } } else if mono { 9 } else { 17 };
        let tag = b.get(xo..xo + 4).map(latin).unwrap_or_default();
        if (tag == "Xing" || tag == "Info") && b.get(xo + 7).map(|x| x & 1 != 0).unwrap_or(false) { let frames = u32be(&b, xo + 8) as f64; m.dur = frames * spf / m.sr as f64; m.vbr = tag == "Xing"; }
        else if b.get(i + 36..i + 40) == Some(b"VBRI") { let frames = u32be(&b, i + 36 + 14) as f64; m.dur = frames * spf / m.sr as f64; m.vbr = true; }
        else { m.kbps = brs[bi]; m.dur = ((size - start - i as u64) * 8) as f64 / (brs[bi] as f64 * 1000.0); }
        break;
    }
    if m.dur > 0.0 && m.kbps == 0 { m.kbps = (((size - start) * 8) as f64 / m.dur / 1000.0).round() as u32; }
    m
}

fn ogg_meta(r: &mut dyn Rs, size: u64, opus_ext: bool) -> Meta {
    let mut m = Meta { codec: if opus_ext { "OPUS" } else { "OGG" }.into(), ..Default::default() };
    let (mut pos, mut pkt, mut pkts): (u64, Vec<u8>, Vec<Vec<u8>>) = (0, vec![], vec![]);
    let (mut rate, mut pre, mut opus) = (0u32, 0u32, false);
    let limit = size.min(40 << 20);
    while pos < limit && pkts.len() < 3 {
        let h = read_at(r, pos, 27 + 255); if h.len() < 27 || &h[0..4] != b"OggS" { break; }
        let ns = h[26] as usize; if h.len() < 27 + ns { break; }
        let seg = h[27..27 + ns].to_vec(); let dpos = pos + 27 + ns as u64; let total: usize = seg.iter().map(|&x| x as usize).sum();
        let data = read_at(r, dpos, total); let mut o = 0;
        for &s in &seg { pkt.extend_from_slice(data.get(o..o + s as usize).unwrap_or(&[])); o += s as usize; if s < 255 { pkts.push(std::mem::take(&mut pkt)); if pkts.len() >= 3 { break; } } }
        pos = dpos + total as u64;
    }
    for p in &pkts {
        if p.starts_with(b"OpusHead") { opus = true; m.codec = "OPUS".into(); m.ch = p.get(9).copied().unwrap_or(2) as u32; pre = u16le(p, 10) as u32; rate = 48000; m.sr = u32le(p, 12).max(1).min(384000); if m.sr == 1 { m.sr = 48000; } }
        else if p.first() == Some(&1) && p.get(1..7) == Some(b"vorbis") { m.ch = p.get(11).copied().unwrap_or(2) as u32; rate = u32le(p, 12); m.sr = rate; m.codec = "OGG".into(); }
        else if p.starts_with(b"OpusTags") { vorbis_comments(p, 8, &mut m); }
        else if p.first() == Some(&3) && p.get(1..7) == Some(b"vorbis") { vorbis_comments(p, 7, &mut m); }
    }
    if rate > 0 {
        let n = size.min(65536); let tail = read_at(r, size - n, n as usize);
        if let Some(at) = tail.windows(4).rposition(|w| w == b"OggS") { if at + 14 <= tail.len() { let g = u64::from_le_bytes(tail[at + 6..at + 14].try_into().unwrap()); if g > 0 && g < u64::MAX / 2 { m.dur = g.saturating_sub(if opus { pre as u64 } else { 0 }) as f64 / rate as f64; } } }
    }
    if m.dur > 0.0 { m.kbps = ((size * 8) as f64 / m.dur / 1000.0).round() as u32; }
    m
}

fn mp4_meta(r: &mut dyn Rs, size: u64) -> Meta {
    let mut m = Meta { codec: "AAC".into(), ..Default::default() };
    let mut pos = 0u64; let mut moov: Option<Vec<u8>> = None;
    while pos + 8 <= size {
        let h = read_at(r, pos, 16); if h.len() < 8 { break; }
        let mut len = u32be(&h, 0) as u64; let ty = &h[4..8]; let mut hl = 8;
        if len == 1 { len = u64::from_be_bytes(h[8..16].try_into().unwrap_or([0; 8])); hl = 16; } else if len == 0 { len = size - pos; }
        if len < 8 { break; }
        if ty == b"moov" { if len > 64 << 20 { break; } moov = Some(read_at(r, pos + hl, (len - hl) as usize)); break; }
        pos += len;
    }
    let Some(mv) = moov else { return m };
    fn kids(b: &[u8], from: usize, to: usize, cb: &mut dyn FnMut(&[u8], usize, usize)) {
        let mut o = from;
        while o + 8 <= to {
            let mut l = u32be(b, o) as usize; let t = &b[o + 4..o + 8]; let mut hl = 8;
            if l == 1 { l = u64::from_be_bytes(b[o + 8..o + 16].try_into().unwrap_or([0; 8])) as usize; hl = 16; } else if l == 0 { l = to - o; }
            if l < 8 || o + l > to { break; }
            cb(t, o + hl, o + l); o += l;
        }
    }
    fn walk(mv: &[u8], from: usize, to: usize, m: &mut Meta) {
        kids(mv, from, to, &mut |t, a, z| {
            match t {
                b"mvhd" => { let v = mv[a]; let (ts, d) = if v == 1 { (u32be(mv, a + 20), u64::from_be_bytes(mv[a + 24..a + 32].try_into().unwrap_or([0; 8])) as f64) } else { (u32be(mv, a + 12), u32be(mv, a + 16) as f64) }; if ts > 0 { m.dur = d / ts as f64; } }
                b"trak" | b"mdia" | b"minf" | b"stbl" | b"udta" | b"ilst" => walk(mv, a, z, m),
                b"meta" => walk(mv, a + 4, z, m),
                b"stsd" => { let ent = mv.get(a + 12..a + 16).unwrap_or(&[]); if ent == b"alac" { m.codec = "ALAC".into(); } m.ch = u16be(mv, a + 32) as u32; m.bits = if ent == b"alac" { u16be(mv, a + 34) as u32 } else { 0 }; m.sr = u16be(mv, a + 40) as u32; }
                _ => {
                    let key = match t { b"\xa9nam" => Some("TITLE"), b"\xa9ART" => Some("ARTIST"), b"aART" => Some("ALBUMARTIST"), b"\xa9alb" => Some("ALBUM"), b"\xa9day" => Some("DATE"), b"\xa9gen" => Some("GENRE"), b"\xa9cmt" => Some("COMMENT"), _ => None };
                    if key.is_some() || t == b"trkn" || t == b"disk" || t == b"covr" || t == b"gnre" {
                        let t2 = t.to_vec();
                        kids(mv, a, z, &mut |dt, da, dz| {
                            if dt != b"data" { return; }
                            let kind = u32be(mv, da) & 0xffffff; let v = &mv[(da + 8).min(dz)..dz];
                            if t2 == b"covr" { if v.len() > 100 && m.pic.is_none() { m.pic = Some(Pic { ty: 3, mime: if kind == 14 { "image/png" } else { "image/jpeg" }.into(), data: v.to_vec() }); } }
                            else if t2 == b"trkn" || t2 == b"disk" { if v.len() >= 4 { m.tags.insert(if t2 == b"trkn" { "TRACKNUMBER" } else { "DISCNUMBER" }.into(), u16be(v, 2).to_string()); } }
                            else if let Some(k) = key { if !m.tags.contains_key(k) { m.tags.insert(k.into(), clean(&String::from_utf8_lossy(v))); } }
                        });
                    }
                }
            }
        });
    }
    walk(&mv, 0, mv.len(), &mut m);
    if m.dur > 0.0 { m.kbps = ((size * 8) as f64 / m.dur / 1000.0).round() as u32; }
    m
}

fn wav_meta(r: &mut dyn Rs, size: u64) -> Option<Meta> {
    let b = read_at(r, 0, 4096); if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" { return None; }
    let mut m = Meta { codec: "WAV".into(), ..Default::default() }; let mut o = 12; let mut rate = 0u32;
    while o + 8 <= b.len() {
        let id = &b[o..o + 4]; let len = u32le(&b, o + 4) as usize;
        if id == b"fmt " { m.ch = u16le(&b, o + 10) as u32; m.sr = u32le(&b, o + 12); rate = u32le(&b, o + 16); m.bits = u16le(&b, o + 22) as u32; }
        if id == b"data" { if rate > 0 { m.dur = (len as u64).min(size - o as u64 - 8) as f64 / rate as f64; } break; }
        o += 8 + len + (len & 1);
    }
    if rate > 0 { m.kbps = (rate as f64 * 8.0 / 1000.0).round() as u32; }
    Some(m)
}

fn ext80(b: &[u8], o: usize) -> f64 {
    let e = (((b[o] & 0x7f) as i32) << 8) | b[o + 1] as i32; let hi = u32be(b, o + 2) as f64; let lo = u32be(b, o + 6) as f64;
    if e == 0 && hi == 0.0 && lo == 0.0 { return 0.0; }
    (hi * 2f64.powi(-31) + lo * 2f64.powi(-63)) * 2f64.powi(e - 16383) * if b[o] & 0x80 != 0 { -1.0 } else { 1.0 }
}
fn aiff_meta(r: &mut dyn Rs, _size: u64) -> Option<Meta> {
    let b = read_at(r, 0, 65536); if b.len() < 12 || &b[0..4] != b"FORM" || !(&b[8..12] == b"AIFF" || &b[8..12] == b"AIFC") { return None; }
    let mut m = Meta { codec: "AIFF".into(), ..Default::default() }; let mut o = 12;
    while o + 8 <= b.len() {
        let id = &b[o..o + 4]; let len = u32be(&b, o + 4) as usize;
        if id == b"COMM" && o + 26 <= b.len() { m.ch = u16be(&b, o + 8) as u32; let frames = u32be(&b, o + 10) as f64; m.bits = u16be(&b, o + 14) as u32; m.sr = ext80(&b, o + 16).round() as u32; if m.sr > 0 { m.dur = frames / m.sr as f64; } }
        if id == b"ID3 " || id == b"id3 " { let mut t = Meta::default(); id3v2(r, o as u64 + 8, &mut t); m.tags = t.tags; m.pic = t.pic; }
        o += 8 + len + (len & 1);
    }
    Some(m)
}

// APE и WavPack: формат и длительность из заголовков, теги — APEv2 в конце файла (или ID3v1)
fn ape_tags(r: &mut dyn Rs, size: u64, m: &mut Meta) {
    let mut end = size;
    let t1 = read_at(r, size.saturating_sub(128), 128); let v1 = t1.len() == 128 && t1.starts_with(b"TAG");
    if v1 { end -= 128; }
    let f = read_at(r, end.saturating_sub(32), 32);
    if f.len() < 32 || &f[0..8] != b"APETAGEX" {
        if v1 { let g = |a: usize, b: usize| clean(&cp1251(&t1[a..b])); m.tags.insert("TITLE".into(), g(3, 33)); m.tags.insert("ARTIST".into(), g(33, 63)); m.tags.insert("ALBUM".into(), g(63, 93)); m.tags.insert("DATE".into(), g(93, 97)); if t1[125] == 0 && t1[126] != 0 { m.tags.insert("TRACKNUMBER".into(), t1[126].to_string()); } }
        return;
    }
    let tsize = u32le(&f, 12) as u64; let items = u32le(&f, 16);
    if tsize <= 32 || tsize > 64 << 20 || tsize > end { return; }
    let b = read_at(r, end - tsize, (tsize - 32) as usize); let mut o = 0usize;
    for _ in 0..items {
        if o + 9 >= b.len() { break; }
        let len = u32le(&b, o) as usize; let fl = u32le(&b, o + 4); let Some(z) = b[o + 8..].iter().position(|&c| c == 0).map(|x| x + o + 8) else { break };
        if z + 1 + len > b.len() { break; }
        let key = latin(&b[o + 8..z]).to_uppercase(); let v = &b[z + 1..z + 1 + len]; o = z + 1 + len;
        let kind = (fl >> 1) & 3;
        if kind == 1 && key.starts_with("COVER ART") {
            let data = v.iter().position(|&c| c == 0).map(|i| &v[i + 1..]).unwrap_or(v); let ty = if key.contains("FRONT") { 3 } else if key.contains("BACK") { 4 } else { 0 };
            if data.len() > 100 && better(&m.pic, ty) { let mime = match img_ext(data) { ".png" => "image/png", ".webp" => "image/webp", ".gif" => "image/gif", ".bmp" => "image/bmp", _ => "image/jpeg" }; m.pic = Some(Pic { ty, mime: mime.into(), data: data.to_vec() }); }
            continue;
        }
        if kind != 0 { continue; }
        let k = match key.as_str() { "YEAR" => "DATE".to_string(), "TRACK" => "TRACKNUMBER".into(), "DISC" => "DISCNUMBER".into(), "ALBUM ARTIST" => "ALBUMARTIST".into(), "PUBLISHER" => "ORGANIZATION".into(), "CATALOG" => "CATALOGNUMBER".into(), k => k.split_whitespace().collect::<String>() };
        let val = if k == "CUESHEET" { String::from_utf8_lossy(v).to_string() } else { clean(&first0(String::from_utf8_lossy(v).to_string())) };
        m.tags.insert(k, val);
    }
}
/// заголовок APE (Monkey's Audio, версии ≥ 3.98) → частота, каналы, разрядность, длительность
fn ape_head(r: &mut dyn Rs) -> Option<(u32, u32, u32, f64)> {
    let b = read_at(r, 0, 128); if !b.starts_with(b"MAC ") { return None; }
    let ver = u16le(&b, 4);
    if ver >= 3980 {
        let d = u32le(&b, 8) as usize; let h = &b[d.min(b.len())..];
        if h.len() < 24 { return None; }
        let bpf = u32le(h, 4) as f64; let flb = u32le(h, 8) as f64; let tf = u32le(h, 12) as f64; let bits = u16le(h, 16) as u32; let ch = u16le(h, 18) as u32; let sr = u32le(h, 20);
        let frames = if tf > 0.0 { (tf - 1.0) * bpf + flb } else { 0.0 };
        return Some((sr, ch, bits, if sr > 0 { frames / sr as f64 } else { 0.0 }));
    }
    // старые версии: заголовок сразу после «MAC »
    let comp = u16le(&b, 6); let flags = u16le(&b, 8); let ch = u16le(&b, 10) as u32; let sr = u32le(&b, 12); let tf = u32le(&b, 24) as f64; let flb = u32le(&b, 28) as f64;
    let bpf = if ver >= 3950 { 73728.0 * 4.0 } else if ver >= 3900 || (ver >= 3800 && comp == 4000) { 73728.0 } else { 9216.0 };
    let bits = if flags & 1 != 0 { 8 } else if flags & 8 != 0 { 24 } else { 16 };
    let frames = if tf > 0.0 { (tf - 1.0) * bpf + flb } else { 0.0 };
    Some((sr, ch, bits, if sr > 0 { frames / sr as f64 } else { 0.0 }))
}
/// заголовок WavPack (блок wvpk) → частота, каналы, разрядность, длительность
fn wv_head(r: &mut dyn Rs) -> Option<(u32, u32, u32, f64)> {
    let b = read_at(r, 0, 32); if !b.starts_with(b"wvpk") || b.len() < 32 { return None; }
    let total = u32le(&b, 12); let flags = u32le(&b, 24);
    const RATES: [u32; 15] = [6000, 8000, 9600, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000, 192000];
    let ri = ((flags >> 23) & 0xf) as usize; let sr = if ri < 15 { RATES[ri] } else { 44100 };
    let bits = ((flags & 3) + 1) * 8; let ch = if flags & 4 != 0 { 1 } else { 2 };
    Some((sr, ch, bits, if total != u32::MAX && sr > 0 { total as f64 / sr as f64 } else { 0.0 }))
}

/// Теги и сведения о файле (как readMeta в local.js). r — поток файла (обычного или куска образа).
pub fn read_meta(r: &mut dyn Rs, size: u64, ext: &str) -> Meta {
    let m = match ext {
        "flac" => flac_meta(r, size),
        "mp3" => Some(mp3_meta(r, size)),
        "wav" => wav_meta(r, size),
        "ogg" | "oga" | "opus" => Some(ogg_meta(r, size, ext == "opus")),
        "m4a" | "m4b" | "mp4" => Some(mp4_meta(r, size)),
        "aif" | "aiff" | "aifc" => aiff_meta(r, size),
        "ape" | "wv" => {
            let h = if ext == "ape" { ape_head(r) } else { wv_head(r) };
            let mut m = Meta { codec: if ext == "ape" { "APE" } else { "WavPack" }.into(), ..Default::default() };
            if let Some((sr, ch, bits, dur)) = h { m.sr = sr; m.ch = ch; m.bits = bits; m.dur = dur; if dur > 0.0 { m.kbps = ((size * 8) as f64 / dur / 1000.0).round() as u32; } }
            ape_tags(r, size, &mut m);
            Some(m)
        }
        _ => None,
    };
    m.unwrap_or_else(|| Meta { codec: audio_codec(ext).unwrap_or("").to_string(), ..Default::default() })
}

// ——— CUE ———
#[derive(Debug, Clone, Default)]
pub struct CueTrack { pub n: u32, pub tags: BTreeMap<String, String>, pub start: f64 }
#[derive(Debug, Clone, Default)]
pub struct CueFile { pub name: String, pub kind: String, pub tracks: Vec<CueTrack>, pub resolved: Option<String> }
#[derive(Debug, Clone, Default)]
pub struct Cue { pub tags: BTreeMap<String, String>, pub files: Vec<CueFile> }

pub fn parse_cue(text: &str) -> Cue {
    let mut cue = Cue::default();
    struct T { n: u32, ty: String, tags: BTreeMap<String, String>, start: Option<f64>, pre: Option<f64> }
    let mut files: Vec<(String, String, Vec<T>)> = vec![];
    let val = |s: &str| -> String { let s = s.trim(); if let Some(r) = s.strip_prefix('"') { match r.rfind('"') { Some(i) => r[..i].to_string(), None => r.to_string() } } else { s.to_string() } };
    let mut in_track = false;
    for raw in text.lines() {
        let line = raw.trim(); if line.is_empty() { continue; }
        let (cmd, rest) = match line.find(' ') { Some(i) => (line[..i].to_uppercase(), &line[i + 1..]), None => (line.to_uppercase(), "") };
        match cmd.as_str() {
            "FILE" => {
                let r = rest.trim();
                let (name, kind) = if let Some(q) = r.strip_prefix('"') { match q.rfind('"') { Some(i) => (q[..i].to_string(), q[i + 1..].trim().to_uppercase()), None => (q.to_string(), String::new()) } } else { let mut it = r.split_whitespace(); (it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_uppercase()) };
                files.push((name, kind, vec![])); in_track = false;
            }
            "TRACK" => {
                let Some(f) = files.last_mut() else { continue };
                let mut it = rest.split_whitespace(); let n = it.next().and_then(|x| x.parse().ok()).unwrap_or(f.2.len() as u32 + 1); let ty = it.next().unwrap_or("AUDIO").to_uppercase();
                f.2.push(T { n, ty, tags: BTreeMap::new(), start: None, pre: None }); in_track = true;
            }
            "INDEX" if in_track => {
                let mut it = rest.split_whitespace(); let no: u32 = it.next().and_then(|x| x.parse().ok()).unwrap_or(1);
                let mm: Vec<f64> = it.next().unwrap_or("").split(':').filter_map(|x| x.parse().ok()).collect();
                if mm.len() == 3 { let s = mm[0] * 60.0 + mm[1] + mm[2] / 75.0; if let Some(t) = files.last_mut().and_then(|f| f.2.last_mut()) { if no == 1 { t.start = Some(s); } else if no == 0 { t.pre = Some(s); } } }
            }
            "TITLE" | "PERFORMER" | "SONGWRITER" | "ISRC" => {
                let v = val(rest);
                match files.last_mut().and_then(|f| f.2.last_mut()).filter(|_| in_track) { Some(t) => { t.tags.insert(cmd.clone(), v); } None => { cue.tags.insert(cmd.clone(), v); } }
            }
            "REM" => {
                if let Some(i) = rest.find(' ') { let k = rest[..i].to_uppercase(); let v = val(&rest[i + 1..]);
                    match files.last_mut().and_then(|f| f.2.last_mut()).filter(|_| in_track) { Some(t) => { t.tags.insert(k, v); } None => { cue.tags.insert(k, v); } } }
            }
            "CATALOG" => { cue.tags.insert("CATALOG".into(), rest.trim().to_string()); }
            _ => {}
        }
    }
    for (name, kind, ts) in files {
        let tracks = ts.into_iter().filter(|t| (t.start.is_some() || t.pre.is_some()) && t.ty == "AUDIO").map(|t| CueTrack { n: t.n, tags: t.tags, start: t.start.or(t.pre).unwrap_or(0.0) }).collect();
        cue.files.push(CueFile { name, kind, tracks, resolved: None });
    }
    cue
}

// ——— ISO 9660 / Joliet ———
pub struct IsoItem { pub rel: String, pub off: u64, pub size: u64 }
pub fn iso_list(p: &Path) -> Result<Vec<IsoItem>, String> {
    let mut f = File::open(p).map_err(|e| e.to_string())?; let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let (mut root, mut joliet) = (None::<Vec<u8>>, false);
    for s in 16..64u64 {
        let d = read_at(&mut f, s * 2048, 2048); if d.len() < 2048 || &d[1..6] != b"CD001" { break; }
        let t = d[0]; if t == 255 { break; }
        if t == 1 && root.is_none() { root = Some(d[156..190].to_vec()); }
        if t == 2 && d[88] == 0x25 && d[89] == 0x2f && [0x40, 0x43, 0x45].contains(&d[90]) { root = Some(d[156..190].to_vec()); joliet = true; }
    }
    let Some(root) = root else { let sa = read_at(&mut f, 510 * 2048, 8); return Err(if sa == b"SACDMTOC" { "образ SACD пока не поддерживается".into() } else { "нет ISO 9660".into() }); };
    let mut items = Vec::new(); let mut guard = 0usize;
    fn dir(f: &mut File, len: u64, lba: u64, sz: u64, rel: &str, depth: u32, joliet: bool, guard: &mut usize, items: &mut Vec<IsoItem>) {
        if depth > 12 || *guard > 20000 { return; }
        let d = read_at(f, lba * 2048, sz.min(8 << 20) as usize); let mut o = 0usize;
        while o < d.len() && *guard < 20000 {
            *guard += 1;
            let rl = d[o] as usize; if rl == 0 { o = (o / 2048 + 1) * 2048; continue; }
            if o + 33 > d.len() { break; }
            let ext = u32le(&d, o + 2) as u64; let size = u32le(&d, o + 10) as u64; let fl = d[o + 25]; let nl = d[o + 32] as usize;
            let nb = d.get(o + 33..o + 33 + nl).unwrap_or(&[]);
            if !(nl == 1 && !nb.is_empty() && (nb[0] == 0 || nb[0] == 1)) {
                let mut n = if joliet { utf16(nb, false) } else { latin(nb) };
                if let Some(i) = n.rfind(';') { if n[i + 1..].chars().all(|c| c.is_ascii_digit()) { n.truncate(i); } }
                if n.ends_with('.') { n.pop(); }
                let r2 = format!("{rel}/{n}");
                if fl & 2 != 0 { dir(f, len, ext, size, &r2, depth + 1, joliet, guard, items); }
                else if ext * 2048 + size <= len { items.push(IsoItem { rel: r2, off: ext * 2048, size }); }
            }
            o += rl;
        }
    }
    dir(&mut f, len, u32le(&root, 2) as u64, u32le(&root, 10) as u64, "", 0, joliet, &mut guard, &mut items);
    Ok(items)
}

// ——— обложка из папки ———
fn has_word(b: &str, w: &str) -> bool {
    // w окружено не-латинскими буквами (как (^|[^a-z])w([^a-z]|$) в local.js)
    let bs = b.as_bytes(); let mut i = 0;
    while let Some(p) = b[i..].find(w) {
        let s = i + p; let e = s + w.len();
        let l_ok = s == 0 || !bs[s - 1].is_ascii_lowercase(); let r_ok = e >= bs.len() || !bs[e].is_ascii_lowercase();
        if l_ok && r_ok { return true; }
        i = s + 1;
    }
    false
}
fn is_back(b: &str) -> bool {
    ["back", "rear", "tray", "inlay", "inside", "interior", "booklet", "book", "leaflet", "spine", "side", "matrix", "label", "disc", "disk", "obi", "задн", "оборот", "вкладыш", "буклет", "диск", "корешок"].iter().any(|w| b.contains(w))
        || has_word(b, "cd") || { let bs = b.as_bytes(); b.match_indices("cd").any(|(i, _)| { let mut j = i + 2; while j < bs.len() && bs[j] == b' ' { j += 1; } j < bs.len() && bs[j].is_ascii_digit() }) }
}
fn is_sub(name: &str) -> bool {
    let l = name.to_lowercase();
    ["scan", "scans", "cover", "covers", "artwork", "art", "image", "images", "pic", "pics", "booklet", "скан", "сканы"].contains(&l.as_str()) || l.starts_with("обложк") || l.starts_with("скан")
}
fn is_cd_dir(name: &str) -> bool {
    let l = name.to_lowercase(); for p in ["cd", "disc", "disk", "диск"] { if let Some(r) = l.strip_prefix(p) { let r = r.trim_start(); if !r.is_empty() && r.chars().all(|c| c.is_ascii_digit()) { return true; } } } false
}
/// естественный порядок: «2» раньше «10»
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase()); let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal, (None, _) => return std::cmp::Ordering::Less, (_, None) => return std::cmp::Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let mut n1 = String::new(); while let Some(&c) = x.peek() { if c.is_ascii_digit() { n1.push(c); x.next(); } else { break; } }
                let mut n2 = String::new(); while let Some(&d) = y.peek() { if d.is_ascii_digit() { n2.push(d); y.next(); } else { break; } }
                let o = n1.trim_start_matches('0').len().cmp(&n2.trim_start_matches('0').len()).then(n1.trim_start_matches('0').cmp(n2.trim_start_matches('0')));
                if o != std::cmp::Ordering::Equal { return o; }
            }
            (Some(c), Some(d)) => { if c != d { return c.cmp(&d); } x.next(); y.next(); }
        }
    }
}
fn pick_cover(d: &str, img_dir: &HashMap<String, Vec<String>>) -> Option<(String, f64)> {
    let score = |p: &str, extra: f64, i: usize| -> f64 {
        let b0 = base(p).to_lowercase(); let b = match b0.rfind('.') { Some(i) => b0[..i].to_string(), None => b0 };
        let r = if ["front", "перед", "лицев"].iter().any(|w| b.contains(w)) { 0.0 }
            else if is_back(&b) { 7.0 }
            else if b.starts_with("cover") || b.starts_with("folder") || b.starts_with("обложка") || has_word(&b, "cover") { 0.0 }
            else if b.starts_with("albumart") || b.starts_with("album") || b.starts_with("art") { 1.0 }
            else { 3.0 + (i as f64 * 0.05).min(0.9) };
        r + extra
    };
    let mut cands: Vec<(f64, String)> = vec![];
    let mut add = |list: &[String], extra: f64| { let mut l = list.to_vec(); l.sort_by(|a, b| natural_cmp(a, b)); for (i, p) in l.iter().enumerate() { cands.push((score(p, extra, i), p.clone())); } };
    if let Some(l) = img_dir.get(d) { add(l, 0.0); }
    for (dir, list) in img_dir { if dirname(dir) == d && is_sub(base(dir)) { add(list, 2.0); } }
    if is_cd_dir(base(d)) { if let Some(l) = img_dir.get(&dirname(d)) { add(l, 1.0); } }
    cands.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    cands.into_iter().next().map(|(r, p)| (p, r))
}
fn choose_cover(cov: &str, cov_type: Option<u32>, d: &str, img_dir: &HashMap<String, Vec<String>>) -> String {
    let f = pick_cover(d, img_dir); let e = if cov.is_empty() { 99.0 } else { emb_rank(cov_type.unwrap_or(0)) };
    if !cov.is_empty() && f.as_ref().map(|(_, r)| e <= *r).unwrap_or(true) { return cov.to_string(); }
    f.map(|(p, _)| p).unwrap_or_else(|| cov.to_string())
}

// ——— библиотека ———
#[derive(Default)]
pub struct Lib { pub v: Value }   // тот же JSON, что у Electron: roots, cache, thumbs, hidden, isoc, tracks, files, covers, vfs
pub struct Ctx<'a> {
    pub cov_dir: PathBuf,
    pub progress: &'a mut dyn FnMut(usize, usize, &str),
    pub thumb: &'a dyn Fn(&Path, &Path) -> bool,   // уменьшенная копия обложки (400 точек): (из, в) → получилось
    pub log: &'a dyn Fn(String),
}

fn mtime_ms(md: &std::fs::Metadata) -> f64 { md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as f64 * 1e3 + d.subsec_nanos() as f64 / 1e6).unwrap_or(0.0) }

pub struct Ent { pub p: String, pub m: f64, pub s: u64, pub vd: Option<String> }
pub fn walk(root: &str, out: &mut Vec<Ent>, depth: usize) {
    if out.len() >= MAX_FILES || depth > MAX_DEPTH { return; }
    let Ok(md) = std::fs::metadata(root) else { return };
    if md.is_file() { out.push(Ent { p: root.to_string(), m: mtime_ms(&md), s: md.len(), vd: None }); return; }
    if !md.is_dir() { return; }
    let Ok(rd) = std::fs::read_dir(root) else { return };
    let mut ents: Vec<_> = rd.flatten().collect(); ents.sort_by_key(|e| e.file_name());
    for e in ents {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "$RECYCLE.BIN" || name == "System Volume Information" { continue; }
        let p = join(root, &name); let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() { walk(&p, out, depth + 1); }
        else if ft.is_file() {
            let ext = ext_of(&name);
            if audio_codec(&ext).is_some() || ext == "cue" || is_img(&name) || ext == "iso" || ext == "bin" || ext == "img" {
                if let Ok(md) = e.metadata() { out.push(Ent { p, m: mtime_ms(&md), s: md.len(), vd: None }); }
            }
        }
        if out.len() >= MAX_FILES { return; }
    }
}

/// Открыть файл библиотеки (обычный или кусок образа) для чтения.
pub fn open_r(p: &str, vfs: &Map<String, Value>) -> Option<(Box<dyn Rs>, u64)> {
    match vfs.get(p) {
        None => { let f = File::open(p).ok()?; let n = f.metadata().ok()?.len(); let b: Box<dyn Rs> = Box::new(f); Some((b, n)) }
        Some(v) => {
            let src = v["src"].as_str()?; let off = v["off"].as_u64()?; let size = v["size"].as_u64()?;
            let f = File::open(src).ok()?;
            if v["wav"].as_bool().unwrap_or(false) { return None; }
            let b: Box<dyn Rs> = Box::new(Slice { f, off, size, pos: 0 }); Some((b, size))
        }
    }
}
struct Slice { f: File, off: u64, size: u64, pos: u64 }
impl Read for Slice { fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> { if self.pos >= self.size { return Ok(0); } let n = (b.len() as u64).min(self.size - self.pos) as usize; self.f.seek(SeekFrom::Start(self.off + self.pos))?; let k = self.f.read(&mut b[..n])?; self.pos += k as u64; Ok(k) } }
impl Seek for Slice { fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> { let n = match p { SeekFrom::Start(x) => x as i64, SeekFrom::End(x) => self.size as i64 + x, SeekFrom::Current(x) => self.pos as i64 + x }; if n < 0 { return Err(std::io::Error::other("до начала")); } self.pos = n as u64; Ok(self.pos) } }

fn save_pic(pic: &Pic, cov_dir: &Path) -> String {
    let ext = { let e = img_ext(&pic.data); if !e.is_empty() { e } else if pic.mime.to_lowercase().contains("png") { ".png" } else { ".jpg" } };
    let h = &sha1_hex(&pic.data)[..20]; let f = cov_dir.join(format!("{h}{ext}"));
    if !f.exists() { let _ = std::fs::create_dir_all(cov_dir); if std::fs::write(&f, &pic.data).is_err() { return String::new(); } }
    f.to_string_lossy().to_string()
}
fn num(s: &str) -> u64 { s.split('/').next().unwrap_or("").trim().parse::<i64>().map(|x| x.max(0) as u64).unwrap_or(0) }
fn year(s: &str) -> String { let b = s.as_bytes(); (0..b.len().saturating_sub(3)).find(|&i| b[i..i + 4].iter().all(|c| c.is_ascii_digit())).map(|i| s[i..i + 4].to_string()).unwrap_or_default() }
fn nice(d: &str) -> String { let b = base(d); if let Some(x) = b.strip_suffix(VSEP) { let l = x.to_lowercase(); if l.ends_with(".iso") { x[..x.len() - 4].to_string() } else { x.to_string() } } else { b.to_string() } }
fn tag<'a>(t: &'a Map<String, Value>, k: &str) -> &'a str { t.get(k).and_then(|v| v.as_str()).unwrap_or("") }
fn or<'a>(a: &'a str, b: &'a str) -> &'a str { if a.is_empty() { b } else { a } }
fn meta_json(m: &Meta, cov: String) -> Value {
    json!({ "codec": m.codec, "sr": m.sr, "ch": m.ch, "bits": m.bits, "dur": m.dur, "kbps": m.kbps, "vbr": m.vbr, "tags": m.tags, "pv": PV, "cov": cov, "covType": m.pic.as_ref().map(|p| p.ty) })
}
fn fmt_of(m: &Value) -> Value { json!({ "codec": m["codec"], "sr": m["sr"].as_u64().unwrap_or(0), "bits": m["bits"].as_u64().unwrap_or(0), "ch": m["ch"].as_u64().unwrap_or(0), "kbps": m["kbps"].as_u64().unwrap_or(0), "vbr": m["vbr"].as_bool().unwrap_or(false) }) }

impl Lib {
    pub fn load(p: &Path) -> Lib {
        let v: Value = std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}));
        let mut l = Lib { v: if v.is_object() { v } else { json!({}) } };
        for k in ["cache", "thumbs", "isoc", "files", "covers", "vfs"] { if !l.v[k].is_object() { l.v[k] = json!({}); } }
        for k in ["roots", "hidden", "tracks"] { if !l.v[k].is_array() { l.v[k] = json!([]); } }
        l.v["v"] = json!(1);
        l
    }
    pub fn save(&self, p: &Path) -> Result<(), String> {
        let tmp = p.with_extension("json.tmp");
        std::fs::write(&tmp, self.v.to_string()).map_err(|e| e.to_string())?; std::fs::rename(&tmp, p).map_err(|e| e.to_string())
    }
    pub fn roots(&self) -> Vec<String> { self.v["roots"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default() }
    /// окно: список папок и треков (как list() в local.js)
    pub fn list(&self, scanning: Option<(usize, usize, String)>) -> Value {
        let tracks = self.v["tracks"].as_array().cloned().unwrap_or_default();
        let files = self.v["files"].as_object().cloned().unwrap_or_default();
        let roots: Vec<Value> = self.roots().iter().map(|r| {
            let n = tracks.iter().filter(|t| { let d = t["dir"].as_str().unwrap_or(""); d == r || d.starts_with(&format!("{r}/")) || files.get(t["file"].as_str().unwrap_or("")).and_then(|x| x.as_str()) == Some(r.as_str()) }).count();
            json!({ "path": r, "name": if base(r).is_empty() { r.as_str() } else { base(r) }, "n": n })
        }).collect();
        let ts: Vec<Value> = tracks.into_iter().map(|mut t| { if let Some(o) = t.as_object_mut() { let d = o.remove("dir").unwrap_or(Value::Null); o.insert("folder".into(), d); } t }).collect();
        json!({ "roots": roots, "tracks": ts, "scanning": scanning.map(|(d, t, n)| json!({ "done": d, "total": t, "name": n })), "hidden": self.v["hidden"].as_array().map(|a| a.len()).unwrap_or(0) })
    }
    /// добавить папки/файлы → сколько добавлено
    pub fn add_roots(&mut self, paths: &[String]) -> usize {
        let mut roots = self.roots(); let mut n = 0;
        for p0 in paths {
            if p0.is_empty() || !Path::new(p0).is_absolute() || !Path::new(p0).exists() { continue; }
            let p = p0.trim_end_matches('/').to_string(); let p = if p.is_empty() { "/".to_string() } else { p };
            if roots.iter().any(|r| p == *r || p.starts_with(&format!("{r}/"))) { continue; }
            roots.retain(|r| !r.starts_with(&format!("{p}/"))); roots.push(p); n += 1;
        }
        self.v["roots"] = json!(roots); n
    }
    pub fn remove_root(&mut self, root: &str) -> bool { let mut r = self.roots(); let b = r.len(); r.retain(|x| x != root); self.v["roots"] = json!(r); r.len() != b }
    pub fn hide(&mut self, ids: &[String]) -> usize {
        let want: HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
        let files = self.v["files"].as_object().cloned().unwrap_or_default();
        let mut ps: Vec<String> = vec![];
        for t in self.v["tracks"].as_array().cloned().unwrap_or_default() { if want.contains(t["id"].as_str().unwrap_or("")) { if let Some(p) = files.get(t["file"].as_str().unwrap_or("")).and_then(|x| x.as_str()) { if !ps.contains(&p.to_string()) { ps.push(p.into()); } } } }
        if ps.is_empty() { return 0; }
        let keys: HashSet<String> = ps.iter().map(|p| fid(p)).collect();
        let mut hid: Vec<String> = self.v["hidden"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        for p in &ps { if !hid.contains(p) { hid.push(p.clone()); } }
        self.v["hidden"] = json!(hid);
        let tr: Vec<Value> = self.v["tracks"].as_array().cloned().unwrap_or_default().into_iter().filter(|t| !keys.contains(t["file"].as_str().unwrap_or(""))).collect();
        self.v["tracks"] = json!(tr);
        ps.len()
    }
    pub fn path_of(&self, id: &str) -> Option<String> {
        let t = self.v["tracks"].as_array()?.iter().find(|t| t["id"].as_str() == Some(id))?.clone();
        let p = self.v["files"][t["file"].as_str()?].as_str()?.to_string();
        Some(match self.v["vfs"].get(&p) { Some(v) => v["src"].as_str().unwrap_or(&p).to_string(), None => p })
    }

    /// Пересмотреть папки (как scan() в local.js).
    pub fn scan(&mut self, cx: &mut Ctx) {
        let roots = self.roots();
        let mut all: Vec<Ent> = vec![]; for r in &roots { walk(r, &mut all, 0); }
        let hid: HashSet<String> = self.v["hidden"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let old_isoc = self.v["isoc"].as_object().cloned().unwrap_or_default();
        let mut vfs = Map::new(); let mut isoc = Map::new();
        let mut extra: Vec<Ent> = vec![]; let mut extra_img: Vec<(String, IsoItem, String, f64)> = vec![]; let mut extra_cue: Vec<Ent> = vec![];
        for x in &all {
            if ext_of(&x.p) != "iso" || hid.contains(&x.p) { continue; }
            let old = old_isoc.get(&x.p).filter(|o| o["m"].as_f64() == Some(x.m) && o["s"].as_u64() == Some(x.s));
            let items: Vec<IsoItem> = match old {
                Some(o) => o["items"].as_array().map(|a| a.iter().map(|i| IsoItem { rel: i["rel"].as_str().unwrap_or("").into(), off: i["off"].as_u64().unwrap_or(0), size: i["size"].as_u64().unwrap_or(0) }).collect()).unwrap_or_default(),
                None => { (cx.progress)(0, 0, base(&x.p)); iso_list(Path::new(&x.p)).unwrap_or_else(|e| { (cx.log)(format!("своя музыка: образ не прочитан — {}: {e}", base(&x.p))); vec![] }) }
            };
            isoc.insert(x.p.clone(), json!({ "m": x.m, "s": x.s, "items": items.iter().map(|i| json!({ "rel": i.rel, "off": i.off, "size": i.size })).collect::<Vec<_>>() }));
            for it in items {
                let vp = format!("{}{VSEP}{}", x.p, it.rel); let ext = ext_of(&it.rel);
                if audio_codec(&ext).is_some() && ext != "ape" && ext != "wv" { vfs.insert(vp.clone(), json!({ "src": x.p, "off": it.off, "size": it.size })); if !hid.contains(&vp) { extra.push(Ent { p: vp, m: x.m, s: it.size, vd: None }); } }
                else if ext == "cue" && it.size < 1 << 20 { vfs.insert(vp.clone(), json!({ "src": x.p, "off": it.off, "size": it.size })); extra_cue.push(Ent { p: vp, m: x.m, s: it.size, vd: None }); }
                else if is_img(&it.rel) && it.size < 20 << 20 { let vd = dirname(&vp); extra_img.push((x.p.clone(), it, vd, x.m)); }
            }
        }
        self.v["isoc"] = Value::Object(isoc);
        // CUE
        let read_all = |p: &str, vfs: &Map<String, Value>| -> Option<Vec<u8>> { let (mut r, n) = open_r(p, vfs)?; let b = read_at(&mut *r, 0, n.min(4 << 20) as usize); Some(b) };
        let mut cues: Vec<(String, Cue)> = vec![];
        let cue_paths: Vec<String> = all.iter().filter(|x| ext_of(&x.p) == "cue").map(|x| x.p.clone()).chain(extra_cue.iter().map(|x| x.p.clone())).collect();
        for cp in cue_paths {
            let Some(b) = read_all(&cp, &vfs) else { continue };
            let mut cue = parse_cue(&text_auto(&b)); let dir = dirname(&cp);
            for f in cue.files.iter_mut() {
                let l = f.name.to_lowercase(); if !(l.ends_with(".bin") || l.ends_with(".img")) || f.kind == "MOTOROLA" { continue; }
                let want = join(&dir, &f.name.replace('\\', "/")).to_lowercase();
                let Some(b) = all.iter().find(|y| y.p.to_lowercase() == want) else { continue };
                let vp = format!("{}{VSEP}audio-cd.wav", b.p); f.resolved = Some(vp.clone());
                if !vfs.contains_key(&vp) { vfs.insert(vp.clone(), json!({ "src": b.p, "off": 0, "size": b.s - b.s % 4, "wav": true })); if !hid.contains(&vp) { extra.push(Ent { p: vp, m: b.m, s: b.s, vd: None }); } }
            }
            cues.push((cp, cue));
        }
        let audio: Vec<Ent> = all.iter().filter(|x| audio_codec(&ext_of(&x.p)).is_some() && !hid.contains(&x.p)).map(|x| Ent { p: x.p.clone(), m: x.m, s: x.s, vd: None }).chain(extra).collect();
        let mut imgs: Vec<Ent> = all.iter().filter(|x| is_img(base(&x.p))).map(|x| Ent { p: x.p.clone(), m: x.m, s: x.s, vd: None }).collect();
        for (iso, it, vd, m) in extra_img {
            let safe: String = base(&it.rel).chars().map(|c| if c.is_alphanumeric() || ".- _".contains(c) { c } else { '_' }).collect();
            let f = cx.cov_dir.join(format!("iso-{}", fid(&iso))).join(format!("{}-{}", it.off, safe));
            if !f.exists() { if let Ok(mut fh) = File::open(&iso) { let b = read_at(&mut fh, it.off, it.size as usize); let _ = std::fs::create_dir_all(f.parent().unwrap()); let _ = std::fs::write(&f, b); } }
            imgs.push(Ent { p: f.to_string_lossy().to_string(), m, s: it.size, vd: Some(vd) });
        }
        let mut by_dir: HashMap<String, Vec<String>> = HashMap::new(); for x in &audio { by_dir.entry(dirname(&x.p)).or_default().push(x.p.clone()); }
        let mut img_dir: HashMap<String, Vec<String>> = HashMap::new(); for x in &imgs { img_dir.entry(x.vd.clone().unwrap_or_else(|| dirname(&x.p))).or_default().push(x.p.clone()); }
        // теги (из кэша, если файл не менялся)
        let old_cache = self.v["cache"].as_object().cloned().unwrap_or_default();
        let mut cache = Map::new(); let mut meta: HashMap<String, Value> = HashMap::new();
        let total = audio.len();
        for (i, x) in audio.iter().enumerate() {
            let old = old_cache.get(&x.p).filter(|o| o["m"].as_f64() == Some(x.m) && o["s"].as_u64() == Some(x.s) && o["meta"]["pv"].as_u64() == Some(PV)).map(|o| o["meta"].clone());
            let mut m = match old { Some(m) => m, None => {
                let ext = if vfs.get(&x.p).map(|v| v["wav"].as_bool() == Some(true)).unwrap_or(false) { "wav".to_string() } else { ext_of(x.p.split(VSEP).last().unwrap_or(&x.p)) };
                match open_r(&x.p, &vfs) {
                    Some((mut r, n)) => {
                        if ext == "dsf" || ext == "dff" {
                            let mut mm = Meta { codec: ext.to_uppercase(), ..Default::default() };
                            if let Ok(f) = File::open(&x.p) { if let Ok(d) = crate::dsd::Reader::open(Box::new(f)) { mm.sr = d.info.fs; mm.ch = d.info.channels as u32; mm.bits = 1; mm.dur = d.info.duration(); mm.codec = format!("{} {}", d.info.grade(), d.info.kind); } }
                            if ext == "dsf" { let h = read_at(&mut *r, 0, 28); let mp = u64::from_le_bytes(h.get(20..28).and_then(|s| s.try_into().ok()).unwrap_or([0; 8])); if mp > 0 && mp < n { let mut t = Meta::default(); id3v2(&mut *r, mp, &mut t); mm.tags = t.tags; mm.pic = t.pic; } }
                            if mm.dur > 0.0 { mm.kbps = ((n * 8) as f64 / mm.dur / 1000.0).round() as u32; }
                            let cov = mm.pic.as_ref().map(|p| save_pic(p, &cx.cov_dir)).unwrap_or_default(); meta_json(&mm, cov)
                        } else {
                            let mm = read_meta(&mut *r, n, &ext);
                            let cov = mm.pic.as_ref().map(|p| save_pic(p, &cx.cov_dir)).unwrap_or_default(); meta_json(&mm, cov)
                        }
                    }
                    None if vfs.get(&x.p).map(|v| v["wav"].as_bool() == Some(true)).unwrap_or(false) => { let n = vfs[&x.p]["size"].as_f64().unwrap_or(0.0); json!({ "codec": "CD", "sr": 44100, "ch": 2, "bits": 16, "dur": n / 176400.0, "kbps": 1411, "vbr": false, "tags": {}, "pv": PV, "cov": "", "covType": null }) }
                    None => json!({ "codec": audio_codec(&ext).unwrap_or(""), "tags": {}, "err": "не открылся" }),
                }
            } };
            if vfs.get(&x.p).map(|v| v["wav"].as_bool() == Some(true)).unwrap_or(false) { m["codec"] = json!("CD"); }
            cache.insert(x.p.clone(), json!({ "m": x.m, "s": x.s, "meta": m.clone() })); meta.insert(x.p.clone(), m);
            if i % 8 == 0 || i + 1 == total { (cx.progress)(i + 1, total, base(&dirname(&x.p))); }
        }
        self.v["cache"] = Value::Object(cache.clone());
        // треки
        let mut files = Map::new(); let mut covers = Map::new(); let mut out: Vec<Value> = vec![]; let mut used: HashSet<String> = HashSet::new();
        let cov_id = |p: &str, covers: &mut Map<String, Value>| -> String { if p.is_empty() { return String::new(); } let k = fid(p); covers.insert(k.clone(), json!(p)); format!("pulsefile://c/{k}") };
        let mut jobs: Vec<(Cue, String, String, bool)> = cues.into_iter().map(|(p, c)| (c, dirname(&p), p, false)).collect();
        for x in &audio { if let Some(cs) = meta.get(&x.p).and_then(|m| m["tags"]["CUESHEET"].as_str()) { let mut c = parse_cue(cs); if !c.files.is_empty() { for f in c.files.iter_mut() { f.name = base(&x.p).to_string(); } jobs.push((c, dirname(&x.p), x.p.clone(), true)); } } }
        for (cue, dir, src, embedded) in &jobs {
            let sib = by_dir.get(dir).cloned().unwrap_or_default();
            for f in &cue.files {
                let p = f.resolved.clone().or_else(|| resolve_cue_file(dir, &f.name, &sib)); let Some(p) = p else { continue };
                if used.contains(&p) || f.tracks.is_empty() { continue; } let Some(m) = meta.get(&p) else { continue };
                used.insert(p.clone()); let k = fid(&p); files.insert(k.clone(), json!(p));
                let ct = &cue.tags; let ft = m["tags"].as_object().cloned().unwrap_or_default();
                let g = |k: &str| ct.get(k).map(|s| s.as_str()).unwrap_or("");
                let album_title = or(or(g("TITLE"), tag(&ft, "ALBUM")), &nice(dir)).to_string();
                let album_artist = or(or(or(g("PERFORMER"), tag(&ft, "ALBUMARTIST")), tag(&ft, "ARTIST")), "Неизвестный артист").to_string();
                let cov = cov_id(&choose_cover(m["cov"].as_str().unwrap_or(""), m["covType"].as_u64().map(|x| x as u32), dir, &img_dir), &mut covers);
                let mdur = m["dur"].as_f64().unwrap_or(0.0);
                let file_name = if vfs.get(&p).map(|v| v["wav"].as_bool() == Some(true)).unwrap_or(false) { base(vfs[&p]["src"].as_str().unwrap_or(&p)).to_string() } else { base(p.split(VSEP).last().unwrap_or(&p)).to_string() };
                let disc = { let d = num(g("DISCNUMBER")); if d > 0 { d } else { 1 } };
                for (i, t) in f.tracks.iter().enumerate() {
                    let s = t.start; let e = f.tracks.get(i + 1).map(|n| n.start).unwrap_or(0.0); let dur = (if e > 0.0 { e } else { mdur }) - s;
                    let tt = |k: &str| t.tags.get(k).map(|s| s.as_str()).unwrap_or("");
                    out.push(json!({ "id": format!("loc:{k}-{}", t.n), "title": if tt("TITLE").is_empty() { format!("Трек {}", t.n) } else { tt("TITLE").to_string() }, "artist": or(tt("PERFORMER"), &album_artist), "albumArtist": album_artist, "albumTitle": album_title, "dir": dir, "n": t.n, "disc": disc,
                        "year": year(or(g("DATE"), tag(&ft, "DATE"))), "genre": or(g("GENRE"), tag(&ft, "GENRE")), "dur": dur.max(0.0), "cover": cov, "file": k, "s": s, "e": e, "cue": true, "fmt": fmt_of(m), "size": cache.get(&p).and_then(|c| c["s"].as_u64()).unwrap_or(0),
                        "extra": { "label": or(or(g("LABEL"), tag(&ft, "LABEL")), tag(&ft, "ORGANIZATION")), "catalog": or(or(g("CATALOG"), g("CATALOGNUMBER")), tag(&ft, "CATALOGNUMBER")), "comment": or(g("COMMENT"), tag(&ft, "COMMENT")), "cueName": if *embedded { String::new() } else { base(src).to_string() }, "fileName": file_name } }));
                }
            }
        }
        for x in &audio {
            if used.contains(&x.p) { continue; }
            let m = meta.get(&x.p).cloned().unwrap_or_else(|| json!({ "tags": {} })); let t = m["tags"].as_object().cloned().unwrap_or_default(); let k = fid(&x.p); let d = dirname(&x.p);
            files.insert(k.clone(), json!(x.p));
            let fname = x.p.split(VSEP).last().unwrap_or(&x.p);
            let title = if tag(&t, "TITLE").is_empty() { let s = stem(fname); let b = s.as_bytes(); let mut i = 0; while i < b.len().min(3) && b[i].is_ascii_digit() { i += 1; } let j = { let mut j = i; while j < b.len() && " .-_".contains(b[j] as char) { j += 1; } j }; if i > 0 && j > i { s[j..].to_string() } else { s } } else { tag(&t, "TITLE").to_string() };
            let artist = or(or(tag(&t, "ARTIST"), tag(&t, "ALBUMARTIST")), "Неизвестный артист").to_string();
            let album = if tag(&t, "ALBUM").is_empty() { if is_cd_dir(base(&d)) { nice(&dirname(&d)) } else { nice(&d) } } else { tag(&t, "ALBUM").to_string() };
            let cov = cov_id(&choose_cover(m["cov"].as_str().unwrap_or(""), m["covType"].as_u64().map(|x| x as u32), &d, &img_dir), &mut covers);
            let disc = { let n = num(tag(&t, "DISCNUMBER")); if n > 0 { n } else { 1 } };
            out.push(json!({ "id": format!("loc:{k}"), "title": title, "artist": artist, "albumArtist": or(or(tag(&t, "ALBUMARTIST"), tag(&t, "ARTIST")), &artist), "albumTitle": album, "dir": d, "n": num(tag(&t, "TRACKNUMBER")), "disc": disc,
                "year": year(or(tag(&t, "DATE"), tag(&t, "YEAR"))), "genre": tag(&t, "GENRE"), "dur": m["dur"].as_f64().unwrap_or(0.0), "cover": cov, "file": k, "s": 0, "e": 0, "cue": false, "fmt": fmt_of(&m), "size": x.s,
                "extra": { "label": or(tag(&t, "LABEL"), tag(&t, "ORGANIZATION")), "catalog": tag(&t, "CATALOGNUMBER"), "comment": tag(&t, "COMMENT"), "fileName": base(fname) } }));
        }
        // маленькие копии обложек (400 точек) для списков: картинки из файлов бывают по 3000 точек
        (cx.progress)(total, total, "обложки");
        let old_thumbs = self.v["thumbs"].as_object().cloned().unwrap_or_default(); let mut keep = Map::new(); let mut done: HashMap<String, String> = HashMap::new();
        for t in out.iter_mut() {
            let c = t["cover"].as_str().unwrap_or("").to_string(); if c.is_empty() { continue; }
            let Some(src) = covers.get(c.trim_start_matches("pulsefile://c/")).and_then(|x| x.as_str()).map(String::from) else { continue };
            let tp = done.entry(src.clone()).or_insert_with(|| thumb_of(&src, &old_thumbs, &mut keep, cx)).clone();
            t["coverBig"] = json!(c);
            if tp != src { let tid = fid(&tp); covers.insert(tid.clone(), json!(tp)); t["cover"] = json!(format!("pulsefile://c/{tid}")); }
        }
        self.v["thumbs"] = Value::Object(keep);
        self.v["files"] = Value::Object(files); self.v["covers"] = Value::Object(covers); self.v["vfs"] = Value::Object(vfs); self.v["tracks"] = json!(out);
    }
}

fn resolve_cue_file(dir: &str, name: &str, siblings: &[String]) -> Option<String> {
    let want = join(dir, &name.replace('\\', "/"));
    let low: HashMap<String, &String> = siblings.iter().map(|p| (p.to_lowercase(), p)).collect();
    if let Some(p) = low.get(&want.to_lowercase()) { return Some((*p).clone()); }
    let b = join(dir, &stem(name)).to_lowercase();
    for ext in ["flac", "mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "wav", "webm", "weba", "ape", "wv", "aif", "aiff", "dsf", "dff"] { if let Some(p) = low.get(&format!("{b}.{ext}")) { return Some((*p).clone()); } }
    None
}

fn thumb_of(src: &str, old: &Map<String, Value>, keep: &mut Map<String, Value>, cx: &mut Ctx) -> String {
    let Ok(md) = std::fs::metadata(src) else { return src.to_string() };
    let (m, s) = (mtime_ms(&md), md.len());
    if let Some(o) = old.get(src) { if o["m"].as_f64() == Some(m) && o["s"].as_u64() == Some(s) { let t = o["t"].as_str().unwrap_or(src).to_string(); if t == src || Path::new(&t).exists() { keep.insert(src.into(), o.clone()); return t; } } }
    let mut t = src.to_string();
    if s > 300 * 1024 {
        let out = cx.cov_dir.join(format!("t_{}.jpg", &sha1_hex(format!("{src}|{m}|{s}").as_bytes())[..20]));
        let _ = std::fs::create_dir_all(&cx.cov_dir);
        if out.exists() || (cx.thumb)(Path::new(src), &out) { t = out.to_string_lossy().to_string(); }
    }
    keep.insert(src.into(), json!({ "m": m, "s": s, "t": t }));
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sha1_and_fid_match_node() {
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        // node -e "crypto.createHash('sha1').update('/users/ivan/music/альбом/01 трек.flac').digest('hex').slice(0,16)"
        assert_eq!(fid("/Users/ivan/Music/Альбом/01 Трек.flac"), &sha1_hex("/users/ivan/music/альбом/01 трек.flac".as_bytes())[..16]);
    }
    #[test]
    fn cp1251_and_text() {
        assert_eq!(cp1251(&[0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), "Привет");
        assert_eq!(text_auto(&[0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), "Привет");
        assert_eq!(text_auto("Привет".as_bytes()), "Привет");
    }
    #[test]
    fn cue_parsing() {
        let c = parse_cue("PERFORMER \"Кино\"\nTITLE \"Группа крови\"\nREM DATE 1988\nFILE \"album.wav\" WAVE\n  TRACK 01 AUDIO\n    TITLE \"Группа крови\"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE \"Закрой за мной дверь\"\n    INDEX 00 04:40:00\n    INDEX 01 04:42:37\n");
        assert_eq!(c.tags.get("PERFORMER").unwrap(), "Кино"); assert_eq!(c.tags.get("DATE").unwrap(), "1988");
        assert_eq!(c.files.len(), 1); assert_eq!(c.files[0].name, "album.wav"); assert_eq!(c.files[0].tracks.len(), 2);
        assert!((c.files[0].tracks[1].start - (4.0 * 60.0 + 42.0 + 37.0 / 75.0)).abs() < 1e-9);
        assert_eq!(c.files[0].tracks[1].tags.get("TITLE").unwrap(), "Закрой за мной дверь");
    }
    #[test]
    fn covers_pick_front() {
        let mut m = HashMap::new(); m.insert("/a".to_string(), vec!["/a/back.jpg".to_string(), "/a/Folder.jpg".to_string(), "/a/cd1.jpg".to_string()]);
        assert_eq!(pick_cover("/a", &m).unwrap().0, "/a/Folder.jpg");
        assert!(is_back("cd 1") && is_back("cd1") && !is_back("cdk") && is_back("matrix"));
        assert!(is_cd_dir("CD2") && is_cd_dir("Диск 1") && !is_cd_dir("CDs"));
        assert_eq!(natural_cmp("2 a", "10 a"), std::cmp::Ordering::Less);
    }
}
