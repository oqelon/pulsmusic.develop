// Сборка интерфейса «Пульса» для Tauri → desktop-tauri/app-dist.zip (dist/: app.js, index.html, ach3d.js).
// Те же настройки, что в build-ui.mjs Electron-версии, но в отдельную папку: dist Electron-версии не трогается.
//   node tools/build-ui.mjs <папка pulse-desktop>
// esbuild: из NODE_PATH (или node_modules рядом).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(process.argv[2] || '../pulse-desktop');
const require = createRequire(path.join(process.env.ESBUILD_DIR || src, 'x.js'));   // ESBUILD_DIR — папка с node_modules (esbuild, react, react-dom)
const { build, transform } = require('esbuild');
const out = path.join(os.tmpdir(), 'pulse-tauri-ui-' + process.pid);
rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, 'dist'), { recursive: true });
await build({
  entryPoints: [path.join(src, 'src/main.jsx')], bundle: true, minify: true, outfile: path.join(out, 'dist/app.js'), format: 'iife', target: 'chrome120',
  jsx: 'automatic', loader: { '.js': 'jsx', '.png': 'dataurl', '.woff': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning', absWorkingDir: src,
  nodePaths: process.env.ESBUILD_DIR ? [path.join(process.env.ESBUILD_DIR, 'node_modules')] : [],
});
copyFileSync(path.join(src, 'src/index.html'), path.join(out, 'dist/index.html'));
const V = path.join(src, 'src/vendor/three-r128/');
const vendor = ['three.min.js', 'CopyShader.js', 'LuminosityHighPassShader.js', 'EffectComposer.js', 'ShaderPass.js', 'RenderPass.js', 'UnrealBloomPass.js', 'RoomEnvironment.js', 'RoundedBoxGeometry.js'].map((f) => readFileSync(V + f, 'utf8')).join('\n;\n');
const own = await transform(readFileSync(path.join(src, 'src/features/achievements/ach3d.js'), 'utf8'), { minify: true, target: 'chrome120' });
writeFileSync(path.join(out, 'dist/ach3d.js'), '/* three.js r128 — MIT License, (c) 2010-2021 three.js authors */\n' + vendor + '\n;\n' + own.code);
const zip = path.join(here, '..', 'app-dist.zip');
rmSync(zip, { force: true });
execFileSync('zip', ['-qr', '-X', zip, 'dist'], { cwd: out });
console.log('готово:', zip);
