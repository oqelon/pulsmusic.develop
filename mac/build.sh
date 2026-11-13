#!/bin/bash
# Сборка «Пульса» для Mac (запускается на Mac — в GitHub Actions, на macos-latest).
#   mac/build.sh <версия> <arm64|x64> <pulse-app-версия.zip> <куда положить .zip>
# Берёт официальный Electron для macOS (сверка SHA-256), кладёт в него файлы «Пульса», переименовывает в Pulse.app,
# подписывает (ad-hoc: подписи Apple Developer у проекта нет) и проверяет подпись. Внутри — загрузчик boot.js:
# он запускает обновления, скачанные программой в ~/Library/Application Support/Pulse/ota/.
set -euo pipefail
VER="$1"; ARCH="$2"; APPZIP="$(cd "$(dirname "$3")" && pwd)/$(basename "$3")"; OUT="$4"
HERE="$(cd "$(dirname "$0")" && pwd)"
EV=33.2.1
case "$ARCH" in
  arm64) SHA=15615ce68c1a31b0db186af8607c00a30e3f64e63642aab735b4997d0fab7631 ;;
  x64)   SHA=d4ba6779efea1034b98d6ad3aef5388c16a4fe2f8938cbeb6a6547ebfe4c7bda ;;
  *) echo "неизвестная архитектура $ARCH"; exit 1 ;;
esac
W="$(mktemp -d)"
# Electron берётся из кэша GitHub Actions (ELECTRON_CACHE), если он там есть: GitHub иногда отвечает 504 на скачивание
EC="${ELECTRON_CACHE:-}"; EN="electron-v$EV-darwin-$ARCH.zip"
if [ -n "$EC" ] && [ -f "$EC/$EN" ] && echo "$SHA  $EC/$EN" | shasum -a 256 -c - >/dev/null 2>&1; then cp "$EC/$EN" "$W/e.zip"
else
  # GitHub — основной адрес; если он отвечает ошибками — зеркало (файл тот же: ниже сверка SHA-256)
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 8 -o "$W/e.zip" "https://github.com/electron/electron/releases/download/v$EV/$EN" \
    || curl -fsSL --retry 5 --retry-all-errors --retry-delay 8 -o "$W/e.zip" "https://npmmirror.com/mirrors/electron/$EV/$EN"
  echo "$SHA  $W/e.zip" | shasum -a 256 -c -
  if [ -n "$EC" ]; then mkdir -p "$EC" && cp "$W/e.zip" "$EC/$EN"; fi
fi
echo "$SHA  $W/e.zip" | shasum -a 256 -c -
ditto -x -k "$W/e.zip" "$W/e"
mv "$W/e/Electron.app" "$W/Pulse.app"
R="$W/Pulse.app/Contents/Resources"
rm -f "$R/default_app.asar"
mkdir "$R/app"
ditto -x -k "$APPZIP" "$R/app"
test -f "$R/app/boot.js" && test -f "$R/app/main.js" && test -f "$R/app/dist/index.html"
cp "$HERE/pulse.icns" "$R/electron.icns"
python3 - "$W/Pulse.app" "$VER" <<'PY'
import json, plistlib, sys, os
app, ver = sys.argv[1], sys.argv[2]
pj = os.path.join(app, "Contents/Resources/app/package.json")
p = json.load(open(pj, encoding="utf-8"))
assert p["version"] == ver, "версия пакета не совпадает"
p["main"] = "boot.js"
json.dump(p, open(pj, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
ip = os.path.join(app, "Contents/Info.plist")
d = plistlib.load(open(ip, "rb"))
d.update({"CFBundleName": "Pulse", "CFBundleDisplayName": "Pulse", "CFBundleIdentifier": "ru.pulse.desktop",
          "CFBundleShortVersionString": ver, "CFBundleVersion": ver, "LSApplicationCategoryType": "public.app-category.music",
          "NSHumanReadableCopyright": "© 2026 Пульс"})
d["CFBundleExecutable"] = "Pulse"
os.rename(os.path.join(app, "Contents/MacOS/Electron"), os.path.join(app, "Contents/MacOS/Pulse"))
# помощники Electron → «Pulse Helper…» (как у electron-packager): Electron ищет их по имени программы
fw = os.path.join(app, "Contents/Frameworks")
for suf, bid in (("", "helper"), (" (GPU)", "helper.GPU"), (" (Plugin)", "helper.Plugin"), (" (Renderer)", "helper.Renderer")):
    old, new = os.path.join(fw, f"Electron Helper{suf}.app"), os.path.join(fw, f"Pulse Helper{suf}.app")
    os.rename(old, new)
    os.rename(os.path.join(new, f"Contents/MacOS/Electron Helper{suf}"), os.path.join(new, f"Contents/MacOS/Pulse Helper{suf}"))
    hp = os.path.join(new, "Contents/Info.plist"); h = plistlib.load(open(hp, "rb"))
    h.update({"CFBundleExecutable": f"Pulse Helper{suf}", "CFBundleName": f"Pulse Helper{suf}", "CFBundleIdentifier": f"ru.pulse.desktop.{bid}"})
    h.pop("CFBundleDisplayName", None)
    plistlib.dump(h, open(hp, "wb"))
for k in ("ElectronAsarIntegrity", "NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription"):
    d.pop(k, None)
plistlib.dump(d, open(ip, "wb"))
PY
codesign --force --deep --sign - "$W/Pulse.app"
codesign --verify --deep --strict --verbose=2 "$W/Pulse.app"
rm -f "$OUT"
ditto -c -k --sequesterRsrc --keepParent "$W/Pulse.app" "$OUT"
# для самопроверки на этом же Mac
rm -rf "$W/e" "$W/e.zip"
echo "$W/Pulse.app" > "$OUT.path"
ls -la "$OUT"
