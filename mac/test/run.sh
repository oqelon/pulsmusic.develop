#!/bin/bash
# Проверка обновлений «Пульса» на настоящем Mac (GitHub Actions, macos-latest) — путь настоящего пользователя:
#  1) стоит старая Pulse.app (pulse-app.zip, загрузчик без проверки подписи) и обновляется по воздуху на новый код;
#  2) новый код видит старый загрузчик и сам, в фоне, скачивает Pulse.app целиком (подписанный mac.json);
#     пока mac.json не подписан — такую сборку не берёт; после выхода из программы (SIGTERM) Pulse.app заменяется
#     тихо, без запуска; следующий запуск — новая Pulse.app с новым загрузчиком;
#  3) обычное обновление тихо скачивается в фоне и ставится по «Перезапустить»; в ota/ рядом пакет и подпись;
#  4) файл в ota/ подменили — загрузчик не запускает эту версию, открывается встроенная;
#  5) файл обновлений с чужой подписью — программа отказывается.
# Ключ подписи — тестовый, создаётся здесь же (PULSE_UPDATE_PUBKEY работает только вместе с PULSE_UPDATE_FEED).
set -euo pipefail
cd "$(dirname "$0")"; T="$PWD"; R="$(cd ../.. && pwd)"
OLD="$T/pulse-app.zip"; NEW="$T/pulse-app-new.zip"
V0=$(unzip -p "$OLD" package.json | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
bump() { python3 -c "import sys;a=sys.argv[1].split('.');a[-1]=str(int(a[-1])+int(sys.argv[2]));print('.'.join(a))" "$1" "$2"; }
V1=$(bump "$V0" 1); V2=$(bump "$V0" 2); V3=$(bump "$V0" 3)
W="$(mktemp -d)"; F="$W/feed"; mkdir -p "$F" "$W/Apps"
# пакет нового кода с другой версией
repack() { rm -rf "$W/p"; mkdir "$W/p"; (cd "$W/p" && unzip -q "$NEW" && python3 -c "import json,sys;p='package.json';d=json.load(open(p));d['version']=sys.argv[1];json.dump(d,open(p,'w'))" "$1" && rm -f "$2" && zip -qr "$2" .); }
cat > "$W/sign.js" <<'JS'
// node sign.js gen | pkg <latest.json> | mac <mac.json> <версия>
const fs = require('fs'), c = require('crypto'), K = __dirname + '/test.pem';
const [mode, file, ver] = process.argv.slice(2);
if (mode === 'gen') {
  const { privateKey, publicKey } = c.generateKeyPairSync('ed25519');
  fs.writeFileSync(K, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  console.log(publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64')); process.exit(0);
}
const key = c.createPrivateKey(fs.readFileSync(K));
const sig = (s) => c.sign(null, Buffer.from(s, 'utf8'), key).toString('base64');
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
if (mode === 'pkg') m.sig = sig(['PULSE-UPDATE-V1', m.version, m.sha256.toLowerCase(), String(m.size), m.minElectron || ''].join('\n'));
if (mode === 'mac') for (const a of ['arm64', 'x64']) m[a].sig = sig(['PULSE-MAC-V1', ver, a, m[a].sha256.toLowerCase(), String(m[a].size)].join('\n'));
if (mode === 'badpkg') m.sig = Buffer.alloc(64, 9).toString('base64');
fs.writeFileSync(file, JSON.stringify(m));
JS
export PULSE_UPDATE_PUBKEY="$(node "$W/sign.js" gen)"
feed() {   # feed <версия> <пакет> <minElectron> [pkg|badpkg]
  python3 - "$F" "$1" "$2" "$3" <<'PY'
import hashlib, json, sys
F, v, zipname, minel = sys.argv[1:5]
b = open(f"{F}/{zipname}", "rb").read()
json.dump({"version": v, "notes": ["проверка"], "url": f"http://localhost:8898/{zipname}", "sha256": hashlib.sha256(b).hexdigest(), "size": len(b), "minElectron": minel}, open(f"{F}/latest.json", "w"))
PY
  node "$W/sign.js" "${4:-pkg}" "$F/latest.json"
}
macjson() {   # macjson <версия> [mac]
  python3 - "$F" "$1" <<'PY'
import hashlib, json, sys
F, v = sys.argv[1:3]
b = open(f"{F}/Pulse-Mac-Apple-M.zip", "rb").read()
a = {"url": "http://localhost:8898/Pulse-Mac-Apple-M.zip", "sha256": hashlib.sha256(b).hexdigest(), "size": len(b)}
json.dump({"version": v, "electron": "33.2.1", "arm64": a, "x64": dict(a)}, open(f"{F}/mac.json", "w"))
PY
  if [ "${2:-}" = mac ]; then node "$W/sign.js" mac "$F/mac.json" "$1"; fi
}
echo "== сборка $V0 (старая) и $V2 (новый код)"
bash "$R/mac/build.sh" "$V0" arm64 "$OLD" "$W/a.zip"
ditto -x -k "$W/a.zip" "$W/Apps"
repack "$V2" "$W/app-$V2.zip"
bash "$R/mac/build.sh" "$V2" arm64 "$W/app-$V2.zip" "$F/Pulse-Mac-Apple-M.zip"
repack "$V1" "$F/pulse-app-$V1.zip"
repack "$V2" "$F/pulse-app-$V2.zip"
repack "$V3" "$F/pulse-app-$V3.zip"
( cd "$F" && python3 -m http.server 8898 >/dev/null 2>&1 & )
(cd "$W" && npm i --silent --no-save playwright-core@1.48.2 >/dev/null 2>&1)
cat > "$W/cdp.js" <<'JS'
// node cdp.js <ожидаемая версия> [install|check|prepare|restart|badsig]
const { chromium } = require('playwright-core');
(async () => {
  let b; for (let i = 0; i < 40; i++) { try { b = await chromium.connectOverCDP('http://localhost:9450'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
  if (!b) { console.log('нет связи с программой'); process.exit(2); }
  let p; for (let i = 0; i < 20 && !p; i++) { p = b.contexts()[0] && b.contexts()[0].pages()[0]; if (!p) await new Promise((r) => setTimeout(r, 500)); }
  await p.waitForFunction(() => window.pulse && window.pulse.update, null, { timeout: 30000 });
  const ev = (s) => p.evaluate(s);
  const v = await ev('window.pulse.version()'); console.log('версия', JSON.stringify(v));
  if (process.argv[2] && v.version !== process.argv[2]) { console.log('ожидалась', process.argv[2]); process.exit(1); }
  const mode = process.argv[3]; let out = 0;
  if (mode) { const c = await ev('window.pulse.update.check()'); console.log('проверка', JSON.stringify(c)); globalThis.c = c; }
  if (mode === 'install') {
    const r = await ev('window.pulse.update.install()'); console.log('установка', JSON.stringify(r));
    if (!r.ok) process.exit(1);
    ev('window.pulse.update.restart()').catch(() => {});
  }
  if (mode === 'check') console.log('CHECK=' + JSON.stringify(globalThis.c));
  if (mode === 'prepare') {
    const r = await ev('window.pulse.update.prepare()'); console.log('PREPARE=' + JSON.stringify(r));
    if (!r.ok) out = 1;
  }
  if (mode === 'restart') ev('window.pulse.update.restart()').catch(() => {});
  if (mode === 'badsig') { const c = globalThis.c; if (c.ok || !/подпис/.test(c.error)) { console.log('чужая подпись не отклонена'); out = 1; } else console.log('чужая подпись отклонена: ' + c.error); }
  setTimeout(() => process.exit(out), 1000);
})();
JS
APP="$W/Apps/Pulse.app"; EXE="$APP/Contents/MacOS/Pulse"; UD="$HOME/Library/Application Support/Pulse"; LOG="$UD/logs/pulse.log"
start() { PULSE_UPDATE_FEED=http://localhost:8898/latest.json "$EXE" --remote-debugging-port=9450 >> "$W/run.log" 2>&1 & sleep 3; }
mainpid() { pgrep -f "MacOS/Pulse --remote-debugging-port" | head -1; }
stopapp() {   # обычный выход (как Cmd+Q / выключение): SIGTERM → before-quit
  local p; p=$(mainpid || true); [ -n "$p" ] || return 0
  kill -TERM "$p"; for i in $(seq 1 30); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
  pkill -9 -f "$APP/Contents" 2>/dev/null || true; sleep 1
}
fail() { echo "ПРОВАЛ: $*"; tail -20 "$LOG" || true; exit 1; }
cd "$W"

echo "== 1. старая Pulse.app $V0 → $V1 по воздуху (новый код)"
feed "$V1" "pulse-app-$V1.zip" 33.2.1
start
node cdp.js "$V0" install || fail "старая программа не поставила обновление"
sleep 6
node cdp.js "$V1" || fail "не запустилась $V1"
sleep 15   # фоновая проверка через 10 с после запуска — пусть пройдёт, пока новой версии нет

echo "== 2. новый код + старый загрузчик → Pulse.app целиком, в фоне, замена при выходе"
macjson "$V2"   # пока без подписи
feed "$V2" "pulse-app-$V2.zip" 33.2.1
node cdp.js "$V1" check | tee "$W/c2.txt"
grep -q '"engine":false' "$W/c2.txt" || fail "неподписанная сборка для Mac принята"
macjson "$V2" mac
node cdp.js "$V1" prepare | tee "$W/p2.txt"
grep -q '"engine":true' "$W/p2.txt" || fail "не скачалась Pulse.app целиком"
stopapp
for i in $(seq 1 60); do [ "$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")" = "$V2" ] && break; sleep 1; done
[ "$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")" = "$V2" ] || fail "Pulse.app не заменилась при выходе"
sleep 2; pgrep -f "$APP/Contents/MacOS/Pulse" >/dev/null && fail "после выхода программа запустилась сама" || echo "Pulse.app заменена на $V2 при выходе, сама не запускалась"
codesign --verify --deep --strict "$APP" && echo "подпись новой программы в порядке"
start
node cdp.js "$V2" || fail "не запустилась новая Pulse.app"

echo "== 3. обычное обновление $V2 → $V3: тихо в фоне, затем «Перезапустить»"
feed "$V3" "pulse-app-$V3.zip" 33.2.1
node cdp.js "$V2" prepare | tee "$W/p3.txt"
grep -q "\"version\":\"$V3\",\"engine\":false" "$W/p3.txt" || fail "обычное обновление не подготовилось"
test -f "$UD/ota/$V3/.pulse-sig.json" && test -f "$UD/ota/$V3/.pulse-pkg.zip" || fail "в ota/ нет пакета и подписи"
node cdp.js "$V2" restart
sleep 6
node cdp.js "$V3" || fail "после перезапуска не $V3"

echo "== 4. файл в ota/ подменили → запускается встроенная"
stopapp
echo "// чужой код" >> "$UD/ota/$V3/main.js"
start
node cdp.js "$V2" || fail "запустилась подменённая версия"
grep -q "версия $V3 в ota/ не прошла проверку подписи" "$LOG" && echo "загрузчик отказался от подменённой папки"

echo "== 5. файл обновлений с чужой подписью"
feed "$V3" "pulse-app-$V3.zip" 33.2.1 badpkg
node cdp.js "$V2" badsig || fail "чужая подпись принята"
stopapp
echo "ГОТОВО: все проверки пройдены"
