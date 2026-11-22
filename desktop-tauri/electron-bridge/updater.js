// Обновления «Пульса» для Windows и Mac — без переустановки.
//
// На Mac (запуск через boot.js) файлы программы не пишутся внутрь Pulse.app (это сломало бы её подпись): новая
// версия кладётся в ~/Library/Application Support/Pulse/ota/<версия>/, и загрузчик запускает её. Если новой версии
// нужен другой движок (Electron), скачивается целиком новая Pulse.app для этого Mac (Apple M или Intel, ~100 МБ;
// адрес и SHA-256 — в mac.json того же релиза), распаковывается рядом со старой, проверяется её подпись, и после
// выхода из программы маленький скрипт меняет старую Pulse.app на новую и запускает её. Вход и настройки не трогаются.
//
// Откуда: релизы GitHub репозитория oqelon/pulsmusic.develop. В каждом релизе — файл latest.json (какая версия,
// что нового, ссылка на пакет и его контрольная сумма SHA-256) и сам пакет pulse-app-<версия>.zip (~0,7 МБ):
// только файлы «Пульса» (main.js, preload.js, yandex.js, updater.js, package.json, dist/, build/icon*.png, build/icon.ico).
// Electron (основа программы, ~110 МБ) не скачивается — он уже установлен. Если новой версии нужен другой Electron,
// latest.json говорит об этом (minElectron), и программа предложит скачать новый установщик.
//
// Как ставится: пакет скачивается во временную папку, сверяется по SHA-256, распаковывается и проверяется
// (есть main.js, интерфейс, версия совпадает). Текущие файлы копируются в резервную папку
// (%APPDATA%\Pulse\update-backup), новые записываются на их место, и программа перезапускается.
// Токен, лайки и настройки не трогаются — они хранятся отдельно (%APPDATA%\Pulse).
//
// Подпись: latest.json и mac.json подписаны ключом разработчика (Ed25519, см. updsign.js). Без верной подписи
// обновление не предлагается и не скачивается. Загрузчик Mac перепроверяет подпись скачанной версии при каждом запуске.
//
// Сами: программа раз в час смотрит, не вышла ли новая версия, и, если включено «Скачивать обновления сами»,
// тихо скачивает и готовит её (prepare). Дальше — «Перезапустить» в островке, или обновление встанет при следующем
// запуске: на Mac версия уже лежит в ota/ (загрузчик возьмёт её сам), на Windows файлы записываются при выходе.
'use strict';
const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const { execFile, spawn } = require('child_process');
const T = require('./updsign');
const BOOT = global.__pulseBoot || null;   // запущены через загрузчик Mac (boot.js)

const FEED = process.env.PULSE_UPDATE_FEED || 'https://github.com/oqelon/pulsmusic.develop/releases/latest/download/latest.json';
const RELEASES = 'https://github.com/oqelon/pulsmusic.develop/releases/latest';

// «0.9.10» > «0.9.9»
function newer(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0; }
  return false;
}

