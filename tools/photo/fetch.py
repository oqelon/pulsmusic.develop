# Фото артиста для макетов: аватар из профиля на Яндекс Музыке (пробуем разные адреса), иначе — Википедия
import json, re, sys, urllib.request, urllib.parse
name = sys.argv[1]; out = sys.argv[2]
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"}
def get(u, h=None):
    return urllib.request.urlopen(urllib.request.Request(u, headers={**UA, **(h or {})}), timeout=20).read()
q = urllib.parse.quote(name)
tries = [
  "https://api.music.yandex.net/search?type=artist&page=0&text=" + q,
  "https://music.yandex.ru/handlers/music-search.jsx?type=artists&text=" + q,
  "https://music.yandex.com/handlers/music-search.jsx?type=artists&text=" + q,
  "https://music.yandex.ru/search?type=artists&text=" + q,
  "https://music.yandex.com/search?type=artists&text=" + q,
  "https://music.yandex.ru/artist/3308067",
  "https://music.yandex.ru/artist/3308067/info",
  "https://music.mts.ru/artist/3308067",
]
src = ""
for u in tries:
    try:
        b = get(u).decode("utf-8", "ignore"); m = re.search(r'avatars\.yandex\.net/get-music-content/[^"\'\s\\]+?%%', b) or re.search(r'"uri"\s*:\s*"(avatars\.yandex\.net[^"]+)"', b) or re.search(r'og:image"\s+content="https?://(avatars\.yandex\.net[^"]+)"', b) or re.search(r'(avatars\.yandex\.net/get-music-content/[^"\'\s\\)]+/(?:\d+x\d+|orig|%%))', b)
        print("ок", len(b), u, "→", m.group(0) if m else "фото не найдено", sorted(set(re.findall(r"https?://[^\"'\s<>]+?\.(?:jpe?g|png|webp)|https?://avatars[^\"'\s<>]+|https?://[^\"'\s<>]*(?:image|cover|img)[^\"'\s<>]*", b)))[:12])
        if m and not src: src = "https://" + re.sub(r"/(\d+x\d+|orig|%%)$", "/1000x1000", (m.group(1) if m.lastindex else m.group(0)))
    except Exception as e:
        print("нет", u, e)
if src:
    try: open(out, "wb").write(get(src)); print("Яндекс фото сохранено", src); sys.exit(0)
    except Exception as e: print("не скачалось", src, e)
print("оставляю прежнее фото")
