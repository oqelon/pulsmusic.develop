// Бесплатный iTunes Search API — ключ не нужен. Доступны 30-секундные превью.
// jpeg-js — необязательная библиотека (npm install jpeg-js). Если её нет, приложение всё равно запускается,
// просто цвет текста на страницах артиста/альбома не подбирается автоматически.
let jpeg: any = null;
try { jpeg = require('jpeg-js'); } catch { jpeg = null; }
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PixelRatio, Platform, Dimensions } from 'react-native';
import { ymSearch } from './yandex';
import { ymLocal, likesList, tracksByIds, likesSet } from './ymLocal';
import type { YTrack } from './yandex';
const IT = 'https://itunes.apple.com/';

// ---------- Кэш на телефоне ----------
// Свежие данные (моложе ttl) отдаём сразу без интернета; устаревшие — обновляем, а если сети нет, показываем сохранённые.
const H = 3600e3;
// Небольшая копия кэша в памяти: повторное открытие артиста/альбома и подбор «Моего пульса» не читают
// и не разбирают данные с диска каждый раз заново. Самые давние записи вытесняются (не больше MEM_MAX).
const MEM_MAX = 80;
const mem = new Map<string, { t: number; v: any }>();
const memPut = (k: string, o: { t: number; v: any }) => { mem.delete(k); mem.set(k, o); if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value as string); };
// Одинаковые запросы, отправленные одновременно (например, два экрана просят одного артиста), выполняются один раз
const inflight = new Map<string, Promise<any>>();
// Кэш на диске за часы прослушивания разрастается до тысяч записей, а хранилище телефона при каждой записи
// переписывает свой список ключей — со временем всё начинает подтормаживать. Раз за запуск (через 20 с, когда
// всё загрузилось) оставляем 300 самых свежих записей кэша; ваши данные (лайки, плейлисты, статистика) не трогаются.
setTimeout(async () => {
  try {
    const ks = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith('pc:'));
    if (ks.length <= 400) return;
    const ts: [string, number][] = [];
    for (let i = 0; i < ks.length; i += 100) {
      const part = await AsyncStorage.multiGet(ks.slice(i, i + 100));
      part.forEach(([k, v]) => { const m = /"t":(\d+)/.exec(String(v || '').slice(0, 40)); ts.push([k, m ? Number(m[1]) : 0]); });   // время записи — из начала строки, без разбора всей записи
    }
    ts.sort((a, b) => b[1] - a[1]);
    const drop = ts.slice(300).map((x) => x[0]);
    for (let i = 0; i < drop.length; i += 200) await AsyncStorage.multiRemove(drop.slice(i, i + 200));
  } catch {}
}, 20000);
// swr — «показать сохранённое сразу»: если запись устарела, она всё равно отдаётся мгновенно, а свежая
// загружается в фоне и будет при следующем открытии (для чартов и новинок на главной).
async function disk<T>(key: string, ttl: number, fetcher: () => Promise<T>, good: (v: T) => boolean = (v) => !!v, swr = false): Promise<T> {
  // в режиме Яндекса — свои ключи кеша, чтобы не смешивать с прежними данными iTunes
  const k = (YB ? 'pc:y:' : 'pc:') + key; let stale: T | undefined;
  const m = mem.get(k);
  if (m) { if (Date.now() - m.t < ttl) { memPut(k, m); return m.v as T; } stale = m.v; }
  else {
    try { const raw = await AsyncStorage.getItem(k); if (raw) { const o = JSON.parse(raw); memPut(k, o); if (Date.now() - o.t < ttl) return o.v as T; stale = o.v; } } catch {}
  }
  if (inflight.has(k)) return stale !== undefined && swr ? stale : inflight.get(k)!;
  const p = (async () => {
    try { const v = await fetcher(); if (good(v)) { const o = { t: Date.now(), v }; memPut(k, o); AsyncStorage.setItem(k, JSON.stringify(o)).catch(() => {}); } return v; }
    catch (e) { if (stale !== undefined) return stale; throw e; }
  })().finally(() => inflight.delete(k));
  inflight.set(k, p);
  if (stale !== undefined && swr) { p.catch(() => {}); return stale; }
  return p;
}
// Кэш на телефоне со временем разрастается (каждый открытый артист, альбом, исполнитель «Моего пульса»).
// Раз за запуск, в фоне: если записей стало много — удаляем самые старые, оставляем свежие.
const DISK_MAX = 300;
setTimeout(async () => {
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith('pc:'));
    if (keys.length <= DISK_MAX) return;
    const ages: [string, number][] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const part = await AsyncStorage.multiGet(keys.slice(i, i + 50));
      for (const [k, raw] of part) { let t = 0; try { t = raw ? JSON.parse(raw).t || 0 : 0; } catch {} ages.push([k, t]); }
    }
    ages.sort((a, b) => b[1] - a[1]);
    await AsyncStorage.multiRemove(ages.slice(Math.floor(DISK_MAX * 0.7)).map((x) => x[0]));
  } catch {}
}, 8000);
// Простые ограничители для кэшей в памяти: не больше n записей, самые давние уходят
const capped = <V,>(m: Map<string, V>, n: number) => { while (m.size > n) m.delete(m.keys().next().value as string); };
export type Track = { id: string; title: string; artist: string; album?: string; cover: string; url: string; artistId?: number; albumId?: number; dur?: number; explicit?: boolean; genre?: string; year?: number };
// размер обложки: у iTunes — «…/600x600bb.jpg», у Яндекса — «avatars.yandex.net/…/600x600» (только 200/400/600/1000)
// с запасом ~13 %: картинка 600 на месте 680 точек выглядит так же, а весит в памяти втрое меньше, чем 1000
const ySize = (n: number) => (n <= 226 ? 200 : n <= 452 ? 400 : n <= 680 ? 600 : 1000);
const sized = (u: string | undefined, n: number) => { const s = u || ''; if (s.includes('avatars.yandex.net')) return s.replace(/\/\d+x\d+$/, `/${ySize(n)}x${ySize(n)}`); return s.replace(/\d+x\d+(bb)?(-\d+)?(?=\.\w+$)/, `${n}x${n}bb`); };
const big = (u?: string) => sized(u, 600);
// Обложка ровно под место на экране: dp (точки) × плотность экрана. Картинка 1000×1000 занимает в памяти 4 МБ,
// 600×600 — 1,4 МБ, 400×400 — 0,6 МБ: на телефонах с 3–4 ГБ это главное, что держит приложение лёгким.
export const artPx = (u: string | undefined, dp: number) => sized(u, Math.round(dp * PixelRatio.get()));
// большие обложки (полный плеер, альбом): на iPhone — максимум, на Android — по ширине экрана
export const hiArt = (u?: string) => (Platform.OS === 'android' ? artPx(u, Math.min(Dimensions.get('window').width, 440)) : sized(u, 1200));
export const bigArt = big;
export const smallArt = (u?: string) => sized(u, 160);   // для строк списков и мини-плеера (48 pt) — в 14 раз меньше пикселей, чем 600
// «Название - Single» / «Название - EP» → «Название»; тип релиза определяем по подписи и числу треков
export const cleanName = (s?: string) => String(s || '').replace(/\s*[-–—]\s*(single|ep|сингл)\s*$/i, '').trim();
export type Kind = 'album' | 'ep' | 'single';
export const KIND_LABEL: Record<Kind, string> = { album: 'Альбом', ep: 'EP', single: 'Сингл' };
export const relKind = (x: any): Kind => {
  const n = String(x.collectionName || '');
  if (/[-–—]\s*(single|сингл)\s*$/i.test(n)) return 'single';
  if (/[-–—]\s*ep\s*$/i.test(n)) return 'ep';
  const c = Number(x.trackCount || 0);
  if (c && c <= 3) return 'single';
  if (c && c <= 6) return 'ep';
  return 'album';
};
const alb = (x: any) => (x ? { ...x, kind: relKind(x), collectionName: cleanName(x.collectionName) } : x);
const toTrack = (r: any): Track => ({ id: (String(r.previewUrl || '').startsWith('ym:') ? 'y' : 'i') + r.trackId, title: cleanName(r.trackName), artist: r.artistName, album: cleanName(r.collectionName), cover: big(r.artworkUrl100), url: r.previewUrl, artistId: r.artistId, albumId: r.collectionId, dur: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined, explicit: r.trackExplicitness === 'explicit', genre: r.primaryGenreName, year: r.releaseDate ? parseInt(String(r.releaseDate).slice(0, 4), 10) || undefined : undefined });
const L = (r: any[]) => r.filter((x) => x.previewUrl).map(toTrack);
// Запросы в сеть: тайм-аут 9 секунд и один повтор при сбое. iTunes ограничивает частоту запросов (≈20 в минуту)
// и при «залпе» начинает отказывать — поэтому к нему идём не больше трёх запросов одновременно и с небольшим шагом.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fetchT(u: string, ms: number, headers?: Record<string, string>) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(u, { signal: c.signal, headers }); } finally { clearTimeout(t); }
}
let active = 0, lastAt = 0; const waiters: (() => void)[] = [];
// prio — запрос поиска: встаёт в начало очереди и идёт с меньшим шагом (человек ждёт ответа прямо сейчас),
// фоновые подгрузки (обложки, «Мой пульс», статистика) пропускают его вперёд
async function slot(prio = false) {
  if (active >= 3) await new Promise<void>((r) => (prio ? waiters.unshift(r) : waiters.push(r)));
  active++;
  const step = prio ? 60 : 150;
  const gap = lastAt + step - Date.now(); lastAt = Math.max(Date.now(), lastAt + step);
  if (gap > 0) await sleep(gap);
}
function free() { active--; const n = waiters.shift(); if (n) n(); }
const j = async (u: string, prio = false): Promise<any> => {
  const it = u.startsWith(IT);
  for (let a = 0; ; a++) {
    if (it) await slot(prio);
    try {
      const r = await fetchT(u, 9000);
      if (r.ok) return await r.json();
      if (a >= 1 || ![403, 429, 500, 502, 503, 504].includes(r.status)) throw new Error('HTTP ' + r.status);
    } catch (e) { if (a >= 1) throw e; }
    finally { if (it) free(); }
    await sleep(prio ? 500 : 1200);
  }
};

