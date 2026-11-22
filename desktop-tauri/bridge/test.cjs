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
global.__TAURI__ = { core: { invoke: async (c, a) => { calls.push(['invoke', c, a]); return c === 'ya_add' ? 'pulseya://s/abc' : null; } },
  http: { fetch: async (u, o) => { calls.push(['fetch', u, (o && o.headers) || {}]);
    if (u.includes('/account/status')) return J({ account: { uid: 42, login: 'x' }, plus: { hasPlus: true } });
    if (u.includes('/get-file-info')) return J({ downloadInfo: { urls: ['https://strm.yandex.net/a'], key: '00112233445566778899aabbccddeeff', codec: 'flac-mp4', bitrate: 0, quality: 'lossless' } });
    if (u.startsWith('https://lrclib.net')) return new Response('[]', { status: 200 });
    return new Response('{"error":{"message":"нет"}}', { status: 404 }); } } };
global.__PULSE_TOKEN__ = 'TKN';
eval(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
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
  console.log('мост: все проверки пройдены (' + calls.length + ' вызовов)');
})().catch((e) => { console.error(e); process.exit(1); });
