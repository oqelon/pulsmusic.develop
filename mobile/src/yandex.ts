// Яндекс Музыка — поиск треков и обложки (неофициальный API, тот же, что у библиотеки MarshalX/yandex-music-api).
// Что берём: поиск (Яндекс лучше знает русскую музыку и точнее ранжирует) и обложки в высоком качестве.
// Что НЕ берём: звук. Полные треки и даже 30-секундные отрывки Яндекса отдаются только по подписанным ссылкам
// с авторизацией — в приложении играют, как и раньше, официальные 30-секундные превью iTunes; трек из Яндекса
// сопоставляется с iTunes по названию и исполнителю.
// Если Яндекс не ответил (нет сети к нему, ограничения, изменили API) — поиск работает как раньше, только на iTunes.
export const BUILD = 64;
const YM = 'https://api.music.yandex.net';
const HEAD = { 'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621', 'Accept-Language': 'ru', Accept: 'application/json' };
export type YTrack = { yid: string; title: string; artist: string; album?: string; cover: string; dur?: number; explicit?: boolean; year?: number; genre?: string };
// обложка Яндекса: «avatars.yandex.net/…/%%» → нужный размер (допустимые: 200, 400, 600, 1000)
export const ymCover = (uri?: string, n = 600) => (uri ? 'https://' + uri.replace('%%', `${n}x${n}`) : '');
export let ymLast = '';   // последняя ошибка Яндекса (для проверки)
export async function ymSearch(q: string, ms = 3500): Promise<YTrack[]> {
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(`${YM}/search?text=${encodeURIComponent(q)}&type=track&page=0&nocorrect=false`, { headers: HEAD, signal: c.signal });
    if (!r.ok) { ymLast = 'HTTP ' + r.status; return []; }
    const d = await r.json(); ymLast = '';
    const list: any[] = d?.result?.tracks?.results || [];
    return list.filter((t) => t && t.available !== false && t.title).map((t) => {
      const al = (t.albums || [])[0] || {};
      return {
        yid: String(t.id), title: t.version ? `${t.title} (${t.version})` : t.title,
        artist: (t.artists || []).map((a: any) => a.name).filter(Boolean).join(', '),
        album: al.title, cover: ymCover(t.coverUri || al.coverUri, 600),
        dur: t.durationMs ? Math.round(t.durationMs / 1000) : undefined, explicit: t.contentWarning === 'explicit',
        year: al.year || undefined, genre: al.genre || undefined,
      };
    });
  } catch (e: any) { ymLast = e?.name === 'AbortError' ? 'timeout' : String(e?.message || e); return []; }
  finally { clearTimeout(tm); }
}
