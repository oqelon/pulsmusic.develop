// Предзагрузка треков: превью следующих треков заранее скачиваются в кэш телефона,
// поэтому переключение происходит мгновенно и не зависит от того, как быстро отвечает сервер.
// expo-file-system входит в Expo. Если модуля нет — всё работает как раньше (потоком из сети).
let FS: any = null;
try { FS = require('expo-file-system/legacy'); } catch { FS = null; }          // Expo SDK 54+
if (!FS || !FS.downloadAsync) { try { FS = require('expo-file-system'); } catch { FS = null; } }   // SDK 53 и старше
const DIR: string | null = FS && FS.cacheDirectory ? FS.cacheDirectory + 'pulse-previews/' : null;
const MAX = 120;   // больше — кэш очищается при запуске; во время работы старые файлы удаляются по одному

const local = new Map<string, string>();                    // адрес в сети → файл на телефоне
const pending = new Map<string, Promise<string | null>>();
const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

let ready: Promise<void> | null = null;
function prepare() {
  if (!ready) ready = (async () => {
    if (!FS || !DIR) return;
    try {
      const info = await FS.getInfoAsync(DIR);
      if (!info.exists) { await FS.makeDirectoryAsync(DIR, { intermediates: true }); return; }
      const files: string[] = await FS.readDirectoryAsync(DIR);
      if (files.length > MAX) { await FS.deleteAsync(DIR, { idempotent: true }); await FS.makeDirectoryAsync(DIR, { intermediates: true }); return; }
      for (const f of files) local.set(f, DIR + f);   // ключ — имя файла, см. fileOf
    } catch {}
  })();
  return ready;
}
const fileOf = (url: string) => hash(url) + (url.match(/\.(m4a|mp3|aac|mp4)(\?|$)/i)?.[0].replace('?', '') || '.m4a');

// готовый файл (если уже скачан) — иначе адрес в сети. Использованный файл становится «свежим» (уходит в конец очереди на удаление)
export function playable(url: string): string {
  const k = fileOf(url); const f = local.get(k);
  if (f) { local.delete(k); local.set(k, f); }
  return f || url;
}
// Кэш не растёт бесконечно за долгую сессию: когда файлов больше MAX, удаляем самые давно использованные
// (Map хранит порядок добавления). Только что скачанный файл не трогаем.
function trim(keep: string) {
  if (local.size <= MAX) return;
  for (const [k, f] of local) {
    if (local.size <= MAX) break;
    if (k === keep) continue;
    local.delete(k); FS.deleteAsync(f, { idempotent: true }).catch(() => {});
  }
}
export function forget(url: string) {
  const k = fileOf(url); const f = local.get(k); local.delete(k);
  if (f && FS) FS.deleteAsync(f, { idempotent: true }).catch(() => {});
}

// скачать заранее; повторные вызовы для одного трека не качают его дважды
export function preload(url?: string): Promise<string | null> {
  if (!url || !FS || !DIR || !/^https?:/.test(url)) return Promise.resolve(null);
  const k = fileOf(url);
  if (local.has(k)) return Promise.resolve(local.get(k)!);
  if (!pending.has(k)) {
    pending.set(k, (async () => {
      await prepare();
      if (local.has(k)) return local.get(k)!;
      const tmp = DIR + k + '.part';
      try {
        const r = await FS.downloadAsync(url, tmp);
        if (r && r.status === 200) {
          await FS.moveAsync({ from: tmp, to: DIR + k });
          local.set(k, DIR + k); trim(k); return DIR + k;
        }
      } catch {}
      FS.deleteAsync(tmp, { idempotent: true }).catch(() => {});
      return null;
    })().finally(() => pending.delete(k)));
  }
  return pending.get(k)!;
}
prepare();

// Удалить ненужную больше картинку (прежняя обложка плейлиста) — только из своей папки covers/
export function dropImage(uri?: string) {
  if (!uri || !FS || !FS.documentDirectory || !uri.startsWith(FS.documentDirectory + 'covers/')) return;
  FS.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

// Сохранить картинку (обложку плейлиста) в постоянную папку приложения — кэш системы может её удалить
export async function keepImage(uri: string): Promise<string> {
  if (!FS || !FS.documentDirectory || !uri) return uri;
  try {
    const dir = FS.documentDirectory + 'covers/';
    const info = await FS.getInfoAsync(dir); if (!info.exists) await FS.makeDirectoryAsync(dir, { intermediates: true });
    const to = dir + Date.now().toString(36) + '.jpg';
    await FS.copyAsync({ from: uri, to }); return to;
  } catch { return uri; }
}

// Номер сборки файла. Все файлы папки src должны быть из одной сборки — иначе приложение покажет подсказку, а не ошибку.
export const BUILD = 64;
