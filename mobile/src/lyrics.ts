// Текст песни — как в версии для Windows: живой текст Яндекса (LRC, нужен вход) → живой из LRCLIB →
// обычный текст. Расширенный LRC (<mm:ss.xx> у слов) даёт время каждого слова. Если времени слов нет —
// берём его из общей базы ИИ-разметки (её наполняют компьютеры с «Пульсом», телефон только читает).
import { ymToken } from './api';
import { utf8, sha256, hex, hmacSha256, base64 } from './sha';

const BASE = 'https://api.music.yandex.net';
const LYR_KEY = 'p93jhgh689SBReK6ghtw62';   // ключ подписи запроса текста (как в yandex_music/utils/sign_request.py)
const HEAD: Record<string, string> = { 'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621', 'Accept-Language': 'ru' };
const ALIGN = 'https://pulse-online.pulsmusic.workers.dev';

export type W = { t: number };
export type Line = { t: number; text: string; w?: W[]; e?: number };
export type Lyrics = { synced: boolean; words?: boolean; ai?: boolean; lines: Line[]; writers?: string; source: string } | { none: true; instrumental?: boolean };

async function get(url: string, opt: { tok?: string; text?: boolean; ms?: number; ua?: string } = {}): Promise<any> {
  const c = new AbortController(); const tm = setTimeout(() => c.abort(), opt.ms || 10000);
  try {
    const h: Record<string, string> = url.startsWith(BASE) ? { ...HEAD } : {};
    if (opt.tok && url.startsWith(BASE)) h.Authorization = 'OAuth ' + opt.tok;
    if (opt.ua) h['User-Agent'] = opt.ua;
    const r = await fetch(url, { headers: h, signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (opt.text) return r.text();
    const d = await r.json(); return url.startsWith(BASE) ? d.result : d;
  } finally { clearTimeout(tm); }
}

const ts2s = (m: string, s: string) => +m * 60 + parseFloat(String(s).replace(':', '.'));
export function parseLrc(text: string): Line[] | null {
  if (!text || !/\[\d+:\d+/.test(text)) return null;
  const lines: Line[] = [];
  for (const ln of String(text).split(/\r?\n/)) {
    const tags: RegExpExecArray[] = []; const re = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g; let mm: RegExpExecArray | null; while ((mm = re.exec(ln))) tags.push(mm); if (!tags.length) continue;
    const body = ln.replace(/\[[^\]]*\]/g, '');
    let w: W[] | null = null, e = 0, plain = body;
    if (/<\d+:\d+(?:[.:]\d+)?>/.test(body)) {
      w = []; plain = ''; let at: number | null = null;
      for (const part of body.split(/(<\d+:\d+(?:[.:]\d+)?>)/)) {
        const m = part.match(/^<(\d+):(\d+(?:[.:]\d+)?)>$/);
        if (m) { at = ts2s(m[1], m[2]); e = at; continue; }
        const word = part.replace(/\s+/g, ' ').trim(); if (!word) continue;
        for (const _ of word.split(' ')) if (at != null) w.push({ t: at });
        plain += (plain ? ' ' : '') + word;
      }
      if (!w.length) w = null;
    }
    const t = plain.trim();
    for (const m of tags) lines.push(w ? { t: ts2s(m[1], m[2]), text: t, w, e } : { t: ts2s(m[1], m[2]), text: t });
  }
  lines.sort((a, b) => a.t - b.t);
  return lines.length ? lines : null;
}

const bare = (s: string) => String(s || '').replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/\s+/g, ' ').trim();
const qs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
async function lrclib(title: string, artist: string, dur?: number) {
  const ua = 'Pulse (alpha; Android music player)';
  const q = (o: Record<string, string>) => get('https://lrclib.net/api/search?' + qs(o), { ua });
  let list: any[] = await q({ track_name: title, artist_name: artist });
  if (!list.length && bare(title) !== title) list = await q({ track_name: bare(title), artist_name: artist });
  if (!list.length) list = await q({ q: bare(title) + ' ' + artist });
  if (!list.length) return null;
  const d = (x: any) => (dur ? Math.abs((x.duration || 0) - dur) : 0);
  const ok = list.filter((x) => !dur || d(x) <= 4); const pool = ok.length ? ok : list;
  pool.sort((a, b) => (Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics)) || (d(a) - d(b)));
  return pool[0];
}
async function yandex(id: string, format: 'LRC' | 'TEXT') {
  const tok = await ymToken(); if (!tok || !id) return null;
  const ts = Math.floor(Date.now() / 1000);
  const sign = base64(hmacSha256(LYR_KEY, id + ts));
  const r = await get(`${BASE}/tracks/${id}/lyrics?format=${format}&timeStamp=${ts}&sign=${encodeURIComponent(sign)}`, { tok });
  if (!r || !r.downloadUrl) return null;
  const text = await get(r.downloadUrl, { text: true });
  return { text: String(text), writers: (r.writers || []).join(', ') };
}

