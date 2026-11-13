// Сборка пакета: pack/ = index.html + cutter.js (одним файлом) + ort/ (WebAssembly) + models/ (кладёт CI)
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
const out = 'pack';
fs.mkdirSync(path.join(out, 'ort'), { recursive: true });
await build({ entryPoints: ['src/cutter.js'], bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'chrome120', outfile: path.join(out, 'cutter.js'), logLevel: 'warning',
  external: ['sharp', 'onnxruntime-node', 'fs', 'path', 'url'] });
fs.copyFileSync('src/index.html', path.join(out, 'index.html'));
const dist = path.dirname(fs.realpathSync('node_modules/onnxruntime-web/package.json')) + '/dist';
let n = 0;
for (const f of fs.readdirSync(dist)) if (/^ort-wasm.*\.(wasm|mjs)$/.test(f)) { fs.copyFileSync(path.join(dist, f), path.join(out, 'ort', f)); n++; }
console.log('cutter.js', fs.statSync(path.join(out, 'cutter.js')).size, 'байт; файлов ort:', n);
