// Обновления Tauri-версии «Пульса» по воздуху — перенос updater.js (ветка «новый движок» для Mac).
//
// Откуда и чем проверяется — как в Electron-версии: latest.json (релиз GitHub, raw.githubusercontent.com, jsDelivr),
// подпись разработчика Ed25519 (тот же открытый ключ, что в updsign.js; закрытый — только у разработчика), mac.json
// того же релиза: адрес архива Pulse.app для этого Mac, его SHA-256, размер и подпись.
//
// Tauri-программа — один бандл, поэтому обновление всегда «программа целиком»: архив скачивается рядом со старой
// программой (нет прав — во временную папку), сверяется SHA-256 и размер, распаковывается (ditto), проверяются версия
// и движок в Contents/Resources/app/package.json (только «tauri» — Tauri-программа не заменит себя Electron-версией),
// снимается карантин и проверяется подпись (codesign --verify --deep). После «Перезапустить» (или при выходе из
// программы) маленький скрипт ждёт выхода, меняет старую программу на новую (не вышло — возвращает старую) и
// запускает её. Данные, вход и настройки не трогаются — они не внутри программы.
//
// Тот же файл package.json внутри бандла нужен и Electron-версии: её обновление «новый движок» проверяет именно его —
// так обычный «Пульс» сможет обновиться на Tauri-версию по воздуху.
//
// Тестовый канал (только в тестовых сборках): лента и подпись — тестовые (свой тестовый ключ), сравнение — по номеру
// сборки; так проверяем обновление, не выпуская настоящих версий.
//
// Windows: пока нет (Tauri-версия для Windows ещё не проверялась).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const KEY: &str = "0YOwoaasY+1McD/zRxs0yNs3eywt/TCfmjYyMDkCuIs=";
/// тестовый открытый ключ (закрытый — только у разработчика, не в репозитории); действует только на тестовом канале
const TEST_KEY: &str = "s3Eo5P9v17NryrIkpgT8ZajAPhfx8sZxv8xinhNBuZc=";
const REPO: &str = "oqelon/pulsmusic.develop";
const FEED: &str = "https://github.com/oqelon/pulsmusic.develop/releases/latest/download/latest.json";
const API_LATEST: &str = "https://api.github.com/repos/oqelon/pulsmusic.develop/releases/latest";
const PKG_PREFIX: &str = "https://github.com/oqelon/pulsmusic.develop/releases/download/";
/// тестовая лента может лежать и в самом репозитории (папка updates/tauri-test ветки tauri-migration)
const TEST_RAW: &str = "https://raw.githubusercontent.com/oqelon/pulsmusic.develop/";

/// номер тестовой сборки (CI задаёт PULSE_BUILD); у местной сборки — 0
pub fn build_no() -> u64 { option_env!("PULSE_BUILD").and_then(|s| s.parse().ok()).unwrap_or(0) }
/// тестовый канал разрешён только в тестовых сборках
pub fn test_allowed() -> bool { option_env!("PULSE_RELEASE").is_none() }

struct Staged { version: String, build: u64, from: PathBuf, to: PathBuf, work: PathBuf, admin: bool, swapped: bool }
#[derive(Default)]
struct St { latest: Option<Value>, staged: Option<Staged>, test_feed: Option<String>, preparing: bool }
static ST: Mutex<St> = Mutex::new(St { latest: None, staged: None, test_feed: None, preparing: false });
fn st() -> std::sync::MutexGuard<'static, St> { ST.lock().unwrap_or_else(|e| e.into_inner()) }

// ——— подписи ———

pub(crate) fn b64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut acc, mut n) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' | b'-' => 62, b'/' | b'_' => 63, b'=' => break, b'\n' | b'\r' | b' ' => continue, _ => return None } as u32;
        acc = (acc << 6) | v; n += 6;
        if n >= 8 { n -= 8; out.push((acc >> n) as u8); acc &= (1 << n) - 1; }
    }
    Some(out)
}
fn hex_ok(s: &str) -> bool { s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()) }
fn sv(m: &Value, k: &str) -> String { match &m[k] { Value::String(s) => s.clone(), Value::Number(n) => n.to_string(), _ => String::new() } }
fn num(m: &Value, k: &str) -> u64 { m[k].as_u64().or_else(|| m[k].as_f64().map(|f| f as u64)).unwrap_or(0) }

