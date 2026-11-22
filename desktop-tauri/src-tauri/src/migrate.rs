// Этап 5: перенос данных пользователя из Electron-версии «Пульса».
//
// Правила владельца: данные Electron не удаляются и не перезаписываются (только читаются); перед переносом —
// резервная копия; есть возврат «как было до переноса».
//
// Что где лежит у Electron-версии (папка данных: macOS ~/Library/Application Support/Pulse, Windows %APPDATA%\Pulse):
//  • «Local Storage/leveldb» — хранилище интерфейса (localStorage источника file://): лайки, плейлисты, история,
//    статистика, настройки, достижения… — все записи «pulse.*»;
//  • secure-token.bin — токен Яндекса; social.bin — ключи друзей (сеанс, ключ шифрования, номер устройства);
//    первый байт 1 — зашифровано safeStorage Electron (ключ в Связке ключей: «Pulse Safe Storage»), 0 — открыто;
//  • local-library.json и local-covers/ — своя музыка (переносится как файлы, подключится на этапе 6).
//
// Как переносится:
//  1. Копия всего перечисленного → <данные Tauri>/migration/backup-<время>/electron/ (сверка размеров).
//  2. Из копии читается localStorage (ldb.rs) → migration/pending.json; при следующем открытии окна «Пульса»
//     программа передаёт его окну до запуска интерфейса, мост записывает записи и сверяет каждую (migrate_applied).
//     Прежние записи Tauri-версии сохраняются (migration/before-localstorage.json — один раз, до первого переноса).
//  3. Токен и ключи друзей расшифровываются и кладутся в Связку ключей этой программы; прежние значения Tauri —
//     в отдельные записи «…before-import» (для возврата).
//  4. Возврат: migrate_restore — прежние записи Tauri (localStorage, токен, ключи друзей) возвращаются.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::Manager;

const KS: &str = "ru.pulse.desktop.tauritest";
static RUN: Mutex<()> = Mutex::new(());

fn now_stamp() -> (u64, String) {
    let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    (s, format!("{s}"))
}

pub fn electron_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    { std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support/Pulse")) }
    #[cfg(target_os = "windows")]
    { std::env::var_os("APPDATA").map(|h| PathBuf::from(h).join("Pulse")) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"))).map(|d| d.join("Pulse")) }
}

fn mig_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("migration");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}
fn read_json(p: &Path) -> Option<Value> { std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok()) }
fn write_private(p: &Path, s: &str) -> Result<(), String> {
    std::fs::write(p, s).map_err(|e| format!("{}: {e}", p.display()))?;
    #[cfg(unix)]
    { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600)); }
    Ok(())
}

// ——— копия ———
fn copy_tree(from: &Path, to: &Path, files: &mut u64, bytes: &mut u64) -> Result<(), String> {
    let md = std::fs::symlink_metadata(from).map_err(|e| format!("{}: {e}", from.display()))?;
    if md.is_dir() {
        std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
            let n = e.file_name();
            if n == "LOCK" { continue; }   // замок открытой базы — не данные
            copy_tree(&e.path(), &to.join(&n), files, bytes)?;
        }
    } else if md.is_file() {
        let n = std::fs::copy(from, to).map_err(|e| format!("{}: {e}", from.display()))?;
        if n != md.len() { return Err(format!("{}: скопировано {n} из {} байт", from.display(), md.len())); }
        *files += 1; *bytes += n;
    }
    Ok(())
}
const ITEMS: [&str; 8] = ["Local Storage", "secure-token.bin", "social.bin", "local-library.json", "local-covers", "window.json", "perf.json", "online-id"];

// ——— safeStorage Electron ———
#[cfg(target_os = "macos")]
fn safe_key() -> Result<Vec<u8>, String> {
    // Electron: служба «<имя> Safe Storage», учётная запись «<имя>» (на случай другой версии — «<имя> Key»)
    let mut last = String::new();
    for acc in ["Pulse", "Pulse Key"] {
        match keyring::Entry::new("Pulse Safe Storage", acc).and_then(|e| e.get_password()) {
            Ok(pw) => {
                let mut k = vec![0u8; 16];
                pbkdf2::pbkdf2_hmac::<sha1::Sha1>(pw.as_bytes(), b"saltysalt", 1003, &mut k);
                return Ok(k);
            }
            Err(e) => last = format!("{acc}: {e}"),
        }
    }
    Err(format!("ключ «Pulse Safe Storage» в Связке ключей не получен ({last})"))
}
#[cfg(not(target_os = "macos"))]
fn safe_key() -> Result<Vec<u8>, String> { Err("расшифровка данных Electron на этой системе ещё не сделана — нужен повторный вход".into()) }

