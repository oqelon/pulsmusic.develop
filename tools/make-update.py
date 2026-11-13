#!/usr/bin/env python3
"""Готовит обновление «Пульса» для Windows: pulse-app-<версия>.zip и latest.json.

Описание обновления (notes) — официальным языком, 2–5 пунктов, с заглавной буквы, без жаргона:
  «Добавлен …», «Улучшена …», «Исправлена ошибка, из-за которой …».
Изменения защиты и служебных (разработческих) функций не расписываются: только общими словами —
  «Исправления ошибок и улучшения стабильности», «Повышена надёжность работы приложения».

Запуск из папки проекта:  python3 tools/make-update.py "Что нового 1" "Что нового 2" ...
Результат — папка release-update/: эти два файла (плюс установщик, если он лежит рядом) выкладываются
в новый релиз GitHub репозитория oqelon/pulsmusic.develop с тегом v<версия>.
Программа берёт latest.json из последнего релиза: …/releases/latest/download/latest.json

Подпись: latest.json подписывается закрытым ключом Ed25519 (см. updsign.js). Ключ — только у разработчика:
PULSE_SIGN_KEY=<путь к .pem> или ../pulse-update-keys/update-ed25519.pem рядом с папкой проекта. В репозиторий и на
GitHub ключ не кладётся. Без ключа обновление не готовится: программа не примет неподписанный пакет.
"""
import base64, hashlib, json, os, sys, zipfile, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.environ.get("PULSE_REPO", "oqelon/pulsmusic.develop")
ELECTRON_MIN = "33.2.1"
# адрес счётчика «сейчас онлайн» (online-server/, Cloudflare Worker); пусто — программы ничего не отправляют
ONLINE = os.environ.get("PULSE_ONLINE_URL", "")   # поднять, только если новой версии нужен другой Electron (тогда нужен и новый установщик)

pkg = json.load(open(os.path.join(ROOT, "package.json"), encoding="utf-8"))
ver = pkg["version"]
out = os.path.join(ROOT, "release-update")
os.makedirs(out, exist_ok=True)
name = f"pulse-app-{ver}.zip"
zpath = os.path.join(out, name)

files = ["main.js", "boot.js", "preload.js", "yandex.js", "updater.js", "updsign.js", "security.js", "online.js", "local.js", "yastream.js", "exebrand.js", "exebrand-worker.js", "perfwatch.js", "build/icon.png", "build/icon.ico"] + [
    "dist/" + f for f in sorted(os.listdir(os.path.join(ROOT, "dist")))]
for f in files:
    if not os.path.isfile(os.path.join(ROOT, f)):
        sys.exit(f"Нет файла {f} — сначала соберите интерфейс (dist)")

slim = {k: pkg[k] for k in ("name", "productName", "version", "description", "author") if k in pkg}
slim["main"] = "main.js"
slim["minElectron"] = ELECTRON_MIN   # загрузчик Mac (boot.js) не запустит версию, которой нужен более новый движок
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in files:
        z.write(os.path.join(ROOT, f), f)
    z.writestr("package.json", json.dumps(slim, ensure_ascii=False, indent=2))

data = open(zpath, "rb").read()
notes = [a for a in sys.argv[1:] if a.strip()] or ["Исправления ошибок и улучшения стабильности"]
latest = {
    "version": ver,
    "date": datetime.date.today().isoformat(),
    "notes": notes,
    "url": f"https://github.com/{REPO}/releases/download/v{ver}/{name}",
    "sha256": hashlib.sha256(data).hexdigest(),
    "size": len(data),
    "minElectron": ELECTRON_MIN,
    "installer": f"https://github.com/{REPO}/releases/latest",
}
if ONLINE:
    latest["online"] = ONLINE
key_path = os.environ.get("PULSE_SIGN_KEY") or os.path.join(os.path.dirname(ROOT), "pulse-update-keys", "update-ed25519.pem")
if not os.path.isfile(key_path):
    sys.exit(f"Нет ключа подписи обновлений ({key_path}) — обновление не подписано, выпускать нельзя")
from cryptography.hazmat.primitives.serialization import load_pem_private_key
key = load_pem_private_key(open(key_path, "rb").read(), password=None)
msg = "\n".join(["PULSE-UPDATE-V1", latest["version"], latest["sha256"].lower(), str(latest["size"]), latest["minElectron"] or ""])
latest["sig"] = base64.b64encode(key.sign(msg.encode("utf-8"))).decode()
json.dump(latest, open(os.path.join(out, "latest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"Готово: release-update/{name} ({len(data)//1024} КБ) и latest.json для версии {ver}")