// Поиск: треки (с запасом — 30, чтобы было из чего выбрать лучшее), артисты и альбомы — тремя запросами разом.
// Если запрос из нескольких слов почти ничего не нашёл (например, «название исполнитель» с опечаткой
// или в непривычном порядке), один раз дополнительно ищем треки без последнего и без первого слова —
// и всё сливаем без повторов. Ранжирование — в приложении (Shell.tsx, rankTracks): по совпадению слов.
// Быстрее: треки и артисты показываются, как только пришли (onPart), альбомы догружаются следом —
// не ждём самый медленный из трёх запросов. Все запросы поиска — вне очереди (prio).
// ================= Яндекс Музыка через свой сервер (server/main.py) =================
// Адрес сервера задаётся в ~/puls/.env:  EXPO_PUBLIC_YM_API=https://…  (скрипт ym-server.sh).
// Если он задан — ВСЁ берётся из Яндекс Музыки: поиск, чарт, новинки, артисты (с фото), альбомы, обложки,
// а звук — через /stream (без входа — 30-секундный фрагмент Яндекса, со своим токеном и Плюсом — целиком).
// Превью iTunes в этом режиме не используются вовсе. Если адрес не задан — работает прежняя версия на iTunes
// (её не удаляли, пока новая не проверена на телефоне).
declare const process: any;
// Без адреса сервера — Яндекс прямо из приложения (src/ymLocal.ts): сервер на Mac больше не нужен
export const YB = String(process.env.EXPO_PUBLIC_YM_API || '').trim().replace(/\/+$/, '') || 'local';
export const YLOCAL = YB === 'local';
// токен пользователя (Профиль → Яндекс Музыка) — идёт с каждым запросом к своему серверу:
// без входа Яндекс многое ограничивает (и поиск, и звук), с входом — работает как в приложении Яндекса
let ymTok: string | null = null;
// токен читаем с телефона; пустой результат (например, хранилище не ответило) не запоминаем — иначе вход
// «пропадал» до перезапуска приложения
export const ymToken = async () => { if (ymTok) return ymTok; const v = (await AsyncStorage.getItem('pulse_ym_token').catch(() => null)) || ''; if (v) ymTok = v; return v; };
// из вставленного текста достаём сам токен (часто вставляют кусок адреса «…access_token=XXX&token_type=…»)
const cleanTok = (t: string) => { let x = (t || '').trim(); if (x.includes('access_token=')) x = x.split('access_token=')[1]; return x.split('&')[0].trim(); };
export const setYmToken = async (t0: string) => { const t = cleanTok(t0); ymTok = t; if (t) await AsyncStorage.setItem('pulse_ym_token', t).catch(() => {}); else await AsyncStorage.removeItem('pulse_ym_token').catch(() => {}); mem.clear?.(); };
const ymHead = async () => { const t = await ymToken(); return t ? { 'X-YM-Token': t } : undefined; };
async function yj(path: string, ms = 9000): Promise<any> {
  if (YLOCAL) {
    for (let a = 0; ; a++) {
      try { return await ymLocal(path, await ymToken()); }
      catch (e: any) { console.warn('[ym]', path.split('?')[0], e?.status || '', String(e?.message || e).slice(0, 160)); if (a >= 1 || (e && e.status && e.status < 500)) throw e; }
      await sleep(500);
    }
  }
  const h = await ymHead();
  for (let a = 0; ; a++) {
    try { const r = await fetchT(YB + path, ms, h); if (r.ok) return await r.json(); if (a >= 1 || r.status < 500) throw new Error('HTTP ' + r.status); }
    catch (e) { if (a >= 1) throw e; }
    await sleep(500);
  }
}
export async function search(q: string, onPart?: (v: { tracks: Track[]; artists: any[]; albums: any[] }) => void) {
  if (YB) {
    const p = (e: string, n: number) => yj(`/search?term=${encodeURIComponent(q)}&entity=${e}&limit=${n}`, 7000).catch(() => null);
    const alP = p('album', 15);
    const [s, a] = await Promise.all([p('song', 30), p('musicArtist', 10)]);
    const tracks = L(s?.results || []);
    if (s || a) onPart?.({ tracks, artists: (a?.results || []) as any[], albums: [], part: true } as any);
    const al = await alP;
    if (!s && !a && !al) throw new Error('net');
    return { tracks, artists: (a?.results || []) as any[], albums: ((al?.results || []) as any[]).map(alb) };
  }
  const ymP = ymSearch(q).catch(() => [] as YTrack[]);   // Яндекс — параллельно с iTunes
  const u = (term: string, e: string, n: number) => `${IT}search?term=${encodeURIComponent(term)}&media=music&country=RU&limit=${n}&entity=${e}`;
  const alP = j(u(q, 'album', 15), true).catch(() => null);
  const [s, a] = await Promise.all([u(q, 'song', 30), u(q, 'musicArtist', 10)].map((x) => j(x, true).catch(() => null)));
  let tracks = L(s?.results || []);
  if (s || a) onPart?.({ tracks, artists: (a?.results || []) as any[], albums: [], part: true } as any);   // part — альбомы ещё в пути
  const ws = q.trim().split(/\s+/).filter(Boolean);
  if (ws.length >= 2 && tracks.length < 4) {
    const more = await Promise.all([ws.slice(0, -1).join(' '), ws.slice(1).join(' ')].map((x) => j(u(x, 'song', 25), true).catch(() => null)));
    const seen = new Set(tracks.map((t) => t.id));
    for (const m of more) for (const t of L(m?.results || [])) if (!seen.has(t.id)) { seen.add(t.id); tracks.push(t); }
  }
  const [al, ym] = await Promise.all([alP, Promise.race([ymP, new Promise<YTrack[]>((r) => setTimeout(() => r([]), 3000))])]);
  if (ym.length) tracks = await mergeYm(ym, tracks);
  if (!s && !a && !al && !tracks.length) throw new Error('net');
  return { tracks, artists: (a?.results || []) as any[], albums: ((al?.results || []) as any[]).map(alb) };
}
// Яндекс + iTunes: порядок треков — как в поиске Яндекса (он точнее для русской музыки), обложки — Яндекса
// (выше качество). Играет превью iTunes: совпавший трек берём из выдачи iTunes, остальные (до 6) ищем в iTunes
// отдельно за ~2,5 с; не нашли — трек не показываем (его нечем проиграть). Остаток выдачи iTunes — следом.
async function mergeYm(ym: YTrack[], it: Track[]): Promise<Track[]> {
  const k = (t: string, a: string) => wsOf(t).join(' ') + '|' + wsOf(baseArtist(a)).join(' ');
  const byKey = new Map<string, Track>(); for (const t of it) { const kk = k(t.title, t.artist); if (!byKey.has(kk)) byKey.set(kk, t); }
  const used = new Set<string>(); const out: (Track | null)[] = []; const miss: [number, YTrack][] = [];
  for (const y of ym.slice(0, 20)) {
    const m = byKey.get(k(y.title, y.artist));
    if (m && !used.has(m.id)) { used.add(m.id); out.push({ ...m, cover: y.cover || m.cover }); }
    else if (miss.length < 6) { miss.push([out.length, y]); out.push(null); }
  }
  const found = await Promise.race([
    Promise.all(miss.map(([, y]) => findTrack(y.title, y.artist).catch(() => null))),
    new Promise<(Track | null)[]>((r) => setTimeout(() => r(miss.map(() => null)), 2500)),
  ]);
  miss.forEach(([i, y], n) => { const t = found[n]; if (t && !used.has(t.id)) { used.add(t.id); out[i] = { ...t, cover: y.cover || t.cover }; } });
  return [...(out.filter(Boolean) as Track[]), ...it.filter((t) => !used.has(t.id))];
}
// Поиск во время ввода: ответы на последние запросы хранятся в памяти — при стирании букв или повторном
// вводе результаты появляются мгновенно, без нового запроса в сеть. Одинаковые запросы не отправляются дважды.
type SearchRes = Awaited<ReturnType<typeof search>>;
const sMem = new Map<string, { t: number; v: SearchRes }>(); const sFly = new Map<string, Promise<SearchRes>>();
const sKey = (q: string) => q.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
export function peekSearch(q: string): SearchRes | undefined {
  const k = sKey(q); const m = sMem.get(k);
  if (!m || Date.now() - m.t > 30 * 60e3) return undefined;
  sMem.delete(k); sMem.set(k, m); return m.v;
}
// часть ответа (треки и артисты), пока альбомы ещё в пути — её получают все, кто ждёт этот запрос
const sPart = new Map<string, SearchRes>(); const sPartL = new Map<string, Set<(v: SearchRes) => void>>();
export function searchCached(q: string, onPart?: (v: SearchRes) => void): Promise<SearchRes> {
  const k = sKey(q); const hit = peekSearch(k); if (hit) return Promise.resolve(hit);
  if (onPart) { const p = sPart.get(k); if (p) onPart(p); else { if (!sPartL.has(k)) sPartL.set(k, new Set()); sPartL.get(k)!.add(onPart); } }
  if (!sFly.has(k)) sFly.set(k, search(k, (v) => { sPart.set(k, v); sPartL.get(k)?.forEach((f) => f(v)); sPartL.delete(k); }).then((v) => { sMem.set(k, { t: Date.now(), v }); while (sMem.size > 40) sMem.delete(sMem.keys().next().value as string); return v; }).finally(() => { sFly.delete(k); sPart.delete(k); sPartL.delete(k); }));
  return sFly.get(k)!;
}
const chartCache = new Map<string, Track[]>();
const newCache = new Map<string, any[]>();
export const clearCache = () => { chartCache.clear(); newCache.clear(); const ks = ['pc:chart:ru', 'pc:new:ru', 'pc:y:chart:ru', 'pc:y:new:ru']; ks.forEach((k) => mem.delete(k)); AsyncStorage.multiRemove(ks).catch(() => {}); };
export async function chart(cc: string): Promise<Track[]> {
  if (chartCache.has(cc)) return chartCache.get(cc)!;
  const res = await disk('chart2:' + cc, 6 * H, () => chartLoad(cc), (v) => v.length > 0, true); if (res.length) chartCache.set(cc, res); return res;
}
async function chartLoad(cc: string): Promise<Track[]> {
  if (YB) return L((await yj('/chart?limit=100')).results || []);   // чарт Яндекс Музыки (Россия), топ-100
  let ids: string[] = [];
  try { const d = await j(`https://rss.applemarketingtools.com/api/v2/${cc}/music/most-played/50/songs.json`); ids = d.feed.results.map((x: any) => x.id); } catch {}
  if (!ids.length) return [];
  const d = await j(`${IT}lookup?id=${ids.join(',')}&country=${cc}`);
  const m = new Map(L(d.results).map((t) => [t.id.slice(1), t]));
  return ids.map((i) => m.get(i)).filter(Boolean) as Track[];
}
export function album(id: number) { return disk('album:' + id, 7 * 24 * H, () => albumLoad(id)); }
async function albumLoad(id: number) {
  if (YB) { const d = await yj('/album/' + id); return { info: alb(d.info), tracks: L(d.songs || []) }; }
  let d = await j(`${IT}lookup?id=${id}&entity=song&country=RU`).catch(() => null);
  if (!d || !d.results?.length) d = await j(`${IT}lookup?id=${id}&entity=song&country=US`);
  return { info: alb(d.results[0]), tracks: L(d.results.slice(1)) };
}
export function artist(id: number) { return disk('artist3:' + id, 24 * H, () => artistLoad(id)); }
// Витрина главной (как на ПК): «Собрано для вас» (персональные плейлисты Яндекса, нужен вход) и «Подборки» редакции
export type YPl = { uid: string; kind: string; title: string; desc: string; count: number; cover: string; coverBig: string; special?: string };
export async function landing(): Promise<{ personal: YPl[]; playlists: YPl[] }> {
  if (!YB) return { personal: [], playlists: [] };
  const tk = (await ymToken()).slice(-6);
  return disk('land:' + tk, 1 * H, async () => { const r = await yj('/landing', 12000); return { personal: (r && r.personal) || [], playlists: (r && r.playlists) || [] }; }, (v) => v.personal.length + v.playlists.length > 0, true);
}
// треки плейлиста Яндекса
export function yplaylist(uid: string, kind: string): Promise<{ info: YPl | null; tracks: Track[] }> {
  return disk('ypl:' + uid + ':' + kind, 1 * H, async () => { const r = await yj('/playlist/' + encodeURIComponent(uid) + '/' + encodeURIComponent(kind), 12000); return { info: r && r.info, tracks: L((r && r.results) || []) }; }, (v) => v.tracks.length > 0);
}
// все песни исполнителя (до 200, популярные — первыми) — для «дальше» после трека со страницы артиста
export function artistAll(id: number): Promise<Track[]> {
  return disk<Track[]>('artall:' + id, 24 * H, async () => {
    if (YB) return L((await yj(`/artist/${id}/songs?limit=200`)).results || []);
    const d = await j(`${IT}lookup?id=${id}&entity=song&limit=200&country=RU`);
    return L((d.results || []).filter((x: any) => x.wrapperType === 'track' && x.artistId === id));
  }, (v) => v.length > 0).catch(() => []);
}
async function artistLoad(id: number) {
  if (YB) { const d = await yj('/artist/' + id); return { info: d.info, albums: (d.albums || []).map(alb).sort((a: any, b: any) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || ''))), tracks: L(d.songs || []), similar: (d.simA || []) as any[] }; }
  const al = (c: string) => j(`${IT}lookup?id=${id}&entity=album&limit=80&sort=recent&country=${c}`).catch(() => ({ results: [] }));
  const [s, ru, us] = await Promise.all([j(`${IT}lookup?id=${id}&entity=song&limit=25&country=RU`), al('RU'), al('US')]);
  // альбомы из двух магазинов без повторов, новые — первыми
  const seen = new Set<number>(); const albums: any[] = [];
  for (const x of [...ru.results.slice(1), ...us.results.slice(1)]) {
    if (!x.collectionName || !x.collectionId || seen.has(x.collectionId)) continue;
    seen.add(x.collectionId); albums.push(alb(x));
  }
  albums.sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
  return { info: ru.results[0] || us.results[0], albums, tracks: L(s.results.filter((x: any) => x.wrapperType === 'track')), similar: [] as any[] };
}

