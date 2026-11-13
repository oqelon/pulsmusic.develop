// ИИ-диджей «Пульса»: пишете запрос обычными словами («для пробежки», «как Земфира, но новее», «один трек на утро») —
// языковая модель (уровня ChatGPT) отвечает списком песен, а приложение находит каждую в каталоге и даёт послушать.
//
// Откуда берётся модель — по умолчанию БЕЗ ключей и бесплатно:
//  1) бесплатные ИИ-сервисы без ключа по очереди: Kilo AI Gateway → OVHcloud AI Endpoints → Pollinations;
//  2) если ни один не ответил — встроенный диджей: понимает запрос по словам («пробежка», «дождь», «как Кино»,
//     «2000-х», «русский рок») и собирает треки по тегам Last.fm, похожим артистам Deezer и поиску iTunes.
// Свой ключ (по желанию, в «настроить»): sk-… ChatGPT (OpenAI), gsk_… Groq, sk-or-… OpenRouter, AIza… Gemini.
// Ключ хранится только на телефоне (AsyncStorage), в коде его нет.
import AsyncStorage from '@react-native-async-storage/async-storage';

// Встроенный ключ — один на всё приложение, пользователям ничего вводить не надо.
// Берётся из файла ~/puls/.env при сборке (его пишет скрипт ai-key.sh). В папке src ключа НЕТ:
// update.sh заменяет src целиком, а .env лежит рядом и не трогается; в GitHub .env не попадает (.gitignore).
//   EXPO_PUBLIC_AI_PROXY   — адрес своего прокси (Cloudflare Worker, файл worker/pulse-ai.js) — рекомендуется:
//                            ключ хранится на сервере, из приложения его не достать, и работает из России;
//   EXPO_PUBLIC_OPENAI_KEY — сам ключ OpenAI в приложении (просто, но ключ можно извлечь из сборки,
//                            а из России OpenAI напрямую отвечает отказом).
declare const process: any;
const BUILT_PROXY = String(process.env.EXPO_PUBLIC_AI_PROXY || '').trim();
const BUILT_KEY = String(process.env.EXPO_PUBLIC_OPENAI_KEY || '').trim();
export const builtIn = () => (BUILT_PROXY ? 'proxy' : BUILT_KEY ? 'key' : '');
import * as api from './api';
import type { Track } from './api';

export const BUILD = 64;

