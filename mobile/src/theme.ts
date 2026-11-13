// Токены дизайн-системы «Пульс» (project/tokens.json) — светлая и тёмная темы
export const LIGHT = {
  dark: false, tint: 'light' as const,
  bgTop: 'rgba(199,207,229,0.71)', bgBase: '#ffffff', bgGlow: 'rgba(226,49,153,0.10)',
  glass: 'rgba(255,255,255,0.55)', glassStrong: 'rgba(255,255,255,0.72)', stroke: 'rgba(0,0,0,0.08)', line: '#dbdbdb',
  ink: '#202020', ink2: '#464646', ink3: '#6e6e73', muted: '#919191',
  accent: '#e23199', accentText: '#c8237f', accentSoft: '#fbb4e7', onAccent: '#ffffff',
  primary: '#202020', onPrimary: '#ffffff',
  ph: '#e4e4ea', sheet: '#ffffff', shadow: 0.10,
  // матовое стекло: ровное размытие + полупрозрачная заливка, без бликов — фон мягко просвечивает
  matte: 'rgba(255,255,255,0.38)', matteStrong: 'rgba(255,255,255,0.58)', matteStroke: 'rgba(255,255,255,0.55)', blur: 40,
};
export const DARK = {
  dark: true, tint: 'dark' as const,
  bgTop: '#0d0e14', bgBase: '#000000', bgGlow: 'rgba(226,49,153,0.12)',
  glass: 'rgba(255,255,255,0.06)', glassStrong: 'rgba(18,18,22,0.80)', stroke: 'rgba(255,255,255,0.10)', line: '#2a2a30',
  ink: '#f5f5f7', ink2: '#c7c7cc', ink3: '#9a9aa0', muted: '#8e8e93',
  accent: '#ff5cb8', accentText: '#ff5cb8', accentSoft: '#7a1d55', onAccent: '#1a0612',
  primary: '#f5f5f7', onPrimary: '#111114',
  ph: '#18181c', sheet: '#0a0a0d', shadow: 0.5,
  matte: 'rgba(28,28,34,0.40)', matteStrong: 'rgba(22,22,26,0.62)', matteStroke: 'rgba(255,255,255,0.10)', blur: 40,
};
export type Theme = typeof LIGHT | typeof DARK;

