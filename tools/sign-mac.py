#!/usr/bin/env python3
"""Подписывает сборки «Пульса» для Mac в релизе (mac.json) ключом разработчика.

Сборки для Mac (Pulse-Mac-Apple-M.zip, Pulse-Mac-Intel.zip и mac.json) собирает GitHub Actions уже после выхода
релиза. Ключа подписи на GitHub нет, поэтому mac.json приходит без подписей, и программа на Mac такую сборку
не берёт («сборка ещё готовится»). Этот скрипт скачивает mac.json и оба архива из релиза, сам сверяет размер
и SHA-256 каждого архива, подписывает их и выкладывает подписанный mac.json обратно в релиз.

  python3 tools/sign-mac.py 0.23.0                 — релиз v0.23.0 репозитория (нужен gh с доступом к репозиторию)
  python3 tools/sign-mac.py 0.23.0 --save <репо>   — не выкладывать самому, а положить в <репо>/updates/0.23.0/mac.json:
                                                     после отправки в main его прикрепит к релизу GitHub Actions
                                                     (workflow «Подпись сборок для Mac» сверяет подпись)
  python3 tools/sign-mac.py --dir <папка> <версия>  — mac.json и архивы в папке (для проверки, без GitHub)

Ключ: PULSE_SIGN_KEY=<путь к .pem> или ../pulse-update-keys/update-ed25519.pem рядом с папкой проекта.
"""
import base64, hashlib, json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.environ.get("PULSE_REPO", "oqelon/pulsmusic.develop")
NAMES = {"arm64": "Pulse-Mac-Apple-M.zip", "x64": "Pulse-Mac-Intel.zip"}


def key():
    p = os.environ.get("PULSE_SIGN_KEY") or os.path.join(os.path.dirname(ROOT), "pulse-update-keys", "update-ed25519.pem")
    if not os.path.isfile(p):
        sys.exit(f"Нет ключа подписи ({p})")
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    return load_pem_private_key(open(p, "rb").read(), password=None)


def gh(*a, **kw):
    return subprocess.run(["gh", *a], check=True, capture_output=True, **kw).stdout


def sign_dir(d, ver, k):
    m = json.load(open(os.path.join(d, "mac.json"), encoding="utf-8"))
    if m.get("version") != ver:
        sys.exit(f"mac.json — для версии {m.get('version')}, а не {ver}")
    for arch, name in NAMES.items():
        a = m.get(arch) or sys.exit(f"в mac.json нет сборки {arch}")
        b = open(os.path.join(d, name), "rb").read()
        if len(b) != a["size"] or hashlib.sha256(b).hexdigest() != a["sha256"].lower():
            sys.exit(f"{name}: размер или SHA-256 не совпадают с mac.json — не подписываю")
        msg = "\n".join(["PULSE-MAC-V1", ver, arch, a["sha256"].lower(), str(a["size"])])
        a["sig"] = base64.b64encode(k.sign(msg.encode("utf-8"))).decode()
        print(f"{name}: {len(b)} байт, SHA-256 {a['sha256'][:16]}… — подписан")
    json.dump(m, open(os.path.join(d, "mac.json"), "w", encoding="utf-8"), indent=2)


def main():
    args = sys.argv[1:]
    k = key()
    if args[:1] == ["--dir"]:
        sign_dir(args[1], args[2], k)
        return
    if not args:
        sys.exit(__doc__)
    ver = args[0]; tag = "v" + ver
    save = args[args.index("--save") + 1] if "--save" in args else None
    rel = json.loads(gh("api", f"repos/{REPO}/releases/tags/{tag}"))
    assets = {a["name"]: a["id"] for a in rel["assets"]}
    need = ["mac.json", *NAMES.values()]
    miss = [n for n in need if n not in assets]
    if miss:
        sys.exit("В релизе ещё нет: " + ", ".join(miss) + " — сборка для Mac не закончилась")
    with tempfile.TemporaryDirectory() as d:
        for n in need:
            data = gh("api", "-H", "Accept: application/octet-stream", f"repos/{REPO}/releases/assets/{assets[n]}")
            open(os.path.join(d, n), "wb").write(data)
        sign_dir(d, ver, k)
        if save:
            dst = os.path.join(save, "updates", ver, "mac.json"); os.makedirs(os.path.dirname(dst), exist_ok=True)
            open(dst, "wb").write(open(os.path.join(d, "mac.json"), "rb").read())
            print(f"Готово: подписанный mac.json — {dst}; отправьте в main, GitHub Actions прикрепит его к {tag}")
            return
        subprocess.run(["gh", "release", "upload", tag, os.path.join(d, "mac.json"), "-R", REPO, "--clobber"], check=True)
    print(f"Готово: подписанный mac.json выложен в релиз {tag}")


main()