/// macOS: "v10" + AES-128-CBC (IV — 16 пробелов, PKCS#7), ключ — PBKDF2-SHA1(пароль из Связки, "saltysalt", 1003)
pub fn safe_decrypt_with(key: &[u8], data: &[u8]) -> Result<String, String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let body = data.strip_prefix(b"v10").ok_or("неизвестный формат шифрования (нет v10)")?;
    if key.len() != 16 { return Err("ключ не того размера".into()); }
    let pt = cbc::Decryptor::<aes::Aes128>::new_from_slices(key, &[b' '; 16]).map_err(|e| e.to_string())?
        .decrypt_padded_vec_mut::<Pkcs7>(body).map_err(|_| "не расшифровалось (ключ не подошёл)".to_string())?;
    String::from_utf8(pt).map_err(|_| "расшифровалось не в текст".into())
}

/// файл Electron (первый байт: 1 — safeStorage, 0 — открыто) → текст
fn read_secret_file(p: &Path, key: &mut Option<Result<Vec<u8>, String>>) -> Result<Option<String>, String> {
    let b = match std::fs::read(p) { Ok(b) => b, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None), Err(e) => return Err(e.to_string()) };
    match b.first() {
        Some(0) => Ok(Some(String::from_utf8_lossy(&b[1..]).to_string())),
        Some(1) => {
            let k = key.get_or_insert_with(safe_key).clone()?;
            safe_decrypt_with(&k, &b[1..]).map(Some)
        }
        _ => Err("пустой или неизвестный файл".into()),
    }
}

// ——— хранилище ключей друзей в этой программе (как токен: Связка ключей, запасной файл 0600) ———
fn kc_get(user: &str) -> Option<String> { keyring::Entry::new(KS, user).and_then(|e| e.get_password()).ok().filter(|s| !s.is_empty()) }
fn kc_set(user: &str, v: &str) -> Result<(), String> {
    let e = keyring::Entry::new(KS, user).map_err(|e| e.to_string())?;
    if v.is_empty() { let _ = e.delete_credential(); return Ok(()); }
    e.set_password(v).map_err(|e| e.to_string())?;
    if e.get_password().map_err(|e| e.to_string())? != v { return Err("Связка ключей вернула другое значение".into()); }
    Ok(())
}
fn social_file(app: &tauri::AppHandle) -> Option<PathBuf> { app.path().app_data_dir().ok().map(|d| d.join("social.json")) }
pub fn social_read(app: &tauri::AppHandle) -> Value {
    let s = kc_get("social").or_else(|| social_file(app).and_then(|p| std::fs::read_to_string(p).ok())).unwrap_or_default();
    serde_json::from_str(&s).unwrap_or_else(|_| json!({}))
}
pub fn social_write(app: &tauri::AppHandle, v: &Value) -> Result<String, String> {
    let s = v.to_string();
    match kc_set("social", &s) {
        Ok(()) => { if let Some(p) = social_file(app) { let _ = std::fs::remove_file(p); } Ok("Связка ключей".into()) }
        Err(e) => { let p = social_file(app).ok_or("нет папки данных")?; if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); } write_private(&p, &s)?; Ok(format!("запасной файл (Связка ключей: {e})")) }
    }
}

// ——— сводка: что перенесено ———
fn summary(ls: &HashMap<String, String>) -> Value {
    let named = [("pulse.likes", "лайки"), ("pulse.playlists", "плейлисты"), ("pulse.recent", "недавнее"), ("pulse.heard", "история прослушиваний"), ("pulse.opened", "недавно открытые"), ("pulse.follow", "избранные исполнители"), ("pulse.banned", "скрытые"), ("pulse.stats", "статистика"), ("pulse.daySum", "статистика по дням"), ("pulse.ach", "достижения"), ("pulse.settings", "настройки"), ("pulse.sound", "звук"), ("pulse.acct", "аккаунт")];
    let mut items = Vec::new();
    for (k, n) in named {
        let v = match ls.get(k) { None => "нет".to_string(), Some(s) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Array(a)) => format!("{} шт.", a.len()),
            Ok(Value::Object(o)) => { let arr = o.values().filter_map(|x| x.as_array()).map(|a| a.len()).sum::<usize>(); if arr > 0 { format!("{} полей, {} записей", o.len(), arr) } else { format!("{} полей", o.len()) } }
            _ => format!("{} символов", s.len()),
        } };
        items.push(json!({ "k": k, "name": n, "v": v }));
    }
    json!({ "keys": ls.len(), "bytes": ls.values().map(|v| v.len()).sum::<usize>(), "items": items })
}