// ---------- Цвет оформления (подписка «Импульс») ----------
// Для каждого цвета — вариант для светлой и тёмной темы: акцент, текст акцентом (контраст ≥ 4.5:1 на фоне), мягкий фон.
// По умолчанию — фирменный розовый «Пульса».
type AC = { a: string; t: string; s: string };
export const ACCENTS: { key: string; name: string; light: AC; dark: AC; duo?: string; grad?: { light: string[]; dark: string[] } }[] = [
  { key: 'pink',   name: 'Розовый', light: { a: '#e23199', t: '#c8237f', s: '#fbb4e7' }, dark: { a: '#ff5cb8', t: '#ff5cb8', s: '#7a1d55' } },
  { key: 'violet', name: 'Сирень',  light: { a: '#8b3dff', t: '#7429e0', s: '#dccbff' }, dark: { a: '#b48cff', t: '#b48cff', s: '#3d2470' } },
  { key: 'blue',   name: 'Синий',   light: { a: '#2f6bff', t: '#2156d4', s: '#c8d8ff' }, dark: { a: '#6e9bff', t: '#7ea6ff', s: '#1c3270' } },
  { key: 'teal',   name: 'Бирюза',  light: { a: '#0ea59f', t: '#0a7c78', s: '#b6ece8' }, dark: { a: '#3ad6cf', t: '#3ad6cf', s: '#0f4442' } },
  { key: 'green',  name: 'Изумруд', light: { a: '#16a34a', t: '#11803a', s: '#c3efd2' }, dark: { a: '#4ade80', t: '#4ade80', s: '#12401f' } },
  { key: 'amber',  name: 'Янтарь',  light: { a: '#f08c00', t: '#a95a00', s: '#ffe0b0' }, dark: { a: '#ffb347', t: '#ffb347', s: '#4a3008' } },
  { key: 'red',    name: 'Красный', light: { a: '#e5484d', t: '#c4343a', s: '#ffc9cb' }, dark: { a: '#ff6b6f', t: '#ff7a7e', s: '#4d1416' } },
  { key: 'mono',   name: 'Графит',  light: { a: '#3a3a42', t: '#2a2a30', s: '#dcdce2' }, dark: { a: '#e5e5ea', t: '#e5e5ea', s: '#3a3a42' } },
];
// ---------- Градиенты (три цвета, как в референсе) ----------
// Мягкое радиальное пятно: центр → кольцо → края. Светлая тема — пастель (центр плотнее, края почти фон),
// тёмная — центр светится, края уходят в темноту. Цвет кнопок/текста берётся из близкого одноцветного варианта (base).
// Градиент рисуется в фонах обложек «Любимого», «Недавних», пустых плейлистов, шапке плейлиста и в фоне приложения.
type G3 = [string, string, string];
// ui — три насыщенных цвета того же градиента для кнопок, колец, иконок, полосок (пастель фона там бы не читалась)
const GRADS: { key: string; name: string; base: string; light: G3; dark: G3; ui: G3 }[] = [
  { key: 'g-mist',   name: 'Туман',   base: 'blue',   light: ['#a9adb8', '#cdd9f2', '#e1e1df'], dark: ['#6a78a8', '#2e3756', '#141519'], ui: ['#5f7be6', '#8e9bd0', '#7c8296'] },
  { key: 'g-lilac',  name: 'Сирень',  base: 'violet', light: ['#a99ad6', '#ddd3f6', '#e9e6ef'], dark: ['#7a62c4', '#2f2650', '#131218'], ui: ['#8f5cf0', '#b394e8', '#8a7fae'] },
  { key: 'g-dawn',   name: 'Рассвет', base: 'pink',   light: ['#dba0bd', '#f6d6dc', '#efe8e4'], dark: ['#b0507f', '#4a2236', '#151215'], ui: ['#de4f97', '#ee8fb4', '#b0849a'] },
  { key: 'g-sunset', name: 'Закат',   base: 'red',    light: ['#e09582', '#f6cdb8', '#efe7e3'], dark: ['#b4523f', '#4a2320', '#151112'], ui: ['#e65a3f', '#f39a74', '#b68c80'] },
  { key: 'g-sand',   name: 'Песок',   base: 'amber',  light: ['#d4b48c', '#f2e2c8', '#ebe7e0'], dark: ['#a5753f', '#3c2d1e', '#151311'], ui: ['#d4841f', '#e3b06e', '#a6926f'] },
  { key: 'g-forest', name: 'Лес',     base: 'green',  light: ['#93bf9d', '#d5ecd3', '#e7e9e3'], dark: ['#3f8a55', '#1d3b27', '#121512'], ui: ['#27995a', '#79c38e', '#7f9c88'] },
  { key: 'g-aurora', name: 'Аврора',  base: 'teal',   light: ['#86b9c9', '#cde9e1', '#e9e9f2'], dark: ['#3a8f9e', '#183f41', '#121418'], ui: ['#1597aa', '#62c6b6', '#7d95b8'] },
  { key: 'g-stone',  name: 'Камень',  base: 'mono',   light: ['#8f929b', '#d3d5db', '#e6e6e4'], dark: ['#6a6c76', '#27282d', '#121214'], ui: ['#4f5361', '#8a8f9d', '#aeb1ba'] },
];
for (const g of GRADS) { const p = ACCENTS.find((x) => x.key === g.base)!; ACCENTS.push({ key: g.key, name: g.name, light: p.light, dark: p.dark, grad: { light: g.light, dark: g.dark }, ui: g.ui } as any); }
export const SOLO = ACCENTS.filter((x: any) => !x.duo && !x.grad), DUOS = ACCENTS.filter((x) => x.duo), GRADIENTS = ACCENTS.filter((x: any) => x.grad);
export const gradOf = (key: string, dark: boolean): string[] | null => { const p: any = ACCENTS.find((x) => x.key === key); return p?.grad ? (dark ? p.grad.dark : p.grad.light) : null; };
// второй цвет варианта (для одноцветных — он же)
export const second = (key: string, dark: boolean) => { const p = ACCENTS.find((x) => x.key === key) || ACCENTS[0]; const q = (p.duo && ACCENTS.find((x) => x.key === p.duo)) || p; return dark ? q.dark.a : q.light.a; };
const rgba = (hex: string, al: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${al})`; };
const mix = (hex: string, w: number) => { const n = parseInt(hex.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * w)); return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`; };
// верх фона в оттенке темы: светлая — белый с лёгкой примесью цвета, тёмная — почти чёрный с каплей цвета
function topOf(c: string, dark: boolean) {
  const a = parseInt((dark ? '#0d0e14' : '#ffffff').slice(1), 16), b = parseInt(c.slice(1), 16), k = dark ? 0.1 : 0.22;
  return '#' + [16, 8, 0].map((sh) => Math.round(((a >> sh) & 255) * (1 - k) + ((b >> sh) & 255) * k).toString(16).padStart(2, '0')).join('');
}
// свет для градиентных тем: из самого градиента (см. withAccent)
function lightOf(g: string[], ui: string[], dark: boolean) {
  const bl = (x: string, y: string, k: number) => { const a = parseInt(x.slice(1), 16), b = parseInt(y.slice(1), 16); const c = [16, 8, 0].map((sh) => Math.round(((a >> sh) & 255) * (1 - k) + ((b >> sh) & 255) * k)); return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`; };
  if (dark) return { lightA: bl(g[0], ui[1], 0.3), lightB: bl(g[0], ui[0], 0.4) };
  return { lightA: bl(bl(g[1], g[0], 0.3), ui[1], 0.35), lightB: bl(bl(g[1], g[0], 0.5), ui[2], 0.3) };
}
export function withAccent(base: typeof LIGHT | typeof DARK, key: string) {
  const p = ACCENTS.find((x) => x.key === key) || ACCENTS[0];
  const v = base.dark ? p.dark : p.light;
  const q = (p.duo && ACCENTS.find((x) => x.key === p.duo)) || p; const v2 = base.dark ? q.dark : q.light;
  const ui: string[] | undefined = (p as any).ui ? (p as any).ui.map((c: string) => (base.dark ? mix(c, 0.22) : c)) : undefined;
  if (ui) {
    // градиент: кольца, «пилюли», иконки меню, звезда, полоски и волна переливаются тремя цветами градиента
    return {
      ...base, accentKey: p.key, duo: true, tri: true, grad: base.dark ? (p as any).grad.dark : (p as any).grad.light,
      accent: ui[0], accentText: v.t, accentSoft: rgba(ui[1], base.dark ? 0.35 : 0.3), accent2: ui[1], accent3: ui[2],
      bgGlow: rgba(ui[0], base.dark ? 0.12 : 0.10),
      accentPill: rgba(ui[0], base.dark ? 0.18 : 0.12), accentPill2: rgba(ui[1], base.dark ? 0.18 : 0.12),
      accentPillA: rgba(ui[0], base.dark ? 0.30 : 0.20), accentPillB: rgba(ui[1], base.dark ? 0.32 : 0.24), accentPillC: rgba(ui[2], base.dark ? 0.30 : 0.22),
      accentGlow: mix(ui[1], 0.2), accentCore: mix(ui[0], 0.88), accentMedia: mix(ui[0], 0.15), accentMedia2: mix(ui[2], 0.15),
      // цвет «света сквозь воду» — из того же градиента, что узор обложек «Любимого»/«Недавних» и шапок:
      // светлая тема — центр и кольцо пастели, чуть углублённые к приглушённому цвету темы (чтобы читались на белом);
      // тёмная — светящийся центр градиента. Так свет и узоры одного оттенка, без расхождения.
      ...lightOf(base.dark ? (p as any).grad.dark : (p as any).grad.light, ui, !!base.dark),
      // верх фона — оттенок той же темы (раньше был общий голубоватый для всех цветов — расходился с узорами)
      bgTop: topOf(lightOf(base.dark ? (p as any).grad.dark : (p as any).grad.light, ui, !!base.dark).lightA, !!base.dark),
    };
  }
  return {
    ...base, accentKey: p.key, duo: !!p.duo,
    grad: p.grad ? (base.dark ? p.grad.dark : p.grad.light) : null,   // три цвета градиента (или null)
    accent2: v2.a,                                        // второй цвет (у одноцветных = accent)
    accentPill2: rgba(v2.a, base.dark ? 0.18 : 0.12), accent3: v2.a,
    // пилюля двухцветного варианта — плотнее, чтобы переход был заметен: первый цвет → второй слева направо
    accentPillA: rgba(v.a, base.dark ? 0.30 : 0.20), accentPillB: rgba(v2.a, base.dark ? 0.34 : 0.24),
    accent: v.a, accentText: v.t, accentSoft: v.s,
    bgGlow: rgba(v.a, base.dark ? 0.12 : 0.10),
    accentPill: rgba(v.a, base.dark ? 0.18 : 0.12),     // подложка активной вкладки
    accentGlow: mix(q.dark.a, 0.2),                       // свечение звезды логотипа (у двухцветных — второй цвет)
    accentCore: mix(p.dark.a, 0.88),                      // светлое ядро звезды
    accentMedia: p.dark.a,
    lightA: v.a, lightB: v2.a, bgTop: topOf(v.a, !!base.dark),                            // цвет «света сквозь воду» (у одноцветных — цвет оформления)
    accentMedia2: q.dark.a,                               // второй цвет поверх тёмного                                // акцент поверх тёмного плеера (в обеих темах)
  };
}

// ---------- Чёрная тема ----------
// Отдельно от цветов оформления: только чёрный фон — без «света сквозь воду», свечений и цветных пятен.
// Всё, что раньше было в цвете (кнопки, переключатели, активная вкладка), — тёмно-серое, но читаемое:
// заливка #5c5c61 с белым текстом (контраст 6:1), значки и подписи «акцентом» — светло-серые #d1d1d6.
// Выбранный цвет оформления не теряется: выключили чёрную тему — вернулись прежние цвета.
export function blackOf(t: any) {
  const g = '#5c5c61', pill = 'rgba(255,255,255,0.10)';
  return {
    ...t, dark: true, tint: 'dark' as const, black: true, noLight: true, accentKey: 'black', duo: false, tri: false, grad: null,
    bgTop: '#000000', bgBase: '#000000', bgGlow: 'rgba(0,0,0,0)', sheet: '#0b0b0c', ph: '#161618',
    accent: g, accent2: g, accent3: g, accentText: '#d1d1d6', accentSoft: '#2c2c2e', onAccent: '#ffffff',
    accentPill: pill, accentPill2: pill, accentPillA: pill, accentPillB: pill, accentPillC: pill,
    accentGlow: '#3a3a3c', accentCore: '#e5e5ea', accentMedia: '#d1d1d6', accentMedia2: '#d1d1d6',
    lightA: '#000000', lightB: '#000000',
    matte: 'rgba(22,22,24,0.72)', matteStrong: 'rgba(18,18,20,0.86)',
  };
}

// Номер сборки файла. Все файлы папки src должны быть из одной сборки — иначе приложение покажет подсказку, а не ошибку.
export const BUILD = 64;

// смешать два цвета #rrggbb (k = 0…1) — для плавного перехода между цветами двухцветного варианта
// ---------- Космос (фон «Моего пульса» и квиза) под цвет профиля ----------
// Основа, два пятна туманности и цвет звёзд считаются из выбранного цвета оформления:
// одноцветный — сам цвет + соседний по кругу оттенок (сдвиг ~40°), градиент — его три цвета.
// Светлая тема — пастельная основа почти белая с оттенком цвета, тёмная — глубокая «ночь» того же оттенка.
const toHsl = (hex: string) => {
  const n = parseInt(hex.slice(1), 16); const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = ((h * 60) + 360) % 360;
  return [h, s, l];
};
const fromHsl = (h: number, s: number, l: number) => {
  const f = (n: number) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};
const cosmosCache = new Map<string, any>();
export function cosmosOf(T: any): { base: string[]; g1: string; g2: string; dot: string; a1: number; a2: number } {
  // чёрная тема: космос — просто чёрный, без цветных туманностей; звёзды — тусклые серые
  if (T.black) return { base: ['#000000', '#000000', '#000000'], g1: '#000000', g2: '#000000', dot: '#8e8e93', a1: 0, a2: 0 };
  const key = (T.accentKey || '') + (T.dark ? 'd' : 'l'); const hit = cosmosCache.get(key); if (hit) return hit;
  const dk = !!T.dark; const [h, s] = toHsl(T.accent); const sat = Math.max(0.35, Math.min(0.85, s));
  let g1 = T.accent, g2 = T.tri ? T.accent2 : T.duo ? T.accent2 : fromHsl((h + 320) % 360, sat, dk ? 0.6 : 0.55);
  // графит и прочие почти бесцветные — спокойный серо-сиреневый космос
  const mono = s < 0.15; if (mono) { g1 = dk ? '#8a8aa0' : '#9a9ab0'; g2 = dk ? '#6a6a88' : '#b8b8cc'; }
  const bh = mono ? 250 : h, bs = mono ? 0.12 : Math.min(0.7, sat);
  const base = dk ? [fromHsl(bh, bs * 0.75, 0.24), fromHsl(bh, bs * 0.7, 0.09), '#07050d'] : [ '#ffffff', fromHsl(bh, bs, 0.965), fromHsl(bh, bs * 0.9, 0.915)];
  const r = { base, g1, g2, dot: dk ? '#ffffff' : fromHsl((h + 345) % 360, mono ? 0.15 : 0.7, mono ? 0.55 : 0.55), a1: dk ? 0.6 : 0.4, a2: dk ? 0.5 : 0.3 };
  if (cosmosCache.size > 40) cosmosCache.clear(); cosmosCache.set(key, r); return r;
}
// три цвета: k = 0 → a, 0,5 → b, 1 → c
export const blend3 = (a: string, b: string, c: string, k: number) => (k <= 0.5 ? blendHex(a, b, k * 2) : blendHex(b, c, (k - 0.5) * 2));
export const blendHex = (a: string, b: string, k: number) => {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const c = [16, 8, 0].map((sh) => Math.round(((x >> sh) & 255) * (1 - k) + ((y >> sh) & 255) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};
