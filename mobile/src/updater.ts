// Обновление прямо из приложения (Android): раз в час смотрим манифест на GitHub; если вышла новая сборка —
// предлагаем обновиться, скачиваем APK и открываем системную установку (Android спросит подтверждение сам).
// Манифест и APK лежат в релизе «android» репозитория oqelon/pulsmusic.develop (собираются в GitHub Actions).
import { Platform } from 'react-native';
import { APP_BUILD, APP_VERSION } from './version';
let FS: any = null; let IL: any = null;
try { FS = require('expo-file-system/legacy'); } catch { FS = null; }
try { IL = require('expo-intent-launcher'); } catch { IL = null; }

const FEED = 'https://github.com/oqelon/pulsmusic.develop/releases/download/android/android.json';
const PREFIX = 'https://github.com/oqelon/pulsmusic.develop/releases/download/';
export type Upd = { version: string; build: number; url: string; size: number; notes: string[] };
export const canSelfUpdate = Platform.OS === 'android' && !!FS && !!IL;
export const current = { version: APP_VERSION, build: APP_BUILD };

export async function checkUpdate(): Promise<Upd | null> {
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), 15000);
  try {
    const r = await fetch(FEED + '?t=' + Date.now(), { signal: c.signal, headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) return null;
    const m: any = await r.json();
    if (!m || !m.build || !m.url || !String(m.url).startsWith(PREFIX)) return null;
    return m.build > APP_BUILD ? { version: String(m.version), build: +m.build, url: String(m.url), size: +m.size || 0, notes: Array.isArray(m.notes) ? m.notes.slice(0, 8) : [] } : null;
  } catch { return null; } finally { clearTimeout(tm); }
}

// скачать и запустить установку; onP — доля 0…1
export async function installUpdate(u: Upd, onP: (p: number) => void): Promise<void> {
  if (!canSelfUpdate) throw new Error('Обновление из приложения работает только на Android');
  const file = FS.cacheDirectory + 'pulse-' + u.build + '.apk';
  await FS.deleteAsync(file, { idempotent: true }).catch(() => {});
  const dl = FS.createDownloadResumable(u.url, file, {}, (p: any) => { const t = p.totalBytesExpectedToWrite || u.size; if (t) onP(Math.min(0.99, p.totalBytesWritten / t)); });
  const res = await dl.downloadAsync();
  if (!res || res.status !== 200) throw new Error('Не получилось скачать обновление' + (res ? ' (' + res.status + ')' : ''));
  const info = await FS.getInfoAsync(file);
  if (!info.exists || (u.size && Math.abs((info.size || 0) - u.size) > 16)) throw new Error('Обновление скачалось не полностью — попробуйте ещё раз');
  onP(1);
  const uri = await FS.getContentUriAsync(file);
  await IL.startActivityAsync('android.intent.action.VIEW', { data: uri, flags: 1, type: 'application/vnd.android.package-archive' });   // 1 — разрешить чтение файла
}