fn own_key(k: &str) -> bool { k.starts_with("pulse.") && !k.starts_with("pulse.tauritest.") && k != "pulse.engine" && !k.starts_with("pulse.migrate") }

/// Перенос: копия, чтение, токен и ключи друзей → Связка ключей, localStorage → ожидает открытия окна.
pub fn prepare(app: &tauri::AppHandle) -> Result<Value, String> {
    let _g = RUN.lock().map_err(|_| "занято")?;
    let md = mig_dir(app)?;
    let (ts, stamp) = now_stamp();
    let mut rep = json!({ "at": ts, "stamp": stamp, "errors": [] });
    let errs = |rep: &mut Value, m: String| { if let Some(a) = rep["errors"].as_array_mut() { a.push(json!(m)); } };
    let Some(ed) = electron_dir().filter(|d| d.is_dir()) else {
        rep["status"] = json!("no-electron");
        rep["electron"] = json!(electron_dir().map(|d| d.display().to_string()));
        write_private(&md.join("state.json"), &rep.to_string())?;
        return Ok(rep);
    };
    rep["electron"] = json!(ed.display().to_string());
    // 1. резервная копия
    let bd = md.join(format!("backup-{stamp}"));
    let be = bd.join("electron");
    std::fs::create_dir_all(&be).map_err(|e| e.to_string())?;
    let (mut files, mut bytes) = (0u64, 0u64);
    let mut copied = Vec::new();
    for it in ITEMS {
        let p = ed.join(it);
        if !p.exists() { continue; }
        match copy_tree(&p, &be.join(it), &mut files, &mut bytes) { Ok(()) => copied.push(it), Err(e) => errs(&mut rep, format!("копия {it}: {e}")) }
    }
    rep["backup"] = json!({ "dir": bd.display().to_string(), "files": files, "bytes": bytes, "items": copied });
    // 2. localStorage из копии
    let ldb = be.join("Local Storage").join("leveldb");
    let mut ls: HashMap<String, String> = HashMap::new();
    if ldb.is_dir() {
        match crate::ldb::local_storage(&ldb, "file://") {
            Ok((all, e2)) => { for e in e2 { errs(&mut rep, format!("хранилище: {e}")); } ls = all.into_iter().filter(|(k, _)| own_key(k)).collect(); }
            Err(e) => errs(&mut rep, format!("хранилище не прочиталось: {e}")),
        }
    } else { errs(&mut rep, "у Electron нет хранилища интерфейса (Local Storage)".into()); }
    rep["ls"] = summary(&ls);
    write_private(&bd.join("imported-localstorage.json"), &serde_json::to_string(&ls).unwrap_or_default())?;
    write_private(&md.join("pending.json"), &json!({ "stamp": stamp, "ls": ls }).to_string())?;
    // 3. токен и ключи друзей (прежние значения этой программы — для возврата, один раз)
    let mut key: Option<Result<Vec<u8>, String>> = None;
    if kc_get("before-import.saved").is_none() {
        let (t0, _) = crate::token_get(app);
        let _ = kc_set("yandex-token.before-import", &t0);
        let _ = kc_set("social.before-import", &social_read(app).to_string());
        let _ = kc_set("before-import.saved", "1");
    }
    match read_secret_file(&be.join("secure-token.bin"), &mut key) {
        Ok(Some(t)) if !t.trim().is_empty() => match crate::token_set(app.clone(), t.trim().to_string()) { Ok(w) => rep["token"] = json!(format!("перенесён ({w})")), Err(e) => { rep["token"] = json!("не сохранён"); errs(&mut rep, format!("токен: {e}")); } },
        Ok(_) => rep["token"] = json!("у Electron токена нет"),
        Err(e) => { rep["token"] = json!("не перенесён"); errs(&mut rep, format!("токен: {e}")); }
    }
    match read_secret_file(&be.join("social.bin"), &mut key) {
        Ok(Some(s)) => match serde_json::from_str::<Value>(&s) {
            Ok(v) => {
                let has: Vec<&str> = ["session", "key", "devId", "me"].into_iter().filter(|k| v.get(*k).and_then(|x| x.as_str()).map(|x| !x.is_empty()).unwrap_or(false)).collect();
                match social_write(app, &v) { Ok(w) => rep["social"] = json!(format!("перенесены: {} ({w})", if has.is_empty() { "пусто".to_string() } else { has.join(", ") })), Err(e) => { rep["social"] = json!("не сохранены"); errs(&mut rep, format!("ключи друзей: {e}")); } }
            }
            Err(e) => { rep["social"] = json!("не перенесены"); errs(&mut rep, format!("ключи друзей: не JSON ({e})")); }
        },
        Ok(None) => rep["social"] = json!("у Electron ключей друзей нет"),
        Err(e) => { rep["social"] = json!("не перенесены"); errs(&mut rep, format!("ключи друзей: {e}")); }
    }
    // 4. своя музыка — файлы рядом с данными этой программы (подключится на этапе 6)
    if let Ok(dd) = app.path().app_data_dir() {
        let mut n = None;
        if let Some(v) = read_json(&be.join("local-library.json")) {
            let _ = std::fs::copy(be.join("local-library.json"), dd.join("electron-local-library.json"));
            n = Some(v.get("tracks").and_then(|t| t.as_array()).map(|a| a.len()).or_else(|| v.as_array().map(|a| a.len())).unwrap_or(0));
        }
        if be.join("local-covers").is_dir() { let (mut f, mut b) = (0, 0); let _ = copy_tree(&be.join("local-covers"), &dd.join("electron-local-covers"), &mut f, &mut b); }
        rep["local"] = json!(match n { Some(n) => format!("список своей музыки сохранён ({n} записей) — подключится на этапе 6"), None => "у Electron своей музыки нет".into() });
    }
    rep["status"] = json!("pending");
    write_private(&md.join("state.json"), &rep.to_string())?;
    write_private(&bd.join("report.json"), &rep.to_string())?;
    Ok(rep)
}

