// ================= Квиз по исполнителю =================
// Вопросы собираются сами из каталога артиста (те же данные, что на его странице — без лишних запросов):
// отрывки треков, обложки, годы релизов, на каком релизе трек, фиты и хронология. Ответы всегда верные — это реальные данные.
// Каждый заход — новый набор из 10 вопросов. Лучший результат хранится на телефоне.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image, StyleSheet, Platform, Share, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, withDelay, withSequence, cancelAnimation, FadeIn, FadeOut, Easing } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAudioPlayer } from 'expo-audio';
import * as api from './api';
import type { Track } from './api';
import { usePlayer } from './player';
import { analyze, NB } from './spectrum';
import { blendHex, blend3, cosmosOf } from './theme';
import { Matte, Press, Ic, Cover, useT, useTy, useWin, SVGLIB, EASE_OUT, rise, once, GlassBtn, hap, AMB, useAmbient, useVisible } from './ui';
import { QUIZ_PATH, QUIZ_VB, GLINT_URI, GLINT_LIGHT_URI, GLINT_BOX } from './quizData';

const SF = Platform.OS === 'ios' ? 'System' : undefined;
const SV: any = SVGLIB;
const N = 10;            // вопросов в одном заходе
const SNIP = 6000;       // длина отрывка, мс

// ---------- Логотип QUIZ с белой звездой ----------
export function QuizMark({ w = 150 }: { w?: number }) {
  const T: any = useT(); const h = (w * 125) / 349;
  return (
    <View style={{ width: w, height: h, alignSelf: 'center' }}>
      {SV ? <SV.default width={w} height={h} viewBox={QUIZ_VB}><SV.Path d={QUIZ_PATH} fill={T.ink} /></SV.default>
        : <Text style={{ fontFamily: Platform.OS === 'ios' ? 'Didot' : 'serif', fontSize: h * 0.95, lineHeight: h, color: T.ink, textAlign: 'center' }}>QUIZ</Text>}
      {/* белый блик. В светлой теме — версия с мягким ореолом, запечённым в картинку (раньше была «тень» у картинки,
          и вместе с почти прозрачной подложкой исходника она давала еле заметный квадрат). Края картинки — полностью прозрачные. */}
      <Image source={{ uri: T.dark ? GLINT_URI : GLINT_LIGHT_URI }} resizeMode="stretch"
        style={{ position: 'absolute', left: GLINT_BOX.x * w, top: GLINT_BOX.y * w, width: GLINT_BOX.w * w, height: GLINT_BOX.h * w }} />
    </View>
  );
}