pub fn pkg_msg(m: &Value) -> String { ["PULSE-UPDATE-V1", &sv(m, "version"), &sv(m, "sha256").to_lowercase(), &num(m, "size").to_string(), &sv(m, "minElectron")].join("\n") }
pub fn mac_msg(v: &str, arch: &str, a: &Value) -> String { ["PULSE-MAC-V1", v, arch, &sv(a, "sha256").to_lowercase(), &num(a, "size").to_string()].join("\n") }

pub fn good(msg: &str, sig: &str, key: &str) -> bool {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let (Some(k), Some(s)) = (b64(key), b64(sig)) else { return false };
    let (Ok(k), Ok(s)) = (<[u8; 32]>::try_from(k.as_slice()), <[u8; 64]>::try_from(s.as_slice())) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&k) else { return false };
    vk.verify(msg.as_bytes(), &Signature::from_bytes(&s)).is_ok()
}
fn verify_pkg(m: &Value, key: &str) -> bool { !sv(m, "version").is_empty() && hex_ok(&sv(m, "sha256")) && num(m, "size") > 0 && good(&pkg_msg(m), &sv(m, "sig"), key) }
/// Windows: установщик Tauri-версии (win.json), та же схема подписи с другой меткой
pub fn win_msg(v: &str, arch: &str, a: &Value) -> String { ["PULSE-WIN-V1", v, arch, &sv(a, "sha256").to_lowercase(), &num(a, "size").to_string()].join("\n") }
fn verify_win(v: &str, arch: &str, a: &Value, key: &str) -> bool { hex_ok(&sv(a, "sha256")) && num(a, "size") > 0 && good(&win_msg(v, arch, a), &sv(a, "sig"), key) }
fn verify_mac(v: &str, arch: &str, a: &Value, key: &str) -> bool { hex_ok(&sv(a, "sha256")) && num(a, "size") > 0 && good(&mac_msg(v, arch, a), &sv(a, "sig"), key) }

/// «0.9.10» > «0.9.9»
pub fn newer(a: &str, b: &str) -> bool {
    let p = |s: &str| s.split(['.', '-']).map(|x| x.trim().parse::<i64>().unwrap_or(0)).collect::<Vec<_>>();
    let (pa, pb) = (p(a), p(b));
    for i in 0..pa.len().max(pb.len()) {
        let d = pa.get(i).copied().unwrap_or(0) - pb.get(i).copied().unwrap_or(0);
        if d != 0 { return d > 0; }
    }
    false
}

// ——— сеть ———

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(format!("PulseDesktop/{} (Tauri)", env!("CARGO_PKG_VERSION"))).build().map_err(|e| e.to_string())
}
fn bust(u: &str) -> String { format!("{u}{}t={}", if u.contains('?') { '&' } else { '?' }, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)) }
async fn get_json(c: &reqwest::Client, url: &str, ms: u64, accept: &str) -> Result<Value, (Option<u16>, String)> {
    let r = c.get(bust(url)).header("Accept", accept).timeout(std::time::Duration::from_millis(ms)).send().await.map_err(|e| (None, e.to_string()))?;
    let s = r.status().as_u16();
    if !r.status().is_success() { return Err((Some(s), format!("ответ {s}"))); }
    let b = r.bytes().await.map_err(|e| (None, e.to_string()))?;
    serde_json::from_slice(&b).map_err(|e| (None, e.to_string()))
}

