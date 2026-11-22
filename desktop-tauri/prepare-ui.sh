#!/usr/bin/env bash
# Готовит папку ui/ для тестовой сборки на Tauri:
#  • интерфейс «Пульса» — app-dist.zip: собран из исходников 0.38.0 с правками только для Tauri (они включаются,
#    когда есть window.__TAURI__; в Electron-версии ничего не меняется). Без него — выпущенный dist из updates/<версия>;
#  • рядом кладётся «Лаборатория звука» (ui-extra/lab.html) и мост window.pulse (bridge/, этап 4);
#  • в копии index.html к правилам безопасности (CSP) добавляется тестовая схема pulsetest:, иначе WebView не пустит
#    звук демо-треков. Исходники приложения при этом не меняются.
set -euo pipefail
cd "$(dirname "$0")"
VER="${1:-0.38.0}"
ZIP="../updates/$VER/pulse-app-$VER.zip"
[ -f "$ZIP" ] || { echo "нет $ZIP"; exit 1; }
rm -rf ui && mkdir -p ui
TMP="$(mktemp -d)"
unzip -q "$ZIP" yandex.js -d "$TMP"
# интерфейс: собранный для Tauri (app-dist.zip — из исходников с правками только для Tauri), иначе — выпущенный
if [ -f app-dist.zip ]; then unzip -q app-dist.zip 'dist/*' -d "$TMP"; echo "интерфейс: app-dist.zip (сборка для Tauri)"; else unzip -q "$ZIP" 'dist/*' -d "$TMP"; echo "интерфейс: $ZIP"; fi
cp -R "$TMP/dist/." ui/
cp ui-extra/lab.html ui/lab.html
# этап 4: мост window.pulse для Tauri (тот же yandex.js из этого выпуска, запросы через tauri-plugin-http)
node bridge/build.mjs "$TMP/yandex.js" ui
rm -rf "$TMP"
python3 - <<'PY'
import re, pathlib
p = pathlib.Path('ui/index.html'); s = p.read_text(encoding='utf-8')
add = ' pulsetest: http://pulsetest.localhost'
n0 = s
s = re.sub(r"(media-src [^;\"]*)", lambda m: m.group(1) + add, s, count=1)
s = re.sub(r"(connect-src [^;\"]*)", lambda m: m.group(1) + add, s, count=1)
assert s != n0, 'CSP не найден в index.html'
p.write_text(s, encoding='utf-8')
print('CSP:', re.search(r'content="([^"]*)"', s).group(1))
PY
echo "ui/ готов: $(ls ui | tr '\n' ' ')"
