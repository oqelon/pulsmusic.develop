// ИИ-разметка живого текста: когда звучит каждое слово.
//
// Работает в скрытом окне «Пульса» (или на тестовой странице в CI). На вход — звук трека и строки текста с временем
// начала (обычный LRC). ИИ (Whisper base, лицензия MIT, работает прямо на компьютере через WebAssembly, один поток)
// «слушает» трек короткими кусками (до 12 с) по границам строк, основной текст и эдлибы — отдельно; начало каждого
// слова сверяется с настоящим вступлением голоса в звуке. Наружу уходит только время слов.
import { pipeline, env } from '@huggingface/transformers';

env.allowRemoteModels = false;                     // ничего не скачивается из интернета — модель лежит рядом
env.allowLocalModels = true;
env.localModelPath = new URL('./models/', import.meta.url).href;
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;              // один поток — компьютер не нагревается и не тормозит
env.backends.onnx.wasm.proxy = false;

const MODEL = 'whisper-base_timestamped';
const SR = 16000;
let asrP = null;
const asr = () => (asrP ||= pipeline('automatic-speech-recognition', MODEL, { device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } }));

// звук → 16 кГц моно
async function decode(buf) {
  const probe = new OfflineAudioContext(1, SR, SR);
  const ab0 = ArrayBuffer.isView(buf) ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf.slice(0);
  const ab = await probe.decodeAudioData(ab0);   // decodeAudioData сам пересчитывает частоту под контекст
  const n = ab.length, ch = ab.numberOfChannels; const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / ch; }
  return out;
}

const cyr = (s) => (String(s).match(/[а-яё]/gi) || []).length, lat = (s) => (String(s).match(/[a-z]/gi) || []).length;
const VOW = /[аеёиоуыэюяaeiouy]/gi;
const syl = (w) => Math.max(1, (String(w).match(VOW) || []).length);

// слова строки с пометкой «эдлиб» (в скобках) — ровно как в интерфейсе
function words(text) {
  const out = []; let depth = 0;
  for (const raw of String(text || '').split(/\s+/).filter(Boolean)) {
    const o = (raw.match(/[([]/g) || []).length, c = (raw.match(/[)\]]/g) || []).length;
    const ad = depth > 0 || o > 0; depth = Math.max(0, depth + o - c);
    const t = raw.replace(/[()[\]]/g, ''); if (t) out.push({ t, ad });
  }
  return out;
}

// «подсказка голосу»: оставляем полосу голоса (150 Гц – 4,5 кГц), бас и бочка почти не мешают
async function voiceBand(pcm) {
  const ctx = new OfflineAudioContext(1, pcm.length, SR);
  const buf = ctx.createBuffer(1, pcm.length, SR); buf.copyToChannel(pcm, 0);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 150; hp.Q.value = 0.7;
  const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 150; hp2.Q.value = 0.7;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4500; lp.Q.value = 0.7;
  src.connect(hp); hp.connect(hp2); hp2.connect(lp); lp.connect(ctx.destination); src.start();
  const out = (await ctx.startRendering()).getChannelData(0);
  let pk = 0; for (let i = 0; i < out.length; i += 7) pk = Math.max(pk, Math.abs(out[i]));
  if (pk > 0) { const g = 0.9 / pk; for (let i = 0; i < out.length; i++) out[i] *= g; }
  return out;
}

// начала звуков (где голос «вступает»): рост энергии в полосе голоса, шаг 10 мс
function onsets(band) {
  const hop = 160, win = 400, n = Math.floor((band.length - win) / hop);
  const e = new Float32Array(Math.max(0, n));
  for (let k = 0; k < n; k++) { let s = 0; const o = k * hop; for (let i = 0; i < win; i += 2) s += band[o + i] * band[o + i]; e[k] = Math.log(1e-6 + s / (win / 2)); }
  const on = new Float32Array(e.length);
  for (let k = 3; k < e.length; k++) on[k] = Math.max(0, e[k] - Math.min(e[k - 1], e[k - 2], e[k - 3]));
  return on;
}
// подвинуть начало слова к ближайшему настоящему началу звука (если оно заметное и рядом)
function snap(on, t, back = 0.18, fwd = 0.12) {
  const k0 = Math.max(3, Math.round((t - back) * 100)), k1 = Math.min(on.length - 1, Math.round((t + fwd) * 100));
  if (k1 <= k0) return t;
  let best = -1, bv = 0;
  for (let k = k0; k <= k1; k++) { const v = on[k] * (1 - Math.abs(k / 100 - t) * 1.5); if (v > bv) { bv = v; best = k; } }
  // порог — относительно окрестности ±1 с: только явное вступление
  let m = 0, c = 0; for (let k = Math.max(0, k0 - 80); k < Math.min(on.length, k1 + 80); k += 2) { m += on[k]; c++; }
  m /= Math.max(1, c);
  return best >= 0 && bv > m * 2.2 + 0.15 ? best / 100 : t;
}