/// Первый запуск: если переноса ещё не было — сделать (владелец выбрал «сам при первом запуске»).
pub fn auto(app: &tauri::AppHandle) {
    let Ok(md) = mig_dir(app) else { return };
    if md.join("state.json").exists() { return; }
    if let Err(e) = prepare(app) { let _ = write_private(&md.join("state.json"), &json!({ "status": "error", "error": e }).to_string()); }
}

/// Скрипт для окна «Пульса» (до запуска интерфейса): перенесённые записи или возврат «как было».
pub fn window_script(app: &tauri::AppHandle) -> String {
    let Ok(md) = mig_dir(app) else { return String::new() };
    if let Ok(s) = std::fs::read_to_string(md.join("restore.json")) { return format!("window.__PULSE_RESTORE__ = {s};"); }
    if let Ok(s) = std::fs::read_to_string(md.join("pending.json")) { return format!("window.__PULSE_IMPORT__ = {s};"); }
    String::new()
}

/// Мост записал перенесённые записи. before — прежние записи окна (сохраняются один раз — до первого переноса).
pub fn applied(app: &tauri::AppHandle, stamp: String, before: String, n: u64, bad: Vec<String>) -> Result<(), String> {
    let md = mig_dir(app)?;
    let bp = md.join("before-localstorage.json");
    if !bp.exists() { write_private(&bp, &before)?; }
    let mut st = read_json(&md.join("state.json")).unwrap_or_else(|| json!({}));
    st["status"] = json!(if bad.is_empty() { "applied" } else { "applied-with-errors" });
    st["applied"] = json!({ "stamp": stamp, "written": n, "bad": bad, "at": now_stamp().0 });
    write_private(&md.join("state.json"), &st.to_string())?;
    let _ = std::fs::remove_file(md.join("pending.json"));
    Ok(())
}

pub fn status(app: &tauri::AppHandle) -> Value {
    let Ok(md) = mig_dir(app) else { return json!({ "status": "error" }) };
    let mut st = read_json(&md.join("state.json")).unwrap_or_else(|| json!({ "status": "none" }));
    st["canRestore"] = json!(md.join("before-localstorage.json").exists());
    st
}

