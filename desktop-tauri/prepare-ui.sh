#!/usr/bin/env bash
# Готовит папку ui/ для тестовой сборки на Tauri:
#  • интерфейс «Пульса» берётся из уже выпущенного обновления (updates/<версия>/pulse-app-<версия>.zip, папка dist/) —
#    тот же самый, что у пользователей Electron-версии, без изменений;
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
unzip -q "$ZIP" 'dist/*' yandex.js -d "$TMP"
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
