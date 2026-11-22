//! Где программа хранит свои секреты: токен Яндекса и ключи друзей.
//!
//! Windows — «Диспетчер учётных данных» (keyring), как раньше.
//! Mac — с 0.42 защищённый файл `secrets.json` в папке данных программы (доступ только у владельца, 0600), а не
//! Связка ключей. Причина (решение владельца 23.11.2026): программа подписана без сертификата Apple, и Связка ключей
//! узнаёт её по отпечатку конкретной сборки — после каждого обновления macOS заново просит пароль на каждую запись,
//! а «Разрешать всегда» действует только до следующей версии.
//!
//! Переезд на Mac — по одной записи и один раз: если записи в файле ещё нет, она один раз читается из Связки ключей
//! (последний запрос пароля), кладётся в файл, и запись отмечается как проверенная — больше в Связку ключей программа
//! за ней не ходит. Связку ключей при этом не трогаем (удаление тоже спросило бы пароль). Отказали в доступе —
//! запись не отмечается, и в следующий раз программа попробует снова.
use std::path::PathBuf;
use std::sync::OnceLock;
#[cfg(target_os = "macos")]
use std::sync::Mutex;

const SERVICE: &str = if crate::RELEASE { "ru.pulse.desktop" } else { "ru.pulse.desktop.tauritest" };
static DIR: OnceLock<PathBuf> = OnceLock::new();
#[cfg(target_os = "macos")]
static LOCK: Mutex<()> = Mutex::new(());

/// папка данных программы — до первого обращения к секретам (setup)
pub fn init(dir: PathBuf) { let _ = DIR.set(dir); }

/// где лежат секреты — для журнала
pub fn place() -> &'static str { if cfg!(target_os = "macos") { "защищённый файл" } else if cfg!(target_os = "windows") { "Диспетчер учётных данных" } else { "Связка ключей" } }

fn kc_read(user: &str) -> Result<Option<String>, String> {
    match keyring::Entry::new(SERVICE, user).and_then(|e| e.get_password()) {
        Ok(v) => Ok(Some(v).filter(|s| !s.is_empty())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn get(user: &str) -> Result<Option<String>, String> { kc_read(user) }

#[cfg(not(target_os = "macos"))]
pub fn set(user: &str, v: &str) -> Result<(), String> {
    let e = keyring::Entry::new(SERVICE, user).map_err(|e| e.to_string())?;
    if v.is_empty() { let _ = e.delete_credential(); return Ok(()); }
    e.set_password(v).map_err(|e| e.to_string())?;
    if e.get_password().map_err(|e| e.to_string())? != v { return Err("хранилище вернуло другое значение".into()); }
    Ok(())
}

// ——— Mac: файл ———
#[cfg(target_os = "macos")]
use serde_json::{json, Value};

#[cfg(target_os = "macos")]
fn file() -> Result<PathBuf, String> { DIR.get().map(|d| d.join("secrets.json")).ok_or_else(|| "папка данных ещё не известна".into()) }

#[cfg(target_os = "macos")]
fn load() -> Value {
    let v = file().ok().and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<Value>(&b).ok()).unwrap_or(Value::Null);
    if v.is_object() { v } else { json!({ "v": 1, "items": {}, "checked": [] }) }
}

#[cfg(target_os = "macos")]
fn save(v: &Value) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let p = file()?;
    if let Some(d) = p.parent() { std::fs::create_dir_all(d).map_err(|e| e.to_string())?; }
    let tmp = p.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    f.write_all(v.to_string().as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, &p).map_err(|e| format!("{}: {e}", p.display()))
}

#[cfg(target_os = "macos")]
fn checked(v: &Value, user: &str) -> bool { v["checked"].as_array().map_or(false, |a| a.iter().any(|x| x == user)) }

#[cfg(target_os = "macos")]
fn mark(v: &mut Value, user: &str) {
    if !v["checked"].is_array() { v["checked"] = json!([]); }
    if !checked(v, user) { if let Some(a) = v["checked"].as_array_mut() { a.push(json!(user)); } }
}

#[cfg(target_os = "macos")]
pub fn get(user: &str) -> Result<Option<String>, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut v = load();
    if let Some(s) = v["items"][user].as_str() { return Ok(Some(s.to_string()).filter(|s| !s.is_empty())); }
    if checked(&v, user) { return Ok(None); }
    // один раз — из Связки ключей прежних версий
    let old = kc_read(user)?;
    if !v["items"].is_object() { v["items"] = json!({}); }
    if let Some(s) = &old { v["items"][user] = json!(s); }
    mark(&mut v, user);
    save(&v)?;
    Ok(old)
}

#[cfg(target_os = "macos")]
pub fn set(user: &str, val: &str) -> Result<(), String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut v = load();
    if !v["items"].is_object() { v["items"] = json!({}); }
    if val.is_empty() { if let Some(m) = v["items"].as_object_mut() { m.remove(user); } } else { v["items"][user] = json!(val); }
    mark(&mut v, user);   // записали сами — прежнее значение из Связки ключей больше не нужно
    save(&v)?;
    let back = load();
    if back["items"][user].as_str().unwrap_or("") != val { return Err("файл вернул другое значение".into()); }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn mac_file_roundtrip_private() {
        let d = std::env::temp_dir().join(format!("pulse-secrets-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        init(d.clone());
        set("test-a", "значение 1").unwrap();
        assert_eq!(get("test-a").unwrap().as_deref(), Some("значение 1"));
        set("test-a", "").unwrap();
        assert_eq!(get("test-a").unwrap(), None);   // отмечена — в Связку ключей уже не ходит
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(d.join("secrets.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_dir_all(&d);
    }
}
