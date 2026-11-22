#!/usr/bin/env python3
"""Подписи выпуска Tauri-версии (делает только разработчик, своим ключом; ключа в репозитории нет).

Берёт архивы из релиза v<версия> (собраны workflow «Tauri — выпуск»), считает SHA-256 и размер, подписывает и кладёт
в updates/<версия>/ (ветка main):
  mac.json  — Pulse.app для Apple M и Intel        «PULSE-MAC-V1 \\n версия \\n arm64|x64 \\n sha256 \\n размер»
  win.json  — установщик Windows                    «PULSE-WIN-V1 \\n версия \\n x64 \\n sha256 \\n размер»
  pulse-app-<версия>.zip — переходное обновление обычного «Пульса» (tools/make-bridge.py)
и, только с ключом --live, updates/latest.json — с этого момента обычный «Пульс» начинает переход.
   python3 tools/sign-release.py 0.39.0 <ключ .pem> <папка репозитория на ветке main> [--live]
"""
import hashlib, json, os, subprocess, sys, datetime

ver, key, repo_dir = sys.argv[1], sys.argv[2], sys.argv[3]
live = "--live" in sys.argv
REPO = "oqelon/pulsmusic.develop"
PKG = f"https://github.com/{REPO}/releases/download/v{ver}/"
here = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(repo_dir, "updates", ver)
os.makedirs(out, exist_ok=True)

def sign(msg):
    p = subprocess.run(["node", "-e", "const c=require('crypto'),fs=require('fs');process.stdout.write(c.sign(null,Buffer.from(process.argv[1]),c.createPrivateKey(fs.readFileSync(process.argv[2]))).toString('base64'))", msg, key], check=True, capture_output=True, text=True)
    return p.stdout

def asset(name):
    rel = json.loads(subprocess.run(["gh", "api", f"repos/{REPO}/releases/tags/v{ver}"], check=True, capture_output=True, text=True).stdout)
    a = next(x for x in rel["assets"] if x["name"] == name)
    p = subprocess.run(["gh", "api", "-H", "Accept: application/octet-stream", f"repos/{REPO}/releases/assets/{a['id']}"], check=True, capture_output=True)
    b = p.stdout
    assert len(b) == a["size"], f"{name}: скачалось {len(b)} из {a['size']}"
    return {"url": PKG + name, "sha256": hashlib.sha256(b).hexdigest(), "size": len(b)}

NOTES = {
    "0.39.0": ["Новая версия «Пульса»: свой звуковой движок — быстрее и легче", "Новая карточка исполнителя: фото во всю шапку, «Об исполнителе» — отдельной кнопкой", "Лайки, плейлисты, история, вход и ключи друзей переносятся сами"],
    "0.42.0": ["Mac больше не спрашивает пароль от связки ключей после каждого обновления: вход хранится в защищённом файле «Пульса» (после этого обновления спросит в последний раз)", "Фото исполнителя видно целиком", "С обычного «Пульса» — переход на новую версию: данные и вход переносятся сами"],
    "0.41.0": ["Карточка исполнителя: фото исполнителя видно целиком — голова больше не уходит за край", "Новая шапка исполнителя и точки у популярных треков в альбоме — из 0.40", "С обычного «Пульса» — переход на новую версию: данные и вход переносятся сами"],
    "0.40.0": ["Карточка исполнителя: фото мягко растворяется в фоне, галочка — под именем", "При прокрутке шапка исполнителя красиво уходит вглубь", "В альбоме самые популярные треки отмечены точкой вместо номера", "С обычного «Пульса» — переход на новую версию: данные и вход переносятся сами"],
}
mac = {"version": ver, "engine": "tauri"}
for arch, name in (("arm64", "Pulse-Mac-Apple-M.zip"), ("x64", "Pulse-Mac-Intel.zip")):
    a = asset(name); a["sig"] = sign("\n".join(["PULSE-MAC-V1", ver, arch, a["sha256"], str(a["size"])])); mac[arch] = a
win = {"version": ver, "engine": "tauri"}
a = asset("Pulse-Windows-Setup.exe"); a["sig"] = sign("\n".join(["PULSE-WIN-V1", ver, "x64", a["sha256"], str(a["size"])])); win["x64"] = a
json.dump(mac, open(os.path.join(out, "mac.json"), "w"), indent=2)
json.dump(win, open(os.path.join(out, "win.json"), "w"), indent=2)

zp = os.path.join(out, f"pulse-app-{ver}.zip")
subprocess.run([sys.executable, os.path.join(here, "make-bridge.py"), ver, zp], check=True)
b = open(zp, "rb").read()
prev = json.load(open(os.path.join(repo_dir, "updates", "latest.json")))
lat = {"version": ver, "url": PKG + f"pulse-app-{ver}.zip", "sha256": hashlib.sha256(b).hexdigest(), "size": len(b), "minElectron": prev.get("minElectron", "33.2.1"),
       "date": datetime.date.today().isoformat(), "installer": f"https://github.com/{REPO}/releases/latest",
       "notes": NOTES.get(ver, NOTES["0.39.0"])}
# engine: "tauri" — с 0.40.0: по этому полю уже установленная Tauri-версия понимает, что релиз — для неё
# (обычный «Пульс» на Electron поле не читает и, как раньше, получает переходный пакет). В подпись поле не входит —
# скачанная программа всё равно проверяется по mac.json / win.json и по своему package.json.
if ver != "0.39.0": lat["engine"] = "tauri"
for k in ("online",):
    if k in prev: lat[k] = prev[k]
lat["sig"] = sign("\n".join(["PULSE-UPDATE-V1", ver, lat["sha256"], str(lat["size"]), lat["minElectron"]]))
json.dump(lat, open(os.path.join(out, "latest.json"), "w"), indent=2, ensure_ascii=False)
if live:
    json.dump(lat, open(os.path.join(repo_dir, "updates", "latest.json"), "w"), indent=2, ensure_ascii=False)
print("готово:", out, "(updates/latest.json обновлён)" if live else "(updates/latest.json не тронут — без --live)")