// Новинки. С Яндексом — свой список новинок (чарт для него не нужен, грузится одновременно с чартом).
// Без Яндекса — свежие альбомы исполнителей из чарта (iTunes Lookup, сортировка по дате выхода).
// Главная сразу начинает грузить чарт и новинки, ещё до первого кадра (warmHome).
export function warmHome() { chart('ru').catch(() => {}); if (YB) newReleases('ru', []).catch(() => {}); }
export async function newReleases(cc: string, from: Track[]): Promise<any[]> {
  if (newCache.has(cc)) return newCache.get(cc)!;
  const r = await disk('new:' + cc, 6 * H, () => newLoad(cc, from), (v) => v.length > 0, true); if (r.length) newCache.set(cc, r); return r;
}
async function newLoad(cc: string, from: Track[]): Promise<any[]> {
  if (YB) { const r = ((await yj('/new?limit=20')).results || []).map(alb); if (r.length) newCache.set(cc, r); return r; }
  const ids = Array.from(new Set(from.map((t) => t.artistId).filter(Boolean) as number[])).slice(0, 18);
  const parts = await Promise.all(ids.map((id) => j(`${IT}lookup?id=${id}&entity=album&limit=4&sort=recent&country=${cc.toUpperCase()}`).then((d) => d.results.slice(1)).catch(() => [])));
  const seen = new Set<number>(); const min = Date.now() - 1000 * 60 * 60 * 24 * 200; const out: any[] = [];
  for (const x of parts.flat()) {
    if (!x.collectionId || seen.has(x.collectionId) || !x.collectionName) continue;
    if (new Date(x.releaseDate).getTime() < min || new Date(x.releaseDate).getTime() > Date.now() + 864e5 * 2) continue;
    seen.add(x.collectionId); out.push(alb(x));
  }
  out.sort((a, b) => String(b.releaseDate).localeCompare(String(a.releaseDate)));
  const r = out.slice(0, 20); if (r.length) newCache.set(cc, r); return r;
}

