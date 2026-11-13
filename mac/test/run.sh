#!/bin/bash
# Проверка обновлений «Пульса» на настоящем Mac (GitHub Actions, macos-latest):
#  1) обычное обновление по воздуху: 0.0.0+1 скачивается в ~/Library/Application Support/Pulse/ota и запускается;
#  2) обновление движка: скачивается новая Pulse.app целиком, после выхода заменяет старую и запускается.
set -euo pipefail
cd "$(dirname "$0")"; T="$PWD"; R="$(cd ../.. && pwd)"
ZIP="$T/pulse-app.zip"
V0=$(unzip -p "$ZIP" package.json | python3 -c "import json,sys;print(json.load(sys.stdin)['version'])")
bump() { python3 -c "import sys;a=sys.argv[1].split('.');a[-1]=str(int(a[-1])+int(sys.argv[2]));print('.'.join(a))" "$1" "$2"; }
V1=$(bump "$V0" 1); V2=$(bump "$V0" 2)
W="$(mktemp -d)"; F="$W/feed"; mkdir -p "$F" "$W/Apps"
# пакет с другой версией
repack() { rm -rf "$W/p"; mkdir "$W/p"; (cd "$W/p" && unzip -q "$ZIP" && python3 -c "import json,sys;p='package.json';d=json.load(open(p));d['version']=sys.argv[1];json.dump(d,open(p,'w'))" "$1" && zip -qr "$2" .); }
repack "$V1" "$F/pulse-app-$V1.zip"
repack "$V2" "$W/app-$V2.zip"
feed() { python3 - "$@" <<'PY'
import hashlib, json, sys
F, v, zipname, minel = sys.argv[1:5]
b = open(f"{F}/{zipname}", "rb").read()
json.dump({"version": v, "notes": ["проверка"], "url": f"http://localhost:8898/{zipname}", "sha256": hashlib.sha256(b).hexdigest(), "size": len(b), "minElectron": minel}, open(f"{F}/latest.json", "w"))
PY
}
echo "== сборка $V0 и $V2"
bash "$R/mac/build.sh" "$V0" arm64 "$ZIP" "$W/a.zip"
ditto -x -k "$W/a.zip" "$W/Apps"
bash "$R/mac/build.sh" "$V2" arm64 "$W/app-$V2.zip" "$F/Pulse-Mac-Apple-M.zip"
( cd "$F" && python3 -m http.server 8898 >/dev/null 2>&1 & )
(cd "$W" && npm i --silent --no-save playwright-core@1.48.2 >/dev/null 2>&1)
cat > "$W/cdp.js" <<'JS'
const { chromium } = require('playwright-core');
(async () => {
  let b; for (let i = 0; i < 40; i++) { try { b = await chromium.connectOverCDP('http://localhost:9450'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
  if (!b) { console.log('нет связи с программой'); process.exit(2); }
  let p; for (let i = 0; i < 20 && !p; i++) { p = b.contexts()[0] && b.contexts()[0].pages()[0]; if (!p) await new Promise((r) => setTimeout(r, 500)); }
  await p.waitForFunction(() => window.pulse && window.pulse.update, null, { timeout: 30000 });
  const ev = (s) => p.evaluate(s);
  const v = await ev('window.pulse.version()'); console.log('версия', JSON.stringify(v));
  if (process.argv[2] && v.version !== process.argv[2]) { console.log('ожидалась', process.argv[2]); process.exit(1); }
  if (process.argv[3] === 'install') {
    const c = await ev('window.pulse.update.check()'); console.log('проверка', JSON.stringify(c));
    const r = await ev('window.pulse.update.install()'); console.log('установка', JSON.stringify(r));
    if (!r.ok) process.exit(1);
    ev('window.pulse.update.restart()').catch(() => {});
  }
  setTimeout(() => process.exit(0), 1000);
})();
JS
APP="$W/Apps/Pulse.app"; EXE="$APP/Contents/MacOS/Pulse"; LOG="$HOME/Library/Application Support/Pulse/logs/pulse.log"
start() { PULSE_UPDATE_FEED=http://localhost:8898/latest.json "$EXE" --remote-debugging-port=9450 >> "$W/run.log" 2>&1 & }
cd "$W"
echo "== 1. обычное обновление $V0 → $V1"
feed "$F" "$V1" "pulse-app-$V1.zip" 33.2.1
start; sleep 3
node cdp.js "$V0" install
sleep 6
node cdp.js "$V1"
cat "$HOME/Library/Application Support/Pulse/ota/state.json"; echo
echo "== 2. обновление движка $V1 → $V2 (целиком новая Pulse.app)"
cp "$F/Pulse-Mac-Apple-M.zip" "$F/x.zip"
python3 - "$F" "$V2" <<'PY'
import hashlib, json, sys
F, v = sys.argv[1:3]
b = open(f"{F}/Pulse-Mac-Apple-M.zip", "rb").read()
json.dump({"version": v, "arm64": {"url": "http://localhost:8898/Pulse-Mac-Apple-M.zip", "sha256": hashlib.sha256(b).hexdigest(), "size": len(b)}, "x64": {"url": "http://localhost:8898/x.zip", "sha256": hashlib.sha256(b).hexdigest(), "size": len(b)}}, open(f"{F}/mac.json", "w"))
PY
feed "$F" "$V2" "x.zip" 33.2.2   # «нужен движок новее» — программа должна взять целую Pulse.app
node cdp.js "$V1" install
for i in $(seq 1 60); do grep -q "запуск $V2" "$LOG" 2>/dev/null && break; sleep 1; done
plutil -p "$APP/Contents/Info.plist" | grep CFBundleShortVersionString
codesign --verify --deep --strict "$APP" && echo "подпись новой программы в порядке"
tail -5 "$LOG"
awk -v v="запуск $V2" 'index($0,v){f=1} f&&/окно показано/{ok=1} END{exit !ok}' "$LOG" && echo "ГОТОВО: обе проверки пройдены" || { echo "новая версия не запустилась"; exit 1; }
