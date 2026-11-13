// Вырезание артиста из фото (для обложек «Подборок»). Работает в скрытом окне «Пульса», без интернета:
// 1) YOLOS-tiny ищет на фото человека — нет человека (логотип, рисунок, группа вдалеке) → обложку не делаем;
// 2) MODNet вырезает человека по контуру (с волосами), получается PNG с прозрачным фоном, обрезанный по силуэту.
import { env, pipeline, AutoModel, AutoProcessor, RawImage } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('./models/', location.href).href;
env.backends.onnx.wasm.wasmPaths = new URL('./ort/', location.href).href;
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

let det = null, mat = null, proc = null;
async function load() {
  if (!det) det = await pipeline('object-detection', 'yolos-tiny', { dtype: 'q8', device: 'wasm' });
  if (!mat) { mat = await AutoModel.from_pretrained('modnet', { dtype: 'q8', device: 'wasm' }); proc = await AutoProcessor.from_pretrained('modnet'); }
}

// bytes — картинка (jpeg/png). Ответ: { person, score, why, png (Uint8Array), w, h, box: {x,y,w,h} — где силуэт был на исходном фото (0…1) }
export async function cut(bytes) {
  await load();
  const blob = new Blob([bytes]);
  let img = await RawImage.fromBlob(blob);
  // фото артистов — 400×400; большие картинки уменьшаем до 512 по длинной стороне (иначе медленно)
  const big = Math.max(img.width, img.height);
  if (big > 512) img = await img.resize(Math.round(img.width * 512 / big), Math.round(img.height * 512 / big));
  const W = img.width, H = img.height;
  // 1. есть ли человек, и достаточно ли он крупный
  const found = await det(img, { threshold: 0.6, percentage: true });
  const ppl = found.filter((o) => o.label === 'person').map((o) => ({ ...o, a: (o.box.xmax - o.box.xmin) * (o.box.ymax - o.box.ymin) })).sort((a, b) => b.a - a.a);
  const main = ppl[0];
  if (!main || main.score < 0.8) return { person: false, why: main ? 'неуверенно (' + main.score.toFixed(2) + ')' : 'нет человека' };
  if (main.a < 0.1) return { person: false, why: 'человек слишком мелкий' };
  // 2. маска MODNet
  const { pixel_values } = await proc(img);
  const { output } = await mat({ input: pixel_values });
  const mask = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(W, H);
  const m = mask.data;
  // маска должна совпадать с найденным человеком: внутри его рамки — в основном «человек», вне — в основном пусто
  const bx0 = Math.round(main.box.xmin * W), by0 = Math.round(main.box.ymin * H), bx1 = Math.round(main.box.xmax * W), by1 = Math.round(main.box.ymax * H);
  let inS = 0, inN = 0, outS = 0, outN = 0;
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const v = m[y * W + x] / 255; if (x >= bx0 && x < bx1 && y >= by0 && y < by1) { inS += v; inN++; } else { outS += v; outN++; } }
  const inF = inS / Math.max(1, inN), outF = outS / Math.max(1, outN);
  // проверка качества: если маска плохая — лучше обычная обложка, чем рваный артист
  if (inF < 0.4) return { person: false, why: 'силуэт рваный (' + inF.toFixed(2) + ')' };
  if (outF > 0.22) return { person: false, why: 'фон не отделился (' + outF.toFixed(2) + ')' };
  // середина фигуры (лицо и грудь): там не должно быть дыр
  const cx0 = bx0 + (bx1 - bx0) * 0.3, cx1 = bx0 + (bx1 - bx0) * 0.7, cy0 = by0 + (by1 - by0) * 0.12, cy1 = by0 + (by1 - by0) * 0.6;
  let cS = 0, cN = 0, holes = 0;
  for (let y = Math.round(cy0); y < cy1; y += 2) for (let x = Math.round(cx0); x < cx1; x += 2) { const v = m[y * W + x] / 255; cS += v; cN++; if (v < 0.5) holes++; }
  const core = cS / Math.max(1, cN), holeF = holes / Math.max(1, cN);
  if (core < 0.85 || holeF > 0.06) return { person: false, why: 'дыры в силуэте (' + core.toFixed(2) + ', ' + holeF.toFixed(2) + ')' };
  // 3. PNG с прозрачным фоном, обрезанный по силуэту (+ запас 2%)
  const cv = new OffscreenCanvas(W, H); const g = cv.getContext('2d');
  const rgba = img.rgba();
  const id = new ImageData(new Uint8ClampedArray(rgba.data), W, H);
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const a = m[i]; id.data[p + 3] = a < 12 ? 0 : a;
    if (a > 60) { const x = i % W, y = (i / W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  g.putImageData(id, 0, 0);
  if (x1 <= x0 || y1 <= y0) return { person: false, why: 'пустая маска' };
  const pad = Math.round(Math.max(W, H) * 0.02);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = new OffscreenCanvas(cw, ch); out.getContext('2d').drawImage(cv, x0, y0, cw, ch, 0, 0, cw, ch);
  const png = new Uint8Array(await (await out.convertToBlob({ type: 'image/png' })).arrayBuffer());
  return { person: true, score: main.score, inF, outF, png, w: cw, h: ch, box: { x: x0 / W, y: y0 / H, w: cw / W, h: ch / H }, bottom: y1 >= H - 1 - pad };
}

// мост к «Пульсу» (в тестах его нет)
if (window.cutBridge) {
  window.cutBridge.onJob(async (j) => {
    try { const v = await cut(j.bytes); window.cutBridge.done({ id: j.id, ok: true, v }); }
    catch (e) { window.cutBridge.done({ id: j.id, ok: false, error: String((e && e.message) || e) }); }
  });
  window.cutBridge.hello();
}
window.pulseCut = cut;
