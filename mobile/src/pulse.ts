// «Мой пульс» — бесконечный поток под вкус слушателя.
// Откуда берутся треки:
//  1) знакомое — любимые треки и топ-песни артистов, которых вы слушаете больше всего (по статистике, лайкам, истории);
//  2) новое — похожие исполнители (Deezer) и их песни (iTunes);
//  3) популярное — чарт.
// «Характер» меняет пропорции этих трёх источников, «Настроение» поднимает выше треки подходящих жанров.
// Дизлайк: трек больше не попадётся, а артист получит меньший вес.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as api from './api';
import type { Track } from './api';
import { Image } from 'react-native';
import { preload } from './audioCache';

export type Mood = 'any' | 'up' | 'calm' | 'fun' | 'sad';
export type Kind = 'mix' | 'fav' | 'new' | 'pop';
// Настройки потока. Кроме настроения и характера — фильтры: язык, годы, длина, слова/инструментал, без мата.
// Применяются сразу: уже подобранное «Далее» отфильтровывается на месте, недостающее догружается.
export type Lang = 'any' | 'ru' | 'world'; export type Era = 'any' | 'new' | 'old'; export type Len = 'any' | 'short' | 'long';
export type Words = 'any' | 'vocal' | 'inst'; export type Clean = 'any' | 'clean';
export type Cfg = { mood: Mood; kind: Kind; lang?: Lang; era?: Era; len?: Len; words?: Words; clean?: Clean };
export const DEFAULT_CFG: Cfg = { mood: 'any', kind: 'mix', lang: 'any', era: 'any', len: 'any', words: 'any', clean: 'any' };
export const LANGS: [Lang, string][] = [['any', 'Любой'], ['ru', 'Русский'], ['world', 'Зарубежный']];
export const ERAS: [Era, string][] = [['any', 'Любые'], ['new', 'Новинки'], ['old', 'Старое']];
export const LENS: [Len, string][] = [['any', 'Любая'], ['short', 'Короткие'], ['long', 'Длинные']];
export const WORDS: [Words, string][] = [['any', 'Любые'], ['vocal', 'Со словами'], ['inst', 'Без слов']];
export const CLEANS: [Clean, string][] = [['any', 'Можно'], ['clean', 'Без мата']];
const INST = /instrumental|инструментал|\bbeat\b|(^|\s)минус|karaoke|lo-?fi|\bambient\b/i;
// подходит ли трек под фильтры (неизвестный год/длина — пропускаем, чтобы поток не пересыхал)
export function fit(t: Track, c: Cfg): boolean {
  const ru = (t as any).ru || /[а-яё]/i.test(`${t.title} ${t.artist}`);   // ru — найден по русским тегам (у многих русских артистов латинские имена)
  if (c.lang === 'ru' && !ru) return false; if (c.lang === 'world' && ru) return false;
  const y = (t as any).year as number | undefined; const now = new Date().getFullYear();
  if (y && c.era === 'new' && y < now - 1) return false; if (y && c.era === 'old' && !(t as any).old && y > now - 8) return false;   // old — найден по тегам эпохи (переиздания бывают «новыми»)
  if (t.dur && c.len === 'short' && t.dur > 180) return false; if (t.dur && c.len === 'long' && t.dur < 240) return false;
  const inst = INST.test(`${t.title} ${t.album || ''}`);
  if (c.words === 'inst' && !inst) return false; if (c.words === 'vocal' && inst) return false;
  if (c.clean === 'clean' && t.explicit) return false;
  return true;
}
export const MOODS: [Mood, string][] = [['any', 'Любое'], ['up', 'Бодрое'], ['calm', 'Спокойное'], ['fun', 'Весёлое'], ['sad', 'Грустное']];
export const KINDS: [Kind, string][] = [['mix', 'Микс'], ['fav', 'Любимое'], ['new', 'Незнакомое'], ['pop', 'Популярное']];
export const cfgLabel = (c: Cfg) => {
  const parts = [(KINDS.find((k) => k[0] === c.kind) || KINDS[0])[1]];
  if (c.mood !== 'any') parts.push((MOODS.find((m) => m[0] === c.mood) || MOODS[0])[1]);
  const extra = [c.lang, c.era, c.len, c.words, c.clean].filter((x) => x && x !== 'any').length;
  return parts.join(' · ') + (extra ? ` · +${extra}` : '');
};

