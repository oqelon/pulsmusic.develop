// Запись аудио-CD на Mac через системную службу записи дисков (DiscRecording) — запускается как
//   osascript -l JavaScript dr.js <режим> …
// drutil (которым писали раньше) не умеет паузу между треками другой длины, кроме 2 с, не даёт выбрать «без пауз»
// и сообщает ход записи только текстом в терминал (через трубу он приходит кусками — отсюда «41 %» до самого конца).
// Здесь — та же служба, что у drutil и Finder, но напрямую: состояние и процент берутся у неё каждые 0,4 с.
//
// Режимы (всё, что видит программа, — строки в стандартный вывод):
//   list                           → DRIVE|{json} на каждый привод, затем END
//   burn <id> <папка> <скорость×|0> <извлечь 1/0> <закрыть диск 1/0> <пауза, с> <очистить 1/0>
//                                  → STATE|<этап>|<процент или -1>|<трек>|<треков> … DONE | ERR|<код>|<текст>
//   eject <id>                     → DONE | ERR|…
//   probe <wav> <wav> …            → проверка моста без привода (для CI): ключи, дорожки, паузы
ObjC.import('Foundation');
ObjC.import('DiscRecording');
ObjC.import('stdlib');

const OUT = $.NSFileHandle.fileHandleWithStandardOutput;
function say(s) { OUT.writeData($(String(s) + '\n').dataUsingEncoding($.NSUTF8StringEncoding)); }
// постоянные службы: из описания моста (BridgeSupport), если он есть; иначе — их известные значения
function K(name) { try { const v = $[name]; if (v !== undefined && v !== null) { const u = ObjC.unwrap(v); if (typeof u === 'string' && u) return u; } } catch (e) {} return name.replace(/^k/, ''); }
const num = (x) => $.NSNumber.numberWithDouble(x);
const yes = (b) => $.NSNumber.numberWithBool(!!b);
const pump = (sec) => $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(sec));
const dict = (o) => ObjC.deepUnwrap(o) || {};

function devices() { const a = $.DRDevice.devices; const r = []; for (let i = 0; i < a.count; i++) r.push(a.objectAtIndex(i)); return r; }
function devId(d) { return ObjC.unwrap(d.ioRegistryEntryPath) || ''; }
function find(id) { const l = devices(); return l.find((d) => devId(d) === id) || (/^\d+$/.test(id) ? l[+id - 1] : null) || null; }

function describe(d) {
  const info = dict(d.info), st = dict(d.status);
  const wc = info[K('kDRDeviceWriteCapabilitiesKey')] || {};
  const mi = st[K('kDRDeviceMediaInfoKey')] || {};
  const present = st[K('kDRDeviceMediaStateKey')] === K('kDRDeviceMediaStateMediaPresent');
  const cls = mi[K('kDRDeviceMediaClassKey')] || '', type = String(mi[K('kDRDeviceMediaTypeKey')] || '');
  const blank = !!mi[K('kDRDeviceMediaIsBlankKey')], erasable = !!mi[K('kDRDeviceMediaIsErasableKey')];
  const canCD = !!(wc[K('kDRDeviceCanWriteCDRKey')] || wc[K('kDRDeviceCanWriteCDRWKey')] || wc[K('kDRDeviceCanWriteCDKey')]);
  let media = 'none';
  if (!canCD) media = 'nowrite';
  else if (present) {
    if (cls && cls !== K('kDRDeviceMediaClassCD')) media = 'notcd';
    else if (blank) media = 'blank';
    else if (erasable || /RW/i.test(type)) media = 'rw';
    else media = 'used';
  }
  // скорости записи для вставленного диска — КБ/с; 1× для CD = 176,4 КБ/с
  const sp = (st[K('kDRDeviceBurnSpeedsKey')] || mi[K('kDRDeviceBurnSpeedsKey')] || []).map((v) => Math.round(+v / 176.4)).filter((x) => x > 0);
  const speeds = [...new Set(sp)].sort((a, b) => a - b);
  const max = Math.round(+(st[K('kDRDeviceMaximumWriteSpeedKey')] || 0) / 176.4) || (speeds.length ? speeds[speeds.length - 1] : 0);
  const blocks = +(mi[K('kDRDeviceMediaBlocksFreeKey')] || 0);
  return {
    id: devId(d), name: [info[K('kDRDeviceVendorNameKey')], info[K('kDRDeviceProductNameKey')]].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || 'Привод',
    letter: '', media, mins: Math.floor(blocks / 75 / 60), speeds, max,
    sao: !!wc[K('kDRDeviceCanWriteCDSAOKey')], tao: !!wc[K('kDRDeviceCanWriteCDTAOKey')], open: true,
  };
}

