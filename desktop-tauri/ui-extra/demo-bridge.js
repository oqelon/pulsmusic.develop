// Подставной window.pulse для ТЕСТОВОЙ сборки на Tauri (этапы 2–3 миграции).
// Интерфейс «Пульса» 0.38.0 остаётся как есть; вместо Яндекса — демо-треки, каждый играет свой тестовый
// файл (FLAC, ALAC, AAC, MP3, OGG, Opus, WebM, WAV…) через схему pulsetest://. Так на Mac проверяется настоящий
// плеер: мини-плеер, перемотка, эквалайзер, кроссфейд, выбор устройства вывода, фоновое воспроизведение.
// Никаких сетевых запросов, токенов и личных данных здесь нет.
(function () {
  if (window.pulse) return;
  var ua = navigator.userAgent || '';
  var WIN = /Windows/.test(ua);
  var MAC = /Mac OS X|Macintosh/.test(ua);
  // на Windows WebView2 открывает свои схемы как http://<схема>.localhost
  var BASE = WIN ? 'http://pulsetest.localhost/test/' : 'pulsetest://localhost/test/';

  var YA = WIN ? 'http://pulseya.localhost/s/' : 'pulseya://s/';
  var FILE = WIN ? 'http://pulsefile.localhost/a/' : 'pulsefile://a/';
  // [файл или адрес, название, кодек, кбит/с, без потерь, качество]
  // Первые — этап 3: звук отдаёт Rust так же, как будет в настоящем «Пульсе» (pulseya:// и pulsefile://)
  var F = [
    [YA + 'lab-flac16', 'Яндекс-поток: FLAC 16/44 (расшифровка в Rust)', 'flac-mp4', 900, true, 'lossless'],
    [YA + 'lab-flac24', 'Яндекс-поток: FLAC 24/96 (расшифровка в Rust)', 'flac-mp4', 3000, true, 'lossless'],
    [YA + 'lab-aac', 'Яндекс-поток: AAC 256', 'aac-mp4', 256, false, 'hq'],
    [YA + 'lab-mp3', 'Яндекс-поток: MP3 320', 'mp3', 320, false, 'hq'],
    [YA + 'lab-retry', 'Яндекс-поток: запасная ссылка', 'flac-mp4', 900, true, 'lossless'],
    [FILE + 'lab-flac', 'Свой файл: FLAC 24/96', 'flac', 3000, true, 'lossless'],
    [FILE + 'lab-cd', 'Свой файл: образ аудио-CD → WAV', 'wav', 1411, true, 'lossless'],
    [FILE + 'lab-aiff', 'Свой файл: AIFF', 'aiff', 1411, true, 'lossless'],
    ['flac-16-44.flac', 'FLAC 16 бит / 44,1 кГц', 'flac', 900, true, 'lossless'],
    ['flac-24-96.flac', 'FLAC 24 бит / 96 кГц', 'flac', 3000, true, 'lossless'],
    ['flac-24-192.flac', 'FLAC 24 бит / 192 кГц', 'flac', 6000, true, 'lossless'],
    ['flac-in-mp4.m4a', 'FLAC в MP4 (как у Яндекса)', 'flac-mp4', 900, true, 'lossless'],
    ['alac-16-44.m4a', 'ALAC 16 бит / 44,1 кГц', 'alac', 900, true, 'lossless'],
    ['mp3-320.mp3', 'MP3 320', 'mp3', 320, false, 'hq'],
    ['aac-256.m4a', 'AAC 256', 'aac', 256, false, 'hq'],
    ['ogg-vorbis.ogg', 'OGG Vorbis', 'vorbis', 192, false, 'hq'],
    ['opus.opus', 'Opus (OGG)', 'opus', 160, false, 'hq'],
    ['webm-opus.webm', 'Opus (WebM)', 'opus', 160, false, 'hq'],
    ['webm-vorbis.webm', 'Vorbis (WebM)', 'vorbis', 192, false, 'hq'],
    ['wav-16-44.wav', 'WAV 16 бит / 44,1 кГц', 'wav', 1411, true, 'lossless'],
    ['wav-24-96.wav', 'WAV 24 бит / 96 кГц', 'wav', 4608, true, 'lossless'],
    ['wavpack.wv', 'WavPack (ожидаемо может не играть)', 'wavpack', 900, true, 'lossless'],
  ];
  // обложки рисуем сами (SVG), без картинок из сети
  var HUE = [12, 38, 160, 200, 262, 320];
  var cover = function (i) {
    var h = HUE[i % HUE.length], h2 = (h + 40) % 360;
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>" +
      "<stop offset='0' stop-color='hsl(" + h + ",70%,55%)'/><stop offset='1' stop-color='hsl(" + h2 + ",60%,22%)'/></linearGradient></defs>" +
      "<rect width='400' height='400' fill='url(#g)'/><circle cx='300' cy='110' r='70' fill='rgba(255,255,255,.12)'/></svg>";
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  };
  var AR = ['Тестовый звук', 'Лаборатория', 'Без потерь', 'Сжатый звук', 'Контейнеры', 'Проверка'].map(function (n, i) { return { id: 'a' + i, name: n }; });
  var T = F.map(function (f, i) {
    var a = AR[f[4] ? (i % 3) : 3 + (i % 3)];
    return { id: 't' + i, title: f[1], artist: a.name, artists: [a], album: { id: 'al' + (i % 4), title: 'Проверка звука' }, cover: cover(i), coverBig: cover(i), dur: 10 };
  });
  var byId = {}; T.forEach(function (t, i) { byId[t.id] = i; });
  var ok = function (v) { return Promise.resolve({ ok: true, v: v }); };
  var never = function () { return new Promise(function () {}); };
  var pl = function (t, i, d) { return { uid: 'u' + i, kind: String(i), title: t, desc: d, count: T.length, cover: cover(i), coverBig: cover(i) }; };

  window.pulse = {
    platform: MAC ? 'darwin' : WIN ? 'win32' : 'linux',
    version: '0.38.0-tauri-test',
    account: function () { return ok({ auth: true, uid: '100', login: 'tauri-test' }); },
    search: function () { return ok({ tracks: T, artists: AR, albums: [] }); },
    chart: function () { return ok(T); },
    artist: function (tk, id) { return ok({ info: { id: id, name: (AR.find(function (a) { return a.id === id; }) || AR[0]).name, counts: { tracks: T.length } }, tracks: T, albums: [], similar: [] }); },
    artistInfo: function () { return ok({}); },
    album: function () { return ok(null); },
    wave: function () { return ok({ tracks: T }); },
    waveFeedback: function () { return ok(true); },
    likes: function () { return ok([]); },
    tracksById: function () { return ok(T); },
    likeSet: function () { return ok(true); },
    lyrics: function () { return ok({ none: true }); },
    // каждый демо-трек — свой тестовый файл
    stream: function (tk, id) {
      var i = byId[id]; if (i == null) i = (parseInt(String(id).replace(/\D/g, ''), 10) || 0) % F.length;
      var f = F[i];
      return ok({ url: /:\/\//.test(f[0]) ? f[0] : BASE + f[0], codec: f[2], bitrate: f[3], lossless: f[4], quality: f[5], preview: false });
    },
    // схема своя, отдаёт Access-Control-Allow-Origin: * — эквалайзер можно подключать
    audioCors: function () { return Promise.resolve(true); },
    // частота и разрядность потока Яндекса — узнаёт Rust по первым байтам (единственная команда, доступная этому окну)
    yaFmt: function (u) { var T = window.__TAURI__; return T && T.core ? T.core.invoke('ya_fmt', { url: String(u || '') }) : Promise.resolve(null); },
    landing: function () {
      return ok({
        personal: [pl('Плейлист дня', 0, 'Все тестовые форматы'), pl('Без потерь', 1, 'FLAC, ALAC, WAV'), pl('Сжатый звук', 2, 'MP3, AAC, OGG, Opus'), pl('Контейнеры', 3, 'MP4, OGG, WebM')],
        releases: T.slice(0, 8).map(function (t, i) { return { id: 'r' + i, title: t.title, year: 2026, cover: cover(i + 1) }; }),
        playlists: [pl('Проверка звука', 4, T.length + ' треков по 10 секунд'), pl('Кроссфейд', 5, 'Переходы между форматами')],
      });
    },
    playlist: function () { return ok({ info: { title: 'Проверка звука', desc: T.length + ' тестовых треков', cover: cover(0), coverBig: cover(0) }, tracks: T }); },
    openExternal: function (u) { try { window.open(u, '_blank'); } catch (e) {} },
    onAiStatus: function () { return function () {}; },
    aiStatus: function () { return Promise.resolve(null); },
    update: { onProgress: function () { return function () {}; }, check: function () { return ok({ available: false }); }, install: never, restart: function () {}, prepare: never, ready: function () { return Promise.resolve(null); } },
    fullscreen: function () { return Promise.resolve(false); },
    onFullscreen: function () { return function () {}; },
  };

  // стартовые данные — один раз, чтобы ваши изменения (эквалайзер, лайки) сохранялись между запусками
  try {
    if (!localStorage.getItem('pulse.tauritest.seeded')) {
      localStorage.setItem('pulse.tauritest.seeded', '1');
      localStorage.setItem('pulse.settings', JSON.stringify({ token: 'demo', dark: true, onboarded: true, effects: 'full' }));
      localStorage.setItem('pulse.recent', JSON.stringify(T.slice(0, 8)));
      localStorage.setItem('pulse.playlists', JSON.stringify([
        { id: 'p1', name: 'Без потерь', tracks: T.filter(function (t, i) { return F[i][4]; }), at: 2 },
        { id: 'p2', name: 'Сжатый звук', tracks: T.filter(function (t, i) { return !F[i][4]; }), at: 1 },
      ]));
    }
  } catch (e) {}
})();