let cfgP: Promise<Cfg> | null = null;
export function getCfg(): Promise<Cfg> {
  if (!cfgP) cfgP = AsyncStorage.getItem('pulse_cfg').then((v) => ({ ...DEFAULT_CFG, ...(v ? JSON.parse(v) : {}) })).catch(() => DEFAULT_CFG);
  return cfgP;
}
export function setCfg(c: Cfg) { cfgP = Promise.resolve(c); AsyncStorage.setItem('pulse_cfg', JSON.stringify(c)).catch(() => {}); }

export const key = (t: Track) => (t.title || '').toLowerCase().replace(/ё/g, 'е').trim() + '|' + (t.artist || '').toLowerCase().trim();
const art = (s: string) => api.baseArtist(s).toLowerCase().replace(/ё/g, 'е');

// ---------- Дизлайки ----------
type Less = { keys: string[]; artists: Record<string, number>; tracks?: Track[] };
let lessP: Promise<Less> | null = null;
const getLess = () => lessP || (lessP = AsyncStorage.getItem('pulse_less').then((v) => (v ? JSON.parse(v) : { keys: [], artists: {} })).catch(() => ({ keys: [], artists: {} })));
// Дизлайк = бан в «Моём пульсе»: трек больше не попадётся никогда (пока его не вернут в профиле), а его артист — реже.
export async function dislike(t: Track) {
  const l = await getLess(); const k = key(t);
  l.keys = [k, ...l.keys.filter((x) => x !== k)].slice(0, 400);
  l.tracks = [t, ...(l.tracks || []).filter((x) => key(x) !== k)].slice(0, 400);
  learn('ban', t);
  const a = art(t.artist); l.artists[a] = (l.artists[a] || 0) + 1;
  AsyncStorage.setItem('pulse_less', JSON.stringify(l)).catch(() => {}); banSubs.forEach((f) => f());
}
const banSubs = new Set<() => void>();
export const onBanned = (f: () => void) => { banSubs.add(f); return () => { banSubs.delete(f); }; };
export async function banned(): Promise<Track[]> { const l = await getLess(); return l.tracks || []; }
export const isBannedKey = async (t: Track) => (await getLess()).keys.includes(key(t));
// вернуть трек: снова может попасться, а его артисту возвращается прежний вес
export async function unban(t: Track) {
  const l = await getLess(); const k = key(t);
  l.keys = l.keys.filter((x) => x !== k); l.tracks = (l.tracks || []).filter((x) => key(x) !== k);
  const a = art(t.artist); if (l.artists[a]) { l.artists[a] -= 1; if (l.artists[a] <= 0) delete l.artists[a]; }
  AsyncStorage.setItem('pulse_less', JSON.stringify(l)).catch(() => {}); banSubs.forEach((f) => f());
}

// ---------- Настроение по жанрам (iTunes отдаёт жанр по-английски или по-русски) ----------
const G: Record<Exclude<Mood, 'any'>, string[]> = {
  up: ['hip-hop', 'rap', 'dance', 'electronic', 'rock', 'metal', 'house', 'trap', 'phonk', 'хип-хоп', 'рэп', 'танц', 'электрон', 'рок', 'метал', 'фонк'],
  calm: ['r&b', 'soul', 'singer', 'jazz', 'classical', 'ambient', 'acoustic', 'folk', 'chill', 'new age', 'соул', 'джаз', 'классич', 'фолк', 'эмбиент', 'автор'],
  fun: ['pop', 'dance', 'disco', 'reggae', 'latin', 'funk', 'k-pop', 'поп', 'танц', 'диско', 'регги', 'латин', 'фанк'],
  sad: ['alternative', 'indie', 'r&b', 'singer', 'blues', 'emo', 'soundtrack', 'альтернатив', 'инди', 'блюз', 'саундтрек', 'автор'],
};
const moodScore = (t: Track, m: Mood) => (m === 'any' || !t.genre ? 0 : G[m].some((g) => t.genre!.toLowerCase().includes(g)) ? 1 : -0.5);

