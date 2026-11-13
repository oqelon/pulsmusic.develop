// Обновления «по воздуху» (expo-updates): новая версия интерфейса приходит без установки APK.
// Сервер (Cloudflare, pulse-online) говорит, есть ли обновление для этой сборки; файлы качаются с GitHub.
// Скачанное включается при перезапуске — сразу по кнопке или само при следующем открытии.
// Нет библиотеки или сети — просто ничего не происходит, приложение работает на своей версии.
let U: any = null;
try { U = require('expo-updates'); } catch { U = null; }

export const otaOn = !!(U && U.isEnabled);
const M = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// «обновление от 2 ноября, 15:10» — если сейчас работает версия, пришедшая по воздуху
export function otaLabel(): string {
  if (!otaOn || U.isEmbeddedLaunch || !U.createdAt) return '';
  const d = new Date(U.createdAt); if (isNaN(+d)) return '';
  return 'обновление от ' + d.getDate() + ' ' + M[d.getMonth()] + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
export type Ota = { notes: string[] };
let busy = false;
// есть ли новое — скачать; вернуть заметки к нему (или null)
export async function otaFetch(): Promise<Ota | null> {
  if (!otaOn || busy) return null; busy = true;
  try {
    const c = await U.checkForUpdateAsync(); if (!c || !c.isAvailable) return null;
    const f = await U.fetchUpdateAsync(); if (!f || !f.isNew) return null;
    const ex = (f.manifest && (f.manifest.extra || (f.manifest as any).extra)) || {};
    return { notes: Array.isArray(ex.notes) ? ex.notes.slice(0, 6).map(String) : [] };
  } catch { return null; } finally { busy = false; }
}
export async function otaRestart() { try { await U.reloadAsync(); } catch {} }
