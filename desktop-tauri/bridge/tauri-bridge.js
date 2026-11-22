// window.pulse для Tauri — то же, что preload.js давал окну в Electron-версии, чтобы интерфейс «Пульса» работал без
// изменений. Яндекс: тот же yandex.js (PulseYandex, собирается из выпущенного файла с заменой Node-частей, см.
// build.mjs), запросы — через tauri-plugin-http, ссылки на звук — в pulseya:// (Rust).
// Токен: хранится в Связке ключей macOS (команда token_set), при открытии окна программа один раз передаёт его сюда
// (window.__PULSE_TOKEN__) — как preload.js в Electron читал его из зашифрованного хранилища.
(function () {
  'use strict';
  if (window.pulse) return;
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

  // yandex.js вызывает ys.add({ urls, key, codec }) → адрес pulseya:// (регистрирует программа)
  window.__PULSE_TAURI__ = {
    yaAdd: function (o) { return invoke('ya_add', { urls: [].concat((o && o.urls) || []), key: (o && o.key) || null, codec: (o && o.codec) || null }); },
  };

  var P = {};
  // как ym:<метод> в main.js: { ok, v, tokenProblem } или { ok: false, error }
  ['account', 'search', 'chart', 'artist', 'artistInfo', 'album', 'wave', 'waveFeedback', 'stream', 'lyrics', 'landing', 'playlist', 'likes', 'tracksById', 'likeSet'].forEach(function (m) {
    P[m] = function () {
      var args = arguments;
      return Promise.resolve().then(function () { return ya[m].apply(ya, args); })
        .then(function (v) { return { ok: true, v: v, tokenProblem: ya.tokenProblem() }; })
        .catch(function (e) { console.log('[ym]', m, '→', e && e.message); return { ok: false, error: String((e && e.message) || e) }; });
    };
  });

  var win = function () { return T.window && T.window.getCurrentWindow ? T.window.getCurrentWindow() : null; };
  P.platform = MAC ? 'darwin' : WIN ? 'win32' : 'linux';
  P.version = '0.38.0-tauri-test';
  P.initialToken = token0;
  P.saveToken = function (t) { return invoke('token_set', { token: String(t || '') }); };
  P.openExternal = function (u) {
    u = String(u || '');
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