// ---------- Вкус: чьи песни вы слушаете ----------
export type Ctx = { stats: any; favs: Track[]; recent: Track[] };
type Seed = { name: string; id?: number; w: number };
// ---------- ИИ-подбор: вкус учится на ваших сигналах ----------
// Маленькая модель прямо на телефоне: у каждого артиста и жанра — вес. Сигналы в «Моём пульсе»:
//  • лайк — артист +3, жанр +1,5;   • дослушали (≥ 85%) — +1 / +0,5;   • пролистнули быстро (< 30%) — −1 / −0,5;
//  • дизлайк (бан) — −3 / −1.
// Веса плавно «забываются» (×0,97 за каждый новый сигнал к остальным — свежие вкусы важнее старых).
// В подборке: артисты с большим весом чаще становятся «семенами» (их песни и похожие на них), а в каждой
// порции треки любимых артистов и жанров поднимаются выше, нелюбимых — опускаются.
type Taste = { a: Record<string, number>; g: Record<string, number>; n: number; nm?: Record<string, string> };
let tasteP: Promise<Taste> | null = null;
export const getTaste = () => tasteP || (tasteP = AsyncStorage.getItem('pulse_taste').then((v) => (v ? JSON.parse(v) : { a: {}, g: {}, n: 0 })).catch(() => ({ a: {}, g: {}, n: 0 })));
const tasteSubs = new Set<() => void>();
export const onTaste = (f: () => void) => { tasteSubs.add(f); return () => { tasteSubs.delete(f); }; };
const gk = (g?: string) => String(g || '').toLowerCase().trim();
export async function learn(kind: 'like' | 'full' | 'skip' | 'ban', t: Track) {
  const tz = await getTaste(); const a = art(t.artist); const g = gk(t.genre);
  const [da, dg] = kind === 'like' ? [3, 1.5] : kind === 'full' ? [1, 0.5] : kind === 'skip' ? [-1, -0.5] : [-3, -1];
  for (const k in tz.a) tz.a[k] *= 0.97; for (const k in tz.g) tz.g[k] *= 0.97;
  if (a) { tz.a[a] = Math.max(-8, Math.min(12, (tz.a[a] || 0) + da)); (tz.nm = tz.nm || {})[a] = api.baseArtist(t.artist); }
  if (g) tz.g[g] = Math.max(-6, Math.min(8, (tz.g[g] || 0) + dg));
  // мелкие веса выкидываем — память не растёт
  for (const k in tz.a) if (Math.abs(tz.a[k]) < 0.05) { delete tz.a[k]; if (tz.nm) delete tz.nm[k]; } for (const k in tz.g) if (Math.abs(tz.g[k]) < 0.05) delete tz.g[k];
  tz.n += 1; AsyncStorage.setItem('pulse_taste', JSON.stringify(tz)).catch(() => {}); tasteSubs.forEach((f) => f());
}
export async function resetTaste() { tasteP = Promise.resolve({ a: {}, g: {}, n: 0 }); await AsyncStorage.removeItem('pulse_taste').catch(() => {}); tasteSubs.forEach((f) => f()); }
// любимые артисты по мнению модели — для подсказок ИИ-ассистенту
export async function topTaste(n = 10) { const tz = await getTaste(); return Object.entries(tz.a).filter(([, w]) => w > 0).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k]) => tz.nm?.[k] || k); }

function seeds(c: Ctx, less: Less, tz?: Taste): Seed[] {
  const m = new Map<string, Seed>();
  const add = (name: string, id: number | undefined, w: number) => {
    const n = api.baseArtist(name); const k = n.toLowerCase().replace(/ё/g, 'е'); if (!k) return;
    const s = m.get(k) || { name: n, id, w: 0 }; s.w += w; if (!s.id && id) s.id = id; m.set(k, s);
  };
  for (const [name, a] of Object.entries<any>(c.stats?.artists || {})) add(name, a.artistId, Math.min(900, a.s || 0));
  c.favs.forEach((t) => add(t.artist, t.artistId, 150));
  c.recent.forEach((t, i) => add(t.artist, t.artistId, Math.max(8, 60 - i * 2)));
  for (const [k, s] of m) s.w /= 1 + 1.5 * (less.artists[k] || 0);
  // вкус из ИИ-подбора: любимые артисты весят больше (до ×2,5), разочаровавшие — меньше (до ×0,2);
  // артист, которого модель полюбила, становится «семенем», даже если его нет в статистике
  if (tz) for (const [k, w] of Object.entries(tz.a) as [string, number][]) { const s = m.get(k); if (s) s.w *= Math.max(0.2, Math.min(2.5, 1 + w * 0.2)); else if (w > 2) m.set(k, { name: tz.nm?.[k] || k, w: 40 * w }); }
  return [...m.values()].sort((a, b) => b.w - a.w);
}