// GitHub иногда на минуту отвечает 502/503 — повторяем, а потом спрашиваем через API GitHub (другой путь к тому же файлу)
const API_LATEST = 'https://api.github.com/repos/oqelon/pulsmusic.develop/releases/latest';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function getOnce(url, accept) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { headers: { 'User-Agent': 'PulseDesktop/' + app.getVersion(), Accept: accept || 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (r.status === 404) throw Object.assign(new Error('Обновлений пока не выкладывали'), { code: 'nofeed' });
  if (!r.ok) throw Object.assign(new Error('Сервер обновлений ответил ' + r.status), { status: r.status });
  return r.json();
}
async function viaApi() {
  const rel = await getOnce(API_LATEST, 'application/vnd.github+json');
  const a = (rel.assets || []).find((x) => x.name === 'latest.json');
  if (!a) throw Object.assign(new Error('Обновлений пока не выкладывали'), { code: 'nofeed' });
  return getOnce(a.url, 'application/octet-stream');
}
async function getJSON(url) {
  let err = null;
  for (let i = 0; i < 3; i++) {
    try { return await getOnce(url); }
    catch (e) { err = e; if (e.code === 'nofeed' || (e.status && e.status < 500 && e.status !== 429)) throw e; await wait(800 * (i + 1)); }
  }
  if (url === FEED && !process.env.PULSE_UPDATE_FEED) { try { return await viaApi(); } catch (e) { if (e.code === 'nofeed') throw e; } }
  throw new Error(err && err.status ? 'GitHub, где лежат обновления, временно не отвечает (' + err.status + '). Попробуйте через пару минут' : 'Нет связи с сервером обновлений. Проверьте интернет');
}

let latest = null;   // последний прочитанный latest.json

// ---------- быстрый поиск обновлений ----------
// Файл latest.json спрашиваем сразу в трёх местах: релиз GitHub, raw.githubusercontent.com и jsDelivr (копии одного и
// того же файла из репозитория — updates/latest.json). Кто первым ответил — тот и даёт ответ (через 1,2 с после первого
// ответа берётся самая новая версия из пришедших: копии на CDN могут отставать на несколько минут).
// Раньше спрашивали только GitHub: когда он «задумывался», поиск шёл до 45 с.
const REPO = 'oqelon/pulsmusic.develop';
const RAW = 'https://raw.githubusercontent.com/' + REPO + '/main/updates/';
const CDN = 'https://cdn.jsdelivr.net/gh/' + REPO + '@main/updates/';
async function getQuick(url, ms) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { headers: { 'User-Agent': 'PulseDesktop/' + app.getVersion(), Accept: 'application/json' }, signal: AbortSignal.timeout(ms), redirect: 'follow' });
  if (!r.ok) throw Object.assign(new Error('ответ ' + r.status), { status: r.status });
  const j = await r.json();
  if (!j || !j.version || !j.url || !/^[0-9a-f]{64}$/i.test(String(j.sha256 || ''))) throw new Error('файл обновлений повреждён');
  if (!T.verifyPkg(j)) throw new Error('подпись файла обновлений не сошлась');
  return j;
}
async function getFeed() {
  if (process.env.PULSE_UPDATE_FEED) return getJSON(FEED);
  const srcs = [FEED, RAW + 'latest.json', CDN + 'latest.json'];
  const got = await new Promise((resolve) => {
    const ok = []; let left = srcs.length, t = null;
    const done = () => { clearTimeout(t); resolve(ok); };
    for (const u of srcs) getQuick(u, 8000).then((j) => { ok.push(j); if (ok.length === 1) t = setTimeout(done, 1200); }).catch(() => {}).finally(() => { if (--left === 0) done(); });
  });
  if (got.length) return got.reduce((a, b) => (newer(b.version, a.version) ? b : a));
  return getJSON(FEED);   // никто не ответил быстро — прежний путь с повторами и API GitHub
}

// ---------- скачивание пакета ----------
// Адреса одного и того же файла: релиз GitHub, raw.githubusercontent.com, jsDelivr (пакеты лежат и в репозитории,
// updates/<версия>/). Начинаем с первого; если он за 2,5 с не начал отдавать файл — параллельно пробуем следующий,
// и так далее. Кто первым начал отдавать — тот и качает, остальные отменяются. Целостность всё равно проверяется
// по SHA-256 из latest.json, так что источник не важен.
function mirrors(m, file) {
  if (process.env.PULSE_UPDATE_FEED) return [m.url];
  const v = encodeURIComponent(m.version);
  return [m.url, RAW + v + '/' + file, CDN + v + '/' + file];
}
async function download(urls, ms) {
  urls = [].concat(urls);
  const ua = { 'User-Agent': 'PulseDesktop/' + app.getVersion() };
  const ctrls = []; let last = null;
  const one = async (url) => {
    const c = new AbortController(); ctrls.push(c);
    const t = setTimeout(() => c.abort(), ms);
    try {
      const r = await fetch(url, { headers: ua, redirect: 'follow', signal: c.signal });
      if (r.ok && r.body) return { r, c, t };
      last = r.status; clearTimeout(t); throw new Error('ответ ' + r.status);
    } catch (e) { clearTimeout(t); if (last == null) last = e; throw e; }
  };
  for (let round = 0; round < 2; round++) {
    try {
      const win = await new Promise((resolve, reject) => {
        let left = urls.length, i = 0, timer = null;
        const next = () => {
          if (i >= urls.length) return;
          const u = urls[i++];
          one(u).then(resolve, () => { if (--left === 0) reject(new Error('все адреса не ответили')); else { clearTimeout(timer); next(); } });
          if (i < urls.length) timer = setTimeout(next, 2500);
        };
        next();
      });
      for (const c of ctrls) if (c !== win.c) c.abort();
      return win.r;
    } catch { await wait(1500); }
  }
  throw new Error(typeof last === 'number' && last >= 500 ? 'GitHub, где лежат обновления, временно не отдаёт файл (' + last + '). Попробуйте ещё раз через минуту' : 'Не получилось скачать обновление' + (typeof last === 'number' ? ' (ответ ' + last + ')' : '. Проверьте интернет'));
}

