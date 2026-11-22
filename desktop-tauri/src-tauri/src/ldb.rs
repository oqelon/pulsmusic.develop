// Чтение хранилища интерфейса Electron-версии (localStorage Chromium = база LevelDB) — этап 5, перенос данных.
//
// Только чтение и только копии: перед чтением папка «Local Storage» Electron копируется в резервную копию, база
// читается из копии. Свой разбор (без сторонней библиотеки LevelDB), потому что библиотеки при открытии базы
// пишут в неё (LOCK, сжатие), а нам нельзя менять даже копию, которая служит резервной.
//
// Формат LevelDB: журнал *.log (пакеты записей, блоки по 32 КБ) + таблицы *.ldb/*.sst (блоки с общими префиксами
// ключей, сжатие Snappy). У каждой записи номер (seq): побеждает запись с наибольшим номером, «удаление» убирает
// ключ. Формат localStorage Chromium: ключ "_" + источник + "\0" + (0 — UTF-16LE | 1 — Latin-1) + имя,
// значение — тот же префикс кодировки + текст.

use std::collections::HashMap;
use std::path::Path;

fn varint(b: &[u8], p: &mut usize) -> Option<u64> {
    let mut r = 0u64; let mut s = 0;
    loop { let c = *b.get(*p)?; *p += 1; r |= ((c & 0x7f) as u64) << s; if c & 0x80 == 0 { return Some(r); } s += 7; if s > 63 { return None; } }
}

/// Snappy (сырой формат, как в блоках LevelDB)
pub fn snappy(src: &[u8]) -> Option<Vec<u8>> {
    let mut p = 0; let n = varint(src, &mut p)? as usize;
    if n > 512 << 20 { return None; }
    let mut out: Vec<u8> = Vec::with_capacity(n);
    while p < src.len() {
        let tag = src[p]; p += 1;
        match tag & 3 {
            0 => {
                let mut len = (tag >> 2) as usize;
                if len >= 60 { let k = len - 59; let mut v = 0usize; for i in 0..k { v |= (*src.get(p + i)? as usize) << (8 * i); } p += k; len = v; }
                len += 1;
                out.extend_from_slice(src.get(p..p + len)?); p += len;
            }
            t => {
                let (len, off) = match t {
                    1 => { let o = (((tag >> 5) as usize) << 8) | *src.get(p)? as usize; p += 1; (((tag >> 2) & 7) as usize + 4, o) }
                    2 => { let o = u16::from_le_bytes([*src.get(p)?, *src.get(p + 1)?]) as usize; p += 2; ((tag >> 2) as usize + 1, o) }
                    _ => { let o = u32::from_le_bytes(src.get(p..p + 4)?.try_into().ok()?) as usize; p += 4; ((tag >> 2) as usize + 1, o) }
                };
                if off == 0 || off > out.len() { return None; }
                let st = out.len() - off;
                for i in 0..len { let c = out[st + i]; out.push(c); }
            }
        }
    }
    if out.len() == n { Some(out) } else { None }
}

type Ent = HashMap<Vec<u8>, (u64, Option<Vec<u8>>)>;
fn put(m: &mut Ent, k: Vec<u8>, seq: u64, v: Option<Vec<u8>>) {
    match m.get(&k) { Some((s, _)) if *s >= seq => {} _ => { m.insert(k, (seq, v)); } }
}

fn block_entries(b: &[u8]) -> Option<Vec<(Vec<u8>, Vec<u8>)>> {
    if b.len() < 4 { return None; }
    let nr = u32::from_le_bytes(b[b.len() - 4..].try_into().ok()?) as usize;
    let end = b.len().checked_sub(4 + nr * 4)?;
    let mut p = 0; let mut key: Vec<u8> = Vec::new(); let mut out = Vec::new();
    while p < end {
        let sh = varint(b, &mut p)? as usize; let ns = varint(b, &mut p)? as usize; let vl = varint(b, &mut p)? as usize;
        if sh > key.len() { return None; }
        key.truncate(sh); key.extend_from_slice(b.get(p..p + ns)?); p += ns;
        let v = b.get(p..p + vl)?.to_vec(); p += vl;
        out.push((key.clone(), v));
    }
    Some(out)
}

fn read_block(f: &[u8], off: usize, size: usize) -> Option<Vec<u8>> {
    let data = f.get(off..off + size)?; let ty = *f.get(off + size)?;
    match ty { 0 => Some(data.to_vec()), 1 => snappy(data), _ => None }
}

fn read_table(f: &[u8], m: &mut Ent) -> Result<(), String> {
    if f.len() < 48 { return Err("таблица короче 48 байт".into()); }
    let ft = &f[f.len() - 48..];
    if u64::from_le_bytes(ft[40..48].try_into().unwrap()) != 0xdb4775248b80fb57 { return Err("не таблица LevelDB".into()); }
    let mut p = 0;
    let _mo = varint(ft, &mut p); let _ms = varint(ft, &mut p);
    let io = varint(ft, &mut p).ok_or("индекс")? as usize; let is = varint(ft, &mut p).ok_or("индекс")? as usize;
    let idx = read_block(f, io, is).ok_or("индекс таблицы не читается")?;
    for (_, h) in block_entries(&idx).ok_or("индекс таблицы повреждён")? {
        let mut q = 0; let o = varint(&h, &mut q).ok_or("ссылка")? as usize; let s = varint(&h, &mut q).ok_or("ссылка")? as usize;
        let blk = read_block(f, o, s).ok_or("блок таблицы не читается")?;
        for (ik, v) in block_entries(&blk).ok_or("блок таблицы повреждён")? {
            if ik.len() < 8 { continue; }
            let tr = u64::from_le_bytes(ik[ik.len() - 8..].try_into().unwrap());
            let (seq, ty) = (tr >> 8, tr & 0xff);
            put(m, ik[..ik.len() - 8].to_vec(), seq, if ty == 1 { Some(v) } else { None });
        }
    }
    Ok(())
}