const shuffle = <T,>(a: T[]) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const within = <T,>(p: Promise<T>, ms: number, d: T) => Promise.race([p.catch(() => d), new Promise<T>((r) => setTimeout(() => r(d), ms))]);
// доля знакомого / нового / популярного
const RATIO: Record<Kind, number[]> = { mix: [0.45, 0.4, 0.15], fav: [0.75, 0.15, 0.1], new: [0.12, 0.73, 0.15], pop: [0.2, 0.3, 0.5] };

// теги Last.fm под выбранные фильтры (настроение — тоже: так оно реально меняет подборку, а не только порядок)
const MOOD_TAG: Record<Mood, string[]> = { any: [], up: ['energetic', 'workout'], calm: ['chill', 'relax'], fun: ['happy', 'party'], sad: ['sad', 'melancholy'] };
function filterTags(cfg: Cfg): string[] {
  const y = new Date().getFullYear(); const t: string[] = [];
  const ru = cfg.lang === 'ru';
  if (cfg.words === 'inst') t.push(ru ? 'russian instrumental' : 'instrumental', 'instrumental');
  if (cfg.era === 'new') t.push(...(ru ? ['russian pop', 'russian rap'] : []), String(y), String(y - 1));
  if (cfg.era === 'old') t.push(...(ru ? ['russian rock', 'soviet', 'russian pop'] : ['90s', '80s', '00s']));
  if (cfg.mood !== 'any') t.push(...MOOD_TAG[cfg.mood].map((m) => (ru ? 'russian ' + m : m)), ...MOOD_TAG[cfg.mood]);
  if (ru && !t.length) t.push('russian', 'russian rap', 'russian pop', 'russian rock');
  return [...new Set(t)];
}
async function filterPool(cfg: Cfg): Promise<Track[]> {
  const tags = filterTags(cfg);
  const any = [cfg.lang, cfg.era, cfg.len, cfg.words, cfg.clean].some((x) => x && x !== 'any') || cfg.mood !== 'any';
  if (!any) return [];
  const lists = await Promise.all(tags.slice(0, 4).map((t) => api.tagTracks(t).catch(() => [] as { t: string; a: string }[])));
  // по 3 трека с артиста — чтобы порция была разнообразной; находим в каталоге по 4 параллельно
  const per: Record<string, number> = {};
  const cand = shuffle(lists.flat()).filter((x) => { const k = x.a.toLowerCase(); per[k] = (per[k] || 0) + 1; return per[k] <= 3; }).slice(0, 36);
  const out: Track[] = []; let i = 0;
  const ruT = cfg.lang === 'ru'; const oldT = cfg.era === 'old';
  const work = async () => { while (i < cand.length) { const x = cand[i++]; const t = await api.findTrack(x.t, x.a).catch(() => null); if (t) out.push({ ...t, ...(ruT ? { ru: true } : {}), ...(oldT ? { old: true } : {}) } as Track); } };
  await Promise.all([work(), work(), work(), work()]);
  // чарт тоже годится: в нём свежие треки (новинки) и короткие/длинные
  if (cfg.era === 'new' || cfg.len !== 'any' || cfg.clean === 'clean') out.push(...(await api.chart(cfg.lang === 'world' ? 'us' : 'ru').catch(() => [] as Track[])));
  return out;
}

