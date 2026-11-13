// Сопоставление: известный текст песни (строки с временем начала) + слова, которые «услышал» ИИ (со временем),
// → время начала каждого слова текста. Без зависимостей — проверяется отдельно (test/match.test.mjs).
//
// Почему так: ИИ иногда ошибается в словах (пение, автотюн, сленг), пропускает или добавляет лишние. Поэтому мы не
// верим его словам, а только времени: находим лучшее соответствие «слово текста ↔ услышанное слово» (как сравнение
// двух текстов), учитывая и похожесть написания, и то, что слово должно звучать внутри своей строки.
// Слова без пары получают время между соседями (пропорционально слогам).

// токены строки — ровно как в интерфейсе (split по пробелам; скобки эдлибов убираются, пустые — пропускаются)
export function tokens(text) {
  const out = [];
  for (const raw of String(text || '').split(/\s+/).filter(Boolean)) { const t = raw.replace(/[()[\]]/g, ''); if (t) out.push(t); }
  return out;
}

const CYR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'u', я: 'ya', і: 'i', ї: 'i', є: 'e' };
// «скелет» слова: строчные латинские буквы и цифры; кириллица — транслитом (ИИ может написать «окей» как «okay»)
export function norm(w) {
  let s = String(w || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let o = '';
  for (const ch of s) { if (CYR[ch] != null) o += CYR[ch]; else if (/[a-z0-9]/.test(ch)) o += ch; }
  return o.replace(/(.)\1+/g, '$1');   // «ееее», «yeeah» → одна буква
}

function lev(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = new Array(b.length + 1); for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export function sim(a, b) { if (!a || !b) return 0; const m = Math.max(a.length, b.length); return 1 - lev(a, b) / m; }

const VOW = /[аеёиоуыэюяaeiouy]/gi;
const syl = (w) => Math.max(1, (String(w).match(VOW) || []).length);

// lines: [{ t, text }] (по времени), heard: [{ w, a, b }] (слово ИИ и его начало/конец, с), dur — длина трека.
// → { lines: [[номер строки, [время каждого слова]]], c: доля слов, у которых нашлась пара }
export function align(lines, heard, dur) {
  const L = lines.map((l, i) => ({ i, t: +l.t || 0, end: i + 1 < lines.length ? +lines[i + 1].t : (dur || (+l.t + 6)), toks: tokens(l.text) }));
  // слова текста одной цепочкой
  const W = [];
  for (const l of L) l.toks.forEach((tk, k) => W.push({ li: l.i, k, n: norm(tk), raw: tk, lo: l.t - 1.2, hi: l.end + 0.6 }));
  const R = heard.filter((h) => h && Number.isFinite(h.a)).map((h) => ({ n: norm(h.w), a: +h.a, b: Number.isFinite(h.b) ? +h.b : +h.a + 0.3 })).filter((h) => h.n);
  const n = W.length, m = R.length;
  if (!n || !m) return { lines: [], c: 0 };
  // выравнивание двух последовательностей (как diff): награда за похожие слова, если время укладывается в строку
  const score = (i, j) => {
    const w = W[i], r = R[j]; if (r.a < w.lo || r.a > w.hi) return -1;
    let s = sim(w.n, r.n);
    if (s < 0.5) { // слово могли «склеить» или «разрезать»: сравниваем начало
      const p = Math.min(w.n.length, r.n.length); if (p >= 3 && (w.n.startsWith(r.n) || r.n.startsWith(w.n))) s = 0.55;
    }
    return s >= 0.5 ? s : -1;
  };
  // DP по полосе вокруг диагонали была бы быстрее, но слов в песне — сотни, полная таблица n*m — доли секунды
  const D = new Float32Array((n + 1) * (m + 1)); const P = new Uint8Array((n + 1) * (m + 1));   // 1 — пара, 2 — пропуск слова текста, 3 — пропуск услышанного
  const at = (i, j) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) P[at(i, 0)] = 2;
  for (let j = 1; j <= m; j++) P[at(0, j)] = 3;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = D[at(i - 1, j)], p = 2;
      if (D[at(i, j - 1)] > best) { best = D[at(i, j - 1)]; p = 3; }
      const s = score(i - 1, j - 1);
      if (s > 0 && D[at(i - 1, j - 1)] + s > best) { best = D[at(i - 1, j - 1)] + s; p = 1; }
      D[at(i, j)] = best; P[at(i, j)] = p;
    }
  }
  const time = new Array(n).fill(null); let matched = 0;
  for (let i = n, j = m; i > 0 || j > 0;) {
    const p = P[at(i, j)];
    if (p === 1) { time[i - 1] = R[j - 1].a; matched++; i--; j--; } else if (p === 2) i--; else j--;
  }
  // время по порядку не должно идти назад (иначе — без пары)
  let last = -1e9;
  for (let i = 0; i < n; i++) if (time[i] != null) { if (time[i] < last + 0.04) { time[i] = null; matched--; } else last = time[i]; }
  // слова без пары — между соседями с парой (в пределах строки), пропорционально слогам
  const out = [];
  for (const l of L) {
    const idx = []; for (let i = 0; i < n; i++) if (W[i].li === l.i) idx.push(i);
    if (!idx.length) continue;
    const got = idx.filter((i) => time[i] != null).length;
    if (got === 0 || got / idx.length < 0.34) continue;   // строку почти не узнали — пусть остаётся оценка по слогам
    const tt = idx.map((i) => time[i]); const ws = idx.map((i) => syl(W[i].raw));
    const anchorL = Math.max(l.t - 0.3, 0), anchorR = l.end - 0.1;
    // пробелы (слова подряд без пары) заполняем по слогам: от прошлого найденного слова до следующего найденного
    for (let k = 0; k < tt.length;) {
      if (tt[k] != null) { k++; continue; }
      const a = k - 1; let b = k; while (b < tt.length && tt[b] == null) b++;
      const from = a >= 0 ? a : k;                       // с какого слова считаем слоги
      let tot = 0; for (let q = from; q < b; q++) tot += ws[q];
      const per = 0.22;                                  // ~0,22 с на слог, если опоры справа нет
      const ta = a >= 0 ? tt[a] : (b < tt.length ? Math.max(anchorL, tt[b] - tot * per) : anchorL);
      const tb = b < tt.length ? tt[b] : Math.min(anchorR, ta + Math.max(0.3, tot * per + (a >= 0 ? ws[a] * per : 0)));
      let acc = 0;
      for (let q = from; q < b; q++) { if (q >= k) tt[q] = ta + (tb - ta) * (tot ? acc / tot : 0); acc += ws[q]; }
      k = b;
    }
    for (let k = 1; k < tt.length; k++) if (tt[k] < tt[k - 1] + 0.04) tt[k] = tt[k - 1] + 0.04;
    out.push([l.i, tt.map((x) => Math.round(x * 100) / 100)]);
  }
  return { lines: out, c: Math.round((matched / n) * 1000) / 1000 };
}
