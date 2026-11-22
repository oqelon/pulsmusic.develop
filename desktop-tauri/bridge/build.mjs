// Собирает ui/pulse-bridge.js: node-shims.js + yandex.js (выпущенный, из updates/<версия>) + tauri-bridge.js.
// yandex.js НЕ переписывается — только заменяются Node-части, ровно в известных местах (иначе сборка падает):
//   require('crypto')      → PulseShims.crypto (те же md5 / hmac-sha256, синхронно)
//   require('./yastream')  → регистрация ссылки в программе (Rust, pulseya://)
//   ys.add(                → await ys.add(   (в Tauri регистрация асинхронная; оба места — внутри async-функций)
//   fetch                  → tauri-plugin-http через мост (только разрешённые адреса, без Origin — как в Node)
//   module.exports = api   → return api
// node build.mjs <путь к yandex.js> <папка ui>
import fs from 'node:fs';
import path from 'node:path';

const [, , yaPath, uiDir] = process.argv;
const here = path.dirname(new URL(import.meta.url).pathname);
let y = fs.readFileSync(yaPath, 'utf8');

function swap(from, to, count) {
  const n = y.split(from).length - 1;
  if (n !== count) throw new Error(`ожидалось ${count} × «${from}», найдено ${n} — yandex.js изменился, проверьте замены`);
  y = y.split(from).join(to);
}
swap("const crypto = require('crypto');", 'const crypto = PulseShims.crypto;', 1);
swap("const ys = require('./yastream');", 'const ys = { add: (o) => window.__PULSE_TAURI__.yaAdd(o) };', 1);
swap('const url = ys.add(', 'const url = await ys.add(', 2);
swap('module.exports = api;', 'return api;', 1);
if (/require\(/.test(y)) throw new Error('в yandex.js остался require()');

const yandex = `// ---- yandex.js (выпущенный файл, Node-части заменены — см. build.mjs) ----
var PulseYandex = (function () {
const fetch = (u, o) => window.__PULSE_TAURI__.fetch(u, o);
${y}
})();
`;
const out = [fs.readFileSync(path.join(here, 'node-shims.js'), 'utf8'), yandex, fs.readFileSync(path.join(here, 'tauri-bridge.js'), 'utf8')].join('\n');
fs.writeFileSync(path.join(uiDir, 'pulse-bridge.js'), out);

// index.html: мост — до app.js; IPC Tauri — в connect-src (иначе медленный запасной путь через postMessage)
const ip = path.join(uiDir, 'index.html');
let h = fs.readFileSync(ip, 'utf8');
if (!h.includes('<script src="app.js"></script>')) throw new Error('нет <script src="app.js"> в index.html');
h = h.replace('<script src="app.js"></script>', '<script src="pulse-bridge.js"></script>\n<script src="app.js"></script>');
h = h.replace(/(connect-src [^;"]*)/, '$1 ipc: http://ipc.localhost');
fs.writeFileSync(ip, h);
console.log('pulse-bridge.js:', out.length, 'байт');
