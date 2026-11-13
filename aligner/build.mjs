// Сборка пакета ИИ: pack/ = index.html + aligner.js (одним файлом) + ort/ (WebAssembly) + models/ (кладёт CI)
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';
const out = 'pack';
fs.mkdirSync(path.join(out, 'ort'), { recursive: true });
await build({ entryPoints: ['src/aligner.js'], bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'chrome120', outfile: path.join(out, 'aligner.js'), logLevel: 'warning',
  // транзитивные модули Node (sharp, onnxruntime-node, fs) в браузерной сборке не нужны
  external: ['sharp', 'onnxruntime-node', 'fs', 'path', 'url'] });
fs.copyFileSync('src/index.html', path.join(out, 'index.html'));
const dist = path.dirname(fs.realpathSync('node_modules/onnxruntime-web/package.json')) + '/dist';
let n = 0;
for (const f of fs.readdirSync(dist)) if (/^ort-wasm.*\.(wasm|mjs)$/.test(f)) { fs.copyFileSync(path.join(dist, f), path.join(out, 'ort', f)); n++; }
console.log('aligner.js', fs.statSync(path.join(out, 'aligner.js')).size, 'байт; файлов ort:', n);