// ---------- открыть экран ИИ из любого места (вкладка «Пульс», поиск, профиль) ----------
const subs = new Set<(q?: string) => void>();
export const onOpenAi = (f: (q?: string) => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const openAi = (q?: string) => subs.forEach((f) => f(q));

// ---------- ключ ----------
let keyP: Promise<string> | null = null;
export const getKey = () => keyP || (keyP = AsyncStorage.getItem('pulse_ai_key').then((v) => v || '').catch(() => ''));
const keySubs = new Set<() => void>();
export const onKey = (f: () => void) => { keySubs.add(f); return () => { keySubs.delete(f); }; };
export async function setKey(k: string) {
  const v = k.trim(); keyP = Promise.resolve(v);
  if (v) await AsyncStorage.setItem('pulse_ai_key', v).catch(() => {}); else await AsyncStorage.removeItem('pulse_ai_key').catch(() => {});
  keySubs.forEach((f) => f());
}

type Prov = { name: string; url: string; model: string; alt?: string[]; extra?: any; auth: boolean };
export function providerOf(key: string): Prov {
  if (key.startsWith('gsk_')) return { name: 'Groq · gpt-oss-120b', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b', alt: ['llama-3.3-70b-versatile'], extra: { reasoning_effort: 'low' }, auth: true };
  if (key.startsWith('sk-or-')) return { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openai/gpt-oss-120b:free', alt: ['openai/gpt-oss-20b:free', 'deepseek/deepseek-chat-v3.1:free', 'meta-llama/llama-3.3-70b-instruct:free'], auth: true };
  if (key.startsWith('AIza')) return { name: 'Gemini 2.5 Flash', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash', auth: true };
  // ChatGPT: ответ строго в JSON (response_format) — список песен всегда разбирается без ошибок
  if (key.startsWith('sk-')) return { name: 'ChatGPT · gpt-4o-mini', url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', alt: ['gpt-4.1-mini'], extra: { response_format: { type: 'json_object' } }, auth: true };
  return FREE[0];
}
// Бесплатные ИИ без ключей (проверены на 10.2026; бесплатные тарифы меняются — поэтому их несколько, по очереди):
//  • Kilo AI Gateway — бесплатные модели без авторизации, ~200 запросов в час с одного адреса;
//  • OVHcloud AI Endpoints (Франция) — открытые модели без ключа, ~2 запроса в минуту;
//  • Pollinations — на случай, если снова откроют анонимный доступ.
// Какой сервис ответил последним — запоминаем и в следующий раз спрашиваем его первым (быстрее).
const FREE: Prov[] = [
  { name: 'Kilo · бесплатный ИИ', url: 'https://api.kilo.ai/api/gateway/chat/completions', model: 'kilo-auto/free', alt: ['nvidia/nemotron-3-super-120b-a12b:free', 'openrouter/free'], auth: false },
  { name: 'OVHcloud · gpt-oss', url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions', model: 'gpt-oss-20b', alt: ['Mistral-Nemo-Instruct-2407'], auth: false },
  { name: 'Pollinations', url: 'https://text.pollinations.ai/openai?referrer=pulse-music', model: 'openai', auth: false },
];
let freeFirst = 0;
let builtErr = '';   // почему не ответил встроенный ChatGPT — показываем мелко под ответом (для проверки)

// ---------- разговор ----------
export type Msg = { role: 'user' | 'assistant'; text: string; title?: string; tracks?: Track[]; miss?: number; err?: boolean; src?: string };
export type Taste = { artists: string[]; liked: string[] };

const SYS = (tz: Taste) => `Ты — музыкальный ИИ-диджей приложения «Пульс». Пользователь пишет запрос по-русски (настроение, занятие, жанр, похожие артисты, эпоха).
Подбери настоящие, существующие песни, которые есть в Apple Music. Никогда не выдумывай песни.
Если просят один трек или «что послушать» — дай 1–3 трека. Если просят плейлист, подборку или занятие на время — 15–20 треков.
Не повторяй одного артиста больше 2 раз, если об этом не просили. Учитывай вкус пользователя, но не ограничивайся им.
${tz.artists.length ? `Любимые артисты пользователя: ${tz.artists.slice(0, 12).join(', ')}.` : ''}
${tz.liked.length ? `Недавно лайкнул: ${tz.liked.slice(0, 10).join('; ')}.` : ''}
Отвечай ТОЛЬКО JSON без markdown:
{"reply":"одна-две короткие фразы по-русски, тёплым тоном","title":"короткое название плейлиста","tracks":[{"t":"название песни","a":"исполнитель"}]}`;

// один запрос к одному сервису и модели. Ошибки помечены: retry — можно пробовать следующую модель/сервис
async function chat1(p: Prov, key: string, model: string, messages: any[], first: boolean): Promise<string> {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), p.auth ? 45000 : 18000);
  const err = (m: string, retry = true) => { const e: any = new Error(m); e.retry = retry; return e; };
  try {
    const r = await fetch(p.url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...(p.auth ? { Authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ model, messages, temperature: 0.8, stream: false, ...(first || p.url.includes('openai.com') ? p.extra || {} : {}) }),
    });
    if (r.status === 401) throw err(p.auth ? 'Ключ не подошёл — проверьте его в настройках ИИ' : 'auth', !p.auth);
    if (r.status === 403) throw err(p.auth ? 'Сервис отказал в доступе: ключ неверный или сервис не работает в вашей стране' : 'forbidden', !p.auth);
    if (r.status === 429) {
      const t = await r.text().catch(() => '');
      if (/insufficient_quota|billing|quota/i.test(t)) throw err('На аккаунте нет баланса: API ChatGPT платный (отдельно от подписки ChatGPT Plus). Пополните баланс на platform.openai.com → Billing', false);
      throw err('Слишком много запросов — подождите минуту и попробуйте снова');
    }
    if (!r.ok) throw err(`Сервис ИИ ответил ошибкой ${r.status}`);
    const d = await r.json();
    const s = d?.choices?.[0]?.message?.content;
    if (!s) throw err('ИИ вернул пустой ответ');
    return String(s);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw err('ИИ слишком долго думает — попробуйте ещё раз');
    if (e?.retry === undefined) throw err(e?.message || 'Нет связи с ИИ');   // сеть: пробуем следующий
    throw e;
  } finally { clearTimeout(tm); }
}
// со своим ключом — его сервис (и запасные модели); без ключа — бесплатные сервисы по очереди.
// Ответ засчитывается, только если в нём есть список песен — иначе спрашиваем следующего.
async function chat(messages: any[]): Promise<{ res: ReturnType<typeof parse>; src: string }> {
  const own = await getKey(); builtErr = '';
  // свой ключ пользователя (если ввёл) → встроенный ChatGPT приложения (прокси или ключ) → бесплатные ИИ
  let p0: Prov | null = null; let key = own;
  if (own) p0 = providerOf(own);
  else if (BUILT_PROXY) p0 = { name: 'ChatGPT', url: BUILT_PROXY, model: 'gpt-4o-mini', alt: [], extra: { response_format: { type: 'json_object' } }, auth: false };
  else if (BUILT_KEY) { key = BUILT_KEY; p0 = providerOf(BUILT_KEY); p0 = { ...p0, name: 'ChatGPT' }; }
  if (p0 && !own) {
    // встроенный ChatGPT не ответил (сеть, лимит) — не показываем ошибку, а идём к бесплатным
    try { return { res: parse(await chat1({ ...p0, auth: !!key && !BUILT_PROXY }, BUILT_PROXY ? '' : key, p0.model, messages, true)), src: p0.name }; } catch (e: any) { builtErr = String(e?.message || 'нет ответа'); }
  }
  if (own) {
    const p = p0!;
    const models = [p.model, ...(p.alt || [])];
    for (let i = 0; ; i++) {
      try { return { res: parse(await chat1(p, key, models[i], messages, i === 0)), src: p.name }; }
      catch (e: any) { if (!(e?.retry && i < models.length - 1)) throw e; }
    }
  }
  const order = [...FREE.slice(freeFirst), ...FREE.slice(0, freeFirst)];
  for (const p of order) {
    for (const [i, m] of [p.model, ...(p.alt || [])].entries()) {
      try {
        const res = parse(await chat1(p, '', m, messages, i === 0));
        if (res.tracks && res.tracks.length) { freeFirst = FREE.indexOf(p); return { res, src: p.name + (builtErr ? ` · ChatGPT не ответил: ${builtErr}` : '') }; }
      } catch (e: any) { if (/429|много запросов/.test(e?.message || '')) break; }   // лимит у сервиса — сразу к следующему
    }
  }
  throw new Error('NOKEY');
}

// из ответа достаём JSON, даже если модель обернула его в текст или ```json
function parse(s0: string): { reply?: string; title?: string; tracks?: { t: string; a: string }[] } {
  const s = s0.replace(/<think>[\s\S]*?<\/think>/g, '');   // «размышления» моделей-рассуждалок не нужны
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return { reply: s.trim().slice(0, 400) };
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return { reply: s.replace(/```[a-z]*|```/g, '').trim().slice(0, 400) }; }
}

// по названию и исполнителю находим трек в каталоге (по 3 параллельно — быстро и без перегруза сети)
async function resolve(list: { t: string; a: string }[], onOne: (done: Track[]) => void) {
  const out: (Track | null)[] = new Array(list.length).fill(null); let i = 0;
  const work = async () => {
    while (i < list.length) {
      const k = i++; const x = list[k];
      out[k] = await api.findTrack(String(x.t || ''), String(x.a || '')).catch(() => null);
      onOne(out.filter(Boolean) as Track[]);
    }
  };
  await Promise.all([work(), work(), work()]);
  const seen = new Set<string>();
  return (out.filter(Boolean) as Track[]).filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
}

// главный вызов: история (для уточнений «ещё», «повеселее») + новый запрос → ответ с треками.
// onPart — треки появляются по мере того, как находятся
export async function ask(history: Msg[], q: string, tz: Taste, onPart?: (m: Msg) => void): Promise<Msg> {
  const msgs: any[] = [{ role: 'system', content: SYS(tz) }];
  for (const m of history.slice(-6)) {
    if (m.err) continue;
    msgs.push(m.role === 'user' ? { role: 'user', content: m.text }
      : { role: 'assistant', content: JSON.stringify({ reply: m.text, title: m.title, tracks: (m.tracks || []).map((t) => ({ t: t.title, a: t.artist })) }) });
  }
  msgs.push({ role: 'user', content: q });
  let res: ReturnType<typeof parse>; let src = '';
  try { const r = await chat(msgs); res = r.res; src = r.src; }
  catch (e: any) {
    // ни один бесплатный ИИ не ответил — собирает встроенный диджей (только каталоги музыки, работает всегда)
    if (e?.message !== 'NOKEY') throw e;
    res = await localDj(q, tz, history); src = 'Встроенный диджей' + (builtErr ? ` · ChatGPT не ответил: ${builtErr}` : '');
  }
  const want = (res.tracks || []).filter((x) => x && x.t).slice(0, 24);
  const base: Msg = { role: 'assistant', src, text: res.reply || (want.length ? 'Вот что я подобрал' : 'Не получилось подобрать — попробуйте описать иначе'), title: res.title };
  if (!want.length) return base;
  onPart?.({ ...base, tracks: [] });
  const tracks = await resolve(want, (d) => onPart?.({ ...base, tracks: d }));
  return { ...base, tracks, miss: want.length - tracks.length };
}

// ---------- встроенный диджей (запасной, без ИИ) ----------
// Понимает запрос по словам: занятие и настроение → теги Last.fm; «как X», «в стиле X», «похожее на X» → похожие
// артисты; годы и язык → теги эпохи и страны. Треки берутся из топов тегов и песен похожих артистов.
const TAGS: [RegExp, string, string][] = [
  [/бег|пробеж|трениров|спорт|зал|кардио|качал/, 'workout', 'Энергия для тренировки'],
  [/дожд|осен|грус|печал|тоск|плак/, 'sad', 'Под дождь и мысли'],
  [/спокой|чил|расслаб|вечер|уют|lofi|лоу.?фай/, 'chill', 'Спокойный вечер'],
  [/сон|засып|усну|ночь|ночн/, 'night', 'Для ночи'],
  [/работ|учеб|учит|фокус|сосредоточ|концентр/, 'study', 'Для работы и учёбы'],
  [/вечерин|туса|танц|клуб|пати/, 'party', 'На вечеринку'],
  [/лет|море|пляж|солн|отпуск/, 'summer', 'Летний вайб'],
  [/дорог|машин|поездк|трасс|ехать/, 'road trip', 'В дорогу'],
  [/любов|романт|свидан/, 'romantic', 'Про любовь'],
  [/утр|бодр|проснут|весел|радост|позитив/, 'happy', 'Бодрое утро'],
  [/русск.{0,3}рок|рок.{0,6}русск/, 'russian rock', 'Русский рок'],
  [/рэп|реп|хип.?хоп/, 'hip-hop', 'Хип-хоп'],
  [/рок/, 'rock', 'Рок'],
  [/джаз/, 'jazz', 'Джаз'],
  [/электрон|техно|хаус/, 'electronic', 'Электроника'],
  [/инди/, 'indie', 'Инди'],
  [/поп/, 'pop', 'Поп'],
  [/металл|метал/, 'metal', 'Метал'],
  [/класси/, 'classical', 'Классика'],
  [/громк|агресс|жестк|жёстк/, 'hard rock', 'Погромче'],
];
const ERAS: [RegExp, string][] = [[/2020|20-х|двадцат/, '2020s'], [/2010|10-х|десят/, '2010s'], [/2000|нулев|00-х/, '00s'], [/90|девяност/, '90s'], [/80|восьмидес/, '80s'], [/70|семидес/, '70s']];
const pick = <T,>(a: T[], n: number) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b.slice(0, n); };
async function localDj(q: string, tz: Taste, history: Msg[]): Promise<{ reply?: string; title?: string; tracks?: { t: string; a: string }[] }> {
  const s = q.toLowerCase().replace(/ё/g, 'е');
  const one = /(^|\s)(один|одну)(\s|$)|какой.?нибудь трек|что послушать/.test(s);   // \b не работает с кириллицей
  const n = one ? 3 : 18;
  // «ещё» — повторяем прошлый запрос
  const prevQ = [...history].reverse().find((m) => m.role === 'user')?.text;
  if (/^(давай )?(еще|больше)([\s!.,]|$)/.test(s) && prevQ) return localDj(prevQ, tz, []);
  const like = /(?:(?:^|\s)как|в стиле|похож[а-яё]* на|типа|вроде)\s+([^,.!?]+)/i.exec(q)?.[1]?.replace(/\s+(но|и|только)\s.*$/i, '').trim();
  const tags = TAGS.filter(([r]) => r.test(s)); const era = ERAS.find(([r]) => r.test(s))?.[1]; const ru = /русск|наш|отечеств/.test(s) && !tags.some(([, t]) => t === 'russian rock');
  const out: { t: string; a: string }[] = [];
  if (like) {
    const names = like === 'мой любимый' || /любим/.test(like) ? tz.artists : [like];
    const rel = (await Promise.all(names.slice(0, 3).map((x) => api.related(x).catch(() => [] as string[])))).flat();
    const pool = pick([...new Set(rel)], 8);
    const songs = await Promise.all(pool.map((a) => api.artistSongs(a).catch(() => [] as Track[])));
    for (const l of songs) for (const t of pick(l, 3)) out.push({ t: t.title, a: t.artist });
  }
  const tagList = [...tags.map(([, t]) => t), ...(era ? [era] : []), ...(ru ? ['russian'] : [])];
  if (!tagList.length && !like) tagList.push(...(tz.artists.length ? [] : ['indie']));
  for (const t of tagList.slice(0, 3)) out.push(...pick(await api.tagTracks(t).catch(() => []), 12));
  if (!out.length && tz.artists.length) {   // ничего не поняли — подборка по вкусу
    const rel = (await Promise.all(tz.artists.slice(0, 3).map((x) => api.related(x).catch(() => [] as string[])))).flat();
    const songs = await Promise.all(pick([...new Set(rel)], 8).map((a) => api.artistSongs(a).catch(() => [] as Track[])));
    for (const l of songs) for (const t of pick(l, 2)) out.push({ t: t.title, a: t.artist });
  }
  if (!out.length) {   // совсем ничего — ищем слова запроса прямо в каталоге (так находится хоть что-то всегда)
    const r = await api.searchCached(q).catch(() => null);
    for (const t of (r?.tracks || []).slice(0, 20)) out.push({ t: t.title, a: t.artist });
  }
  const seen = new Set<string>(); const per: Record<string, number> = {};
  const list = pick(out, out.length).filter((x) => { const k = (x.t + '|' + x.a).toLowerCase(); const a = x.a.toLowerCase(); if (seen.has(k) || (per[a] || 0) >= 2) return false; seen.add(k); per[a] = (per[a] || 0) + 1; return true; }).slice(0, n);
  const title = like ? `Похоже на ${like}` : tags[0]?.[2] || (era ? `Хиты ${era.replace('s', '-х')}` : 'Подборка для вас');
  return list.length
    ? { reply: one ? 'Вот что включить прямо сейчас.' : `Собрал подборку «${title}».`, title, tracks: list }
    : { reply: 'Не понял запрос — попробуйте назвать настроение, занятие, жанр или артиста («как Кино», «для пробежки»).' };
}

export const SUGGEST = ['Для пробежки', 'Дождливый вечер', 'Один трек на утро', 'Как в моём «Любимом», но новое', 'Русский рок 2000-х', 'Сосредоточиться на работе', 'Летний вайб у моря', 'Самое громкое на тренировку'];
