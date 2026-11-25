// Проверки моста (запускаются в CI после prepare-ui): подписи совпадают с Node.js, токен уходит только на Яндекс,
// ссылка на звук регистрируется в программе. node bridge/test.cjs ui/pulse-bridge.js
'use strict';
const fs = require('fs'), nc = require('crypto'), assert = require('assert');
const S = require('./node-shims.js');
for (const s of ['', 'a', 'abc', 'Привет', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'q'.repeat(1000)]) {
  assert.strictEqual(S.crypto.createHash('md5').update(s).digest('hex'), nc.createHash('md5').update(s).digest('hex'), 'md5 ' + s.length);
  for (const k of ['p93jhgh689SBReK6ghtw62', 'K'.repeat(100)]) assert.strictEqual(S.crypto.createHmac('sha256', k).update(s).digest('base64'), nc.createHmac('sha256', k).update(s).digest('base64'), 'hmac ' + s.length);
}
global.window = global; Object.defineProperty(global, 'navigator', { value: { userAgent: 'Macintosh' }, configurable: true });
const store = {}; global.localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; }, clear() {} }; global.sessionStorage = { clear() {} };
const calls = [];
const J = (o) => new Response(JSON.stringify({ result: o }), { status: 200 });
global.__TAURI__ = { core: { invoke: async (c, a, o) => { calls.push(['invoke', c, a, o]); return c === 'ya_add' ? 'pulseya://s/abc' : c === 'app_version' ? { version: '0.38.0 (Tauri, тест №1)', engine: 'tauri' } : c === 'cd_piece' ? new Uint8Array([1, 82, 73, 70, 70]).buffer : null; } },
  http: { fetch: async (u, o) => { calls.push(['fetch', u, (o && o.headers) || {}]);
    if (u.includes('/account/status')) return J({ account: { uid: 42, login: 'x' }, plus: { hasPlus: true } });
    if (u.includes('/get-file-info')) { global.__gfiN = (global.__gfiN || 0) + 1; if (global.__gfi === 'fail1' && global.__gfiN === 1 || global.__gfi === 'failAll') return new Response('{"error":{"message":"сбой"}}', { status: 503 }); }
    if (u.includes('/tracks/') && u.endsWith('/download-info')) return J([{ codec: 'mp3', bitrateInKbps: 320, downloadInfoUrl: 'https://storage.mds.yandex.net/dl' }]);
    if (u === 'https://storage.mds.yandex.net/dl') return new Response('<host>h.yandex.net</host><path>/a/b</path><ts>1</ts><s>2</s>', { status: 200 });
    if (u.includes('/get-file-info')) return J({ downloadInfo: { urls: ['https://strm.yandex.net/a'], key: '00112233445566778899aabbccddeeff', codec: 'flac-mp4', bitrate: 0, quality: 'lossless' } });
    if (u.startsWith('https://lrclib.net')) return new Response('[]', { status: 200 });
    return new Response('{"error":{"message":"нет"}}', { status: 404 }); } } };
