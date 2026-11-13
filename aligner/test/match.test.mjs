import { align, norm, tokens } from '../src/match.js';
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok', m); };
ok(norm('Привет!') === 'privet', 'translit');
ok(tokens('Сердце (огней, огней)').length === 3, 'tokens');
const lines = [{ t: 1, text: 'Я давно не слышал твой голос' }, { t: 5, text: 'Город гаснет, но я (не сплю)' }, { t: 9, text: 'Hey yeah okay' }];
const heard = [
  { w: 'я', a: 1.2 }, { w: 'давно', a: 1.5 }, { w: 'не', a: 2.0 }, { w: 'слыша', a: 2.2 }, { w: 'твой', a: 2.9 }, { w: 'голос', a: 3.3 },
  { w: 'город', a: 5.1 }, { w: 'гаснет', a: 5.6 }, /* «но» пропущено */ { w: 'я', a: 6.4 }, { w: 'не', a: 7.0 }, { w: 'сплю', a: 7.3 },
  { w: 'лишнее', a: 8.2 }, { w: 'хей', a: 9.2 }, { w: 'yeah', a: 9.6 }, { w: 'окей', a: 10.1 },
];
const r = align(lines, heard, 14);
console.log(JSON.stringify(r));
ok(r.lines.length === 3, 'all lines');
const l1 = r.lines[1][1]; ok(l1.length === 6 && l1[2] > 5.6 && l1[2] < 6.4, 'interp missing word ' + l1[2]);
ok(r.lines[2][1][0] === 9.2 && r.lines[2][1][2] === 10.1, 'translit match hey/okay');
ok(r.c > 0.85, 'confidence ' + r.c);
// почти ничего не узнали — строку не трогаем
const r2 = align([{ t: 0, text: 'раз два три четыре пять шесть' }], [{ w: 'мимо', a: 0.5 }], 5);
ok(r2.lines.length === 0, 'unknown line skipped');
// слова в чужой строке по времени не сопоставляются
const r3 = align([{ t: 0, text: 'да да да' }, { t: 10, text: 'нет нет' }], [{ w: 'нет', a: 1 }, { w: 'да', a: 1.5 }, { w: 'нет', a: 10.4 }, { w: 'нет', a: 10.9 }], 14);
ok(r3.lines.find((x) => x[0] === 1)[1][0] === 10.4, 'time window');