// загрузчик Mac без проверки подписи при запуске (Pulse.app до 0.23.0)
const oldBoot = () => !!(BOOT && !(BOOT.v >= 2));
const needEngine = (m) => !!(m && m.minElectron && newer(m.minElectron, process.versions.electron));

async function check() {
  const cur = app.getVersion();
  const m = await getFeed();
  if (!m || !m.version || !m.url || !/^[0-9a-f]{64}$/i.test(String(m.sha256 || ''))) throw new Error('Файл обновлений повреждён');
  if (!T.verifyPkg(m)) throw new Error('Обновление не прошло проверку подписи — установка отменена');
  latest = m;
  // версия, которая на этом Mac уже не запустилась и была откачена, больше не предлагается
  const available = newer(m.version, cur) && !(BOOT && (otaState().bad || []).includes(m.version));
  const mac = process.platform === 'darwin';
  let needInstaller = false, engine = false, size = m.size || 0, why = '';
  if (mac && !BOOT) { needInstaller = true; why = 'old-mac'; }   // старая сборка для Mac без загрузчика — один раз поставить заново
  else if (needEngine(m)) {
    if (BOOT && available) {
      // новый движок на Mac — тоже по воздуху (если сборки для Mac в релизе ещё нет — через сайт)
      try { const e = await macEngine(m); engine = true; size = e.size; } catch (er) { needInstaller = true; why = String(er.message || er); }
    } else if (!BOOT) needInstaller = true;
  } else if (available && oldBoot()) {
    // загрузчик этой Pulse.app ещё не умеет перепроверять подпись при запуске — один раз приходит программа целиком
    // (если сборки для Mac ещё нет — обычное обновление, программа целиком придёт со следующей версией)
    try { const e = await macEngine(m); engine = true; size = e.size; } catch {}
  }
  // переходное обновление: дальше — только новая версия «Пульса»
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return { current: cur, version: MOVE_V, available: true, notes: ['Новая версия «Пульса»: свой звуковой движок, быстрее и легче. Данные и вход переносятся сами'], size: 0,
      date: '', needInstaller: false, engine: true, why: '', ready: !!(staged && staged.version === MOVE_V), installer: RELEASES, packaged: app.isPackaged };
  }
  return { current: cur, version: m.version, available, notes: Array.isArray(m.notes) ? m.notes.slice(0, 12) : [], size,
    date: m.date || '', needInstaller, engine, why, ready: !!(staged && staged.version === m.version), installer: mac ? RELEASES : m.installer || RELEASES, packaged: app.isPackaged };
}