// этапы службы → этапы программы
function stageOf(s) {
  const m = {
    [K('kDRStatusStatePreparing')]: 'prepare', [K('kDRStatusStateVerifying')]: 'finish', [K('kDRStatusStateSessionOpen')]: 'prepare',
    [K('kDRStatusStateTrackOpen')]: 'write', [K('kDRStatusStateTrackWrite')]: 'write', [K('kDRStatusStateTrackClose')]: 'write',
    [K('kDRStatusStateSessionClose')]: 'finish', [K('kDRStatusStateFinishing')]: 'finish', [K('kDRStatusStateErasing')]: 'erase',
    [K('kDRStatusStateDone')]: 'done', [K('kDRStatusStateFailed')]: 'failed',
  };
  return m[s] || '';
}
function errOf(st) {
  const e = st[K('kDRErrorStatusKey')] || {};
  const code = e[K('kDRErrorStatusErrorKey')]; const txt = e[K('kDRErrorStatusErrorStringKey')] || e[K('kDRErrorStatusErrorInfoStringKey')] || '';
  return 'ERR|' + (code != null ? '0x' + (code >>> 0).toString(16).toUpperCase() : '') + '|' + String(txt).replace(/\s+/g, ' ');
}
// ждём, пока задание (очистка или запись) закончится; этапы и процент — в вывод
function follow(job, n, tag) {
  let last = '';
  for (;;) {
    pump(0.4);
    const st = dict(job.status);
    const g = stageOf(st[K('kDRStatusStateKey')]);
    const p = st[K('kDRStatusPercentCompleteKey')]; const pct = typeof p === 'number' && p >= 0 ? Math.round(p * 1000) / 10 : -1;
    const tr = +(st[K('kDRStatusCurrentTrackKey')] || 0);
    if (g === 'done') return true;
    if (g === 'failed') { say(errOf(st)); return false; }
    const line = 'STATE|' + (tag || g || 'prepare') + '|' + pct + '|' + tr + '|' + n;
    if (line !== last) { say(line); last = line; }
  }
}

function list() { try { devices().forEach((d) => { try { say('DRIVE|' + JSON.stringify(describe(d))); } catch (e) { say('ERRD|' + e); } }); } catch (e) { say('ERRL|' + e); } say('END'); }

function tracksOf(files, gap) {
  const out = [];
  files.forEach((f, i) => {
    const t = $.DRTrack.trackForAudioFile($(f));
    if (!t || t.isNil()) throw new Error('не открылся звук ' + f);
    const pr = $.NSMutableDictionary.dictionary; const cur = t.properties; if (cur && !cur.isNil()) pr.addEntriesFromDictionary(cur);
    // первая дорожка — пауза 2 с по стандарту аудио-CD; остальные — сколько выбрано (0 — подряд)
    pr.setObjectForKey(num(i === 0 ? 150 : Math.round(gap * 75)), $(K('kDRPreGapLengthKey')));
    t.setProperties(pr);
    out.push(t);
  });
  return out;
}