/// latest.json: тестовый канал — только его адрес; обычный — три источника сразу, берём самую новую подписанную
async fn feed(test: Option<String>) -> Result<(Value, &'static str), String> {
    let c = client()?;
    if let Some(u) = test {
        let m = get_json(&c, &u, 15000, "application/json").await.map_err(|e| format!("тестовая лента: {}", e.1))?;
        if !verify_pkg(&m, TEST_KEY) { return Err("тестовая лента: подпись не сошлась".into()); }
        return Ok((m, TEST_KEY));
    }
    let srcs = [FEED.to_string(), format!("https://raw.githubusercontent.com/{REPO}/main/updates/latest.json"), format!("https://cdn.jsdelivr.net/gh/{REPO}@main/updates/latest.json")];
    let hs: Vec<_> = srcs.iter().map(|u| { let (c, u) = (c.clone(), u.clone()); tauri::async_runtime::spawn(async move { get_json(&c, &u, 8000, "application/json").await }) }).collect();
    let mut best: Option<Value> = None;
    let mut last = String::new();
    for h in hs {
        match h.await { Ok(Ok(m)) if verify_pkg(&m, KEY) => { if best.as_ref().map_or(true, |b| newer(&sv(&m, "version"), &sv(b, "version"))) { best = Some(m); } } Ok(Err(e)) => last = e.1, _ => {} }
    }
    if let Some(m) = best { return Ok((m, KEY)); }
    // запасной путь — API GitHub
    if let Ok(rel) = get_json(&c, API_LATEST, 15000, "application/vnd.github+json").await {
        if let Some(a) = rel["assets"].as_array().and_then(|v| v.iter().find(|a| a["name"] == "latest.json")) {
            if let Ok(m) = get_json(&c, a["url"].as_str().unwrap_or(""), 15000, "application/octet-stream").await { if verify_pkg(&m, KEY) { return Ok((m, KEY)); } }
        }
    }
    Err(if last.is_empty() { "Нет связи с сервером обновлений. Проверьте интернет".into() } else { format!("Сервер обновлений не ответил ({last})") })
}

fn arch() -> &'static str { if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" } }

/// сборка для этой системы: Mac — mac.json (архив Pulse.app), Windows — win.json (установщик)
async fn mac_entry(m: &Value, key: &str, test: bool) -> Result<Value, String> {
    let win = cfg!(target_os = "windows");
    let (file, what) = if win { ("win.json", "Windows") } else { ("mac.json", "Mac") };
    let wait = format!("Сборка для {what} этой версии ещё готовится — попробуйте через несколько минут");
    let url = sv(m, "url");
    let base = url.rsplit_once('/').map(|x| x.0).ok_or("в ленте нет адреса")?;
    let c = client()?;
    let j = get_json(&c, &format!("{base}/{file}"), 15000, "application/json").await.map_err(|_| wait.clone())?;
    let v = sv(m, "version");
    let a = j[arch()].clone();
    let ok = if win { verify_win(&v, arch(), &a, key) } else { verify_mac(&v, arch(), &a, key) };
    if sv(&j, "version") != v || !ok { return Err(wait); }
    if !test && !sv(&a, "url").starts_with(PKG_PREFIX) { return Err(format!("Адрес сборки для {what} не похож на релиз «Пульса» — обновление отменено")); }
    Ok(a)
}

/// есть ли что ставить. Обычный канал: версия новее и релиз — Tauri-версия (поле engine в latest.json; без него —
/// это Electron-релиз, и Tauri-программа на него не меняется; то же проверяется ещё раз по скачанной программе).
fn available(m: &Value, test: bool, cur: &str) -> bool {
    if test { num(m, "build") > build_no() } else { sv(m, "engine") == "tauri" && newer(&sv(m, "version"), cur) }
}

// ——— команды ———

pub async fn check(cur: String) -> Result<Value, String> {
    let test = st().test_feed.clone();
    let is_test = test.is_some();
    let (m, key) = feed(test).await?;
    let avail = available(&m, is_test, &cur);
    let mut size = 0;
    let mut why = String::new();
    let mut need_installer = false;
    if avail {
        if cfg!(any(target_os = "macos", target_os = "windows")) {
            match mac_entry(&m, key, is_test).await { Ok(a) => size = num(&a, "size"), Err(e) => { need_installer = true; why = e; } }
        } else { need_installer = true; why = "Обновление по воздуху на этой системе не поддерживается".into(); }
    }
    let ready = st().staged.as_ref().map_or(false, |s| s.version == sv(&m, "version") && (!is_test || s.build == num(&m, "build")));
    let notes: Vec<Value> = m["notes"].as_array().map(|v| v.iter().take(12).cloned().collect()).unwrap_or_default();
    let out = json!({ "current": cur, "version": sv(&m, "version"), "build": num(&m, "build"), "test": is_test, "available": avail, "notes": notes, "size": size,
        "date": sv(&m, "date"), "needInstaller": need_installer, "engine": true, "why": why, "ready": ready,
        "installer": format!("https://github.com/{REPO}/releases/latest"), "packaged": true });
    st().latest = Some(m);
    Ok(out)
}