fn read_log(f: &[u8], m: &mut Ent) {
    const BS: usize = 32768;
    let mut rec: Vec<u8> = Vec::new(); let mut p = 0;
    while p + 7 <= f.len() {
        let left = BS - p % BS;
        if left < 7 { p += left; continue; }
        let len = u16::from_le_bytes([f[p + 4], f[p + 5]]) as usize; let ty = f[p + 6];
        let Some(d) = f.get(p + 7..p + 7 + len) else { break };
        p += 7 + len;
        match ty {
            1 => { batch(d, m); rec.clear(); }
            2 => { rec.clear(); rec.extend_from_slice(d); }
            3 => rec.extend_from_slice(d),
            4 => { rec.extend_from_slice(d); let r = std::mem::take(&mut rec); batch(&r, m); }
            _ => {}
        }
    }
}

fn batch(b: &[u8], m: &mut Ent) {
    if b.len() < 12 { return; }
    let seq = u64::from_le_bytes(b[0..8].try_into().unwrap()); let n = u32::from_le_bytes(b[8..12].try_into().unwrap()) as u64;
    let mut p = 12;
    for i in 0..n {
        let Some(&ty) = b.get(p) else { return }; p += 1;
        let Some(kl) = varint(b, &mut p) else { return }; let Some(k) = b.get(p..p + kl as usize) else { return }; let k = k.to_vec(); p += kl as usize;
        if ty == 1 {
            let Some(vl) = varint(b, &mut p) else { return }; let Some(v) = b.get(p..p + vl as usize) else { return }; let v = v.to_vec(); p += vl as usize;
            put(m, k, seq + i, Some(v));
        } else { put(m, k, seq + i, None); }
    }
}

/// Все живые записи базы LevelDB (ключ → значение). Ошибки отдельных файлов — в список ошибок.
pub fn read_db(dir: &Path) -> Result<(Vec<(Vec<u8>, Vec<u8>)>, Vec<String>), String> {
    let mut m: Ent = HashMap::new(); let mut errs = Vec::new();
    let rd = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for e in rd.flatten() {
        let p = e.path(); let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let Ok(f) = std::fs::read(&p) else { continue };
        if name.ends_with(".ldb") || name.ends_with(".sst") { if let Err(x) = read_table(&f, &mut m) { errs.push(format!("{name}: {x}")); } }
        else if name.ends_with(".log") && name != "LOG" { read_log(&f, &mut m); }
    }
    Ok((m.into_iter().filter_map(|(k, (_, v))| v.map(|v| (k, v))).collect(), errs))
}

fn decode(b: &[u8]) -> Option<String> {
    match b.first()? {
        0 => { let u: Vec<u16> = b[1..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect(); String::from_utf16(&u).ok() }
        1 => Some(b[1..].iter().map(|&c| c as char).collect()),
        _ => None,
    }
}

/// localStorage одного источника (например, "file://") из базы Chromium → имя → значение.
pub fn local_storage(dir: &Path, origin: &str) -> Result<(HashMap<String, String>, Vec<String>), String> {
    let (all, errs) = read_db(dir)?;
    let mut pre = b"_".to_vec(); pre.extend_from_slice(origin.as_bytes()); pre.push(0);
    let mut out = HashMap::new();
    for (k, v) in all {
        if !k.starts_with(&pre) { continue; }
        if let (Some(name), Some(val)) = (decode(&k[pre.len()..]), decode(&v)) { out.insert(name, val); }
    }
    Ok((out, errs))
}

#[cfg(test)]
mod tests {
    use super::*;
    // настоящая база localStorage Chromium (создана браузером: три сеанса, перезапись, удаление, длинное значение,
    // кириллица и эмодзи) — lab-media/chromium-localstorage
    #[test]
    fn reads_real_chromium_local_storage() {
        let dir = std::path::PathBuf::from(format!("{}/../lab-media/chromium-localstorage", env!("CARGO_MANIFEST_DIR")));
        let (ls, errs) = local_storage(&dir, "file://").unwrap();
        assert!(errs.is_empty(), "{errs:?}");
        assert_eq!(ls.get("pulse.settings").map(|s| s.as_str()), Some(r#"{"theme":"light","accent":"violet","n":2}"#), "перезапись — побеждает новая");
        assert!(!ls.contains_key("pulse.deleted"), "удалённое не должно вернуться");
        assert!(ls.get("pulse.likes").unwrap().contains("Café — naïve ★") && ls.get("pulse.likes").unwrap().contains("Танцуй"));
        assert!(ls.get("pulse.playlists").unwrap().contains("🎧"));
        assert_eq!(ls.get("pulse.big").map(|s| s.len()), Some(150000));
        assert_eq!((0..300).filter(|i| ls.contains_key(&format!("pulse.hist.{i}"))).count(), 150);
        assert!(ls.contains_key("pulse.hist.1") && !ls.contains_key("pulse.hist.0"));
        assert_eq!(ls.get("other.key").map(|s| s.as_str()), Some("not ours"));
    }
    #[test]
    fn snappy_literal() {
        assert!(snappy(&[5, 4 << 2, b'h', b'e', b'l', b'l', b'o']).as_deref() == Some(b"hello".as_ref()));
    }
}