function burn(id, dir, speed, eject, close, gap, erase) {
  const d = find(id); if (!d) { say('ERR||Привод не найден — подключите его и проверьте ещё раз'); return 1; }
  const fm = $.NSFileManager.defaultManager;
  const names = ObjC.deepUnwrap(fm.contentsOfDirectoryAtPathError($(dir), null)) || [];
  const files = names.filter((x) => /\.wav$/i.test(x)).sort().map((x) => dir + '/' + x);
  if (!files.length) { say('ERR||Нет звука для записи'); return 1; }
  let tracks;
  try { tracks = tracksOf(files, gap); } catch (e) { say('NOSTART|' + e); return 3; }
  if (erase) {
    say('STATE|erase|-1|0|' + files.length);
    const er = $.DRErase.eraseForDevice(d);
    const ep = $.NSMutableDictionary.dictionary; ep.setObjectForKey($(K('kDREraseTypeQuick')), $(K('kDREraseTypeKey'))); er.setProperties(ep);
    er.start;
    started = true;
    if (!follow(er, files.length, 'erase')) return 1;
  }
  const b = $.DRBurn.burnForDevice(d);
  const p = $.NSMutableDictionary.dictionary; const cur = b.properties; if (cur && !cur.isNil()) p.addEntriesFromDictionary(cur);
  p.setObjectForKey(num(speed > 0 ? speed * 176.4 : 65535), $(K('kDRBurnRequestedSpeedKey')));
  p.setObjectForKey($(eject ? K('kDRBurnCompletionActionEject') : K('kDRBurnCompletionActionMount')), $(K('kDRBurnCompletionActionKey')));
  p.setObjectForKey(yes(!close), $(K('kDRBurnAppendableKey')));
  p.setObjectForKey(yes(false), $(K('kDRBurnVerifyDiscKey')));
  // пауза не 2 с — только «диск за один проход» (SAO): в режиме «трек за треком» привод сам ставит 2 с
  if (gap !== 2) { p.setObjectForKey($([K('kDRBurnStrategyCDSAO')]), $(K('kDRBurnStrategyKey'))); p.setObjectForKey(yes(true), $(K('kDRBurnStrategyIsRequiredKey'))); }
  b.setProperties(p);
  say('STATE|prepare|-1|0|' + files.length);
  started = true;   // дальше запасной путь (drutil) уже нельзя: диск мог начать писаться
  b.writeLayout($(tracks));
  return follow(b, files.length) ? (say('DONE'), 0) : 1;
}

function probe(files) {
  ['kDRBurnRequestedSpeedKey', 'kDRBurnCompletionActionKey', 'kDRBurnCompletionActionEject', 'kDRBurnCompletionActionMount', 'kDRBurnAppendableKey',
    'kDRBurnVerifyDiscKey', 'kDRBurnStrategyKey', 'kDRBurnStrategyCDSAO', 'kDRBurnStrategyIsRequiredKey', 'kDRPreGapLengthKey', 'kDRStatusStateKey',
    'kDRStatusPercentCompleteKey', 'kDRStatusCurrentTrackKey', 'kDRStatusStateTrackWrite', 'kDRStatusStateDone', 'kDRStatusStateFailed',
    'kDRDeviceMediaInfoKey', 'kDRDeviceBurnSpeedsKey', 'kDRDeviceMediaStateMediaPresent', 'kDRDeviceCanWriteCDSAOKey', 'kDRErrorStatusKey',
    'kDREraseTypeKey', 'kDREraseTypeQuick', 'kDRDeviceMaximumWriteSpeedKey'].forEach((k) => {
    let raw = 'нет в мосте'; try { const v = $[k]; if (v !== undefined && v !== null) raw = JSON.stringify(ObjC.unwrap(v)); } catch (e) { raw = 'ошибка ' + e; }
    say('KEY|' + k + '|' + raw + '|' + K(k));
  });
  say('DEVICES|' + devices().length);
  const t = tracksOf(files, 0);
  t.forEach((x, i) => { const pr = dict(x.properties); say('TRACK|' + (i + 1) + '|pregap=' + pr[K('kDRPreGapLengthKey')] + '|length=' + ObjC.unwrap(x.length ? x.length.description : '') + '|keys=' + Object.keys(pr).join(',')); });
  const t2 = tracksOf(files, 4.5); say('GAP45|' + t2.map((x) => dict(x.properties)[K('kDRPreGapLengthKey')]).join(','));
  say('BURNCLASS|' + (typeof $.DRBurn.burnForDevice) + '|' + (typeof $.DRErase.eraseForDevice));
  say('DONE');
  return 0;
}

let started = false;
function run(argv) {
  const m = argv[0];
  try {
    if (m === 'list') { list(); return ''; }
    if (m === 'probe') { probe(argv.slice(1)); return ''; }
    if (m === 'eject') { const d = find(argv[1] || ''); if (!d) { say('ERR||Привод не найден'); return ''; } d.ejectMedia; say('DONE'); return ''; }
    if (m === 'burn') {
      const c = burn(argv[1] || '', argv[2] || '', +argv[3] || 0, argv[4] === '1', argv[5] !== '0', Math.max(0, Math.min(60, +argv[6] || 0)), argv[7] === '1');
      if (c) $.exit(c);
      return '';
    }
    say('ERR||неизвестный режим');
  } catch (e) {
    if (m === 'burn' && !started) { say('NOSTART|' + e); $.exit(3); }
    say('ERR||' + e); if (m === 'burn') $.exit(1);
  }
  return '';
}
