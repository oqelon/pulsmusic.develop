# Тестовый «трек»: каждое слово синтезируется отдельно (espeak-ng) и ставится в известное время поверх простой «музыки»
# (аккорды + бочка + шум). Так у каждого слова есть точное время начала — с ним и сравнивается разметка ИИ.
import json, random, subprocess, sys, wave, struct, math, os, tempfile
SR = 16000
random.seed(7)
LINES = [
    ("ru", "Я давно не слышал твой голос"), ("ru", "Город гаснет, но я не сплю"),
    ("ru", "Каждый свет в окне как сигнал"), ("ru", "Что ты где-то рядом со мной"),
    ("en", "Hold me closer every night"), ("en", "We are dancing in the light"),
    ("ru", "Сердце бьётся в ритме огней (огней)"), ("ru", "Пока не рассвело над этой рекой"),
    ("en", "Never let me go tonight"), ("ru", "Пусть горят огни большого города"),
]
def synth(word, lang):
    f = tempfile.mktemp(suffix=".wav")
    subprocess.run(["espeak-ng", "-v", lang, "-s", "165", "-w", f, word], check=True)
    w = wave.open(f); sr = w.getframerate(); fr = w.readframes(w.getnframes()); w.close(); os.remove(f)
    x = [s / 32768 for s in struct.unpack("<%dh" % (len(fr) // 2), fr)]
    if sr != SR: x = [x[int(i * sr / SR)] for i in range(int(len(x) * SR / sr))]
    # обрезаем тишину по краям — время начала слова = первый звук
    th = 0.02; a = next((i for i, v in enumerate(x) if abs(v) > th), 0); b = len(x) - next((i for i, v in enumerate(reversed(x)) if abs(v) > th), 0)
    return x[a:b]
voice, truth, lrc = [], [], []
t = 1.5
for lang, text in LINES:
    words = [w.strip("(),.") for w in text.split()]
    # вся строка целиком (естественная интонация), а время слов — по длительностям слов, синтезированных по одному,
    # растянутым на длину строки (точность такой «правды» ~0,1 с)
    full = synth(" ".join(words), lang)
    lens = [len(synth(w, lang)) for w in words]; tot = sum(lens)
    start = int(t * SR)
    if len(voice) < start + len(full): voice += [0.0] * (start + len(full) - len(voice))
    for i, v in enumerate(full): voice[start + i] += v
    acc = 0; ws = []
    for L in lens: ws.append(round(t + acc / tot * len(full) / SR, 3)); acc += L
    truth.append(ws)
    lrc.append({"t": round(max(0, t + random.uniform(-0.3, 0.25)), 2), "text": text})   # LRC неточный, как в жизни
    t += len(full) / SR + random.uniform(0.6, 1.4)
dur = t + 2; n = int(dur * SR); voice += [0.0] * (n - len(voice))
# «музыка»: смена аккордов каждые 2 с, бочка на каждую долю (120 bpm), немного шума
mus = [0.0] * n
chords = [[220, 277, 330], [196, 247, 294], [174, 220, 262], [196, 247, 330]]
for i in range(n):
    ts = i / SR; ch = chords[int(ts / 2) % 4]
    v = sum(math.sin(2 * math.pi * f * ts) for f in ch) * 0.05
    ph = ts % 0.5; v += math.sin(2 * math.pi * 60 * ph) * math.exp(-ph * 18) * 0.25
    v += (random.random() - 0.5) * 0.02
    mus[i] = v
mix = [max(-1, min(1, voice[i] * 0.9 + mus[i])) for i in range(n)]
os.makedirs(sys.argv[1], exist_ok=True)
w = wave.open(os.path.join(sys.argv[1], "song.wav"), "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
w.writeframes(struct.pack("<%dh" % n, *[int(v * 32000) for v in mix])); w.close()
json.dump({"lines": lrc, "truth": truth, "dur": dur}, open(os.path.join(sys.argv[1], "song.json"), "w"), ensure_ascii=False)
print("тестовый трек:", round(dur, 1), "с,", sum(len(x) for x in truth), "слов")
