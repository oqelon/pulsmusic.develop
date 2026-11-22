#!/usr/bin/env python3
"""Переходное обновление обычного «Пульса» (Electron) на Tauri-версию: pulse-app-<версия>.zip.

Пакет = выпущенный pulse-app-0.38.0.zip, в котором заменён updater.js (electron-bridge/updater.js — блок «переход на
Tauri-версию») и версия в package.json. Больше ничего не меняется: интерфейс и остальные файлы — как в 0.38.0.
   python3 tools/make-bridge.py 0.39.0 <куда положить zip>
"""
import io, json, os, sys, zipfile

ver, out = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
base = os.path.join(here, "..", "..", "updates", "0.38.0", "pulse-app-0.38.0.zip")
upd = open(os.path.join(here, "..", "electron-bridge", "updater.js"), "rb").read()
assert b"MOVE_V = '" + ver.encode() + b"'" in upd, "версия в electron-bridge/updater.js (MOVE_V) не совпадает"
zin = zipfile.ZipFile(base)
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for it in sorted(zin.infolist(), key=lambda i: i.filename):
        data = zin.read(it.filename)
        if it.filename == "updater.js": data = upd
        if it.filename == "package.json":
            p = json.loads(data); p["version"] = ver; data = (json.dumps(p, ensure_ascii=False, indent=2) + "\n").encode()
        zi = zipfile.ZipInfo(it.filename, date_time=(2026, 11, 23, 0, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED; zi.external_attr = it.external_attr
        z.writestr(zi, data)
print(out, os.path.getsize(out))