fn app_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let app = exe.parent().and_then(|p| p.parent()).and_then(|p| p.parent()).ok_or("Не нашёл саму программу")?.to_path_buf();
    if app.extension().map_or(true, |e| e != "app") { return Err("Не нашёл саму программу (.app)".into()); }
    let s = app.to_string_lossy();
    if s.contains("AppTranslocation") { return Err("Перенесите «Пульс» в папку «Программы», откройте его оттуда и обновите ещё раз".into()); }
    if s.contains('\'') || s.contains('"') || s.contains('\\') { return Err("В пути к программе есть кавычки — перенесите «Пульс» в папку «Программы»".into()); }
    Ok(app)
}
fn writable(p: &Path) -> bool {
    let t = p.join(format!(".pulse-w-{}", std::process::id()));
    let ok = std::fs::write(&t, b"").is_ok();
    let _ = std::fs::remove_file(&t);
    ok
}
fn run(cmd: &str, args: &[&str]) -> Result<(), String> {
    let o = std::process::Command::new(cmd).args(args).output().map_err(|e| e.to_string())?;
    if o.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&o.stderr).trim().lines().last().unwrap_or("ошибка").to_string()) }
}

/// найти .app в распакованной папке (Pulse.app — первым)
fn find_app(dir: &Path) -> Option<PathBuf> {
    let p = dir.join("Pulse.app");
    if p.is_dir() { return Some(p); }
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.extension().map_or(false, |e| e == "app") && p.is_dir())
}

pub async fn prepare(cur: String, progress: impl Fn(f64, &str) + Send + Sync + 'static) -> Result<Value, String> {
    if !cfg!(any(target_os = "macos", target_os = "windows")) { return Err("Обновление по воздуху на этой системе не поддерживается".into()); }
    {
        let mut s = st();
        if s.preparing { return Err("Обновление уже скачивается".into()); }
        s.preparing = true;
    }
    let r = prepare_inner(cur, &progress).await;
    st().preparing = false;
    r
}