global.__PULSE_TOKEN__ = 'TKN';
// этап 5: перенос из Electron — записи pulse.* записываются до запуска интерфейса, служебные не трогаются
global.__PULSE_IMPORT__ = { stamp: '77', ls: { 'pulse.likes': '[{"id":"1","title":"Танцуй"}]', 'pulse.settings': '{"theme":"light"}', 'pulse.tauritest.alive': 'ЧУЖОЕ', 'pulse.engine': 'off', 'other.key': 'x' } };
store['pulse.settings'] = '{"theme":"dark"}'; store['pulse.tauritest.httplog'] = '[]';
global.localStorage.removeItem = (k) => { delete store[k]; };
Object.defineProperty(global.localStorage, 'length', { get: () => Object.keys(store).length });
global.localStorage.key = (i) => Object.keys(store)[i];
global.addEventListener = () => {}; global.location = { hash: '#/home', pathname: '/' }; global.document = { body: null }; global.setInterval = () => 0;
eval(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  {
    assert.strictEqual(store['pulse.likes'], '[{"id":"1","title":"Танцуй"}]'); assert.strictEqual(store['pulse.settings'], '{"theme":"light"}');
    assert.strictEqual(store['pulse.engine'], undefined, 'pulse.engine не переносится'); assert.strictEqual(store['other.key'], undefined); assert.strictEqual(store['pulse.tauritest.httplog'], '[]');
    const ap = calls.find((c) => c[1] === 'migrate_applied'); assert.ok(ap, 'migrate_applied не вызван');
    assert.strictEqual(ap[2].n, 2); assert.deepStrictEqual(ap[2].bad, []); assert.strictEqual(ap[2].stamp, '77');
    assert.deepStrictEqual(JSON.parse(ap[2].before), { 'pulse.settings': '{"theme":"dark"}' }, 'прежние записи окна — для возврата');
    assert.strictEqual(typeof global.__PULSE_IMPORT__, 'undefined');
  }
  assert.strictEqual(pulse.initialToken, 'TKN'); assert.strictEqual(typeof global.__PULSE_TOKEN__, 'undefined');
  const a = await pulse.account('TKN'); assert.deepStrictEqual(a, { ok: true, v: { auth: true, uid: '42', login: 'x', plus: true }, tokenProblem: '' });
  const s = await pulse.stream('TKN', '123', 'lossless'); assert.strictEqual(s.ok, true); assert.strictEqual(s.v.url, 'pulseya://s/abc'); assert.strictEqual(s.v.lossless, true);
  const g = calls.find((c) => c[0] === 'fetch' && c[1].includes('get-file-info'));
  const q = new URL(g[1]).searchParams; const p = { ts: q.get('ts'), trackId: '123', quality: 'lossless', codecs: q.get('codecs'), transports: 'encraw' };
  const want = nc.createHmac('sha256', 'p93jhgh689SBReK6ghtw62').update(Object.values(p).join('').replace(/,/g, '')).digest('base64').slice(0, -1);
  assert.strictEqual(q.get('sign'), want, 'подпись get-file-info');
  assert.deepStrictEqual(calls.find((c) => c[1] === 'ya_add')[2], { urls: ['https://strm.yandex.net/a'], key: '00112233445566778899aabbccddeeff', codec: 'flac-mp4' });
  await pulse.lyrics('TKN', '123', { title: 't', artist: 'a', dur: 100 });
  for (const c of calls.filter((x) => x[0] === 'fetch')) if (!/^https:\/\/([a-z0-9-]+\.)*yandex\.(net|ru)\//.test(c[1])) assert.ok(!c[2].Authorization, 'токен ушёл не на Яндекс: ' + c[1]);
  const bad = await pulse.chart('TKN'); assert.strictEqual(bad.ok, false);
  for (const c of calls.filter((x) => x[0] === 'fetch')) assert.strictEqual(c[2].Origin, '', 'Origin должен быть пустым: ' + c[1]);
  const log = JSON.parse(store['pulse.tauritest.httplog']); const acc = log.find((x) => /account\/status$/.test(x.u));
  assert.ok(acc && acc.uid === true && acc.st === 200, 'журнал account/status'); assert.ok(!JSON.stringify(log).includes('TKN'), 'токен попал в журнал');
  // токен из адреса и из «мусора» вокруг
  calls.length = 0;
  await pulse.account('https://music.yandex.ru/#access_token=y0_AbcdefGHIJKLMNOPQRSTUVWX123&token_type=bearer');
  assert.strictEqual(calls.find((c) => c[0] === 'fetch')[2].Authorization, 'OAuth y0_AbcdefGHIJKLMNOPQRSTUVWX123');
  calls.length = 0;
  await pulse.account('Токен:\n y0_AbcdefGHIJKLMNOPQRSTUVWX123 \nконец');
  assert.strictEqual(calls.find((c) => c[0] === 'fetch')[2].Authorization, 'OAuth y0_AbcdefGHIJKLMNOPQRSTUVWX123');
  // мусор вместо токена: без запроса, понятная ошибка
  calls.length = 0;
  const junk = await pulse.account('Какой-то текст страницы '.repeat(400));
  assert.strictEqual(junk.v.auth, false); assert.ok(/не токен/.test(junk.v.error)); assert.strictEqual(calls.filter((c) => c[0] === 'fetch').length, 0);
  const ch = await pulse.chart('мусор с пробелами'); assert.ok(!calls.some((c) => c[0] === 'fetch' && c[2].Authorization), 'мусор ушёл в заголовок');
  calls.length = 0; await pulse.openExternal('https://oauth.yandex.ru/authorize?response_type=token&client_id=x'); assert.ok(calls.some((c) => c[1] === 'ya_login'));
  console.error(new Error('проба OAuth y0_SECRET'));
  const el = JSON.parse(store['pulse.tauritest.errors']); assert.ok(el.some((x) => x.k === 'console' && x.m.includes('[токен]') && !x.m.includes('SECRET')), 'журнал ошибок прячет токен');
  // как app:version в Electron: объект с полем version (страница «Программа» показывает ver.version)
  assert.strictEqual(typeof (await pulse.version()).version, 'string');
  // кусок звука для CD: первый байт — «кусок с s» или «файл целиком», дальше данные
  const pc = await pulse.cd.piece('f1', 12.5, 20); assert.ok(pc.ok && pc.seg && pc.at === 12.5); assert.strictEqual(Buffer.from(pc.data).toString('latin1'), 'RIFF');
  // звук кусками — сырыми байтами, номер задания и трека — в заголовках
  calls.length = 0; await pulse.cd.put('j1', 3, new Uint8Array([1, 2, 3, 4]).buffer, 1);
  const put = calls.find((c) => c[1] === 'cd_put'); assert.ok(put[2] instanceof Uint8Array && put[2].length === 4);
  // сбой get-file-info: один раз — второй запрос возвращает FLAC; всегда — запасной MP3 с понятной причиной
  global.__gfi = 'fail1'; global.__gfiN = 0; const r1 = await pulse.stream('TKN', '124', 'lossless');
  assert.ok(r1.ok && r1.v.lossless === true && global.__gfiN === 2, 'один сбой — повтор вернул FLAC, а не MP3');
  global.__gfi = 'failAll'; global.__gfiN = 0; const r2 = await pulse.stream('TKN', '125', 'lossless');
  assert.ok(r2.ok && !r2.v.lossless && r2.v.quality === 'hq' && /сбой/.test(r2.v.why) && global.__gfiN === 3, 'постоянный сбой — три попытки, потом MP3 и причина: ' + JSON.stringify(r2.v));
  assert.ok(JSON.parse(store['pulse.tauritest.errors']).some((x) => x.k === 'quality' && /125/.test(x.m) && /сбой/.test(x.m)), 'причина записана в журнал');
  global.__gfi = 'failAll'; global.__gfiN = 0; const r3 = await pulse.stream('TKN', '126', 'nq');
  assert.ok(r3.ok && r3.v.quality === 'nq' && !r3.v.why && global.__gfiN === 1, 'среднее качество — без повторов');
  global.__gfi = 'ok';
  console.log('мост: все проверки пройдены (' + calls.length + ' вызовов)');
})().catch((e) => { console.error(e); process.exit(1); });