// Deezer: фото артиста и реальная статистика (поклонники, число альбомов). Берём только при точном совпадении имени
// ИИ-диджей: найти конкретную песню по названию и исполнителю. Совпадение считаем по словам:
// исполнитель должен совпасть (хотя бы основной), название — почти целиком; ремиксы и «live» — только если их просили.
const nz = (s: string) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff]+/g, ' ').trim();
const wsOf = (s: string) => nz(s).split(' ').filter(Boolean);
export async function findTrack(title: string, artist: string): Promise<Track | null> {
  if (!title.trim()) return null;
  if (YB) { const d = await yj(`/match?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(baseArtist(artist))}`, 7000).catch(() => null); return d?.result ? L([d.result])[0] || null : null; }
  const q = `${baseArtist(artist)} ${title}`.trim();
  const r = await j(`${IT}search?term=${encodeURIComponent(q)}&media=music&country=RU&limit=12&entity=song`, true).catch(() => null);
  const list = L(r?.results || []); if (!list.length) return null;
  const tw = wsOf(title), aw = wsOf(baseArtist(artist)); const wantVar = /remix|live|mix|edit|version|ремикс/i.test(title);
  let best: Track | null = null, bs = 0;
  for (const t of list) {
    const ttw = new Set(wsOf(t.title)), taw = nz(t.artist);
    const tHit = tw.length ? tw.filter((w) => ttw.has(w)).length / tw.length : 0;
    const aHit = aw.length ? aw.filter((w) => taw.includes(w)).length / aw.length : 0;
    let sc = tHit * 2 + aHit * 1.5 - (!wantVar && /remix|live|ремикс|sped up|slowed/i.test(t.title) ? 0.8 : 0) - Math.max(0, ttw.size - tw.length) * 0.05;
    if (aHit < 0.5 && tHit < 1) sc = 0;
    if (sc > bs) { bs = sc; best = t; }
  }
  return bs >= 2.2 ? best : null;
}