// ---------- Mac: новая Pulse.app целиком (когда меняется движок) ----------
// mac.json лежит в том же релизе, что и latest.json: { version, electron, arm64: { url, sha256, size, sig }, x64: {…} }
// sig — подпись разработчика (см. updsign.js); пока её нет, сборка считается неготовой.
async function macEngine(m) {
  const u = new URL('mac.json', m.url).href;
  const j = await getJSON(u).catch(() => { throw new Error('Сборка для Mac этой версии ещё готовится — попробуйте через несколько минут'); });
  const a = j && j[process.arch];
  if (!j || j.version !== m.version || !a || !a.url || !/^[0-9a-f]{64}$/i.test(String(a.sha256 || '')) || !(a.size > 0)) throw new Error('Сборка для Mac этой версии ещё готовится — попробуйте через несколько минут');
  if (!T.verifyMac(m.version, process.arch, a)) throw new Error('Сборка для Mac этой версии ещё готовится — попробуйте через несколько минут');
  if (!process.env.PULSE_UPDATE_FEED && !String(a.url).startsWith(PKG_PREFIX)) throw new Error('Адрес сборки для Mac не похож на релиз «Пульса» — обновление отменено');
  return a;
}
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { timeout: 180000, maxBuffer: 4 << 20 }, (e, out, err) => (e ? rej(new Error(String(err || e.message).trim().split('\n').pop())) : res(out))));

// что уже скачано и ждёт перезапуска: { kind: 'ota' | 'win' | 'engine', version, … }
let staged = null;
let applied = false;   // Windows: файлы уже записаны в папку программы
const pub = (s) => (s ? { version: s.version, engine: s.kind === 'engine' || s.kind === 'move-win', admin: !!s.admin } : null);