// ---------- Звёздное небо как в иконке «Космос» — звёзды медленно падают ----------
// Точки разного размера (фиолетовые в светлой теме, белые в тёмной) и две мягкие туманности — розовая и фиолетовая.
// Три слоя звёзд плывут вниз бесконечно и с разной скоростью (дальние — медленнее, ближние — чуть быстрее и крупнее),
// и каждый слой тихо мерцает. Слой нарисован дважды друг над другом, поэтому зацикливание незаметно.
// Всего 6 анимаций на весь фон (сдвиг + мерцание на слой) — ни одной на отдельную звезду.
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const LAYERS = [
  { n: 16, r: [0.8, 1, 1.2], dur: 140000, o: 0.55 },   // дальние: мелкие и медленные
  { n: 11, r: [1.2, 1.5, 1.8], dur: 95000, o: 0.75 },
  { n: 6, r: [2, 2.4, 2.8], dur: 65000, o: 0.95 },      // ближние: крупнее и чуть быстрее
].map((L) => ({ ...L, dots: Array.from({ length: L.n }, () => ({ x: rnd(), y: rnd(), r: L.r[Math.floor(rnd() * 3)], o: (0.5 + rnd() * 0.5) * L.o, dx: (rnd() - 0.5) * 0.06 })) }));
// Звёзды — маленькие круглые точки-виды (а не огромная SVG-картинка в два экрана высотой на слой: та занимала
// десятки мегабайт видеопамяти и перерисовывалась). Движение — от общих фоновых часов AMB (30 кадров/с):
// звёзды падают медленно, на глаз так же плавно, а стекло поверх переразмывается в 4 раза реже.
function fallAt(t: number, li: number, h: number, w: number) {
  'worklet';
  // секунды на один проход звезды сверху вниз: дальние 140 с, средние 95 с, ближние 65 с — медленное падение
  const L = [140, 95, 65][li]; const k = (t / L + li * 0.31) % 1;
  const tw = 0.5 - 0.5 * Math.cos((Math.PI * 2 * t) / (5.6 + li));
  return { opacity: 1 - 0.55 * tw, transform: [{ translateY: k * h }, { translateX: k * w * 0.04 }] };
}
function FallLayer({ li, w, h, color, dark, run = true }: { li: number; w: number; h: number; color: string; dark: boolean; run?: boolean }) {
  const L = LAYERS[li]; const vis = useVisible(); const on = run && vis;   // экран скрыт (под другим экраном, вкладка в фоне) — звёзды стоят
  useAmbient(on);
  const live = useAnimatedStyle(() => fallAt(AMB.value, li, h, w));
  const st = on ? live : fallAt(AMB.value, li, h, w);   // скрыт — стоит на месте той же фазы
  const dots = (off: number) => L.dots.map((d, i) => (
    <View key={off + ':' + i} style={{ position: 'absolute', left: d.x * w * 1.04 - d.r, top: d.y * h + off - d.r, width: d.r * 2, height: d.r * 2, borderRadius: d.r, backgroundColor: color, opacity: d.o * (dark ? 1 : 0.75) }} />
  ));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: -w * 0.04, top: -h, width: w * 1.04, height: h * 2 }, st]}>
      {dots(0)}{dots(h)}
    </Animated.View>
  );
}
export const Sky = React.memo(function Sky({ w, h, run = true, nebula = true }: { w: number; h: number; run?: boolean; nebula?: boolean }) {
  const T: any = useT(); const dark = !!T.dark; const C = cosmosOf(T); const c = C.dot;   // звёзды и туманность — в цвете профиля
  if (!SV || !w || !h) return null;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]}>
      {nebula && <SV.default width={w} height={h} style={StyleSheet.absoluteFill}>
        <SV.Defs>
          <SV.RadialGradient id="nebP" cx="50%" cy="50%" r="50%"><SV.Stop offset="0" stopColor={T.accent} stopOpacity={dark ? 0.3 : 0.12} /><SV.Stop offset="1" stopColor={T.accent} stopOpacity={0} /></SV.RadialGradient>
          <SV.RadialGradient id="nebV" cx="50%" cy="50%" r="50%"><SV.Stop offset="0" stopColor={C.g2} stopOpacity={dark ? 0.3 : 0.12} /><SV.Stop offset="1" stopColor={C.g2} stopOpacity={0} /></SV.RadialGradient>
        </SV.Defs>
        <SV.Circle cx={w * 0.4} cy={h * 0.52} r={Math.max(w, h) * 0.32} fill="url(#nebP)" />
        <SV.Circle cx={w * 0.8} cy={h * 0.3} r={Math.max(w, h) * 0.24} fill="url(#nebV)" />
      </SV.default>}
      {[0, 1, 2].map((li) => <FallLayer key={li} li={li} w={w} h={h} color={c} dark={dark} run={run} />)}
    </View>
  );
});