export const baseArtist = (name: string) => String(name || '').split(/\s*(?:,|&|feat\.?|ft\.?|\sx\s|×)\s*/i)[0].trim();
export type DZ = { photo: string; photoS: string; fans: number; albums: number };
const dz = new Map<string, Promise<DZ | null>>();
export function artistDeezer(name: string): Promise<DZ | null> {
  const base = baseArtist(name).toLowerCase();
  if (!base) return Promise.resolve(null);
  // режим Яндекса: фото исполнителя и число «поклонников» (лайков) — из Яндекс Музыки
  // нет точного совпадения в Яндексе — берём фото из Deezer (тоже только по точному имени)
  if (YB) return ymByName(name).then((d) => (d?.artist?.photo ? { photo: d.artist.photo || '', photoS: d.artist.photoS || d.artist.photo || '', fans: Number(d.artist.fans) || 0, albums: 0 } : deezerCard(base))).catch(() => deezerCard(base));
  return deezerCard(base);
}
// Тёзки: у Deezer бывает несколько артистов с одинаковым именем. Берём из точных совпадений самого популярного,
// имена сравниваем без регистра, «ё» и знаков; серую заглушку (артист без фото) не показываем.
const nzName = (s: string) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff]+/g, '');
function deezerCard(base: string): Promise<DZ | null> {
  if (!dz.has(base)) capped(dz, 300);
  if (!dz.has(base)) dz.set(base, disk<DZ | null>('dz2:' + base, 7 * 24 * H, () => j(`https://api.deezer.com/search/artist?q=${encodeURIComponent(base)}&limit=15`)
    .then((d) => {
      const want = nzName(base);
      const a = (d.data || []).filter((x: any) => nzName(x.name) === want).sort((x: any, y: any) => (Number(y.nb_fan) || 0) - (Number(x.nb_fan) || 0))[0];
      if (!a) return null;
      const noPic = !a.picture || /\/images\/artist\/\//.test(String(a.picture_medium || ''));
      return { photo: noPic ? '' : a.picture_xl || a.picture_big || '', photoS: noPic ? '' : a.picture_medium || a.picture_big || '', fans: Number(a.nb_fan) || 0, albums: Number(a.nb_album) || 0 };
    }))
    .catch(() => { dz.delete(base); return null; }));
  return dz.get(base)!;
}
export async function artistPhoto(name: string, small = false): Promise<string> { const d = await artistDeezer(name); return (small ? d?.photoS || d?.photo : d?.photo) || ''; }
// Фото по id исполнителя (точнее, чем по имени: у тёзок и у имён с «feat.», «&», латиницей/кириллицей поиск по имени
// промахивается). Карточка артиста кэшируется на сутки — заодно его страница потом открывается мгновенно.
// Одновременно — не больше 3 запросов, чтобы ряд «Недавних» не занимал всю сеть на слабом телефоне.
let photoBusy = 0; const photoWait: (() => void)[] = [];
const photoSlot = async <T,>(f: () => Promise<T>): Promise<T> => {
  if (photoBusy >= 3) await new Promise<void>((r) => photoWait.push(r));
  photoBusy++; try { return await f(); } finally { photoBusy--; const n = photoWait.shift(); if (n) n(); }
};
const photoById = new Map<string, Promise<string>>();
export function artistPhotoBy(name: string, id?: number, small = false): Promise<string> {
  const k = (id || '') + '|' + name + '|' + (small ? 's' : 'b');
  if (!photoById.has(k)) {
    capped(photoById, 300);
    photoById.set(k, photoSlot(async () => {
      if (id) { try { const r: any = await artist(id); const i = r?.info || {}; const u = (small ? i.photoS || i.photo : i.photo || i.photoS) || ''; if (u) return u; } catch {} }
      for (let a = 0; a < 2; a++) { const u = await artistPhoto(name, small).catch(() => ''); if (u) return u; await new Promise((r) => setTimeout(r, 1500)); }
      return '';
    }).then((u) => { if (!u) photoById.delete(k); return u; }));
  }
  return photoById.get(k)!;
}

// Средняя яркость картинки (0 — чёрная, 1 — белая): качаем крошечную копию 60×60 и считаем пиксели.
// Нужна, чтобы выбрать цвет текста поверх цветного фона (белый на тёмном, тёмный на светлом).
const tones = new Map<string, Promise<number | null>>();
export function imageTone(u?: string): Promise<number | null> {
  if (!u || !jpeg) return Promise.resolve(null);
  const url = u.replace(/\d+x\d+(bb)?(-\d+)?(?=\.\w+$)/, '60x60bb').replace(/\/\d+x\d+-/, '/56x56-');
  if (!tones.has(url)) capped(tones, 200);
  if (!tones.has(url)) tones.set(url, (async () => {
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const img: any = jpeg.decode(new Uint8Array(buf), { useTArray: true, formatAsRGBA: true });
      const d = img.data as Uint8Array; let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
      return n ? sum / n / 255 : null;
    } catch { tones.delete(url); return null; }
  })());
  return tones.get(url)!;
}