async fn prepare_inner(cur: String, progress: &(impl Fn(f64, &str) + Send + Sync)) -> Result<Value, String> {
    progress(0.0, "Проверяю последнюю версию");
    let test = st().test_feed.clone();
    let is_test = test.is_some();
    let (m, key) = feed(test).await?;
    if !available(&m, is_test, &cur) { return Err("У вас уже последняя версия".into()); }
    let ver = sv(&m, "version");
    let build = num(&m, "build");
    if let Some(s) = st().staged.as_ref() { if s.version == ver && s.build == build { return Ok(json!({ "version": ver, "engine": true, "admin": s.admin })); } }
    let e = mac_entry(&m, key, is_test).await?;
    if cfg!(target_os = "windows") {
        // Windows: установщик во временную папку → после выхода тихо ставится поверх (NSIS /S) и программа открывается снова
        let work = std::env::temp_dir().join(format!("pulse-update-{ver}"));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let setup = work.join("Pulse-Setup.exe");
        download_to(&e, &setup, &work, &format!("Скачиваю версию {ver}"), progress).await?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        progress(0.96, "Готово");
        st().staged = Some(Staged { version: ver.clone(), build, from: setup, to: exe, work, admin: false, swapped: false });
        return Ok(json!({ "version": ver, "engine": true, "admin": false }));
    }
    let app = app_path()?;
    let parent = app.parent().ok_or("нет папки программы")?.to_path_buf();
    let admin = !writable(&parent) || !writable(&app);
    let work = if admin { std::env::temp_dir().join(format!("pulse-update-{ver}")) } else { parent.join(".pulse-update") };
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let zip = work.join("app.zip");
    let label = format!("Скачиваю версию {ver}");
    progress(0.0, &label);
    let want_size = num(&e, "size");
    let c = client()?;
    let mut r = None;
    let mut last = String::new();
    for _ in 0..2 {
        match c.get(sv(&e, "url")).timeout(std::time::Duration::from_secs(15 * 60)).send().await {
            Ok(x) if x.status().is_success() => { r = Some(x); break; }
            Ok(x) => last = format!("ответ {}", x.status().as_u16()),
            Err(er) => last = er.to_string(),
        }
        tokio_sleep(1500).await;
    }
    let mut r = r.ok_or_else(|| { let _ = std::fs::remove_dir_all(&work); format!("Не получилось скачать обновление ({last})") })?;
    let mut h = Sha256::new();
    let mut got: u64 = 0;
    {
        use std::io::Write;
        let mut f = std::io::BufWriter::new(std::fs::File::create(&zip).map_err(|e| e.to_string())?);
        loop {
            match r.chunk().await {
                Ok(Some(b)) => {
                    h.update(&b); got += b.len() as u64;
                    if got > want_size { break; }
                    f.write_all(&b).map_err(|e| e.to_string())?;
                    progress((got as f64 / want_size.max(1) as f64 * 0.8).min(0.8), &label);
                }
                Ok(None) => break,
                Err(er) => { let _ = std::fs::remove_dir_all(&work); return Err(format!("Обновление не докачалось: {er}")); }
            }
        }
        f.flush().map_err(|e| e.to_string())?;
    }
    let sum: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != want_size || sum != sv(&e, "sha256").to_lowercase() {
        let _ = std::fs::remove_dir_all(&work);
        return Err("Обновление скачалось с ошибкой (не совпала контрольная сумма). Попробуйте ещё раз.".into());
    }
    progress(0.84, "Распаковываю");
    let out = work.join("new");
    let w2 = work.clone();
    let checked = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        let fail = |e: String| { let _ = std::fs::remove_dir_all(&w2); e };
        run("/usr/bin/ditto", &["-x", "-k", &zip.to_string_lossy(), &out.to_string_lossy()]).map_err(|e| fail(format!("Не распаковалось: {e}")))?;
        let _ = std::fs::remove_file(&zip);
        let nu = find_app(&out).ok_or_else(|| fail("В архиве нет программы".into()))?;
        let pkg: Value = std::fs::read(nu.join("Contents/Resources/app/package.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
        if sv(&pkg, "version") != ver { return Err(fail("Версия в скачанной программе не совпадает с объявленной".into())); }
        if sv(&pkg, "engine") != "tauri" { return Err(fail("Скачанная программа — не Tauri-версия «Пульса»; обновление отменено".into())); }
        if is_test && num(&pkg, "build") != build { return Err(fail("Номер сборки в скачанной программе не совпадает с объявленным".into())); }
        let _ = run("/usr/bin/xattr", &["-cr", &nu.to_string_lossy()]);
        run("/usr/bin/codesign", &["--verify", "--deep", &nu.to_string_lossy()]).map_err(|e| fail(format!("Подпись скачанной программы не сошлась: {e}")))?;
        Ok(nu)
    }).await.map_err(|e| e.to_string())??;
    progress(0.96, "Готово");
    st().staged = Some(Staged { version: sv(&m, "version"), build, from: checked, to: app, work, admin, swapped: false });
    Ok(json!({ "version": sv(&m, "version"), "engine": true, "admin": admin }))
}

/// скачать файл записи mac.json / win.json, сверив размер и SHA-256 (не сошлось — папка work удаляется)
async fn download_to(e: &Value, to: &Path, work: &Path, label: &str, progress: &(impl Fn(f64, &str) + Send + Sync)) -> Result<(), String> {
    progress(0.0, label);
    let want_size = num(e, "size");
    let c = client()?;
    let mut r = None;
    let mut last = String::new();
    for _ in 0..2 {
        match c.get(sv(e, "url")).timeout(std::time::Duration::from_secs(15 * 60)).send().await {
            Ok(x) if x.status().is_success() => { r = Some(x); break; }
            Ok(x) => last = format!("ответ {}", x.status().as_u16()),
            Err(er) => last = er.to_string(),
        }
        tokio_sleep(1500).await;
    }
    let mut r = r.ok_or_else(|| { let _ = std::fs::remove_dir_all(work); format!("Не получилось скачать обновление ({last})") })?;
    let mut h = Sha256::new();
    let mut got: u64 = 0;
    {
        use std::io::Write;
        let mut f = std::io::BufWriter::new(std::fs::File::create(to).map_err(|e| e.to_string())?);
        loop {
            match r.chunk().await {
                Ok(Some(b)) => {
                    h.update(&b); got += b.len() as u64;
                    if got > want_size { break; }
                    f.write_all(&b).map_err(|e| e.to_string())?;
                    progress((got as f64 / want_size.max(1) as f64 * 0.9).min(0.9), label);
                }
                Ok(None) => break,
                Err(er) => { let _ = std::fs::remove_dir_all(work); return Err(format!("Обновление не докачалось: {er}")); }
            }
        }
        f.flush().map_err(|e| e.to_string())?;
    }
    let sum: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if got != want_size || sum != sv(e, "sha256").to_lowercase() {
        let _ = std::fs::remove_dir_all(work);
        return Err("Обновление скачалось с ошибкой (не совпала контрольная сумма). Попробуйте ещё раз.".into());
    }
    Ok(())
}