// последний трек, выданный волной, — с него Яндекс продолжает поток (без повторов)
let waveAfter = '';
export async function batch(c: Ctx, cfg: Cfg, used: Set<string>, n = 12): Promise<Track[]> {
  const less = await getLess(); const ban = new Set(less.keys); const tz = await getTaste();
  // со входом в Яндекс — как на компьютере: «Моя волна» с фильтрами (несколько попыток, если фильтры строгие)
  if (api.YLOCAL && (await api.ymToken())) {
    const out: Track[] = []; const seen = new Set<string>(used);
    for (let a = 0; a < 4 && out.length < n; a++) {
      const w = await within(api.wave(cfg, waveAfter), 12000, [] as Track[]);
      if (!w.length) break;
      waveAfter = String((w[w.length - 1] as any).url || '').replace(/^ym:/, '') || waveAfter;
      for (const t of w) { const k = key(t); if (seen.has(k) || ban.has(k) || !fit(t, cfg)) continue; seen.add(k); out.push(t); }
    }
    if (out.length) return out.slice(0, n);
  }
  const sd = seeds(c, less, tz);
  const top = sd.filter((s) => s.id).slice(0, 5);
  const famP = Promise.all(top.map((s) => api.artist(s.id!).then((r: any) => (r.tracks as Track[]).slice(0, 15)).catch(() => [] as Track[])))
    .then((p) => [...c.favs, ...p.flat()]);
  const disP = (async () => {
    if (!sd.length) return [] as Track[];
    const own = new Set(sd.map((s) => s.name.toLowerCase().replace(/ё/g, 'е')));
    const rel = (await Promise.all(sd.slice(0, 4).map((s) => api.related(s.name)))).flat();
    const names = shuffle(Array.from(new Set(rel.filter((x) => !own.has(art(x)))))).slice(0, 6);
    return (await Promise.all(names.map((x) => api.artistSongs(x)))).flat();
  })();
  const popP = (cfg.lang === 'world' ? api.chart('us') : api.chart('ru')).catch(() => [] as Track[]);
  // Под фильтры — отдельная порция: обычные источники (ваши артисты, похожие, чарт) малы, и при 2–3 фильтрах
  // в них почти ничего не проходило («ничего не нашлось»). Поэтому ищем треки прямо под фильтры:
  // теги Last.fm (язык, годы, настроение, инструментал) → находим каждый в каталоге iTunes.
  const extP = filterPool(cfg);
  // долго не ждём: что не успело за несколько секунд — подтянется в следующей порции
  const [fam, dis, pop, ext] = await Promise.all([within(famP, 5000, c.favs), within(disP, 6000, [] as Track[]), within(popP, 5000, [] as Track[]), within(extP, 8000, [] as Track[])]);

  const seen = new Set<string>(used);
  const prep = (l: Track[], cf: Cfg = cfg) => {
    const out: Track[] = []; const k0 = new Set<string>();
    for (const t of shuffle(l)) { const k = key(t); if (!t.url || seen.has(k) || ban.has(k) || k0.has(k) || !fit(t, cf)) continue; k0.add(k); out.push(t); }
    // порядок: немного случайности + настроение + вкус (артист и жанр из ИИ-подбора)
    const ts = (t: Track) => Math.max(-1, Math.min(1, (tz.a[art(t.artist)] || 0) / 6)) * 0.5 + Math.max(-1, Math.min(1, (tz.g[gk(t.genre)] || 0) / 4)) * 0.3;
    return out.map((t) => [t, Math.random() * 0.6 + moodScore(t, cfg.mood) * 0.8 + ts(t)] as const).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  };
  let pools = [prep(fam), prep(dis), prep(pop), prep(ext)]; const w = [...RATIO[cfg.kind], 0.6];
  // строгие фильтры почти ничего не дали — мягко ослабляем годы и длину (язык, «без мата» и «без слов» — держим)
  if (pools.reduce((a, p) => a + p.length, 0) < 3 && (cfg.era !== 'any' || cfg.len !== 'any')) {
    const soft = { ...cfg, era: 'any' as Era, len: 'any' as Len }; pools = [prep(fam, soft), prep(dis, soft), prep(pop, soft), prep(ext, soft)];
  }
  const out: Track[] = []; let lastA = '';
  while (out.length < n) {
    const live = [0, 1, 2, 3].filter((i) => pools[i].length); if (!live.length) break;
    let r = Math.random() * live.reduce((s, i) => s + w[i], 0); let pi = live[live.length - 1];
    for (const i of live) { r -= w[i]; if (r <= 0) { pi = i; break; } }
    const pool = pools[pi];
    let j = pool.findIndex((t) => art(t.artist) !== lastA); if (j < 0) j = 0;   // один артист — не два раза подряд
    const t = pool.splice(j, 1)[0]; const k = key(t);
    if (seen.has(k)) continue;
    seen.add(k); out.push(t); lastA = art(t.artist);
  }
  return out;
}
// Прогрев: первая порция «Моего пульса» подбирается заранее, в фоне — тогда запуск мгновенный.
// Заодно скачиваются звук и обложка первого трека.
let warmP: { at: number; k: string; p: Promise<Track[]> } | null = null;
const ck = (c: Cfg) => [c.mood, c.kind, c.lang, c.era, c.len, c.words, c.clean].join('|');
const fresh = (cfg: Cfg) => !!warmP && warmP.k === ck(cfg) && Date.now() - warmP.at < 20 * 60e3;
export async function warm(c: Ctx) {
  const cfg = await getCfg(); if (fresh(cfg)) return;
  const p = batch(c, cfg, new Set(), 10).then((l) => {
    if (l[0]) { preload(l[0].url); Image.prefetch(api.hiArt(l[0].cover)).catch(() => {}); }
    if (l[1]) setTimeout(() => preload(l[1].url), 600);
    return l;
  }).catch(() => [] as Track[]);
  warmP = { at: Date.now(), k: ck(cfg), p };
}
export async function start(c: Ctx, n = 10) {
  const cfg = await getCfg();
  if (fresh(cfg)) { const w = warmP!; warmP = null; const l = await w.p; if (l.length) return l; }
  return batch(c, cfg, new Set(), n);
}
export const more = async (c: Ctx, queue: Track[], n = 10, cfg?: Cfg) => batch(c, cfg || (await getCfg()), new Set(queue.map(key)), n);