async function installEngine(m, progress) {
  const e = await macEngine(m);
  const appPath = path.resolve(process.execPath, '..', '..', '..');
  if (!/\.app$/.test(appPath)) throw new Error('Не нашёл саму программу Pulse.app');
  if (/AppTranslocation/.test(appPath)) throw new Error('Перенесите «Пульс» в папку «Программы», откройте его оттуда и обновите ещё раз');
  if (/['"\\]/.test(appPath)) throw new Error('В пути к программе есть кавычки — перенесите «Пульс» в папку «Программы»');
  let admin = false;
  try { fs.accessSync(path.dirname(appPath), fs.constants.W_OK); fs.accessSync(appPath, fs.constants.W_OK); } catch { admin = true; }
  // распаковываем рядом со старой программой (тот же диск — замена мгновенная); нет прав — во временную папку
  const work = admin ? path.join(os.tmpdir(), 'pulse-update-' + m.version) : path.join(path.dirname(appPath), '.pulse-update');
  fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
  const zip = path.join(work, 'engine.zip');
  progress(0, 'Скачиваю версию ' + m.version + ' с новым движком');
  const r = await download(e.url, 15 * 60000);
  const h = crypto.createHash('sha256'); const fd = fs.openSync(zip, 'w'); let got = 0;
  try {
    for await (const chunk of r.body) { const b = Buffer.from(chunk); h.update(b); fs.writeSync(fd, b); got += b.length; progress(Math.min(0.8, (got / e.size) * 0.8), 'Скачиваю версию ' + m.version + ' с новым движком'); }
  } finally { fs.closeSync(fd); }
  if (got !== e.size || h.digest('hex') !== String(e.sha256).toLowerCase()) { fs.rmSync(work, { recursive: true, force: true }); throw new Error('Обновление скачалось с ошибкой (не совпала контрольная сумма). Попробуйте ещё раз.'); }
  progress(0.84, 'Распаковываю');
  const out = path.join(work, 'new');
  await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
  fs.rmSync(zip, { force: true });
  const nu = path.join(out, 'Pulse.app');
  progress(0.92, 'Проверяю подпись');
  let pkg = {}; try { pkg = JSON.parse(fs.readFileSync(path.join(nu, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')); } catch {}
  if (pkg.version !== m.version) { fs.rmSync(work, { recursive: true, force: true }); throw new Error('Версия в скачанной программе не совпадает с объявленной'); }
  await run('/usr/bin/xattr', ['-cr', nu]).catch(() => {});
  try { await run('/usr/bin/codesign', ['--verify', '--deep', nu]); }
  catch (er) { fs.rmSync(work, { recursive: true, force: true }); throw new Error('Подпись скачанной программы не сошлась: ' + er.message); }
  staged = { kind: 'engine', version: m.version, from: nu, to: appPath, work, admin };
  return staged;
}

// скрипт замены: ждёт выхода «Пульса», меняет Pulse.app (не вышло — возвращает старую) и запускает программу
// (quiet — при обычном выходе из программы: заменить и не запускать)
const SWAP_SH = `#!/bin/sh
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
  /usr/bin/osascript -e "do shell script \\"/bin/sh '$0' core 0 '$OLD' '$NEW' '$WORK'\\" with administrator privileges" || true
else core; fi
rm -rf "$WORK"
[ "$MODE" = quiet ] || /usr/bin/open "$OLD"
`;
function startSwap(mode) {
  const sh = path.join(os.tmpdir(), 'pulse-swap-' + process.pid + '.sh');
  fs.writeFileSync(sh, SWAP_SH, { mode: 0o700 });
  const p = spawn('/bin/sh', [sh, mode, String(process.pid), staged.to, staged.from, staged.work], { detached: true, stdio: 'ignore' });
  p.unref();
}

// ---------- Mac: обычное обновление — в папку пользователя ----------
function otaState() { try { return JSON.parse(fs.readFileSync(path.join(BOOT.ota, 'state.json'), 'utf8')) || {}; } catch { return {}; } }
function placeOta(files, ver, buf, m) {
  const dir = path.join(BOOT.ota, ver), tmp = dir + '.part';
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) { const to = path.join(tmp, f.name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, f.data); }
  // пакет и подпись — загрузчик сверяет по ним папку при каждом запуске
  fs.writeFileSync(path.join(tmp, T.PKG), buf);
  fs.writeFileSync(path.join(tmp, T.META), JSON.stringify({ version: m.version, sha256: m.sha256, size: m.size, minElectron: m.minElectron || '', sig: m.sig }));
  fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(tmp, dir);
  const s = otaState();
  // предыдущая рабочая версия остаётся на случай, если новая не запустится
  const prev = BOOT.fromOta && BOOT.version !== ver ? BOOT.version : '';
  const ns = { current: ver, previous: prev, tries: 0, bad: (s.bad || []).filter((x) => x !== ver) };
  fs.writeFileSync(path.join(BOOT.ota, 'state.json'), JSON.stringify(ns));
  try { for (const d of fs.readdirSync(BOOT.ota)) if (/^[\d.]+(\.part)?$/.test(d) && d !== ver && d !== prev) fs.rmSync(path.join(BOOT.ota, d), { recursive: true, force: true }); } catch {}
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

// ---------- Windows: скачанное ждёт в %APPDATA%\Pulse\update-staged до перезапуска или выхода ----------
const stageDir = () => path.join(app.getPath('userData'), 'update-staged');
function stageWin(buf, files, ver) {
  const d = stageDir();
  fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, ver + '.zip'), buf);
  staged = { kind: 'win', version: ver, files }; applied = false;
}
function applyWin() {
  if (!staged || staged.kind !== 'win' || applied) return;
  const appDir = app.getAppPath();
  const backup = path.join(app.getPath('userData'), 'update-backup');
  fs.rmSync(backup, { recursive: true, force: true });
  copyDir(appDir, backup);
  try {
    fs.rmSync(path.join(appDir, 'dist'), { recursive: true, force: true });   // старые файлы интерфейса не смешиваются с новыми
    for (const f of staged.files) {
      const to = path.join(appDir, f.name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, f.data);
    }
  } catch (e) {
    // не получилось — возвращаем как было
    try { copyDir(backup, appDir); } catch {}
    throw new Error('Не получилось записать файлы обновления: ' + e.message);
  }
  applied = true;
  fs.rmSync(stageDir(), { recursive: true, force: true });
}

// ---------- скачать и подготовить (без перезапуска) ----------
// progress(доля 0…1, подпись)
// пакет скачивается только из релизов «Пульса» на GitHub (кроме проверки с подменённым адресом PULSE_UPDATE_FEED)
const PKG_PREFIX = 'https://github.com/oqelon/pulsmusic.develop/releases/download/';
async function doPrepare(progress) {
  if (process.platform === 'darwin' && !BOOT) throw new Error('Эту сборку для Mac нужно один раз поставить заново со страницы релиза «Пульса» — дальше обновления придут сами');
  if (!app.isPackaged) throw new Error('Обновления ставятся только в установленный «Пульс» (через установщик). Сейчас программа запущена для проверки.');
  // Перед скачиванием всегда заново читаем latest.json: если пока программа ждала, вышло ещё несколько версий,
  // ставится сразу самая последняя (пакет — полная программа, промежуточные версии не нужны).
  progress(0, 'Проверяю последнюю версию');
  let m = latest;
  try {
    const f = await getFeed();
    if (f && T.verifyPkg(f) && (!m || !newer(m.version, f.version))) m = f;
  } catch (e) { if (!m) throw e; }
  if (!T.verifyPkg(m)) throw new Error('Обновление не прошло проверку подписи — установка отменена');
  if (!newer(m.version, app.getVersion())) throw new Error('У вас уже последняя версия');
  latest = m;
  if (!process.env.PULSE_UPDATE_FEED && !String(m.url).startsWith(PKG_PREFIX)) throw new Error('Адрес пакета обновления не похож на релиз «Пульса» — обновление отменено');
  if (staged && staged.version === m.version) return staged;   // уже скачано
  let full = needEngine(m);
  if (!full && oldBoot()) full = await macEngine(m).then(() => true, () => false);
  if (full) { if (BOOT) return installEngine(m, progress); throw new Error('Для этой версии нужен новый установщик'); }
  const want = String(m.sha256).toLowerCase();
  let buf = null;
  if (!BOOT) { try { const b = fs.readFileSync(path.join(stageDir(), m.version + '.zip')); if (b.length === m.size && T.sha256(b) === want) buf = b; } catch {} }
  if (!buf) {
    progress(0, 'Скачиваю версию ' + m.version);
    const r = await download(mirrors(m, 'pulse-app-' + m.version + '.zip'), 120000);
    const total = Number(r.headers.get('content-length')) || m.size || 0; const parts = []; let got = 0;
    for await (const chunk of r.body) { parts.push(Buffer.from(chunk)); got += chunk.length; if (total) progress(Math.min(0.85, (got / total) * 0.85), 'Скачиваю версию ' + m.version); }
    buf = Buffer.concat(parts);
    if (buf.length !== m.size || T.sha256(buf) !== want) throw new Error('Обновление скачалось с ошибкой (не совпала контрольная сумма). Попробуйте ещё раз.');
  }
  progress(0.88, 'Проверяю файлы');
  const files = T.readZip(buf);
  const has = (n) => files.some((f) => f.name.replace(/\\/g, '/') === n);
  if (!has('main.js') || !has('preload.js') || !has('dist/index.html') || !has('package.json') || !has('security.js') || !has('online.js') || !has('updsign.js')) throw new Error('В пакете обновления не хватает файлов');
  const pkg = JSON.parse(files.find((f) => f.name === 'package.json').data.toString('utf8'));
  if (pkg.version !== m.version) throw new Error('Версия в пакете не совпадает с объявленной');
  progress(0.96, 'Готовлю обновление');
  try {
    if (BOOT) { placeOta(files, m.version, buf, m); staged = { kind: 'ota', version: m.version }; }   // Mac: рядом, в папку пользователя
    else stageWin(buf, files, m.version);
  } catch (e) { throw new Error('Не получилось записать файлы обновления: ' + e.message); }
  return staged;
}
// одно скачивание на всех: тихое фоновое и кнопка «Обновить» не качают дважды
let preparing = null; const listeners = new Set();
function prepare(progress) {
  if (process.platform === 'darwin' || process.platform === 'win32') return move(progress).then(pub);
  if (progress) listeners.add(progress);
  if (!preparing) {
    preparing = doPrepare((f, l) => { for (const cb of listeners) { try { cb(f, l); } catch {} } })
      .finally(() => { preparing = null; listeners.clear(); });
  }
  return preparing.then(pub);
}


// ==================== 0.39.0: переход обычного «Пульса» на новую версию (Tauri) ====================
// Это «переходное» обновление: сам пакет — прежний «Пульс» 0.38.0 и этот блок. После запуска он находит сборку
// Tauri-версии для этого компьютера (updates/0.39.0/mac.json или win.json — подписаны ключом разработчика, архив —
// в релизе «Пульса» на GitHub), скачивает её, сверяет SHA-256 и подпись, а при выходе или «Перезапустить» ставит:
//   • Mac — Pulse.app меняется целиком (тот же путь, что «новый движок» выше);
//   • Windows — установщик ставится тихо, новый «Пульс» открывается, прежний (папка, ярлыки, запись в «Установке и
//     удалении программ») удаляется. Не вышло — прежний «Пульс» остаётся и пробует снова при следующем запуске.
// Данные (лайки, плейлисты, история, вход, ключи друзей) новая версия забирает сама при первом запуске.
const MOVE_V = '0.41.0';
const MOVE_URL = { darwin: RAW + MOVE_V + '/mac.json', win32: RAW + MOVE_V + '/win.json' };
const winMsg = (v, arch, a) => ['PULSE-WIN-V1', v, arch, String(a.sha256 || '').toLowerCase(), String(Number(a.size) || 0)].join('\n');
function winGood(v, arch, a) {
  try {
    const k = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from('0YOwoaasY+1McD/zRxs0yNs3eywt/TCfmjYyMDkCuIs=', 'base64')]), format: 'der', type: 'spki' });
    const s = Buffer.from(String(a.sig || ''), 'base64');
    return s.length === 64 && /^[0-9a-f]{64}$/i.test(String(a.sha256 || '')) && a.size > 0 && crypto.verify(null, Buffer.from(winMsg(v, arch, a), 'utf8'), k, s);
  } catch { return false; }
}
let moving = null;
async function moveWin(progress) {
  const j = await getJSON(MOVE_URL.win32);
  const arch = 'x64', a = j && j[arch];
  if (!j || j.version !== MOVE_V || !a || !winGood(MOVE_V, arch, a) || !String(a.url).startsWith(PKG_PREFIX)) throw new Error('Новая версия для Windows ещё готовится');
  const dir = path.join(os.tmpdir(), 'pulse-move-' + MOVE_V); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const setup = path.join(dir, 'Pulse-Setup.exe');
  progress(0, 'Скачиваю новую версию «Пульса»');
  const r = await download([a.url], 15 * 60000);
  const h = crypto.createHash('sha256'); const fd = fs.openSync(setup, 'w'); let got = 0;
  try { for await (const chunk of r.body) { const b = Buffer.from(chunk); h.update(b); fs.writeSync(fd, b); got += b.length; progress(Math.min(0.9, (got / a.size) * 0.9), 'Скачиваю новую версию «Пульса»'); } }
  finally { fs.closeSync(fd); }
  if (got !== a.size || h.digest('hex') !== String(a.sha256).toLowerCase()) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error('Новая версия скачалась с ошибкой. Попробуем ещё раз позже'); }
  staged = { kind: 'move-win', version: MOVE_V, setup, dir };
  return staged;
}
async function doMove(progress) {
  progress = progress || (() => {});
  if (staged && (staged.kind === 'move-win' || (staged.kind === 'engine' && staged.version === MOVE_V))) return staged;
  if (process.platform === 'darwin') {
    if (!BOOT) throw new Error('Эту сборку для Mac нужно один раз поставить заново со страницы релиза «Пульса»');
    return installEngine({ version: MOVE_V, url: MOVE_URL.darwin }, progress);
  }
  if (process.platform === 'win32') return moveWin(progress);
  throw new Error('Новая версия есть только для Windows и Mac');
}
function move(progress) {
  if (!moving) moving = doMove(progress).finally(() => { moving = null; });
  return moving;
}
// Windows: ждём выхода, тихо ставим новую версию, открываем её и убираем прежний «Пульс»; не вышло — открываем прежний
function applyMoveWin(open) {
  if (!staged || staged.kind !== 'move-win' || staged.applied) return;
  staged.applied = true;
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dest = path.join(la, 'Pulse');
  const old = path.dirname(process.execPath);
  const q = (s) => String(s).replace(/'/g, "''");
  const ps = [
    "$p=" + process.pid + "; for($i=0;$i -lt 300 -and (Get-Process -Id $p -ErrorAction SilentlyContinue);$i++){Start-Sleep -Milliseconds 100}",
    "$r=Start-Process -FilePath '" + q(staged.setup) + "' -ArgumentList '/S','/D=" + q(dest) + "' -Wait -PassThru",
    "$exe=Get-ChildItem -LiteralPath '" + q(dest) + "' -Filter *.exe -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^(?i)uninstall' } | Select-Object -First 1",
    "if($r.ExitCode -eq 0 -and $exe){",
    "  " + (open ? "Start-Process -FilePath $exe.FullName;" : ""),
    "  $n='" + q('Пульс Десктоп Альфа') + ".lnk'; foreach($k in @('Desktop','Programs','Startup')){ $l=Join-Path ([Environment]::GetFolderPath($k)) $n; if(Test-Path -LiteralPath $l){ Remove-Item -LiteralPath $l -Force -ErrorAction SilentlyContinue } }",
    "  Remove-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PulseDesktopAlpha' -Recurse -Force -ErrorAction SilentlyContinue",
    "  if(Test-Path -LiteralPath '" + q(path.join(old, 'Pulse.exe')) + "'){ Start-Sleep -Seconds 2; Remove-Item -LiteralPath '" + q(old) + "' -Recurse -Force -ErrorAction SilentlyContinue }",
    "} else { " + (open ? "Start-Process -FilePath '" + q(process.execPath) + "'" : "") + " }",
    "Remove-Item -LiteralPath '" + q(staged.dir) + "' -Recurse -Force -ErrorAction SilentlyContinue",
  ].join('\r\n');
  const f = path.join(os.tmpdir(), 'pulse-move-' + process.pid + '.ps1');
  fs.writeFileSync(f, '﻿' + ps, 'utf8');
  const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', f], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
}
// сразу после запуска — сам, без кнопок (решение владельца: переход при обновлении); раз в 6 часов, если не вышло
if (app.isPackaged) app.whenReady().then(() => {
  const go = () => move().catch(() => setTimeout(go, 6 * 3600 * 1000));
  setTimeout(go, 15000);
});

// «Обновить» — скачать, поставить и сразу перезапустить
async function install(progress) {
  const s = await prepare(progress);
  if (staged && staged.kind === 'win') { progress(0.96, 'Ставлю обновление'); applyWin(); }
  if (staged && staged.kind === 'move-win') { progress(1, 'Перезапускаю'); applyMoveWin(true); app.exit(0); return s; }
  progress(1, s.engine && s.admin ? 'Перезапуск — macOS попросит пароль, чтобы заменить программу' : 'Перезапускаю');
  return s;
}

function restart() {
  if (staged && staged.kind === 'move-win') { applyMoveWin(true); app.exit(0); return; }
  if (staged && staged.kind === 'engine') { startSwap(staged.admin ? 'admin' : 'user'); staged.swapped = true; app.exit(0); return; }
  if (staged && staged.kind === 'win' && !applied) { try { applyWin(); } catch {} }
  app.relaunch(); app.exit(0);
}
// выход из программы без перезапуска: скачанное ставится сейчас, чтобы в следующий раз открылась новая версия
// (на Mac обычное обновление уже лежит в ota/; программа целиком меняется без пароля — иначе ждёт «Перезапустить»)
function onQuit() {
  if (!staged) return;
  if (staged.kind === 'move-win') { try { applyMoveWin(true); } catch {} return; }
  if (staged.kind === 'win' && !applied) { try { applyWin(); } catch {} }
  else if (staged.kind === 'engine' && !staged.admin && !staged.swapped) { staged.swapped = true; try { startSwap('quiet'); } catch {} }
}
const ready = () => pub(staged);

module.exports = { check, install, prepare, ready, restart, onQuit, newer, readZip: T.readZip, FEED };
