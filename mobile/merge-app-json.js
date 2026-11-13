// app.json шаблона Expo + наш (наш важнее, вложенные поля сливаются); версия — из mobile/VERSION
const fs = require('fs');
const [tplPath, oursPath, verPath] = process.argv.slice(2);
const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8')); const ours = JSON.parse(fs.readFileSync(oursPath, 'utf8'));
const merge = (a, b) => { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], b[k]); else a[k] = b[k]; } return a; };
const out = merge(tpl, ours);
const [ver, build] = fs.readFileSync(verPath, 'utf8').trim().split(/\s+/);
out.expo.version = ver; out.expo.android = { ...(out.expo.android || {}), versionCode: +build };
// обновления «по воздуху» подходят только к своей сборке: номер сборки = версия «движка»
out.expo.runtimeVersion = String(build);
fs.writeFileSync(tplPath, JSON.stringify(out, null, 2));
console.log('app.json:', ver, 'build', build);
