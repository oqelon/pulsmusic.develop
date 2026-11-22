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
  setInterval(function () { try { localStorage.setItem('pulse.tauritest.alive', JSON.stringify({ t: Date.now(), page: location.hash || location.pathname, nodes: document.body ? document.body.getElementsByTagName('*').length : 0 })); } catch (x) {} }, 1000);

  var T = window.__TAURI__;
  if (!T || !T.core) { console.error('[pulse] нет связи с программой (__TAURI__)'); return; }
  var invoke = T.core.invoke;
  var ya = PulseYandex;
  var MAC = /Mac OS X|Macintosh/.test(navigator.userAgent || '');
  var WIN = /Windows/.test(navigator.userAgent || '');

  // данные прежних тестовых сборок (демо-треки этапов 2–3) — не настоящие, убираем один раз,
  // иначе демо-«токен» из них ушёл бы в Связку ключей. Касается только этой тестовой программы.
  try { if (localStorage.getItem('pulse.tauritest.seeded')) { localStorage.clear(); sessionStorage.clear(); } } catch (e) {}

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
  P.version = function () { return Promise.resolve('0.38.0-tauri-test'); };
  P.initialToken = token0;
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
  // обновлений у тестовой сборки нет
  var never = function () { return new Promise(function () {}); };
  P.update = { onProgress: function () { return function () {}; }, check: function () { return Promise.resolve({ ok: true, v: { available: false } }); }, install: never, restart: function () {}, prepare: never, ready: function () { return Promise.resolve(null); } };
  P.onAiStatus = function () { return function () {}; };
  P.aiStatus = function () { return Promise.resolve(null); };

  window.pulse = P;
})();