// Цвет низа картинки (для подписей поверх обложки, как на ПК): средний цвет нижней половины, затемнённый (×0,42),
// чтобы белый текст читался. Строка «r,g,b» или '' (не удалось).
const tints = new Map<string, Promise<string>>();
// Средний цвет нижней части обложки (r, g, b 0…255). Запоминается — одну обложку не скачиваем дважды.
const avgs = new Map<string, Promise<number[] | null>>();
function coverAvg(u?: string, from = 0.5): Promise<number[] | null> {
  if (!u || !jpeg) return Promise.resolve(null);
  const url = u.replace(/\d+x\d+(bb)?(-\d+)?(?=\.\w+$)/, '60x60bb').replace(/\/\d+x\d+$/, '/100x100');
  const k = url + '|' + from;
  if (!avgs.has(k)) { capped(avgs, 200); avgs.set(k, (async () => {
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const img: any = jpeg.decode(new Uint8Array(buf), { useTArray: true, formatAsRGBA: true });
      const d = img.data as Uint8Array, w = img.width, h = img.height; let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.floor(h * from); y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      return n ? [r / n, g / n, b / n] : null;
    } catch { avgs.delete(k); return null; }
  })()); }
  return avgs.get(k)!;
}
// тёмный оттенок обложки (подложка карточек подборок)
export function coverTint(u?: string): Promise<string> {
  return coverAvg(u).then((c) => (c ? c.map((v) => Math.round(v * 0.42)).join(',') : ''));
}
// Насыщенный тёмный цвет обложки — в него обложка альбома перетекает снизу (как в Apple Music): тот же оттенок,
// но сочнее и темнее, чтобы на нём читался белый текст. Серые обложки остаются серыми (без выдуманного цвета).
export function coverTintVivid(u?: string): Promise<string> {
  return coverAvg(u, 0.66).then((c) => {
    if (!c) return '';
    const [r, g, b] = c.map((v) => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l0 = (mx + mn) / 2; const dl = mx - mn;
    let h = 0; const s0 = dl ? dl / (1 - Math.abs(2 * l0 - 1)) : 0;
    if (dl) h = mx === r ? ((g - b) / dl) % 6 : mx === g ? (b - r) / dl + 2 : (r - g) / dl + 4; h = (h * 60 + 360) % 360;
    const s = s0 < 0.08 ? s0 : Math.min(0.85, s0 * 1.35 + 0.08), l = Math.max(0.14, Math.min(0.3, l0 * 0.55));
    const C = (1 - Math.abs(2 * l - 1)) * s, X = C * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - C / 2;
    const [a1, a2, a3] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
    return [a1, a2, a3].map((v) => Math.round((v + m) * 255)).join(',');
  });
}

// Основной цвет обложки для ползунка. Возвращает тон в HSL (0..1) или null, если обложка почти без цвета
// (чёрно-белая, тёмная) — тогда плеер использует «инверсию»: белая звезда и шлейф, чёрное ядро.
export type HSL = { h: number; s: number; l: number };
const ccache = new Map<string, Promise<HSL | null>>();
export function coverColor(u?: string): Promise<HSL | null> {
  if (!u || !jpeg) return Promise.resolve(null);
  const url = u.replace(/\d+x\d+(bb)?(-\d+)?(?=\.\w+$)/, '60x60bb').replace(/\/\d+x\d+-/, '/56x56-');
  if (!ccache.has(url)) capped(ccache, 200);
  if (!ccache.has(url)) ccache.set(url, (async () => {
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const d: Uint8Array = jpeg.decode(new Uint8Array(buf), { useTArray: true, formatAsRGBA: true }).data;
      const acc = new Array(24).fill(0), sr = new Array(24).fill(0), sg = new Array(24).fill(0), sb = new Array(24).fill(0); let tot = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx, sat = mx ? (mx - mn) / mx : 0; n++;
        if (sat < 0.28 || v < 0.22) continue;
        let h = mx === mn ? 0 : mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4; h = ((h * 60) + 360) % 360;
        const w = sat * v, k = Math.floor(h / 15) % 24; acc[k] += w; sr[k] += r * w; sg[k] += g * w; sb[k] += b * w; tot += w;
      }
      if (!n || tot / n < 0.035) return null;                       // почти без цвета
      let best = 0, bv = -1;
      for (let k = 0; k < 24; k++) { const sc = acc[k] + 0.5 * (acc[(k + 23) % 24] + acc[(k + 1) % 24]); if (sc > bv) { bv = sc; best = k; } }
      let R = 0, G = 0, B = 0, W = 0;
      for (const k of [(best + 23) % 24, best, (best + 1) % 24]) { R += sr[k]; G += sg[k]; B += sb[k]; W += acc[k]; }
      R /= W; G /= W; B /= W;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2, dd = mx - mn;
      const sat = dd === 0 ? 0 : dd / (1 - Math.abs(2 * l - 1));
      let h = mx === mn ? 0 : mx === R ? ((G - B) / dd) % 6 : mx === G ? (B - R) / dd + 2 : (R - G) / dd + 4; h = (((h * 60) + 360) % 360) / 360;
      return { h, s: sat, l };
    } catch { ccache.delete(url); return null; }
  })());
  return ccache.get(url)!;
}

// ---------- «Об исполнителе» (Last.fm) ----------
// Текст об артисте, число слушателей и прослушиваний и жанры — из Last.fm (не из Википедии).
// Нужен бесплатный ключ: last.fm/api/account/create → строка «API key». Без ключа блок показывает
// фото (Deezer), жанр и год первого релиза (iTunes), но без текста и цифр Last.fm.
export const LASTFM_KEY = '8705e9dc7d61fc06b1aa78d0ed887b26';
const LF = 'https://ws.audioscrobbler.com/2.0/';
// топ треков по тегу Last.fm («workout», «chill», «russian rock», «00s»…) — для встроенного ИИ-диджея
export function tagTracks(tag: string): Promise<{ t: string; a: string }[]> {
  return disk<{ t: string; a: string }[]>('tag:' + tag, 3 * 24 * H, async () => {
    const d = await j(`${LF}?method=tag.gettoptracks&tag=${encodeURIComponent(tag)}&limit=80&api_key=${LASTFM_KEY}&format=json`);
    return ((d?.tracks?.track || []) as any[]).map((x) => ({ t: String(x.name || ''), a: String(x.artist?.name || '') })).filter((x) => x.t && x.a);
  }, (v) => v.length > 0).catch(() => []);
}
const SKIP_TAGS = /^(seen live|favorites?|favourites?|my|love|awesome|under \d+|\d+s?|all)$/i;
// Текст Last.fm приходит с HTML-ссылками и хвостом «Read more on Last.fm» / лицензией — оставляем чистый текст
function cleanBio(html?: string) {
  let t = String(html || '')
    .replace(/<a [^>]*>(Read more on Last\.fm|Читать дальше на Last\.fm|Подробнее на Last\.fm)<\/a>\.?/gi, '')
    .replace(/User-contributed text is available under[\s\S]*$/i, '')
    .replace(/Текст доступен на условиях[\s\S]*$/i, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t.length >= 40 ? t : '';
}
async function lfInfo(name: string, lang: string) {
  const d = await j(`${LF}?method=artist.getinfo&artist=${encodeURIComponent(name)}&autocorrect=1&lang=${lang}&api_key=${LASTFM_KEY}&format=json`);
  return d?.artist || null;
}
// ---------- Перевод на русский ----------
// Если у Last.fm есть только английский текст, переводим его на русский через бесплатный сервис MyMemory.
// Перевод сохраняется на телефоне на месяц — один и тот же текст не переводится повторно.
// У сервиса бесплатный дневной лимит; если он исчерпан, показываем оригинал и пробуем перевести позже.
const isRu = (t: string) => /[а-яё]/i.test(t);
const hashStr = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + s.length.toString(36); };
function chunks(t: string, max = 450): string[] {
  const out: string[] = []; let cur = '';
  // режем по предложениям (без «просмотра назад» в регулярке — его поддерживают не все движки JS)
  const parts = t.replace(/([.!?…])\s+/g, '$1\u0000').split(/\u0000|\n+/);
  for (const part of parts) {
    if (!part) continue;
    if ((cur + ' ' + part).trim().length > max && cur) { out.push(cur.trim()); cur = ''; }
    if (part.length > max) { for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max)); continue; }
    cur += ' ' + part;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
