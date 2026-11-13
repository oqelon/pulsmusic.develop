// Манифест обновления «по воздуху» (протокол Expo Updates) из результата `expo export`.
// node ota-manifest.js <папка dist> <runtime> <версия> <файл заметок> <куда сложить файлы для релиза>
// Файлы называются по своему SHA-256 — одинаковые не загружаются повторно, старые версии продолжают работать.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const [dist, runtime, version, notesFile, out] = process.argv.slice(2);
const BASE = 'https://github.com/oqelon/pulsmusic.develop/releases/download/android-ota/';
const meta = JSON.parse(fs.readFileSync(path.join(dist, 'metadata.json'), 'utf8')).fileMetadata.android;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ttf: 'font/ttf', otf: 'font/otf', json: 'application/json', mp3: 'audio/mpeg', wav: 'audio/wav' };
fs.mkdirSync(out, { recursive: true });
const put = (rel, ext) => {
  const buf = fs.readFileSync(path.join(dist, rel));
  const sha = crypto.createHash('sha256').update(buf);
  const hex = sha.copy().digest('hex'), b64 = sha.digest('base64url');
  const name = hex.slice(0, 40) + '.' + ext; fs.copyFileSync(path.join(dist, rel), path.join(out, name));
  return { hash: b64, url: BASE + name, size: buf.length };
};
const b = put(meta.bundle, 'hbc');
const launchAsset = { hash: b.hash, key: 'bundle-' + b.hash.slice(0, 16), contentType: 'application/javascript', url: b.url };
// ключ ресурса = его md5 (так его называет metro) — совпадает с ресурсами внутри APK, их телефон не качает заново
const assets = meta.assets.map((a) => { const r = put(a.path, a.ext); return { hash: r.hash, key: path.basename(a.path), contentType: TYPES[a.ext] || 'application/octet-stream', fileExtension: '.' + a.ext, url: r.url }; });
let notes = []; try { notes = fs.readFileSync(notesFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6); } catch {}
const m = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), runtimeVersion: String(runtime), launchAsset, assets, metadata: {}, extra: { version, notes } };
fs.writeFileSync(path.join(out, 'manifest-' + runtime + '.json'), JSON.stringify(m));
console.log('Обновление', m.id, 'для сборки', runtime, '· файлов', assets.length + 1, '· JS', Math.round(b.size / 1024), 'КБ');