// куски: подряд идущие строки одного языка, не длиннее maxLen с; каждый начинается за pad с до первой строки
function windows(lines, dur, maxLen, pad) {
  const W = []; let cur = null;
  lines.forEach((l, i) => {
    const t = +l.t, end = i + 1 < lines.length ? Math.min(+lines[i + 1].t, t + 10) : Math.min(dur, t + 8);
    if (!words(l.text).length) return;
    const lang = cyr(l.text) >= lat(l.text) ? 'ru' : 'en';
    if (cur && end - cur.a <= maxLen && (cur.lang === lang || !(cyr(l.text) + lat(l.text)))) { cur.b = end; cur.idx.push(i); return; }
    if (cur) W.push(cur);
    cur = { a: Math.max(0, t - pad), b: end, lang, idx: [i] };
  });
  if (cur) W.push(cur);
  return W.map((w) => ({ ...w, b: Math.min(dur, Math.min(w.b + 0.4, w.a + 29)) }));
}

// Принудительное выравнивание: текст известен, поэтому ИИ не угадывает слова, а только ищет, где звучит каждое.
// Декодеру Whisper подаётся сам текст (как будто он его «распознал»), а по вниманию декодера к звуку
// (cross-attention) и динамическому выравниванию (DTW) находится момент начала каждого токена.
async function forced(run, seg, list, language) {
  const tok = run.tokenizer, model = run.model, gc = model.generation_config;
  if (!list.length) return null;
  const ids = []; const first = [];
  for (const w of list) { const e = tok.encode(' ' + w, { add_special_tokens: false }); first.push(ids.length); ids.push(...e); }
  if (ids.length > 220) return null;
  const code = language === 'russian' ? 'ru' : 'en';
  const prefix = [gc.decoder_start_token_id, gc.lang_to_id['<|' + code + '|>'], gc.task_to_id.transcribe, gc.no_timestamps_token_id].filter((x) => x != null);
  const feats = (await run.processor(seg)).input_features;
  const out = await model.generate({ inputs: feats, decoder_input_ids: [...prefix, ...ids], max_new_tokens: 1, return_token_timestamps: true, num_frames: Math.floor(seg.length / 320) });
  const ts = out.token_timestamps.tolist()[0];
  return first.map((i) => +ts[prefix.length + i + 1]);
}

// правдоподобна ли разметка слов строки: слова внутри своей строки, идут по порядку и не «слиплись» в одну точку
function plausible(tt, ws, lo, hi) {
  if (!tt || !tt.length || tt.some((x) => !Number.isFinite(x))) return 0;
  const inside = tt.filter((x) => x >= lo - 0.3 && x <= hi + 0.3).length / tt.length;
  if (inside < 0.75) return 0;
  const span = tt[tt.length - 1] - tt[0], need = tt.length > 1 ? Math.min(hi - lo, 0.09 * ws.slice(0, -1).reduce((a, w) => a + syl(w), 0)) : 0;
  if (span < need * 0.5) return 0;
  let back = 0; for (let k = 1; k < tt.length; k++) if (tt[k] < tt[k - 1] - 0.05) back++;
  return Math.max(0, inside - back / tt.length);
}
// порядок, границы строки и минимальная длина слов
function tidy(tt, lo, hi) {
  const out = tt.slice();
  out[0] = Math.max(out[0], lo - 0.4);
  for (let k = 1; k < out.length; k++) if (out[k] < out[k - 1] + 0.06) out[k] = out[k - 1] + 0.06;
  for (let k = out.length - 1; k >= 0; k--) { const lim = hi - 0.05 - (out.length - 1 - k) * 0.06; if (out[k] > lim) out[k] = lim; }
  return out.map((x) => Math.round(x * 100) / 100);
}
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

// Способы «слушать». Обычный разбор — A. «Пересчитать» пробует все и берёт лучший из тех, что заметно отличаются
// от прошлого (раз пользователь говорит, что прошлый был неверным).
const WAYS = {
  A: { band: true, maxLen: 12, pad: 0.8, lag: 0.1, snap: true },    // полоса голоса, куски до 12 с
  B: { band: false, maxLen: 12, pad: 0.3, lag: 0.0, snap: true },   // весь звук, кусок впритык к строке
  C: { band: true, maxLen: 6, pad: 1.4, lag: 0.12, snap: false },   // по одной-две строки, с запасом
};