export type Txt = { text: string; tr: boolean };   // tr — переведено автоматически
export async function toRussian(text: string): Promise<Txt> {
  if (!text || isRu(text)) return { text, tr: false };
  try {
    const ru = await disk<string>('tr:' + hashStr(text), 30 * 24 * H, async () => {
      // абзацы сохраняем: переводим каждый отдельно
      const paras = text.split(/\n{2,}/); const done: string[] = [];
      for (const para of paras) {
        const parts: string[] = [];
        for (const c of chunks(para)) {
          const d = await j(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(c)}&langpair=en|ru`);
          const tt = String(d?.responseData?.translatedText || '');
          if (!tt || Number(d?.responseStatus) !== 200 || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(tt)) throw new Error('limit');
          parts.push(tt.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
        }
        done.push(parts.join(' '));
      }
      return done.join('\n\n');
    }, (v) => !!v && isRu(v));
    return { text: ru, tr: true };
  } catch { return { text, tr: false }; }
}

// Жанры Last.fm — по-русски (что не нашлось в словаре — как есть)
const TAG_RU: Record<string, string> = {
  'hip-hop': 'хип-хоп', 'hip hop': 'хип-хоп', 'rap': 'рэп', 'trap': 'трэп', 'cloud rap': 'клауд-рэп', 'rage': 'рейдж', 'drill': 'дрилл',
  'pop': 'поп', 'rock': 'рок', 'indie': 'инди', 'alternative': 'альтернатива', 'alternative rock': 'альт-рок', 'indie rock': 'инди-рок',
  'electronic': 'электроника', 'dance': 'танцевальная', 'house': 'хаус', 'techno': 'техно', 'edm': 'EDM', 'dubstep': 'дабстеп',
  'rnb': 'R&B', 'r&b': 'R&B', 'soul': 'соул', 'jazz': 'джаз', 'blues': 'блюз', 'funk': 'фанк', 'disco': 'диско', 'reggae': 'регги',
  'metal': 'метал', 'punk': 'панк', 'punk rock': 'панк-рок', 'emo': 'эмо', 'grunge': 'гранж', 'classical': 'классика',
  'ambient': 'эмбиент', 'folk': 'фолк', 'country': 'кантри', 'latin': 'латино', 'k-pop': 'K-pop', 'soundtrack': 'саундтрек',
  'singer-songwriter': 'автор-исполнитель', 'synthpop': 'синти-поп', 'new wave': 'новая волна', 'post-punk': 'пост-панк',
  'phonk': 'фонк', 'russian': 'русское', 'russian rap': 'русский рэп', 'russian rock': 'русский рок', 'american': 'американское',
  'british': 'британское', 'female vocalists': 'женский вокал', 'male vocalists': 'мужской вокал', 'experimental': 'экспериментальное',
  'psychedelic': 'психоделика', 'lo-fi': 'лоу-фай', 'chillout': 'чилаут', 'pop rap': 'поп-рэп', 'underground': 'андеграунд',
  'hardcore': 'хардкор', 'grime': 'грайм', 'afrobeats': 'афробит', 'reggaeton': 'реггетон', 'atlanta': 'Атланта', 'usa': 'США',
};
export const tagRu = (t: string) => TAG_RU[t.toLowerCase()] || t;
// Жанр iTunes («Hip-Hop/Rap», «Alternative») — по-русски
export const genreRu = (g?: string) => (g ? g.split('/').map((x) => tagRu(x.trim())).join('/') : '');

export type About = { bio: string; listeners: number; plays: number; tags: string[]; url: string; tr: boolean };
export function artistAbout(name: string): Promise<About | null> {
  const base = String(name || '').trim();
  if (!LASTFM_KEY || !base) return Promise.resolve(null);
  return disk<About | null>('lf2:' + base.toLowerCase(), 3 * 24 * H, async () => {
    const ru = await lfInfo(base, 'ru');
    if (!ru) return null;
    // русский текст, если он есть; иначе английский — и переводим его на русский
    let bio = cleanBio(ru.bio?.content) || cleanBio(ru.bio?.summary);
    if (!bio || !isRu(bio)) { const en = await lfInfo(base, 'en').catch(() => null); const b2 = cleanBio(en?.bio?.content) || cleanBio(en?.bio?.summary); if (b2 && !bio) bio = b2; }
    const t = await toRussian(bio);
    const tags = ((ru.tags?.tag || []) as any[]).map((x) => String(x.name || '').toLowerCase()).filter((x) => x && !SKIP_TAGS.test(x)).slice(0, 4).map(tagRu);
    return { bio: t.text, tr: t.tr, listeners: Number(ru.stats?.listeners) || 0, plays: Number(ru.stats?.playcount) || 0, tags, url: String(ru.url || '') };
  }, (v) => !!v && (!v.bio || isRu(v.bio))).catch(() => null);
}

// ---------- История трека и альбома (Last.fm) ----------
// Last.fm хранит статьи о многих треках и альбомах: как и когда записывали, что вдохновило, как приняли.
// Есть не у всех — тогда так и пишем. Русский текст, если он есть; иначе английский с автопереводом.
export type Story = { text: string; tr: boolean; url: string; published?: string };
async function lfWiki(method: 'track' | 'album', artist: string, name: string, lang: string) {
  const d = await j(`${LF}?method=${method}.getinfo&artist=${encodeURIComponent(artist)}&${method}=${encodeURIComponent(name)}&autocorrect=1&lang=${lang}&api_key=${LASTFM_KEY}&format=json`);
  return d?.[method] || null;
}
function story(method: 'track' | 'album', artist?: string, name?: string): Promise<Story | null> {
  const a = baseArtist(String(artist || '')), n = cleanName(name);
  if (!LASTFM_KEY || !a || !n) return Promise.resolve(null);
  return disk<Story | null>(`st:${method}:${a.toLowerCase()}|${n.toLowerCase()}`, 7 * 24 * H, async () => {
    const ru = await lfWiki(method, a, n, 'ru').catch(() => null);
    let text = cleanBio(ru?.wiki?.content) || cleanBio(ru?.wiki?.summary);
    if (!text || !isRu(text)) { const en = await lfWiki(method, a, n, 'en').catch(() => null); const t2 = cleanBio(en?.wiki?.content) || cleanBio(en?.wiki?.summary); if (t2 && !text) text = t2; }
    if (!text) return { text: '', tr: false, url: String(ru?.url || '') };
    const t = await Promise.race([toRussian(text), sleep(5000).then(() => ({ text, tr: false }))]);
    return { text: t.text, tr: t.tr, url: String(ru?.url || ''), published: ru?.wiki?.published };
  }, (v) => !!v && (!v.text || isRu(v.text))).catch(() => null);
}
export const trackStory = (artist?: string, title?: string) => story('track', artist, title);
export const albumStory = (artist?: string, album?: string) => story('album', artist, album);

// ---------- Для «Моего пульса» ----------
// Похожие исполнители (Deezer): имена артистов, близких к данному
export function related(name: string): Promise<string[]> {
  const base = baseArtist(name).toLowerCase();
  if (!base) return Promise.resolve([]);
  if (YB) return ymByName(name).then((d) => (d?.similar || []) as string[]).catch(() => []);
  return disk<string[]>('rel:' + base, 7 * 24 * H, async () => {
    const d = await j(`https://api.deezer.com/search/artist?q=${encodeURIComponent(base)}&limit=5`);
    const a = (d.data || []).find((x: any) => String(x.name).toLowerCase() === base);
    if (!a) return [];
    const r = await j(`https://api.deezer.com/artist/${a.id}/related?limit=15`);
    return (r.data || []).map((x: any) => String(x.name || '')).filter(Boolean);
  }, (v) => v.length > 0).catch(() => []);
}
// Песни исполнителя по имени (iTunes) — только где он основной артист
// артист по имени (фото, похожие, песни) — один запрос на имя, повторы берутся из памяти и с диска
const ymNames = new Map<string, Promise<any>>();
function ymByName(name: string): Promise<any> {
  const n = baseArtist(name); const k = n.toLowerCase();
  if (!ymNames.has(k)) { capped(ymNames, 300); ymNames.set(k, disk<any>('yn2:' + k, 3 * 24 * H, () => yj('/artist-by-name?name=' + encodeURIComponent(n)), (v) => !!v?.artist).catch(() => { ymNames.delete(k); return null; })); }
  return ymNames.get(k)!;
}
// ссылка на звук трека из Яндекса. Приложение просит её прямо перед проигрыванием (ссылки живут недолго).
// Токен пользователя (если он вошёл) уходит только на ваш сервер, в заголовке, и там не хранится.
// preview = true — Яндекс отдал лишь 30-секундный фрагмент (без входа или без подписки Плюс).
const streamMem = new Map<string, { at: number; v: { url: string; preview: boolean } }>();
export let streamErr = '';   // почему не удалось получить звук (показывается в плеере и в настройках)
// Ссылка на звук. Одинаковые одновременные запросы (заранее готовим следующий трек и тут же его включили) — один запрос.
const streamFly = new Map<string, Promise<{ url: string; preview: boolean } | null>>();
export function streamUrl(t: Track): Promise<{ url: string; preview: boolean } | null> {
  const k = String(t.url || t.id); const f = streamFly.get(k); if (f) return f;
  const p = streamUrl0(t).finally(() => streamFly.delete(k)); streamFly.set(k, p); return p;
}
// заранее, при касании трека в списке (до того как палец отпустили): ссылка уже едет, когда трек включится
export const warmStream = (t: Track) => { if (YB) streamUrl(t).catch(() => null); };
// есть ли вход в Яндекс (тогда фрагмент — случайность, и стоит попробовать получить полный звук ещё раз)
export const ymSignedIn = async () => !!(await ymToken());
export const forgetStream = (t: Track) => { const id = String(t.url || '').startsWith('ym:') ? String(t.url).slice(3) : ''; if (id) streamMem.delete(id); };
async function streamUrl0(t: Track): Promise<{ url: string; preview: boolean } | null> {
  if (!YB) return null; streamErr = '';
  let id = String(t.url || '').startsWith('ym:') ? String(t.url).slice(3) : '';
  // старый трек (сохранён ещё из iTunes) — находим его в Яндексе по названию и исполнителю; найденное запоминаем
  if (!id) {
    const mk = 'ymid:' + (t.title + '|' + t.artist).toLowerCase();
    id = (await AsyncStorage.getItem(mk).catch(() => null)) || '';
    if (!id) {
      let d: any = null;
      try { d = await yj(`/match?title=${encodeURIComponent(t.title)}&artist=${encodeURIComponent(baseArtist(t.artist))}`, 9000); }
      catch (e: any) { streamErr = `Сервер не ответил на поиск трека (${e?.message || 'нет связи'})`; return null; }
      const u = String(d?.result?.previewUrl || '');
      if (!u.startsWith('ym:')) { streamErr = `«${t.title}» не найден в Яндекс Музыке`; return null; }
      id = u.slice(3); AsyncStorage.setItem(mk, id).catch(() => {});
    }
  }
  // полная ссылка живёт минуту; фрагмент — 10 с (вдруг Яндекс отказал случайно — следующий раз спросим снова)
  // запоминаем только полный звук — фрагмент всегда спрашиваем заново
  const hit = streamMem.get(id); if (hit && !hit.v.preview && Date.now() - hit.at < 50000) return hit.v;
  if (YLOCAL) {
    try { const v: any = await ymLocal('/stream/' + id, await ymToken()); if (!v?.url) return null; capped(streamMem, 60); streamMem.set(id, { at: Date.now(), v: { url: v.url, preview: !!v.preview } }); return streamMem.get(id)!.v; }
    catch (e: any) { streamErr = String(e?.message || 'Яндекс не отдал звук'); return null; }
  }
  const r = await fetchT(`${YB}/stream/${id}`, 9000, await ymHead()).catch(() => null);
  if (!r) { streamErr = 'Сервер Яндекс Музыки не отвечает'; return null; }
  if (!r.ok) { const d = await r.json().catch(() => null); streamErr = String(d?.detail || 'Ошибка ' + r.status); return null; }
  const v = await r.json().catch(() => null); if (!v?.url) return null;
  capped(streamMem, 60); streamMem.set(id, { at: Date.now(), v: { url: v.url, preview: !!v.preview } }); return streamMem.get(id)!.v;
}
export function artistSongs(name: string): Promise<Track[]> {
  const n = baseArtist(name); const k = n.toLowerCase();
  if (!k) return Promise.resolve([]);
  if (YB) return ymByName(name).then((d) => L(d?.songs || []).slice(0, 12)).catch(() => []);
  return disk<Track[]>('as:' + k, 3 * 24 * H, async () => {
    const d = await j(`${IT}search?term=${encodeURIComponent(n)}&media=music&entity=song&country=RU&limit=25`);
    return L((d.results || []).filter((x: any) => baseArtist(x.artistName).toLowerCase() === k)).slice(0, 12);
  }, (v) => v.length > 0).catch(() => []);
}

// Номер сборки файла. Все файлы папки src должны быть из одной сборки — иначе приложение покажет подсказку, а не ошибку.
export const BUILD = 64;

// проверка связи с Яндексом (экран «Яндекс Музыка»): и для своего сервера, и для режима без сервера
export async function ymHealth(): Promise<any> { return yj('/health', 9000); }
// «Моя волна» Яндекса для «Моего пульса» (нужен вход). cfg — фильтры приложения → настройки волны
export async function wave(cfg: { mood: string; kind: string; lang?: string }, after = ''): Promise<Track[]> {
  if (!YLOCAL || !(await ymToken())) return [];
  const mood = ({ any: 'all', up: 'active', calm: 'calm', fun: 'fun', sad: 'sad' } as any)[cfg.mood] || 'all';
  const kind = ({ mix: 'default', fav: 'favorite', new: 'discover', pop: 'popular' } as any)[cfg.kind] || 'default';
  const lang = ({ any: 'any', ru: 'russian', world: 'not-russian' } as any)[cfg.lang || 'any'] || 'any';
  const d = await yj(`/wave?mood=${mood}&kind=${kind}&lang=${lang}&after=${encodeURIComponent(after)}`, 12000).catch(() => null);
  return L((d && d.results) || []);
}

// ---------- общее «Любимое» с ПК: «Мне нравится» Яндекс Музыки (см. ysync.ts) ----------
export const yLikes = async () => likesList(await ymToken());
export const yTracks = async (ids: string[]) => L(await tracksByIds(await ymToken(), ids));
export const yLikeSet = async (ids: string[], on: boolean) => likesSet(await ymToken(), ids, on);
export const ySyncOn = async () => YLOCAL && !!(await ymToken());
