// Проверка в Chromium: каждое фото из pack/test/img → вырезанный PNG и отчёт (test-out/)
import { chromium } from 'playwright';
import fs from 'fs';
const imgs = fs.readdirSync('pack/test/img').filter((f) => /\.(jpe?g|png|webp)$/i.test(f));
fs.mkdirSync('test-out', { recursive: true });
const b = await chromium.launch(); const pg = await b.newPage();
pg.on('console', (m) => console.log('[стр]', m.text())); pg.on('pageerror', (e) => console.log('[ошибка]', e.message));
await pg.goto('http://127.0.0.1:8124/index.html');
await pg.waitForFunction(() => !!window.pulseCut, null, { timeout: 60000 });
const rep = [];
for (const f of imgs) {
  const t0 = Date.now();
  const r = await pg.evaluate(async (u) => { const bytes = new Uint8Array(await (await fetch(u)).arrayBuffer()); const v = await window.pulseCut(bytes); return { ...v, png: v.png ? Array.from(v.png) : null }; }, 'test/img/' + f);
  const ms = Date.now() - t0;
  if (r.png) fs.writeFileSync('test-out/' + f.replace(/\.\w+$/, '') + '.cut.png', Buffer.from(r.png));
  delete r.png; rep.push({ f, ms, ...r }); console.log(f, ms + ' мс', JSON.stringify(r));
}
fs.writeFileSync('test-out/report.json', JSON.stringify(rep, null, 1));
await b.close();