// Разметка одним способом. part: 'main' | 'ad' — какие слова размечать
async function pass(run, pcm, band, on, lines, dur, way, part, onP) {
  const W = windows(lines, dur, way.maxLen, way.pad); const res = new Map();
  for (let k = 0; k < W.length; k++) {
    const w = W[k]; const src = way.band ? band : pcm;
    const seg = src.subarray(Math.floor(w.a * SR), Math.floor(w.b * SR));
    if (seg.length < SR * 0.5) continue;
    const language = w.lang === 'en' ? 'english' : 'russian';
    const per = w.idx.map((i) => words(lines[i].text).filter((x) => (part === 'ad' ? x.ad : !x.ad)).map((x) => x.t));
    const flat = per.flat(); if (!flat.length) { onP((k + 1) / W.length); continue; }
    let ts = null; try { ts = await forced(run, seg, flat, language); } catch (e) { console.log('кусок', k, e && e.message); }
    if (ts) {
      let p = 0;
      w.idx.forEach((i, j) => {
        const ws = per[j]; const n = ws.length; if (!n) return;
        let tt = ts.slice(p, p + n).map((x) => w.a + x - way.lag); p += n;
        if (way.snap) tt = tt.map((x) => snap(on, x));
        const lo = lines[i].t, hi = i + 1 < lines.length ? lines[i + 1].t : Math.min(dur, lo + 10);
        const q = plausible(tt, ws, lo, hi);
        if (q >= 0.7) res.set(i, { tt: tidy(tt, lo, hi), q });
      });
    }
    onP((k + 1) / W.length);
  }
  return res;
}

// job: { audio | pcm, lines: [{ t, text }], scope?: 'all' | 'main' | 'ad', prev?: [[строка, [время]]] (прошлая разметка) }
export async function alignTrack(job, onProgress = () => {}) {
  const t0 = performance.now();
  const pcm = job.pcm instanceof Float32Array ? job.pcm : await decode(job.audio);
  const dur = pcm.length / SR;
  const lines = (job.lines || []).filter((l) => Number.isFinite(+l.t)).map((l) => ({ t: +l.t, text: String(l.text || '') }));
  const run = await asr();
  const band = await voiceBand(pcm); const on = onsets(band);
  const retry = !!job.scope; const scope = job.scope || 'all';
  const prev = new Map(Array.isArray(job.prev) ? job.prev : []);
  // прошлая разметка строки → отдельно время основных слов и эдлибов
  const prevPart = (i, part) => { const ts = prev.get(i); if (!ts) return null; const ws = words(lines[i].text); if (ws.length !== ts.length) return null; return ts.filter((_, k) => (part === 'ad' ? ws[k].ad : !ws[k].ad)); };
  const ways = retry ? ['A', 'B', 'C'] : ['A'];
  const parts = scope === 'ad' ? ['ad'] : scope === 'main' ? ['main'] : ['main', 'ad'];
  const steps = ways.length * parts.length; let done = 0;
  const got = { main: new Map(), ad: new Map() };
  for (const part of parts) {
    const cands = [];
    for (const wk of ways) { cands.push(await pass(run, pcm, band, on, lines, dur, WAYS[wk], part, (p) => onProgress((done + p) / steps))); done++; }
    lines.forEach((_, i) => {
      let best = null;
      for (const c of cands) {
        const r = c.get(i); if (!r) continue;
        let score = r.q;
        // пересчёт: вариант, почти совпадающий с прошлым (неверным), — в конец очереди
        const old = retry ? prevPart(i, part) : null;
        if (old && old.length === r.tt.length && median(r.tt.map((x, k) => Math.abs(x - old[k]))) < 0.12) score -= 0.5;
        if (!best || score > best.score) best = { ...r, score };
      }
      if (best) got[part].set(i, best.tt);
    });
  }
  // сборка: время каждого слова строки в исходном порядке (основные и эдлибы вперемешку, как в тексте)
  const out = []; let good = 0, total = 0;
  lines.forEach((l, i) => {
    const ws = words(l.text); if (!ws.length) return;
    const m = got.main.get(i) || (parts.includes('main') ? null : prevPart(i, 'main'));
    let a = got.ad.get(i) || (parts.includes('ad') ? null : prevPart(i, 'ad'));
    const nMain = ws.filter((x) => !x.ad).length, nAd = ws.length - nMain;
    total += ws.length;
    if (nMain && !m) return;                       // основной текст не разметился — строка остаётся «по слогам»
    if (nAd && !a) {
      // эдлибы не разметились: ставим их сразу после соседнего основного слова (по порядку в тексте)
      a = []; let lastMain = l.t, mi = 0;
      ws.forEach((x) => { if (!x.ad) { lastMain = m[mi++]; } else a.push(Math.round((lastMain + 0.25 + a.length * 0.18) * 100) / 100); });
    }
    let mi = 0, ai = 0; const tt = ws.map((x) => (x.ad ? a[ai++] : m[mi++]));
    good += ws.length; out.push([i, tt]);
  });
  return { lines: out, c: total ? Math.round((good / total) * 1000) / 1000 : 0, v: 3, ms: Math.round(performance.now() - t0) };
}

// мост к «Пульсу» (preload скрытого окна); в CI тест вызывает alignTrack напрямую
window.PulseAI = { alignTrack, ready: () => asr().then(() => true) };
if (window.aiBridge) {
  window.aiBridge.onJob(async (job) => {
    try { window.aiBridge.done({ id: job.id, ok: true, v: await alignTrack(job, (p) => window.aiBridge.progress(job.id, p)) }); }
    catch (e) { window.aiBridge.done({ id: job.id, ok: false, error: String((e && e.message) || e) }); }
  });
  window.aiBridge.hello();
}