// общая база ИИ-разметки (Cloudflare): тот же отпечаток текста, что и на компьютере
// «v3\n» — новая база разметки (с версии ПК 0.14.6): старые разметки не используются
const fingerprint = (lines: Line[]) => hex(sha256(utf8('v3\n' + lines.map((l) => String(l.text || '').trim().toLowerCase()).join('\n')))).slice(0, 16);
async function aiTimes(id: string, lines: Line[]): Promise<[number, number[]][] | null> {
  try { const r = await get(`${ALIGN}/align?id=${encodeURIComponent(id)}&h=${fingerprint(lines)}`, { ms: 7000 }); return r && r.ok && r.v && Array.isArray(r.v.lines) ? r.v.lines : null; } catch { return null; }
}
const VOW = /[аеёиоуыэюяaeiouyäöüéèáíóú]/gi;
export const syl = (w: string) => Math.max(1, (String(w).match(VOW) || []).length);
function withAi(lines: Line[], ai: [number, number[]][]): Line[] | null {
  const m = new Map(ai); let used = 0;
  const out = lines.map((l, i) => {
    const ts = m.get(i); if (!ts || !l.text) return l;
    const raw = l.text.split(/\s+/).filter(Boolean); const real = raw.filter((r) => r.replace(/[()[\]]/g, ''));
    if (real.length !== ts.length) return l;
    let k = 0; const w = raw.map((r) => ({ t: r.replace(/[()[\]]/g, '') ? ts[k++] : ts[Math.max(0, k - 1)] }));
    const next = lines[i + 1]; const last = ts[ts.length - 1];
    const e = Math.max(last + 0.15, Math.min(next ? next.t - 0.08 : last + 1.6, last + 0.3 + 0.22 * syl(real[real.length - 1])));
    used++; return { ...l, w, e };
  });
  return used ? out : null;
}

const cache = new Map<string, Lyrics>();
// t — трек приложения: url «ym:<id>» у треков Яндекса
export async function getLyrics(t: { url?: string; title: string; artist: string; dur?: number }): Promise<Lyrics> {
  const id = String(t.url || '').startsWith('ym:') ? String(t.url).slice(3) : '';
  const key = id || (t.title + '|' + t.artist);
  const hit = cache.get(key); if (hit) return hit;
  const [yL, lib] = await Promise.all([yandex(id, 'LRC').catch(() => null), lrclib(t.title, (t.artist || '').split(',')[0].trim(), t.dur).catch(() => null)]);
  const y = yL && parseLrc(yL.text); const l = lib && lib.syncedLyrics ? parseLrc(lib.syncedLyrics) : null;
  const hasW = (x: Line[] | null) => !!(x && x.some((ln) => ln.w));
  let res: Lyrics;
  if (hasW(l) && !hasW(y)) res = { synced: true, words: true, lines: l!, writers: (yL && yL.writers) || '', source: 'LRCLIB (по словам)' };
  else if (y) res = { synced: true, words: hasW(y), lines: y, writers: yL!.writers, source: 'Яндекс Музыка' };
  else if (l) res = { synced: true, words: false, lines: l, writers: '', source: 'LRCLIB' };
  else if (lib && lib.instrumental) res = { none: true, instrumental: true };
  else {
    const yT = await yandex(id, 'TEXT').catch(() => null);
    const plain = (yT && yT.text.trim() && yT) || (lib && lib.plainLyrics ? { text: String(lib.plainLyrics), writers: '' } : null);
    res = plain ? { synced: false, lines: plain.text.split(/\r?\n/).map((x) => ({ t: -1, text: x.trim() })), writers: plain.writers, source: plain === yT ? 'Яндекс Музыка' : 'LRCLIB' } : { none: true };
  }
  // времени слов нет — смотрим общую базу ИИ (строки берём только у трека Яндекса: номер — общий с компьютером)
  if ('lines' in res && res.synced && !res.words && id) {
    const ai = await aiTimes(id, res.lines); const lines = ai && withAi(res.lines, ai);
    if (lines) res = { ...res, lines, words: true, ai: true };
  }
  cache.set(key, res); if (cache.size > 60) cache.delete(cache.keys().next().value as string);
  return res;
}

// ---------- время слов строки — как на компьютере ----------
export const wordMax = (w: string) => Math.min(1.8, Math.max(0.35, 0.22 + 0.3 * syl(w)));
export function adFlags(words: string[]) {
  let depth = 0;
  return words.map((raw) => { const o = (raw.match(/[([]/g) || []).length, c = (raw.match(/[)\]]/g) || []).length; const ad = depth > 0 || o > 0; depth = Math.max(0, depth + o - c); return ad; });
}
// → [{ a, b }] для каждого слова (по пробелам): когда слово начинает и заканчивает светиться
export function wordTimes(ln: Line, next?: Line): { a: number; b: number }[] {
  const words = String(ln.text || '').split(/\s+/).filter(Boolean); const ad = adFlags(words);
  const lineEnd = next ? next.t - 0.1 : ln.t + 30;
  if (ln.w && ln.w.length === words.length) {
    const lastOf = (kind: boolean) => { for (let j = words.length - 1; j >= 0; j--) if (ad[j] === kind) return j; return -1; };
    const lastMain = lastOf(false), lastAd = lastOf(true);
    return ln.w.map((w, i) => {
      const cap = w.t + wordMax(words[i] || '');
      let nx = -1; for (let j = i + 1; j < ln.w!.length; j++) if (ad[j] === ad[i]) { nx = j; break; }
      if (nx >= 0) return { a: w.t, b: Math.max(w.t + 0.08, Math.min(ln.w![nx].t, cap)) };
      const isLast = i === (ad[i] ? lastAd : lastMain);
      const end = isLast && !ad[i] && ln.e && ln.e > w.t ? Math.min(ln.e, lineEnd) : Math.min(lineEnd, cap);
      return { a: w.t, b: Math.max(w.t + 0.12, end) };
    });
  }
  const n = words.map(syl); const total = n.reduce((x, y) => x + y, 0) || 1;
  const start = ln.t + 0.12; const gap = next ? Math.max(0.5, next.t - start) : total * 0.3 + 1;
  const dur = Math.max(0.5, Math.min(gap * 0.9, (total * 0.27 + 0.3) * 1.2));
  let at = start; return n.map((k) => { const d = (dur * k) / total; const o = { a: at, b: at + d }; at += d; return o; });
}
