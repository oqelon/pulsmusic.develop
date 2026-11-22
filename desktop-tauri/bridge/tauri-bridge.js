// window.pulse для Tauri — то же, что preload.js давал окну в Electron-версии, чтобы интерфейс «Пульса» работал без
// изменений. Яндекс: тот же yandex.js (PulseYandex, собирается из выпущенного файла с заменой Node-частей, см.
// build.mjs), запросы — через tauri-plugin-http, ссылки на звук — в pulseya:// (Rust).
// Токен: хранится в Связке ключей macOS (команда token_set), при открытии окна программа один раз передаёт его сюда
// (window.__PULSE_TOKEN__) — как preload.js в Electron читал его из зашифрованного хранилища.
(function () {
  'use strict';
  if (window.pulse) return;
  // ——— журнал ошибок окна (для Лаборатории, раздел «Этап 4»): ошибки JS, отклонённые обещания, console.error
  // и «пульс» окна раз в секунду — если окно почернело, а ошибок нет, значит упал сам процесс WebKit.
  var ELOG = 'pulse.tauritest.errors';
  function enote(kind, msg) {
    try {
      var l = JSON.parse(localStorage.getItem(ELOG) || '[]');
      l.push({ at: new Date().toISOString().slice(11, 19), k: kind, m: String(msg || '').replace(/y0_[\w-]+|OAuth [\w-]+/g, '[токен]').slice(0, 1200), page: location.hash || location.pathname });
      while (l.length > 80) l.shift();
      localStorage.setItem(ELOG, JSON.stringify(l));
    } catch (x) {}
  }
  try { enote('start', 'окно открыто, ' + navigator.userAgent); } catch (x) {}
  window.addEventListener('error', function (e) { enote('error', (e.message || '') + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno + (e.error && e.error.stack ? '\n' + e.error.stack : '')); });
  window.addEventListener('unhandledrejection', function (e) { var r = e.reason; enote('promise', (r && (r.stack || r.message)) || r); });
  var cerr = console.error.bind(console);
  console.error = function () { try { enote('console', Array.prototype.map.call(arguments, function (a) { return a && a.stack ? a.stack : typeof a === 'object' ? (function () { try { return JSON.stringify(a); } catch (x) { return String(a); } })() : String(a); }).join(' ')); } catch (x) {} cerr.apply(null, arguments); };
  // ——— журнал плеера (диагностика перемотки, 22.11): каждая перемотка и события звука с точным временем —
  // сколько от команды «перемотать» до «перемотал» (seeked) и до «играет», куда на самом деле встал плеер.
  (function () {
    var MLOG = 'pulse.tauritest.media', buf = [], seen = new WeakSet();
    function mnote(a, ev, extra) {
      var src = String(a.currentSrc || a.src || ''); src = src.replace(/^.*\/\/(s|a)\//, '').slice(0, 10);
      buf.push({ ms: Date.now(), ev: ev, src: src, t: +(+a.currentTime || 0).toFixed(2), x: extra || '' });
      if (buf.length > 300) buf.shift();
    }
    setInterval(function () { if (buf.length) try { localStorage.setItem(MLOG, JSON.stringify(buf)); } catch (x) {} }, 1000);
    function watch(a) {
      if (seen.has(a)) return; seen.add(a);
      ['seeking', 'seeked', 'waiting', 'playing', 'stalled', 'canplay', 'loadedmetadata', 'error', 'ended'].forEach(function (ev) { a.addEventListener(ev, function () { mnote(a, ev, ev === 'error' && a.error ? 'код ' + a.error.code : ''); }); });
    }
    try {
      var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) { watch(this); mnote(this, 'перемотать', '→ ' + (+v).toFixed(2)); d.set.call(this, v); } });
      var pl = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { watch(this); mnote(this, 'play()'); return pl.apply(this, arguments); };
    } catch (x) { enote('media', 'журнал плеера не включился: ' + x); }
  })();
  // запуски окна: если интерфейс перезагрузился сам (а не программу открыли заново), здесь будет видно — как и с какой страницы
  try {
    var nv = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {};
    var prev = JSON.parse(localStorage.getItem('pulse.tauritest.alive') || 'null');
    var boots = JSON.parse(localStorage.getItem('pulse.tauritest.boots') || '[]');
    boots.push({ at: new Date().toISOString().slice(0, 19).replace('T', ' '), how: nv.type || '?', prevAgo: prev ? Math.round((Date.now() - prev.t) / 1000) : null, prevPage: prev ? prev.title || prev.page : null });
    localStorage.setItem('pulse.tauritest.boots', JSON.stringify(boots.slice(-20)));
  } catch (x) {}
  // картинки, которые не загрузились (обложки): адрес без параметров — для отчёта (первые 30 за запуск)
  (function () { var n = 0; document.addEventListener && document.addEventListener('error', function (e) {
    var t = e && e.target; if (!t || t.tagName !== 'IMG' || n >= 30) return; n++;
    enote('img', 'не загрузилась: ' + String(t.currentSrc || t.src || '').split('?')[0].slice(0, 160));
  }, true); })();
  setInterval(function () { try { localStorage.setItem('pulse.tauritest.alive', JSON.stringify({ t: Date.now(), page: location.hash || location.pathname, nodes: document.body ? document.body.getElementsByTagName('*').length : 0, title: ((document.querySelector('.main .page h1') || {}).textContent || '').slice(0, 60) })); } catch (x) {} }, 1000);

  var T = window.__TAURI__;
  if (!T || !T.core) { console.error('[pulse] нет связи с программой (__TAURI__)'); return; }
  var invoke = T.core.invoke;
  var ya = PulseYandex;
  var MAC = /Mac OS X|Macintosh/.test(navigator.userAgent || '');
  var WIN = /Windows/.test(navigator.userAgent || '');

  // данные прежних тестовых сборок (демо-треки этапов 2–3) — не настоящие, убираем один раз,
  // иначе демо-«токен» из них ушёл бы в Связку ключей. Касается только этой тестовой программы.
  try { if (localStorage.getItem('pulse.tauritest.seeded')) { localStorage.clear(); sessionStorage.clear(); } } catch (e) {}

  // этап 5: перенос данных из Electron-версии (или возврат «как было»). Программа передаёт данные окну при его
  // открытии — до запуска интерфейса, поэтому интерфейс сразу видит перенесённые лайки, плейлисты, историю,
  // статистику и настройки. Каждая запись сверяется после записи; итог — программе (migrate_applied).
  (function () {
    var imp = window.__PULSE_IMPORT__, res = window.__PULSE_RESTORE__;
    try { delete window.__PULSE_IMPORT__; delete window.__PULSE_RESTORE__; } catch (e) { window.__PULSE_IMPORT__ = window.__PULSE_RESTORE__ = undefined; }
    var own = function (k) { return /^pulse\./.test(k) && !/^pulse\.tauritest\./.test(k) && k !== 'pulse.engine' && !/^pulse\.migrate/.test(k); };
    var snap = function () { var o = {}; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (own(k)) o[k] = localStorage.getItem(k); } return o; };
    try {
      if (res && res.ls) {
        Object.keys(snap()).forEach(function (k) { localStorage.removeItem(k); });
        Object.keys(res.ls).forEach(function (k) { if (own(k)) try { localStorage.setItem(k, String(res.ls[k])); } catch (e) {} });
        enote('migrate', 'возврат «как было до переноса»: ' + Object.keys(res.ls).length + ' записей');
        invoke('migrate_restored').catch(function (e) { enote('migrate', 'migrate_restored: ' + e); });
      } else if (imp && imp.ls) {
        var before = JSON.stringify(snap()), n = 0, bad = [];
        Object.keys(imp.ls).forEach(function (k) {
          if (!own(k)) return; var v = String(imp.ls[k]);
          try { localStorage.setItem(k, v); } catch (e) { bad.push(k + ': ' + (e && e.name || e)); return; }
          if (localStorage.getItem(k) !== v) bad.push(k + ': прочиталось не то'); else n++;
        });
        enote('migrate', 'перенос из Electron: записано ' + n + ', ошибок ' + bad.length);
        invoke('migrate_applied', { stamp: String(imp.stamp || ''), before: before, n: n, bad: bad }).catch(function (e) { enote('migrate', 'migrate_applied: ' + e); });
      }
    } catch (e) { enote('migrate', 'перенос: ' + e); }
  })();

  var token0 = typeof window.__PULSE_TOKEN__ === 'string' ? window.__PULSE_TOKEN__ : '';
  try { delete window.__PULSE_TOKEN__; } catch (e) { window.__PULSE_TOKEN__ = undefined; }
  try { enote('token', 'при открытии окна: ' + (window.__PULSE_TOKEN_INFO__ || 'нет сведений')); delete window.__PULSE_TOKEN_INFO__; } catch (e) {}

  // Запросы yandex.js → tauri-plugin-http. Плагин сам добавляет заголовок Origin (tauri://localhost) — в Electron
  // (Node.js) его не было, и Яндекс на запрос с чужим Origin может ответить отказом. Пустой Origin плагин убирает
  // (сборка с unsafe-headers) — запрос становится таким же, как из Electron-версии.
  // Журнал последних запросов (без токена, без адресов с параметрами, без тел) — для раздела «Связь с Яндексом» в
  // Лаборатории (тот же адрес окна → тот же localStorage).
  var LOG = 'pulse.tauritest.httplog';
  function note(e) {
    try { var l = JSON.parse(localStorage.getItem(LOG) || '[]'); l.push(e); while (l.length > 60) l.shift(); localStorage.setItem(LOG, JSON.stringify(l)); } catch (x) {}
  }
  function where(u) { try { var x = new URL(u); return x.origin + x.pathname.replace(/\/[0-9a-f]{20,}/gi, '/…'); } catch (e) { return '?'; } }
  function hfetch(u, o) {
    o = o || {};
    var h = {}; var src = o.headers || {};
    Object.keys(src).forEach(function (k) { h[k] = src[k]; });
    h.Origin = '';
    var t0 = Date.now(), e = { at: new Date().toISOString().slice(11, 19), m: o.method || 'GET', u: where(u), auth: !!h.Authorization, sent: Object.keys(h).filter(function (k) { return k !== 'Authorization'; }).join(',') };
    return T.http.fetch(u, Object.assign({}, o, { headers: h })).then(function (r) {
      e.st = r.status; e.ms = Date.now() - t0;
      // для /account/status — узнал ли Яндекс аккаунт (номер не пишем). Ответ читаем ОДИН раз и отдаём yandex.js
      // новый Response с тем же текстом: clone() у ответа плагина в WebKit, похоже, ломал вход («Яндекс не отвечает»).
      if (/\/account\/status$/.test(e.u)) {
        return r.text().then(function (t) {
          try { var d = JSON.parse(t); e.uid = !!(d && d.result && d.result.account && d.result.account.uid); e.keys = Object.keys((d && d.result) || d || {}).slice(0, 8).join(','); if (d && d.error) e.err = String(d.error.name || '') + ' ' + String(d.error.message || '').slice(0, 120); } catch (x) { e.err = 'не JSON: ' + String(t).slice(0, 80); }
          note(e);
          return new Response(t, { status: r.status, statusText: r.statusText, headers: r.headers });
        }, function (x) { e.err = 'ответ не прочитался: ' + String((x && x.message) || x).slice(0, 160); note(e); throw x; });
      }
      note(e); return r;
    }, function (err) { e.ms = Date.now() - t0; e.err = String((err && err.message) || err).replace(/y0_[\w-]+|OAuth [\w-]+/g, '[токен]').slice(0, 200); if (h.Authorization) e.err += ' (токен: ' + tokShape(String(h.Authorization).slice(6)) + ')'; note(e); throw err; });
  }

  // yandex.js вызывает ys.add({ urls, key, codec }) → адрес pulseya:// (регистрирует программа)
  window.__PULSE_TAURI__ = {
    fetch: hfetch,
    yaAdd: function (o) { return invoke('ya_add', { urls: [].concat((o && o.urls) || []), key: (o && o.key) || null, codec: (o && o.codec) || null }); },
  };

  // Токен из поля ввода: на Mac в него попадало что-то длиннее 4096 символов, и заголовок Authorization с таким
  // значением WebKit отвергал сразу («Type error»). Достаём сам токен: из адреса после access_token=, либо токен
  // вида y0_… / AQAAAA… из любого текста, без пробелов и переносов. Сам токен никуда не пишется — в журнал
  // попадает только его «форма»: длина, есть ли не-латинские символы, пробелы, на что похоже.
  function tokShape(t) {
    t = String(t || '');
    return 'длина ' + t.length + (/[^\x20-\x7e]/.test(t) ? ', есть не-латинские/служебные символы' : '') + (/\s/.test(t) ? ', есть пробелы/переносы' : '') +
      (/access_token=/.test(t) ? ', адрес с access_token' : /^y0_/.test(t) ? ', вид y0_' : /^AQAA/.test(t) ? ', вид AQAA' : ', вид неизвестен');
  }
  var shapes = {};
  function tok(t) {
    var raw = String(t || ''), v = raw;
    var m = raw.match(/access_token=([^&\s#"'<>]+)/);
    if (m) v = m[1];
    else { var k = raw.match(/(?:^|[^A-Za-z0-9_-])((?:y0_|AQAAAA)[A-Za-z0-9_-]{20,})/); if (k) v = k[1]; else v = raw.replace(/\s+/g, ''); }
    try { v = decodeURIComponent(v); } catch (x) {}
    if (raw && !shapes[raw.length]) { shapes[raw.length] = 1; if (v !== raw) enote('token', 'введено: ' + tokShape(raw) + ' → взят токен: ' + tokShape(v)); }
    return v;
  }
  // похоже ли на токен: только латиница, цифры, «._-», разумная длина. Иначе это не токен — в запрос его не кладём
  // (WebKit отвергает такой заголовок, и выглядело бы как «Яндекс не отвечает»).
  function tokOk(v) { return !v || (v.length <= 300 && /^[A-Za-z0-9._-]+$/.test(v)); }
  function notToken(raw) {
    return 'В поле вставлен не токен (' + String(raw || '').length + ' символов, в тексте нет access_token и нет токена вида y0_…). ' +
      'Нажмите «Получить токен» — откроется окно входа в Яндекс, и программа сама заберёт токен';
  }

  var P = {};
  // как ym:<метод> в main.js: { ok, v, tokenProblem } или { ok: false, error }
  ['account', 'search', 'chart', 'artist', 'artistInfo', 'album', 'wave', 'waveFeedback', 'stream', 'lyrics', 'landing', 'playlist', 'likes', 'tracksById', 'likeSet'].forEach(function (m) {
    P[m] = function () {
      var args = Array.prototype.slice.call(arguments);
      if (args.length) {
        var raw0 = args[0]; args[0] = tok(args[0]);
        if (!tokOk(args[0])) {
          if (m === 'account') return Promise.resolve({ ok: true, v: { auth: false, kind: 'bad', error: notToken(raw0) }, tokenProblem: 'Токен не подошёл' });
          args[0] = '';
        }
      }
      return Promise.resolve().then(function () { return ya[m].apply(ya, args); })
        .then(function (v) { return { ok: true, v: v, tokenProblem: ya.tokenProblem() }; })
        .catch(function (e) { console.log('[ym]', m, '→', e && e.message); return { ok: false, error: String((e && e.message) || e) }; });
    };
  });

  var win = function () { return T.window && T.window.getCurrentWindow ? T.window.getCurrentWindow() : null; };
  P.platform = MAC ? 'darwin' : WIN ? 'win32' : 'linux';
  // как app:version в Electron — функция, возвращающая обещание (Program.jsx вызывает window.pulse.version())
  P.version = function () { return invoke('app_version').catch(function () { return { version: '0.38.0 (Tauri)' }; }); };
  P.initialToken = token0;
  // аккаунт «Пульса» (друзья, чаты, «Искра»): ключи — в Связке ключей программы (как social.bin в Electron)
  P.socialGet = function () { return invoke('social_get'); };
  P.socialSet = function (p) { return invoke('social_set', { patch: p || {} }); };
  // своя музыка (library.rs): окно получает список и адреса pulsefile://, не сами пути к файлам
  var dropAt = 0, dropPaths = [];
  try {
    T.event.listen('tauri://drag-drop', function (e) {
      var ps = (e && e.payload && e.payload.paths) || []; if (!ps.length) return;
      dropAt = Date.now(); dropPaths = ps;
      // открыта «Запись CD» — файлы идут в список диска, а не в «Мою музыку»: окну передаём обычное событие drop
      // (страница сама вызовет cd.addFiles, пути возьмутся отсюда)
      var cdp = document.querySelector('.cd-page');
      if (cdp) {
        try { var dt = new DataTransfer(); ps.forEach(function (p) { dt.items.add(new File([], String(p).split(/[\\/]/).pop() || 'file')); }); cdp.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); }
        catch (x) { enote('cd', 'перетаскивание: ' + x); }
        return;
      }
      // перетащили музыку или папки на окно — добавляем в «Мою музыку» (как перетаскивание в Electron-версии)
      invoke('local_add', { paths: ps.slice(0, 200) }).then(function (n) { if (n) enote('local', 'перетащено: добавлено ' + n); }).catch(function (x) { enote('local', 'перетаскивание: ' + x); });
    });
  } catch (x) {}
  var localSubs = { changed: [], progress: [] };
  try { T.event.listen('pulse-local', function (e) { var p = e && e.payload; if (!p) return; (localSubs[p.k] || []).forEach(function (f) { try { f(p.v); } catch (x) {} }); }); } catch (x) {}
  var sub = function (k) { return function (cb) { localSubs[k].push(cb); return function () { localSubs[k] = localSubs[k].filter(function (f) { return f !== cb; }); }; }; };
  P.local = {
    list: function () { return invoke('local_list'); },
    pick: function () { return invoke('local_pick'); },
    pickFiles: function () { return invoke('local_pick_files'); },
    // перетаскивание: пути приходят от программы (событие tauri://drag-drop) — уже добавлены
    drop: function () { return Promise.resolve(Date.now() - dropAt < 3000 ? dropPaths.length : 0); },
    remove: function (root) { return invoke('local_remove', { root: String(root || '') }); },
    rescan: function () { return invoke('local_rescan'); },
    hide: function (ids) { return invoke('local_hide', { ids: [].concat(ids || []).map(String) }); },
    unhide: function () { return invoke('local_unhide'); },
    reveal: function (id) { return invoke('local_reveal', { id: String(id || '') }); },
    onChange: sub('changed'),
    onProgress: sub('progress'),
  };
  P.saveToken = function (t) { var v = tok(t); if (!tokOk(v)) { enote('token', 'не сохранён: ' + tokShape(v)); return Promise.resolve(false); } return invoke('token_set', { token: v }).then(function (where) { enote('token', 'сохранён: ' + where); return true; }, function (e) { enote('token', 'не сохранён: ' + e); return false; }); };
  P.openExternal = function (u) {
    u = String(u || '');
    // «Получить токен» → окно входа в Яндекс внутри программы (токен программа заберёт сама)
    if (/^https:\/\/oauth\.yandex\.(ru|com)\/authorize/i.test(u)) return invoke('ya_login').then(function () { return true; }, function (e) { enote('login', String(e)); return false; });
    if (!/^https:\/\//i.test(u)) return Promise.resolve(false);
    return (T.opener && T.opener.openUrl ? T.opener.openUrl(u) : Promise.reject(new Error('нет opener'))).then(function () { return true; }, function (e) { console.log('[pulse] openExternal', e); return false; });
  };
  P.yaFmt = function (u) { return invoke('ya_fmt', { url: String(u || '') }); };
  // как win:fs: без аргумента — переключить; возвращает, во весь ли экран теперь
  P.fullscreen = function (v) {
    var w = win(); if (!w) return Promise.resolve(false);
    return w.isFullscreen().then(function (cur) { var next = v == null ? !cur : !!v; return (next === cur ? Promise.resolve() : w.setFullscreen(next)).then(function () { return next; }); }).catch(function () { return false; });
  };
  P.onFullscreen = function (cb) {
    var w = win(); if (!w) return function () {};
    var off = null, dead = false, last = null;
    w.onResized(function () { w.isFullscreen().then(function (v) { if (v !== last) { last = v; cb(!!v); } }); }).then(function (u) { if (dead) u(); else off = u; });
    return function () { dead = true; if (off) off(); };
  };
  // обновления по воздуху (updater.rs): те же ответы, что у upd:* в Electron-версии
  var updErr = function (e) { return { ok: false, error: String((e && e.message) || e) }; };
  P.update = {
    check: function () { return invoke('upd_check').catch(updErr); },
    install: function () { return invoke('upd_install').catch(updErr); },
    prepare: function () { return invoke('upd_prepare').catch(updErr); },
    restart: function () { return invoke('upd_restart').catch(function () {}); },
    ready: function () { return invoke('upd_ready').catch(function () { return null; }); },
    onProgress: function (cb) {
      var off = null, dead = false;
      try { T.event.listen('pulse-upd', function (e) { try { cb(e && e.payload); } catch (x) {} }).then(function (u) { if (dead) u(); else off = u; }); } catch (x) {}
      return function () { dead = true; if (off) off(); };
    },
  };

  // ——— этап 6.3: то, что в Electron делал главный процесс (cd.rs, extras.rs); ответы — как у Electron-версии
  var listen = function (ev, cb) {
    var off = null, dead = false;
    try { T.event.listen(ev, function (e) { try { cb(e && e.payload); } catch (x) {} }).then(function (u) { if (dead) u(); else off = u; }); } catch (x) {}
    return function () { dead = true; if (off) off(); };
  };
  P.discord = {
    enable: function (v) { return invoke('discord_enable', { v: !!v }).catch(function () { return 'off'; }); },
    set: function (t) { return invoke('discord_set', { t: t && typeof t === 'object' ? t : null }).catch(function () { return 'off'; }); },
    state: function () { return invoke('discord_state').catch(function () { return 'off'; }); },
    onState: function (f) { return listen('pulse-discord', f); },
  };
  P.openDevTools = function () { return invoke('dev_devtools').catch(function () { return { ok: false }; }); };
  P.devUnlock = function (pw) { return invoke('dev_unlock', { pw: String(pw || '') }); };
  P.online = function () { return invoke('online_get').catch(function () { return { ok: false, error: 'Нет ответа' }; }); };
  P.perf = function () { return invoke('perf_info'); };
  P.perfSlow = function (v) { return invoke('perf_slow', { v: !!v }).catch(function () { return false; }); };
  P.perfUnsafe = function () { return invoke('perf_unsafe').catch(function () { return false; }); };
  P.relaunch = function () { return invoke('perf_relaunch').catch(function () {}); };
  P.audioCors = function (u) { return invoke('audio_cors', { url: String(u || '') }).catch(function () { return false; }); };
  P.onPower = function (cb) { return listen('pulse-power', function (v) { cb(!!v); }); };
  // запись CD и «WAV для CD»: звук кусками — сырыми байтами (без перевода в JSON)
  var ab = function (d) { return d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(0); };
  P.cd = {
    drives: function () { return invoke('cd_drives'); },
    begin: function (n) { return invoke('cd_begin', { n: n | 0 }); },
    put: function (id, i, data, mode) { return invoke('cd_put', ab(data), { headers: { 'x-id': String(id), 'x-i': String(i | 0), 'x-mode': String(mode | 0) } }).catch(function (e) { return { ok: false, err: String(e) }; }); },
    burn: function (id, o) { return invoke('cd_burn', { id: String(id), o: o || {} }); },
    eject: function (d) { return invoke('cd_eject', { d: String(d == null ? '' : d) }); },
    cancel: function () { return invoke('cd_cancel'); },
    onProgress: function (cb) { return listen('pulse-cd', cb); },
    pickFiles: function () { return invoke('cdw_pick_files'); },
    pickFolder: function () { return invoke('cdw_pick_folder'); },
    // перетащенные в окно файлы: пути пришли от программы (tauri://drag-drop), окну они не видны
    addFiles: function () { var ps = Date.now() - dropAt < 3000 ? dropPaths.slice(0, 2000) : []; dropAt = 0; return invoke('cdw_add_paths', { paths: ps }); },
    pickOut: function (cur) { return invoke('cdw_pick_out', { cur: typeof cur === 'string' ? cur : null }); },
    piece: function (file, s, e) {
      return invoke('cd_piece', { file: String(file), s: +s || 0, e: +e || 0 }).then(function (buf) {
        var u = new Uint8Array(buf); var seg = u[0] === 1;
        return { ok: true, seg: seg, at: seg ? Math.max(0, +s || 0) : 0, data: u.slice(1).buffer };
      }, function (er) { return { ok: false, err: String((er && er.message) || er) }; });
    },
    wavOpen: function (dir, name, mode) { return invoke('cdw_open', { dir: String(dir || ''), name: String(name || ''), mode: mode || null }); },
    wavWrite: function (id, data) { return invoke('cdw_write', ab(data), { headers: { 'x-id': String(id) } }).catch(function (e) { return { ok: false, err: String(e) }; }); },
    wavFinish: function (id, n) { return invoke('cdw_finish', { id: String(id), n: Math.max(0, n | 0) }); },
    wavAbort: function (id) { return invoke('cdw_abort', { id: String(id) }); },
    reveal: function (p) { return invoke('cdw_reveal', { p: String(p || '') }); },
  };

  // ——— шапка окна. В Electron полоса .win-drag таскала окно (-webkit-app-region), а на Windows системные кнопки
  // «свернуть / развернуть / закрыть» рисовались поверх тёмного фона (titleBarOverlay, высота 40, значки #c7c7cc).
  // В Tauri: полосе даём data-tauri-drag-region (таскание и двойной щелчок — развернуть), а на Windows рисуем те же
  // кнопки сами — в стиле Windows 11, на том же месте и того же размера. Исходники интерфейса не меняются.
  (function () {
    var queued = false;
    var mark = function () { queued = false; try { var l = document.querySelectorAll('.win-drag:not([data-tauri-drag-region])'); for (var i = 0; i < l.length; i++) l[i].setAttribute('data-tauri-drag-region', ''); } catch (x) {} };
    var start = function () {
      if (typeof document.querySelectorAll !== 'function' || !document.documentElement) return;
      mark();
      try { new MutationObserver(function () { if (!queued) { queued = true; requestAnimationFrame(mark); } }).observe(document.documentElement, { childList: true, subtree: true }); } catch (x) {}
      if (!WIN) return;
      var w = win(); if (!w || !document.head || !document.body) return;
      var css = document.createElement('style');
      css.textContent = '.pulse-cap{position:fixed;top:0;right:0;height:40px;display:flex;z-index:2147483000;-webkit-app-region:no-drag;user-select:none}' +
        '.pulse-cap button{width:46px;height:40px;border:0;margin:0;padding:0;background:transparent;color:#c7c7cc;font:10px "Segoe Fluent Icons","Segoe MDL2 Assets";display:flex;align-items:center;justify-content:center;cursor:default;outline:none;transition:background-color .1s}' +
        '.pulse-cap button:hover{background:rgba(255,255,255,.0605);color:#fff}.pulse-cap button:active{background:rgba(255,255,255,.0419)}' +
        '.pulse-cap button.x:hover{background:#c42b1c;color:#fff}.pulse-cap button.x:active{background:#c83c31}' +
        'html.pulse-fs .pulse-cap{display:none}';
      document.head.appendChild(css);
      var box = document.createElement('div'); box.className = 'pulse-cap';
      var mk = function (glyph, title, cls, fn) { var b = document.createElement('button'); b.type = 'button'; b.textContent = glyph; b.title = title; if (cls) b.className = cls; b.addEventListener('click', function (e) { e.stopPropagation(); fn(); }); box.appendChild(b); return b; };
      mk('', 'Свернуть', '', function () { w.minimize(); });
      var mx = mk('', 'Развернуть', '', function () { w.toggleMaximize(); });
      mk('', 'Закрыть', 'x', function () { w.close(); });
      document.body.appendChild(box);
      var sync = function () {
        w.isMaximized().then(function (m) { mx.textContent = m ? '' : ''; mx.title = m ? 'Свернуть в окно' : 'Развернуть'; }).catch(function () {});
        w.isFullscreen().then(function (f) { document.documentElement.classList.toggle('pulse-fs', !!f); }).catch(function () {});
      };
      sync(); try { w.onResized(sync); } catch (x) {}
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  })();
  P.onAiStatus = function () { return function () {}; };
  P.aiStatus = function () { return Promise.resolve(null); };

  window.pulse = P;
})();