// ---------- Автопродолжение: похожие треки после альбома, плейлиста или одиночного трека ----------
// Отталкиваемся от того, что только что играло (последние треки очереди, свежие — важнее):
//  • ~30% — другие песни тех же исполнителей (их топ в каталоге);
//  • ~70% — песни похожих исполнителей (Deezer «related» → iTunes).
// Без повторов (что уже было в очереди и недавно играло — не берём), без дизлайкнутого,
// один исполнитель не два раза подряд. Если сеть ничего не дала — популярное (чарт).
export async function similar(seed: Track[], used: Set<string>, n = 10, artistId?: number): Promise<Track[]> {
  const less = await getLess(); const ban = new Set(less.keys);
  // включили со страницы артиста — «дальше» продолжает ЭТОГО артиста: остальные его песни по популярности.
  // Похожие артисты — только когда его песни закончились.
  if (artistId) {
    const own = (await within(api.artistAll(artistId), 6000, [] as Track[])).filter((t) => t.url && !used.has(key(t)) && !ban.has(key(t)));
    const seen = new Set<string>(); const out = own.filter((t) => { const k = key(t); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, n);
    if (out.length) return out;
  }
  const m = new Map<string, { name: string; id?: number; w: number }>();
  seed.slice(-6).forEach((t, i, a) => {
    const name = api.baseArtist(t.artist); const k = art(t.artist); if (!k) return;
    const e = m.get(k) || { name, id: t.artistId, w: 0 }; e.w += 1 + i / a.length; if (!e.id && t.artistId) e.id = t.artistId; m.set(k, e);
  });
  const sd = [...m.values()].sort((a, b) => b.w - a.w); const own = new Set(sd.map((x) => art(x.name)));
  const sameP = Promise.all(sd.filter((x) => x.id).slice(0, 2).map((x) => api.artist(x.id!).then((r: any) => (r.tracks as Track[]).slice(0, 20)).catch(() => [] as Track[]))).then((p) => p.flat());
  const relP = (async () => {
    const rel = (await Promise.all(sd.slice(0, 3).map((x) => api.related(x.name)))).flat();
    const names = shuffle(Array.from(new Set(rel.filter((x) => !own.has(art(x)))))).slice(0, 7);
    return (await Promise.all(names.map((x) => api.artistSongs(x)))).flat();
  })();
  const [same, rel] = await Promise.all([within(sameP, 5000, [] as Track[]), within(relP, 6500, [] as Track[])]);
  const seen = new Set<string>(used);
  const prep = (l: Track[]) => { const out: Track[] = []; const k0 = new Set<string>(); for (const t of shuffle(l)) { const k = key(t); if (!t.url || seen.has(k) || ban.has(k) || k0.has(k)) continue; k0.add(k); out.push(t); } return out; };
  let pools = [prep(same), prep(rel)]; const w = [0.3, 0.7];
  if (!pools[0].length && !pools[1].length) pools = [[], prep(await within(api.chart('ru'), 5000, [] as Track[]))];
  const out: Track[] = []; let lastA = seed.length ? art(seed[seed.length - 1].artist) : '';
  while (out.length < n) {
    const live = [0, 1].filter((i) => pools[i].length); if (!live.length) break;
    let r = Math.random() * live.reduce((x, i) => x + w[i], 0); let pi = live[live.length - 1];
    for (const i of live) { r -= w[i]; if (r <= 0) { pi = i; break; } }
    const pool = pools[pi]; let j = pool.findIndex((t) => art(t.artist) !== lastA); if (j < 0) j = 0;
    const t = pool.splice(j, 1)[0]; const k = key(t); if (seen.has(k)) continue;
    seen.add(k); out.push(t); lastA = art(t.artist);
  }
  return out;
}

// Номер сборки файла. Все файлы папки src должны быть из одной сборки — иначе приложение покажет подсказку, а не ошибку.
export const BUILD = 64;
