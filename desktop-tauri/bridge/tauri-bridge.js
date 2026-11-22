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
      // для /account/status — узнал ли Яндекс аккаунт (номер не пишем)
      if (/\/account\/status$/.test(e.u)) {
        return r.clone().text().then(function (t) {
          try { var d = JSON.parse(t); e.uid = !!(d && d.result && d.result.account && d.result.account.uid); e.keys = Object.keys((d && d.result) || d || {}).slice(0, 8).join(','); if (d && d.error) e.err = String(d.error.name || '') + ' ' + String(d.error.message || '').slice(0, 120); } catch (x) { e.err = 'не JSON: ' + t.slice(0, 80); }
          note(e); return r;
        });
      }
      note(e); return r;
    }, function (err) { e.ms = Date.now() - t0; e.err = String((err && err.message) || err).slice(0, 200); note(e); throw err; });
  }

  // yandex.js вызывает ys.add({ urls, key, codec }) → адрес pulseya:// (регистрирует программа)
  window.__PULSE_TAURI__ = {
    fetch: hfetch,
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
