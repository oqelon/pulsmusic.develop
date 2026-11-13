// Разбор звука на частоты для «живой» линии «Моего пульса».
// Из плеера приходят кусочки звука (PCM, значения от −1 до 1). Быстрое преобразование Фурье раскладывает их
// на частоты, а дальше мы считаем громкость в 24 полосах: от баса (40 Гц) до самых высоких (14 кГц).
// У каждой полосы своя «автоподстройка»: высокие обычно тише баса, но тоже должны заметно двигаться.
export const NB = 24;
const SR = 44100, F0 = 40, F1 = 14000;
const peak = new Array(NB).fill(0.02);

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// Буферы, окно Ханна и границы полос считаются один раз для каждого размера и дальше переиспользуются —
// разбор звука идёт до 25 раз в секунду, и без этого он каждый раз заново выделял память и считал косинусы.
type Prep = { re: Float64Array; im: Float64Array; win: Float64Array; b0: Int32Array; b1: Int32Array };
const preps = new Map<number, Prep>();
function prep(n: number): Prep {
  let p = preps.get(n); if (p) return p;
  const win = new Float64Array(n); for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const b0 = new Int32Array(NB), b1 = new Int32Array(NB); const hz = SR / n;
  for (let k = 0; k < NB; k++) {
    const lo = F0 * Math.pow(F1 / F0, k / NB), hi = F0 * Math.pow(F1 / F0, (k + 1) / NB);
    const i0 = Math.max(1, Math.floor(lo / hz)); b0[k] = i0; b1[k] = Math.min(n / 2 - 1, Math.max(i0, Math.ceil(hi / hz)));
  }
  p = { re: new Float64Array(n), im: new Float64Array(n), win, b0, b1 }; preps.set(n, p); return p;
}

// sample — { channels: [{ frames: number[] }, …] } из expo-audio. Возвращает 24 числа 0…1 (бас → высокие) или null.
export function analyze(sample: any): number[] | null {
  const ch = sample?.channels; if (!ch || !ch.length) return null;
  const a: number[] = ch[0]?.frames, b: number[] | undefined = ch[1]?.frames;
  if (!a || a.length < 256) return null;
  let n = 256; while (n * 2 <= a.length && n < 1024) n *= 2;
  const { re, im, win, b0, b1 } = prep(n); let rms = 0;
  for (let i = 0; i < n; i++) {
    const x = b ? (a[i] + b[i]) / 2 : a[i]; rms += x * x;
    re[i] = x * win[i]; im[i] = 0;   // окно Ханна
  }
  rms = Math.sqrt(rms / n);
  if (rms < 0.002) return new Array(NB).fill(0);   // тишина
  fft(re, im);
  const out = new Array(NB);
  for (let k = 0; k < NB; k++) {
    const i0 = b0[k], i1 = b1[k];
    let s = 0; for (let i = i0; i <= i1; i++) s += Math.hypot(re[i], im[i]);
    const v = s / (i1 - i0 + 1);
    peak[k] = Math.max(peak[k] * 0.996, v, 1e-4);
    out[k] = Math.pow(Math.min(1, v / peak[k]), 1.3) * Math.min(1, 0.45 + rms * 5);
  }
  return out;
}

// Номер сборки файла. Все файлы папки src должны быть из одной сборки — иначе приложение покажет подсказку, а не ошибку.
export const BUILD = 64;