/// Вернуть «как было до переноса»: прежние записи окна (при следующем открытии), токен, ключи друзей.
pub fn restore(app: &tauri::AppHandle) -> Result<Value, String> {
    let _g = RUN.lock().map_err(|_| "занято")?;
    let md = mig_dir(app)?;
    let before = std::fs::read_to_string(md.join("before-localstorage.json")).map_err(|_| "нет сохранённых прежних данных — перенос ещё не применялся")?;
    write_private(&md.join("restore.json"), &json!({ "ls": serde_json::from_str::<Value>(&before).unwrap_or_else(|_| json!({})) }).to_string())?;
    let _ = std::fs::remove_file(md.join("pending.json"));
    let mut rep = json!({});
    if kc_get("before-import.saved").is_some() {
        let t = kc_get("yandex-token.before-import").unwrap_or_default();
        rep["token"] = json!(match crate::token_set(app.clone(), t.clone()) { Ok(_) if t.is_empty() => "токена до переноса не было — удалён".to_string(), Ok(w) => format!("возвращён ({w})"), Err(e) => format!("ошибка: {e}") });
        let s: Value = kc_get("social.before-import").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| json!({}));
        rep["social"] = json!(match social_write(app, &s) { Ok(w) => format!("возвращены ({w})"), Err(e) => format!("ошибка: {e}") });
    }
    let mut st = read_json(&md.join("state.json")).unwrap_or_else(|| json!({}));
    st["status"] = json!("restore-pending");
    write_private(&md.join("state.json"), &st.to_string())?;
    Ok(rep)
}

pub fn restored(app: &tauri::AppHandle) -> Result<(), String> {
    let md = mig_dir(app)?;
    let _ = std::fs::remove_file(md.join("restore.json"));
    let mut st = read_json(&md.join("state.json")).unwrap_or_else(|| json!({}));
    st["status"] = json!("restored");
    write_private(&md.join("state.json"), &st.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    // проверочный вектор: зашифровано так же, как safeStorage Electron на macOS (Node.js crypto: PBKDF2-SHA1 1003,
    // AES-128-CBC, IV из 16 пробелов), пароль «test-password», текст «y0_проверка_токена»
    #[test]
    fn decrypts_electron_safe_storage_mac_format() {
        let mut k = vec![0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"test-password", b"saltysalt", 1003, &mut k);
        let ct = hex(include_str!("../../lab-media/safestorage-vector.hex").trim());
        assert_eq!(safe_decrypt_with(&k, &ct).unwrap(), "y0_проверка_токена");
        let mut bad = ct.clone(); let n = bad.len(); bad[n - 1] ^= 1;
        assert!(safe_decrypt_with(&k, &bad).is_err());
        assert!(safe_decrypt_with(&k, b"v11abc").is_err());
    }
    fn hex(s: &str) -> Vec<u8> { (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect() }

    #[test]
    fn copy_keeps_source_and_sizes() {
        let t = std::env::temp_dir().join(format!("pulse-mig-{}", std::process::id()));
        let src = t.join("src"); let dst = t.join("dst");
        std::fs::create_dir_all(src.join("Local Storage/leveldb")).unwrap();
        std::fs::write(src.join("Local Storage/leveldb/000003.ldb"), vec![7u8; 5000]).unwrap();
        std::fs::write(src.join("Local Storage/leveldb/LOCK"), b"").unwrap();
        std::fs::write(src.join("secure-token.bin"), b"\x01v10abc").unwrap();
        let before: Vec<(PathBuf, u64)> = walk(&src);
        let (mut f, mut b) = (0, 0);
        for it in ITEMS { if src.join(it).exists() { copy_tree(&src.join(it), &dst.join(it), &mut f, &mut b).unwrap(); } }
        assert_eq!(f, 2); assert_eq!(b, 5000 + 7);
        assert_eq!(walk(&src), before, "исходные файлы Electron не должны меняться");
        assert!(!dst.join("Local Storage/leveldb/LOCK").exists());
        let _ = std::fs::remove_dir_all(&t);
    }
    fn walk(d: &Path) -> Vec<(PathBuf, u64)> {
        let mut v = Vec::new();
        for e in std::fs::read_dir(d).unwrap().flatten() { let p = e.path(); if p.is_dir() { v.extend(walk(&p)); } else { v.push((p.clone(), std::fs::metadata(&p).unwrap().len())); } }
        v.sort(); v
    }

    #[test]
    fn own_keys_only() {
        assert!(own_key("pulse.likes") && own_key("pulse.u.abc") && !own_key("pulse.tauritest.alive") && !own_key("pulse.engine") && !own_key("other"));
        let mut m = HashMap::new(); m.insert("pulse.likes".to_string(), "[1,2,3]".to_string()); m.insert("pulse.stats".to_string(), r#"{"a":[1,2],"b":3}"#.to_string());
        let s = summary(&m); assert_eq!(s["keys"], 2);
        assert_eq!(s["items"][0]["v"], "3 шт.");
    }
}