async fn tokio_sleep(ms: u64) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await;
}

pub fn ready() -> Value {
    match st().staged.as_ref() { Some(s) => json!({ "version": s.version, "engine": true, "admin": s.admin }), None => Value::Null }
}

// скрипт замены: ждёт выхода «Пульса», меняет программу (не вышло — возвращает старую) и запускает её
// (quiet — при обычном выходе из программы: заменить и не запускать). Тот же, что в Electron-версии.
const SWAP_SH: &str = r#"#!/bin/sh
MODE="$1"; PID="$2"; OLD="$3"; NEW="$4"; WORK="$5"
core() {
  BAK="$WORK/old.app"; rm -rf "$BAK"
  if mv "$OLD" "$BAK"; then
    if mv "$NEW" "$OLD"; then rm -rf "$BAK"; else mv "$BAK" "$OLD"; fi
  fi
}
if [ "$MODE" = core ]; then core; exit 0; fi
i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
if [ "$MODE" = admin ]; then
  /usr/bin/osascript -e "do shell script \"/bin/sh '$0' core 0 '$OLD' '$NEW' '$WORK'\" with administrator privileges" || true
else core; fi
rm -rf "$WORK"
[ "$MODE" = quiet ] || /usr/bin/open "$OLD"
"#;

fn start_swap(s: &Staged, mode: &str) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        use std::os::unix::process::CommandExt;
        let sh = std::env::temp_dir().join(format!("pulse-swap-{}.sh", std::process::id()));
        std::fs::write(&sh, SWAP_SH).map_err(|e| e.to_string())?;
        let _ = std::fs::set_permissions(&sh, std::fs::Permissions::from_mode(0o700));
        std::process::Command::new("/bin/sh")
            .arg(&sh).arg(mode).arg(std::process::id().to_string()).arg(&s.to).arg(&s.from).arg(&s.work)
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .process_group(0)
            .spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(windows)]
    {
        // ждём выхода «Пульса», тихо ставим новую версию поверх и (кроме quiet) открываем её; окна не видно
        use std::os::windows::process::CommandExt;
        let q = |p: &Path| p.to_string_lossy().replace('\'', "''");
        let ps = format!("$p={pid}; for($i=0;$i -lt 300 -and (Get-Process -Id $p -ErrorAction SilentlyContinue);$i++){{Start-Sleep -Milliseconds 100}}; \
            $r=Start-Process -FilePath '{setup}' -ArgumentList '/S' -Wait -PassThru; \
            if('{mode}' -ne 'quiet'){{ Start-Process -FilePath '{exe}' }}; \
            Start-Sleep -Seconds 2; Remove-Item -LiteralPath '{work}' -Recurse -Force -ErrorAction SilentlyContinue",
            pid = std::process::id(), setup = q(&s.from), exe = q(&s.to), work = q(&s.work), mode = mode);
        std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", &ps])
            .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn().map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = (s, mode); Err("не поддерживается".into()) }
}

/// «Перезапустить»: заменить программу и открыть новую
pub fn restart(app: &tauri::AppHandle) {
    let mut g = st();
    if let Some(s) = g.staged.as_mut() {
        if start_swap(s, if s.admin { "admin" } else { "user" }).is_ok() { s.swapped = true; drop(g); app.exit(0); return; }
    }
    drop(g);
    app.restart();
}

/// выход из программы: скачанное ставится сейчас (без пароля), чтобы в следующий раз открылась новая версия
pub fn on_exit() {
    let mut g = st();
    if let Some(s) = g.staged.as_mut() {
        if !s.admin && !s.swapped { s.swapped = true; let _ = start_swap(s, "quiet"); }
    }
}

