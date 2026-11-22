#!/usr/bin/env python3
# Тестовый канал обновлений Tauri-версии (этап 6.2): для предрелиза tauri-test-<N> готовит test-latest.json и mac.json,
# подписанные ТЕСТОВЫМ ключом (закрытый ключ — только у разработчика, вне репозитория; путь — аргументом),
# и выкладывает их в тот же предрелиз. Тестовая сборка с более старым номером, переключённая в лаборатории на адрес
# test-latest.json, скачает эту сборку, проверит подпись и сумму и заменит себя на неё.
#   python3 tools/test-feed.py <N> <путь к тестовому закрытому ключу .pem>
import hashlib, json, os, subprocess, sys, tempfile

n, key = sys.argv[1], sys.argv[2]
repo = "oqelon/pulsmusic.develop"
tag = f"tauri-test-{n}"
zipname = "Pulse-Tauri-Test-Mac-Apple-M.zip"
d = tempfile.mkdtemp()
subprocess.run(["gh", "release", "download", tag, "-R", repo, "-p", zipname, "-D", d], check=True)
b = open(os.path.join(d, zipname), "rb").read()
url = f"https://github.com/{repo}/releases/download/{tag}/{zipname}"
sha, size, ver = hashlib.sha256(b).hexdigest(), len(b), "0.38.0"

def sign(msg):
    p = subprocess.run(["node", "-e", "const c=require('crypto'),fs=require('fs');process.stdout.write(c.sign(null,Buffer.from(process.argv[1]),c.createPrivateKey(fs.readFileSync(process.argv[2]))).toString('base64'))", msg, key], check=True, capture_output=True, text=True)
    return p.stdout

a = {"url": url, "sha256": sha, "size": size}
a["sig"] = sign("\n".join(["PULSE-MAC-V1", ver, "arm64", sha, str(size)]))
mac = {"version": ver, "engine": "tauri", "arm64": a}
lat = {"version": ver, "engine": "tauri", "build": int(n), "url": url, "sha256": sha, "size": size, "minElectron": "999.0.0",
       "notes": [f"Тестовая сборка №{n}"]}
lat["sig"] = sign("\n".join(["PULSE-UPDATE-V1", ver, sha, str(size), lat["minElectron"]]))
json.dump(mac, open(os.path.join(d, "mac.json"), "w"), indent=2)
json.dump(lat, open(os.path.join(d, "test-latest.json"), "w"), indent=2, ensure_ascii=False)
subprocess.run(["gh", "release", "upload", tag, os.path.join(d, "mac.json"), os.path.join(d, "test-latest.json"), "-R", repo, "--clobber"], check=True)
print(f"https://github.com/{repo}/releases/download/{tag}/test-latest.json")