// ---------- Вопросы ----------
type Kind = 'snip' | 'cover' | 'year' | 'album' | 'feat' | 'first' | 'newest';
type Q = { kind: Kind; label: string; q: string; opts: string[]; ok: number; url?: string; img?: string };
const LABEL: Record<Kind, string> = { snip: 'УГАДАЙ ПО ОТРЫВКУ', cover: 'УГАДАЙ ПО ОБЛОЖКЕ', year: 'ГОДЫ РЕЛИЗОВ', album: 'РЕЛИЗЫ', feat: 'КОЛЛАБОРАЦИИ', first: 'ХРОНОЛОГИЯ', newest: 'ХРОНОЛОГИЯ' };
// группы для итога: «отрывки 3/3», «обложки 2/2»…
const GROUP: Record<Kind, string> = { snip: 'отрывки', cover: 'обложки', year: 'годы', album: 'релизы', first: 'релизы', newest: 'релизы', feat: 'фиты' };
const KIND_RU: Record<string, string> = { album: 'альбом', ep: 'EP', single: 'сингл' };
// Чистое название для вопроса: без скобок «(feat. …)», «[Prod. …]», «(Remix)», хвостов « - Sped Up», « - Single»,
// «feat. …», звёздочек и прочих лишних символов. Если после чистки ничего не осталось — исходное название.
const VAR = /\b(remix|rmx|mix|edit|version|versión|remaster(ed)?|live|sped[\s-]*up|slowed|reverb|instrumental|karaoke|acoustic|demo|nightcore|8d|mashup|bootleg|cover)\b|ремикс|минус|караоке/i;
export function qt(raw: string): string {
  const s0 = String(raw || '');
  const s = s0.replace(/\s*[(\[{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s+[-–—|/]\s+.*$/i, (m) => (VAR.test(m) || /\b(single|ep|сингл|prod)\b/i.test(m) ? '' : m))
    .replace(/\s+(feat\.?|ft\.?|featuring|prod\.?|при уч\.?)\s.*$/i, '')
    .replace(/[*_#~•|"“”«»]+/g, '').replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—.,:;!]+|[\s\-–—.,:;]+$/g, '').trim();
  return s || s0.trim();
}
const isVariant = (raw: string) => VAR.test(String(raw || ''));
const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();
function shuffle<T>(a: T[]): T[] { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
// варианты: верный + 3 других (без повторов по написанию), перемешаны
function mk(kind: Kind, q: string, right: string, pool: string[], extra?: Partial<Q>): Q | null {
  const seen = new Set([norm(right)]); const wrong: string[] = [];
  for (const x of shuffle(pool)) { const k = norm(x); if (!k || seen.has(k)) continue; seen.add(k); wrong.push(x); if (wrong.length === 3) break; }
  if (wrong.length < 3) return null;
  const opts = shuffle([right, ...wrong]);
  return { kind, label: LABEL[kind], q, opts, ok: opts.indexOf(right), ...extra };
}
// соавторы трека: «VILLIAN & madk1d», «A, B feat. C» — все, кроме самого артиста
const others = (artist: string, main: string) => artist.split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|\bи\b)\s*/i).map((s) => s.trim()).filter((s) => s && norm(s) !== norm(main));

type Data = { tracks: Track[]; albums: any[]; info?: any };
function material(d: Data, name: string) {
  // треки: только оригиналы (без ремиксов, sped up и т. п.), названия очищены, повторы по чистому названию убраны
  const seenT = new Set<string>(); const tracks: (Track & { q: string; qa: string })[] = [];
  for (const t of d.tracks || []) {
    if (isVariant(t.title)) continue; const q = qt(t.title); const k = norm(q); if (!k || seenT.has(k)) continue;
    seenT.add(k); tracks.push({ ...t, q, qa: qt(t.album || '') });
  }
  // релизы: чистые имена; «делюкс», переиздания и ремикс-сборники схлопываются в один
  const seenA = new Set<string>(); const rel: any[] = [];
  // от старых к новым: из оригинала и переиздания остаётся оригинал (его год и обложка)
  for (const a of [...(d.albums || [])].reverse()) {
    if (isVariant(a.collectionName)) continue; const q = qt(a.collectionName); const k = norm(q); if (!k || seenA.has(k)) continue;
    seenA.add(k); rel.push({ ...a, q });
  }
  return { tracks, rel, titles: tracks.map((t) => t.q), names: rel.map((a) => a.q as string), name };
}
// хватает ли данных хотя бы на короткий квиз — иначе карточку на странице артиста не показываем
export function canQuiz(d?: Data | null) {
  if (!d) return false; const m = material(d, ''); return m.tracks.length >= 4 && (m.tracks.length + m.rel.length) >= 8;
}
export function buildQuiz(d: Data, name: string): Q[] {
  const m = material(d, name); const out: Q[] = []; const used = new Set<string>();
  const add = (q: Q | null, key: string) => { if (q && !used.has(key)) { used.add(key); out.push(q); return true; } return false; };
  const yr = (a: any) => parseInt(String(a.releaseDate || '').slice(0, 4), 10) || 0;
  const now = new Date().getFullYear();
  const makers: (() => boolean)[] = [
    // отрывок трека — 6 секунд превью
    () => { const t = pick(m.tracks.filter((x) => x.url)); return !!t && add(mk('snip', 'Что это за трек?', t.q, m.titles, { url: t.url }), 's' + t.id); },
    // обложка релиза
    () => { const a = pick(m.rel.filter((x) => x.artworkUrl100)); return !!a && add(mk('cover', 'Какой это релиз?', a.q, m.names, { img: api.hiArt(a.artworkUrl100) }), 'c' + a.collectionId); },
    // год выхода: соседние годы, но не позже текущего
    () => {
      const a = pick(m.rel.filter((x) => yr(x) > 1950)); if (!a) return false; const y = yr(a);
      const near = [-3, -2, -1, 1, 2, 3].map((k) => y + k).filter((v) => v <= now);
      return add(mk('year', `В каком году вышел ${KIND_RU[a.kind] || 'релиз'} «${a.q}»?`, String(y), near.map(String)), 'y' + a.collectionId);
    },
    // на каком релизе трек (только если трек не одноимённый сингл)
    () => {
      const t = pick(m.tracks.filter((x) => x.qa && norm(x.qa) !== norm(x.q) && m.names.some((n) => norm(n) === norm(x.qa)))); if (!t) return false;
      return add(mk('album', `На каком релизе трек «${t.q}»?`, t.qa, m.names), 'a' + t.id);
    },
    // фит: с кем трек
    () => {
      const fs = m.tracks.map((t) => ({ t, o: others(t.artist, name).map(qt) })).filter((x) => x.o.length);
      const all = Array.from(new Set(fs.flatMap((x) => x.o))); const x = pick(fs); if (!x || all.length < 4) return false;
      return add(mk('feat', `С кем у ${name} трек «${x.t.q}»?`, x.o[0], all.filter((s) => !x.o.some((o) => norm(o) === norm(s)))), 'f' + x.t.id);
    },
    // хронология: самый ранний / самый новый из четырёх
    () => {
      const c = shuffle(m.rel.filter((x) => yr(x))).slice(0, 4); if (c.length < 4) return false;
      const d0 = c.map((a) => String(a.releaseDate)); if (new Set(d0).size < 4) return false;
      const first = c.reduce((p, a) => (String(a.releaseDate) < String(p.releaseDate) ? a : p));
      return add({ kind: 'first', label: LABEL.first, q: 'Какой релиз вышел раньше всех?', opts: c.map((a) => a.q), ok: c.indexOf(first) }, 'first');
    },
    () => {
      const c = shuffle(m.rel.filter((x) => yr(x))).slice(0, 4); if (c.length < 4) return false;
      if (new Set(c.map((a) => String(a.releaseDate))).size < 4) return false;
      const last = c.reduce((p, a) => (String(a.releaseDate) > String(p.releaseDate) ? a : p));
      return add({ kind: 'newest', label: LABEL.newest, q: 'Какой релиз вышел позже всех?', opts: c.map((a) => a.q), ok: c.indexOf(last) }, 'newest');
    },
  ];
  // желаемый состав: 3 отрывка, 2 обложки, 2 года, по одному остальному; недостающее добираем чем получится
  const plan = [0, 1, 2, 0, 3, 1, 4, 2, 0, 5, 6];
  for (const i of plan) { if (out.length >= N) break; for (let k = 0; k < 4 && !makers[i](); k++); }
  for (let tries = 0; out.length < N && tries < 60; tries++) makers[tries % makers.length]();
  // отрывки не подряд: перемешиваем, но первым ставим отрывок — самый весёлый вопрос
  const s = shuffle(out); const fi = s.findIndex((q) => q.kind === 'snip'); if (fi > 0) [s[0], s[fi]] = [s[fi], s[0]];
  return s.slice(0, N);
}

// ---------- Лучший результат ----------
const bestKey = (id: number) => 'quiz:best:' + id;
const bestSubs = new Set<() => void>();
export function useBest(id: number) {
  const [b, setB] = useState<number | null>(null);
  useEffect(() => {
    const load = () => AsyncStorage.getItem(bestKey(id)).then((v) => setB(v != null ? parseInt(v, 10) : null)).catch(() => {});
    load(); bestSubs.add(load); return () => { bestSubs.delete(load); };
  }, [id]);
  return b;
}
async function saveBest(id: number, score: number) {
  const v = await AsyncStorage.getItem(bestKey(id)).catch(() => null);
  if (v == null || score > parseInt(v, 10)) { await AsyncStorage.setItem(bestKey(id), String(score)).catch(() => {}); bestSubs.forEach((f) => f()); }
}

// ---------- Карточка на странице артиста ----------
export function QuizCard({ id, name, onStart }: { id: number; name: string; onStart: () => void }) {
  const T: any = useT(); const ty = useTy(); const best = useBest(id); const [box, setBox] = useState({ w: 0, h: 0 });
  return (
    <Animated.View entering={FadeIn.duration(500).easing(EASE_OUT)} style={{ marginHorizontal: 16, marginTop: 28 }}>
      <Matte radius={22} onLayout={undefined} style={{ overflow: 'visible' }}>
        <View onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })} style={{ borderRadius: 22, overflow: 'hidden', paddingTop: 44, paddingHorizontal: 20, paddingBottom: 12 }}>
          <Sky w={box.w} h={box.h} />
          <QuizMark w={150} />
          <Text style={[ty.title1, { fontWeight: '700', letterSpacing: -0.5, marginTop: 22 }]}>Насколько хорошо ты знаешь {name}?</Text>
          <Text style={[ty.callout, { color: T.ink3, marginTop: 6 }]}>{N} вопросов · отрывки, обложки, релизы</Text>
          {/* кнопки — капсулы, концентричны карточке: отступ 12 → радиус 22 − 12 ≈ капсула 52 */}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 22, marginHorizontal: -8 }}>
            <Press onPress={onStart} style={{ flex: 1, height: 52, borderRadius: 26, backgroundColor: T.primary, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              <Ic n="play" s={18} c={T.onPrimary} /><Text style={[ty.headline, { color: T.onPrimary }]}>Начать квиз</Text>
            </Press>
            {best != null && (
              <View style={{ height: 52, paddingHorizontal: 18, borderRadius: 26, overflow: 'hidden', backgroundColor: T.accentPill, justifyContent: 'center' }}>
                {T.duo && <LinearGradient colors={T.tri ? [T.accentPillA, T.accentPillB, T.accentPillC] : [T.accentPillA, T.accentPillB]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />}
                <Text style={[ty.subhead, { fontWeight: '600', color: T.accentText }]}>лучший {best}/{N}</Text>
              </View>
            )}
          </View>
        </View>
      </Matte>
    </Animated.View>
  );
}

// ---------- Экран квиза ----------
export function QuizScreen({ id, name, back }: { id: number; name: string; back: () => void }) {
  const T: any = useT(); const ty = useTy(); const P = usePlayer(); const ins = useSafeAreaInsets(); const { width: W, height: H } = useWin();
  const padT = Math.max(ins.top, Platform.OS === 'ios' ? 47 : 0);
  const [qs, setQs] = useState<Q[] | null>(null); const [err, setErr] = useState(false);
  const [i, setI] = useState(0); const [picked, setPicked] = useState<number | null>(null);
  const [res, setRes] = useState<boolean[]>([]); const [photo, setPhoto] = useState('');
  const dataRef = useRef<Data | null>(null);
  const snip = useAudioPlayer(null);
  // «живая» волна отрывка: тот же разбор звука на 24 полосы (бас → высокие), что у линии «Моего пульса».
  // Перехват звука включается сразу, ещё до первого отрывка (позже включать нельзя — звук «заикается»).
  // Сглаживание: столбик быстро подскакивает на ударе и плавно опадает.
  const lv = useSharedValue<number[]>(new Array(NB).fill(0)); const gotAt = useRef(0); const fake = useRef<any>(null);
  useEffect(() => {
    const pl: any = snip; if (pl.isAudioSamplingSupported === false) return;
    try { pl.setAudioSamplingEnabled?.(true); } catch {}
    let last = 0; const sm = new Array(NB).fill(0); let sub: any = null;
    try {
      sub = pl.addListener?.('audioSampleUpdate', (smp: any) => {
        const now = Date.now(); if (now - last < 40) return; last = now;
        const r = analyze(smp); if (!r) return; gotAt.current = now;
        for (let k = 0; k < NB; k++) sm[k] = r[k] > sm[k] ? sm[k] + (r[k] - sm[k]) * 0.75 : sm[k] * 0.78 + r[k] * 0.22;
        lv.value = sm.slice();
      });
    } catch {}
    return () => { try { sub?.remove?.(); } catch {} };
  }, [snip]);
  // данные артиста уже в кэше (страница артиста их только что загрузила) — квиз собирается мгновенно
  useEffect(() => {
    let ok = true;
    api.artist(id).then((d: any) => { if (!ok) return; dataRef.current = d; setQs(buildQuiz(d, name)); }).catch(() => ok && setErr(true));
    api.artistPhoto(name, true).then((u) => ok && setPhoto(u)).catch(() => {});
    if (P.playing) P.toggle();   // музыка на паузу, чтобы отрывки было слышно
    return () => { ok = false; };
  }, [id]);
  const q = qs?.[i]; const done = !!qs && i >= qs.length;
  // отрывок: играет 6 секунд с начала превью; полоска показывает, сколько осталось
  const pr = useSharedValue(0); const [playing, setPlaying] = useState(false); const tm = useRef<any>(null);
  const stopSnip = () => { clearTimeout(tm.current); clearInterval(fake.current); try { snip.pause(); } catch {} cancelAnimation(pr); setPlaying(false); lv.value = new Array(NB).fill(0); };
  const playSnip = () => {
    if (!q?.url) return; stopSnip();
    // Яндекс: сначала берём ссылку на звук (фрагмент трека), иначе — прямой адрес как раньше
    const u = q.url;
    if (u.startsWith('ym:')) api.streamUrl({ url: u } as any).then((s) => { if (s) { try { snip.replace({ uri: s.url }); snip.play(); } catch {} } }).catch(() => {});
    else { try { snip.replace({ uri: u }); snip.play(); } catch {} }
    setPlaying(true); pr.value = 0; pr.value = withTiming(1, { duration: SNIP, easing: Easing.linear });
    // запасной вариант: если телефон не отдаёт звук на разбор, волна всё равно мягко движется в ритм (~120 BPM)
    const t0 = Date.now(); clearInterval(fake.current);
    fake.current = setInterval(() => {
      if (Date.now() - gotAt.current < 600) return; const t = (Date.now() - t0) / 1000; const beat = Math.pow(Math.max(0, Math.cos(t * Math.PI * 2)), 6);
      lv.value = Array.from({ length: NB }, (_, k) => Math.min(1, (k < 6 ? beat * 0.9 : 0.25) + 0.3 * Math.abs(Math.sin(t * (2.1 + k * 0.37) + k)) * (1 - k / NB * 0.5)));
    }, 80);
    tm.current = setTimeout(() => { clearInterval(fake.current); try { snip.pause(); } catch {} setPlaying(false); lv.value = new Array(NB).fill(0); }, SNIP);
  };
  useEffect(() => { if (q?.kind === 'snip') playSnip(); else stopSnip(); }, [i, qs]);
  useEffect(() => () => { clearTimeout(tm.current); clearInterval(fake.current); try { snip.pause(); } catch {} }, []);
  const prSt = useAnimatedStyle(() => ({ width: `${pr.value * 100}%` as any }));

  const choose = (k: number) => {
    if (picked != null || !q) return; setPicked(k);
    const r = [...res, k === q.ok]; setRes(r);
    // верно — «успех» (двойной мягкий импульс), неверно — «ошибка» (тройной); конец квиза — нарастающая серия
    hap(k === q.ok ? 'success' : 'error');
    setTimeout(() => {
      stopSnip(); setPicked(null); setI((x) => x + 1);
      if (qs && r.length >= qs.length) { saveBest(id, r.filter(Boolean).length); hap(r.filter(Boolean).length >= qs.length * 0.7 ? 'ramp' : 'medium'); }
    }, 1150);
  };
  const again = () => { if (!dataRef.current) return; setRes([]); setPicked(null); setI(0); setQs(buildQuiz(dataRef.current, name)); };

  const bg = (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: T.bgBase }]}>
      <LinearGradient colors={[T.bgTop, T.bgBase]} locations={[0, 0.6]} style={StyleSheet.absoluteFill} />
      <LinearGradient colors={[T.bgGlow, 'transparent']} start={{ x: 1, y: 0 }} end={{ x: 0.2, y: 0.45 }} style={StyleSheet.absoluteFill} />
      <Sky w={W} h={H} />
    </View>
  );
  const top = (
    <View style={{ position: 'absolute', top: padT + 6, left: 16, right: 16, height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 3 }}>
      <GlassBtn onPress={back} size={44}><Ic n="close" s={22} /></GlassBtn>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, paddingHorizontal: 8 }}>
        {!!photo && <Image source={{ uri: photo }} style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: T.ph }} />}
        <Text numberOfLines={1} style={[ty.miniTitle, { flexShrink: 1 }]}>{name}</Text>
      </View>
      {qs && !done ? <Matte radius={22} strong style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Text style={[ty.footnote, { fontWeight: '600', fontVariant: ['tabular-nums'] }]}>{i + 1}/{qs.length}</Text></Matte> : <View style={{ width: 44 }} />}
    </View>
  );
  const bottom = Math.max(ins.bottom, 16) + 12;

  if (err || (qs && !qs.length)) return <View style={{ flex: 1 }}>{bg}{top}<View style={{ flex: 1, justifyContent: 'center', padding: 32 }}><Text style={[ty.callout, { textAlign: 'center' }]}>Не получилось собрать квиз — у артиста пока мало данных.</Text></View></View>;
  if (!qs) return <View style={{ flex: 1 }}>{bg}{top}</View>;

  // ---------- итог ----------
  if (done) {
    const sc = res.filter(Boolean).length; const n = qs.length;
    const title = sc >= n - 1 ? `Фанат ${name}` : sc >= Math.ceil(n * 0.7) ? `Знаток ${name}` : sc >= Math.ceil(n * 0.4) ? `Слушатель ${name}` : 'Новичок';
    const g: Record<string, [number, number]> = {};
    qs.forEach((x, k) => { const key = GROUP[x.kind]; const v = g[key] || (g[key] = [0, 0]); v[1]++; if (res[k]) v[0]++; });
    const groups = Object.entries(g).sort((a, b) => b[1][1] - a[1][1]).slice(0, 3);
    const weak = Object.entries(g).filter(([, v]) => v[0] < v[1]).sort((a, b) => a[1][0] / a[1][1] - b[1][0] / b[1][1])[0];
    const strong = Object.entries(g).find(([, v]) => v[1] >= 2 && v[0] === v[1]);
    const hint = sc === n ? 'Ни одной ошибки. Ты знаешь всё.' : [strong ? `${strong[0][0].toUpperCase() + strong[0].slice(1)} — без ошибок.` : '', weak ? `Подтяни ${weak[0]}.` : ''].filter(Boolean).join(' ');
    const share = () => Share.share({ message: `Я прошёл квиз по ${name} в Пульсе: ${sc}/${n} — «${title}». Сможешь лучше?` }).catch(() => {});
    return (
      <View style={{ flex: 1 }}>{bg}{top}
        <View style={{ flex: 1, paddingTop: padT + 84, paddingHorizontal: 16, paddingBottom: bottom }}>
          <Animated.View entering={FadeIn.duration(420).easing(EASE_OUT)}><QuizMark w={150} /></Animated.View>
          <Animated.View entering={rise(80)} style={{ alignItems: 'center', marginTop: 28 }}>
            <Text style={{ fontFamily: SF, fontSize: 112, lineHeight: 116, fontWeight: '700', letterSpacing: -5, color: T.ink }}>{sc}<Text style={{ fontSize: 42, letterSpacing: -1, color: T.ink3 }}>/{n}</Text></Text>
            <Text style={[ty.title1, { fontWeight: '700', letterSpacing: -0.5, marginTop: 4, textAlign: 'center' }]}>{title}</Text>
            {!!hint && <Text style={[ty.callout, { color: T.ink3, textAlign: 'center', marginTop: 8, marginHorizontal: 24 }]}>{hint}</Text>}
          </Animated.View>
          <Animated.View entering={rise(160)} style={{ flexDirection: 'row', gap: 10, marginTop: 24 }}>
            {groups.map(([k, v]) => (
              <Matte key={k} radius={22} style={{ flex: 1, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 14 }}>
                <Text style={[ty.title2, { fontVariant: ['tabular-nums'] }]}>{v[0]}/{v[1]}</Text>
                <Text style={[ty.footnote, { marginTop: 2 }]}>{k}</Text>
              </Matte>
            ))}
          </Animated.View>
          <View style={{ flex: 1 }} />
          <Animated.View entering={rise(240)} style={{ gap: 10 }}>
            <Press onPress={() => once(share)} style={{ height: 52, borderRadius: 26, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center' }}><Text style={[ty.headline, { color: T.onPrimary }]}>Поделиться результатом</Text></Press>
            <Press onPress={() => once(again)}><Matte radius={26} style={{ height: 52, alignItems: 'center', justifyContent: 'center' }}><Text style={ty.headline}>Ещё раз</Text></Matte></Press>
          </Animated.View>
        </View>
      </View>
    );
  }

  // ---------- вопрос ----------
  const n = qs.length;
  return (
    <View style={{ flex: 1 }}>{bg}{top}
      <View style={{ flex: 1, paddingTop: padT + 62, paddingHorizontal: 16, paddingBottom: bottom }}>
        {/* прогресс — сегменты капсулами, пройденные — акцентом профиля */}
        <View style={{ flexDirection: 'row', gap: 4, marginHorizontal: 8 }}>
          {qs.map((_, k) => <View key={k} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: k < i ? (T.tri ? blend3(T.accent, T.accent2, T.accent3, k / Math.max(1, qs.length - 1)) : T.duo ? blendHex(T.accent, T.accent2, k / Math.max(1, qs.length - 1)) : T.accent) : k === i ? T.accentSoft : T.dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)' }} />)}
        </View>
        <View style={{ marginTop: 50 }}><QuizMark w={150} /></View>
        <Animated.View key={'q' + i} entering={FadeIn.duration(320).easing(EASE_OUT)} exiting={FadeOut.duration(180).easing(EASE_OUT)} style={{ flex: 1, marginTop: 26, paddingHorizontal: 8 }}>
          <Text style={[ty.caption, { fontSize: 13, letterSpacing: 0.2, color: T.ink3 }]}>ВОПРОС {i + 1} · {q!.label}</Text>
          <Text style={{ fontFamily: SF, fontSize: q!.q.length > 44 ? 28 : 32, lineHeight: q!.q.length > 44 ? 34 : 38, fontWeight: '700', letterSpacing: -0.6, color: T.ink, marginTop: 6 }}>{q!.q}</Text>
          {q!.kind === 'snip' && (
            <Matte radius={22} style={{ marginTop: 18, height: 88, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 12 }}>
              <Press onPress={() => (playing ? stopSnip() : playSnip())} to={0.9} style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center' }}>
                <Ic n={playing ? 'pause' : 'play'} s={26} c={T.onPrimary} />
              </Press>
              <View style={{ flex: 1 }}>
                <Wave lv={lv} />
                <View style={{ height: 3, borderRadius: 2, backgroundColor: T.dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)', marginTop: 10, overflow: 'hidden' }}>
                  <Animated.View style={[{ height: 3, borderRadius: 2, backgroundColor: T.accent, overflow: 'hidden' }, prSt]}>{T.duo && <LinearGradient colors={T.tri ? [T.accent, T.accent2, T.accent3] : [T.accent, T.accent2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />}</Animated.View>
                </View>
              </View>
            </Matte>
          )}
          {q!.kind === 'cover' && !!q!.img && <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 120 }}><CoverFit u={q!.img} /></View>}
        </Animated.View>
        <View style={{ gap: 10 }}>
          {q!.opts.map((o, k) => {
            const st = picked == null ? 0 : k === q!.ok ? 1 : k === picked ? 2 : 3;
            return <Answer key={i + ':' + k} text={o} st={st} onPress={() => choose(k)} />;
          })}
        </View>
      </View>
    </View>
  );
}

// обложка в вопросе: размер под свободное место (на маленьких экранах меньше)
function CoverFit({ u }: { u: string }) {
  const T: any = useT(); const [s, setS] = useState(0);
  return <View style={{ alignSelf: 'stretch', flex: 1, alignItems: 'center', justifyContent: 'center' }} onLayout={(e) => setS(Math.min(220, e.nativeEvent.layout.height - 16, e.nativeEvent.layout.width))}>
    {s > 60 && <View style={{ borderRadius: 22, backgroundColor: T.ph, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 8 } }}><Cover u={u} size={s} r={22} /></View>}
  </View>;
}

// волна отрывка: 20 столбиков слева направо — от баса к высоким. Высота — громкость своей полосы прямо сейчас,
// в паузе столбики опадают до тихой «линии». Цвет — акцент, у двухцветного оформления — плавный переход между цветами.
const BN = 20;
function Bar({ lv, j, color }: { lv: any; j: number; color: string }) {
  const band = Math.round((j * (NB - 1)) / (BN - 1));
  const st = useAnimatedStyle(() => ({ height: withTiming(5 + (lv.value[band] || 0) * 35, { duration: 90 }) }));
  return <Animated.View style={[{ width: 4, borderRadius: 2, backgroundColor: color }, st]} />;
}
function Wave({ lv }: { lv: any }) {
  const T: any = useT();
  const cols = useMemo(() => Array.from({ length: BN }, (_, j) => (T.tri ? blend3(T.accent, T.accent2, T.accent3, j / (BN - 1)) : T.duo ? blendHex(T.accent, T.accent2, j / (BN - 1)) : j % 2 ? T.accent : T.accentText)), [T]);
  return (
    <View style={{ height: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      {cols.map((c, j) => <Bar key={j} lv={lv} j={j} color={c} />)}
    </View>
  );
}

// ответ-капсула: стекло → после выбора верный зелёный, ошибка красная, остальные гаснут
function Answer({ text, st, onPress }: { text: string; st: number; onPress: () => void }) {
  const T: any = useT(); const ty = useTy();
  const ok = T.dark ? '#4ade80' : '#16a34a', bad = T.dark ? '#ff6b6f' : '#e5484d';
  const fill = st === 1 ? ok : st === 2 ? bad : null;
  const fg = fill ? (T.dark && st === 1 ? '#0b2a14' : '#ffffff') : T.ink;
  const inner = (
    <View style={{ height: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, gap: 10 }}>
      <Text numberOfLines={1} style={[ty.headline, { flex: 1, color: fg }]}>{text}</Text>
      {st === 1 && <Ic n="checkmark" s={20} c={fg} />}{st === 2 && <Ic n="close" s={20} c={fg} />}
    </View>
  );
  return (
    <Press onPress={onPress} to={0.97} style={{ opacity: st === 3 ? 0.55 : 1 }}>
      {fill ? <Animated.View entering={FadeIn.duration(220).easing(EASE_OUT)} style={{ borderRadius: 26, backgroundColor: fill }}>{inner}</Animated.View>
        : <Matte radius={26} strong>{inner}</Matte>}
    </Press>
  );
}

export const BUILD = 64;
