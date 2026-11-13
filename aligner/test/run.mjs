// CI: открывает тестовую страницу в Chromium (как в «Пульсе» — WebAssembly, один поток) и сравнивает разметку с правдой
import { chromium } from 'playwright';
import fs from 'fs';
const b = await chromium.launch(); const pg = await b.newPage();
pg.on('console', (m) => console.log('[page]', m.text())); pg.on('pageerror', (e) => console.log('[page error]', e.message));
await pg.goto('http://127.0.0.1:8123/test/index.html');
await pg.waitForFunction(() => window.testReady === true, null, { timeout: 60000 });
const { meta, res, res2 } = await pg.evaluate(() => window.runTest());
await b.close();
function score(res) {
  const errs = []; let lines = 0;
  for (const [li, times] of res.lines) {
    const tr = meta.truth[li]; if (!tr || tr.length !== times.length) { console.log('строка', li, 'число слов не совпало', tr && tr.length, times.length); continue; }
    lines++; times.forEach((t, k) => errs.push(t - tr[k]));
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const med = abs.length ? abs[abs.length >> 1] : 99, p90 = abs.length ? abs[Math.floor(abs.length * 0.9)] : 99;
  const within = abs.filter((e) => e <= 0.25).length / Math.max(1, abs.length);
  const early = errs.filter((e) => e < -0.25).length, late = errs.filter((e) => e > 0.25).length;
  const total = meta.truth.reduce((a, x) => a + x.length, 0);
  return { lines, med, report: { время_мс: res.ms, строк_размечено: lines + ' из ' + meta.truth.length, медиана_ошибки_с: +med.toFixed(3), ошибка_90проц_с: +p90.toFixed(3), точно_в_025с: +(within * 100).toFixed(1) + '%', раньше_на_025: early, позже_на_025: late, слов_проверено: abs.length + ' из ' + total } };
}
const A = score(res), B = score(res2);
const report = { обычный: A.report, пересчёт: B.report };
console.log(JSON.stringify(report, null, 1));
console.log('правда:', JSON.stringify(meta.truth)); console.log('ИИ:', JSON.stringify(res.lines)); console.log('LRC:', JSON.stringify(meta.lines.map((l) => l.t)));
fs.writeFileSync('test-report.json', JSON.stringify({ report, res, res2 }, null, 1));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Проверка ИИ-разметки\n```\n' + JSON.stringify(report, null, 1) + '\n```\n');
const lines = A.lines, med = A.med;
if (!(lines >= meta.truth.length * 0.6 && med < 0.3)) { console.log('ПРОВЕРКА НЕ ПРОЙДЕНА'); process.exit(1); }