/// тестовый канал: адрес тестовой ленты (None — обычный канал)
pub fn set_test_feed(url: Option<String>) -> Result<(), String> {
    if !test_allowed() { return Err("тестовый канал есть только в тестовых сборках".into()); }
    if let Some(u) = &url { if !u.starts_with(PKG_PREFIX) && !u.starts_with(TEST_RAW) { return Err("тестовая лента — только из репозитория «Пульса» на GitHub".into()); } }
    let mut g = st();
    g.test_feed = url;
    g.latest = None;
    Ok(())
}
pub fn test_feed() -> Option<String> { st().test_feed.clone() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_like_electron() {
        assert!(newer("0.9.10", "0.9.9"));
        assert!(newer("0.39.0", "0.38.0"));
        assert!(!newer("0.38.0", "0.38.0"));
        assert!(!newer("0.37.6", "0.38.0"));
        assert!(newer("0.38.0-1", "0.38.0"));
    }

    #[test]
    fn real_release_signatures_verify() {
        // настоящие подписанные файлы релиза 0.38.0 (updates/0.38.0) — открытым ключом из updsign.js
        let m = json!({ "version": "0.38.0", "url": "https://github.com/oqelon/pulsmusic.develop/releases/download/v0.38.0/pulse-app-0.38.0.zip",
            "sha256": "5a6074a14d8de4c72331b92807fb8f1e2aa47b96018d2b168e442e34fbe64d0d", "size": 1147352, "minElectron": "33.2.1",
            "sig": "jpFkJxBr3sOuSaB9omap59krzc2THFlUSHleciFoUmLCUhM1w9LwZVQJwcop6nbUbY19GEQwsoc06JfUnWtHBQ==" });
        assert!(verify_pkg(&m, KEY));
        let a = json!({ "url": "https://github.com/oqelon/pulsmusic.develop/releases/download/v0.38.0/Pulse-Mac-Apple-M.zip",
            "sha256": "02d287cdb246dcd0be0f29a996af898320ad712bce00282981726a6a16373d7e", "size": 98358565,
            "sig": "9KGraN1qjYDawFQH59AxCI8Bf9u1MvbilXU49EwzweJasboKa5I8jm+j/k/f+vkuHPrxfcpppv7TRd4p19FRBQ==" });
        assert!(verify_mac("0.38.0", "arm64", &a, KEY));
        // подмена версии, архитектуры, суммы или ключа — подпись не сходится
        assert!(!verify_mac("0.38.1", "arm64", &a, KEY));
        assert!(!verify_mac("0.38.0", "x64", &a, KEY));
        let mut b = a.clone(); b["size"] = json!(98358566); assert!(!verify_mac("0.38.0", "arm64", &b, KEY));
        assert!(!verify_mac("0.38.0", "arm64", &a, TEST_KEY));
        let mut m2 = m.clone(); m2["minElectron"] = json!(""); assert!(!verify_pkg(&m2, KEY));
    }

    #[test]
    fn test_key_vector() {
        let a = json!({ "sha256": "ab".repeat(32), "size": 123, "sig": "yknWvP1Sp0VGiKL0Tp8ax0iAdf0w6Y0jUXdBm9lYyGUdJvUQVh16NfE+r6y231z3HGcwQbFn3CcdE82H7E2EDw==" });
        assert!(verify_mac("0.38.0", "arm64", &a, TEST_KEY));
        assert!(!verify_mac("0.38.0", "arm64", &a, KEY));
    }

    #[test]
    fn win_and_mac_signatures_differ() {
        let a = json!({ "sha256": "ab".repeat(32), "size": 123, "sig": "yknWvP1Sp0VGiKL0Tp8ax0iAdf0w6Y0jUXdBm9lYyGUdJvUQVh16NfE+r6y231z3HGcwQbFn3CcdE82H7E2EDw==" });
        // подпись, сделанная для Mac, не подходит как подпись установщика Windows
        assert!(!verify_win("0.38.0", "arm64", &a, TEST_KEY));
        assert!(win_msg("0.39.0", "x64", &a).starts_with("PULSE-WIN-V1\n0.39.0\nx64\n"));
    }

    #[test]
    fn base64_decodes() {
        assert_eq!(b64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(b64("aGVsbG8gd29ybGQ").unwrap(), b"hello world");
        assert_eq!(b64(KEY).unwrap().len(), 32);
        assert!(b64("a*b").is_none());
    }
}
