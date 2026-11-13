// Вкладка «Пульс» — экран «Мой пульс».
//  • Первый вход (один раз): карточка в розовой фольге — стираешь пальцем, под ней первый подобранный трек.
//  • Дальше всегда — «Притяжение»: звезда, к которой летят черточки-треки. Нажал — они влетают в неё, звезда вспыхивает
//    и превращается в обложку, музыка начинает играть. Очередь бесконечная (её подкармливает PulseFeeder).
// Все анимации — на withTiming без пружин: плавно и мягко.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, Platform, Modal, ScrollView, useWindowDimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, useAnimatedProps, useDerivedValue, useFrameCallback, useAnimatedReaction, withTiming, withRepeat, withSequence, withDelay, Easing, FadeIn, FadeOut, runOnJS, cancelAnimation } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import * as api from './api';
import type { Track } from './api';
import * as pulse from './pulse';
import { usePlayer, usePlaying, useProgress } from './player';
import { openAi } from './ai';
import { Sky } from './Quiz';
import { cosmosOf } from './theme';
import { SHEET, useT, useTy, useWin, Press, Matte, Glow, LStar, PIcon, Explicit, BrokenHeart, SVGLIB, Marquee, PlayPause, GlassBtn, HeartFill, AiIcon, hap, WaterLight, setFullOrigin, useAwake } from './ui';
import type { Hap } from './ui';
import { Pic, prefetchPic } from './ui';
import { LSTAR_UP, LSTAR_LO, LSTAR_RATIO } from './logoData';
// тактильная отдача — общая (ui.tsx → hap): здесь короткие имена для совместимости
const buzz = (k: 'light' | 'medium' | 'ok' | Hap = 'light') => hap(k === 'ok' ? 'success' : k);

const SF = Platform.OS === 'ios' ? 'System' : undefined;
const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const DOCK_B = 24, TAB_H = 60;   // капсулы (меню, мини-плеер, управление пульсом) — одной высоты: 60
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = (n: number) => { const x = Math.sin(n * 12.9898 + 4.1) * 43758.5453; return x - Math.floor(x); };
const abs = StyleSheet.absoluteFill;

function useArea() {
  const ins = useSafeAreaInsets(); const { width: W, height: H } = useWin();
  const top = Math.max(ins.top, Platform.OS === 'ios' ? 47 : 0) + 56;
  const bottom = DOCK_B + TAB_H + 12;
  return { W, H, top, bottom, avail: H - top - bottom };
}
const useCtx = () => { const P = usePlayer(); return () => ({ stats: P.stats, favs: P.favs as Track[], recent: P.recent as Track[] }); };

// ================= Экран вкладки =================
export function PulseScreen({ openFull, active = true }: { openFull: () => void; active?: boolean }) {
  const [seen, setSeen] = useState<boolean | null>(null);
  const { top, bottom, W: aW, H: aH } = useArea();
  useEffect(() => { AsyncStorage.getItem('pulse_seen').then((v) => setSeen(v === '1')).catch(() => setSeen(true)); }, []);
  const P = usePlayer(); const on = P.src === 'pulse' && !!P.cur;
  if (seen === null) return null;
  return (
    <View style={{ flex: 1 }}>
    <Cosmos on={on} active={active} />
    {/* общий «свет сквозь воду» — как во всех разделах (та же фаза, при переходе не перезапускается) */}
    <WaterLight W={aW} H={aH} dim={on ? 0.55 : 1} />
    <View style={{ flex: 1, paddingTop: top, paddingBottom: bottom }}>
      {seen
        ? <Animated.View key="attract" entering={FadeIn.duration(650).easing(Easing.out(Easing.cubic))} style={{ flex: 1 }}><Attract openFull={openFull} active={active} onReset={() => setSeen(false)} /></Animated.View>
        : <Animated.View key="scratch" exiting={FadeOut.duration(380).easing(EASE)} style={{ flex: 1 }}><Scratch onDone={() => setSeen(true)} /></Animated.View>}
    </View>
    </View>
  );
}

// Подкармливает очередь «Моего пульса», где бы вы ни были в приложении: осталось мало треков — добавляет новые
export function PulseFeeder() {
  const P = usePlayer(); const ctx = useCtx(); const busy = useRef(false);
  // через пару секунд после запуска приложения тихо готовим первую порцию — кнопка «Запустить» сработает сразу
  useEffect(() => { const tm = setTimeout(() => pulse.warm(ctx()), 3000); return () => clearTimeout(tm); }, []);
  useEffect(() => {
    if (P.src !== 'pulse' || busy.current || P.queue.length - P.idx > 4) return;
    busy.current = true;
    pulse.more(ctx(), P.queue).then((l) => { if (l.length) P.extend(l); }).catch(() => {}).finally(() => { busy.current = false; });
  }, [P.src, P.idx, P.queue.length]);
  return null;
}

// ИИ-подбор: смотрит, насколько долго вы слушаете треки «Моего пульса». Когда трек сменился —
// оценивает предыдущий: дослушали почти до конца — «нравится», пролистнули в первой трети — «не то».
// Отдельный компонент, чтобы частые обновления позиции не трогали остальной экран.
export function PulseLearner() {
  const P = usePlayer(); const { pos, dur } = useProgress();
  const last = useRef<{ t: any; pos: number; dur: number; src: string } | null>(null);
  const cur = P.cur;
  useEffect(() => {
    const l = last.current;
    if (l && l.t && (!cur || cur.id !== l.t.id) && l.src === 'pulse') {
      const r = l.dur > 0 ? l.pos / l.dur : 0; const t0 = l.t;
      // забаненный трек уже учтён дизлайком — второй раз не считаем
      const kind = r >= 0.85 ? 'full' : r < 0.3 ? 'skip' : null;
      if (kind) pulse.isBannedKey(t0).then((b) => { if (!b) pulse.learn(kind, t0); }).catch(() => {});
    }
    last.current = cur ? { t: cur, pos: 0, dur: dur || 30, src: P.src } : null;
  }, [cur?.id]);
  if (last.current && cur && last.current.t.id === cur.id && pos > last.current.pos) { last.current.pos = pos; last.current.dur = dur || last.current.dur; }
  return null;
}

// ================= Живая линия пульса =================
// Линия под обложкой двигается под музыку по частотам: в центре — бас (медленные широкие волны),
// к краям — всё более высокие ноты (мелкая быстрая рябь). Громче полоса — сильнее качается её участок линии.
// Звук разбирается на 24 полосы (spectrum.ts). Если плеер не отдаёт звук — линия идёт по ритму:
// бочка на каждую долю (центр), малый барабан через долю (середина), хай-хэт на восьмые (края).
const SV: any = SVGLIB;
const APath: any = SV ? Animated.createAnimatedComponent(SV.Path) : null;
const NBANDS = 24;
const f1 = (v: number) => { 'worklet'; return Math.round(v * 10) / 10; };
const VIZ_H = 104;
// искусственный ритм (когда настоящего звука нет): 0…1 по полосам
function fakeBands(t: number, playing: number, busy: number) {
  'worklet';
  const o: number[] = [];
  if (!playing) {
    // ожидание / пауза: спокойное сердцебиение в центре линии
    const bpm = busy ? 150 : 60; const ph = ((t * bpm) / 60000) % 1;
    const beat = Math.max(Math.exp(-Math.pow(ph - 0.05, 2) / 0.0014), 0.6 * Math.exp(-Math.pow(ph - 0.21, 2) / 0.0018));
    for (let i = 0; i < NBANDS; i++) o.push(0.03 + (i < 7 ? beat * (1 - i / 8) * 0.75 : 0));
    return o;
  }
  const bpm = 112, beats = (t * bpm) / 60000;
  const kick = Math.exp(-(beats % 1) * 7);
  const snare = Math.exp(-(((beats / 2) % 1 + 0.5) % 1) * 9);
  const hat = Math.exp(-((beats * 2) % 1) * 12);
  for (let i = 0; i < NBANDS; i++) {
    let v = 0;
    if (i < 6) v = 0.12 + 0.85 * kick * (1 - i / 9);
    else if (i < 15) v = 0.18 + 0.5 * snare + 0.12 * Math.sin(t / 260 + i * 1.3);
    else v = 0.1 + 0.6 * hat * (0.6 + 0.4 * Math.sin(i * 1.7 + t / 80));
    o.push(Math.max(0, Math.min(1, v)));
  }
  return o;
}
// точки линии: от левого края к центру и от центра к правому краю (зеркально).
// u: 0 — центр (бас), 1 — край (высокие). Ближе к краям точки чаще — там мелкая рябь.
const NPTS = 26;
function vizPath(b: number[], t: number, W: number, cy: number, ampLow: number, ampHigh: number, ph: number) {
  'worklet';
  const half = W / 2; const xs: number[] = [], ys: number[] = [];
  for (let s = -1; s <= 1; s += 2) {
    for (let jj = 0; jj <= NPTS; jj++) {
      const j = s < 0 ? NPTS - jj : jj; if (s > 0 && j === 0) continue;
      const u = j / NPTS;
      const x = half + s * (half + 4) * Math.pow(u, 0.78);
      const fb = Math.min(NBANDS - 1.001, u * (NBANDS - 1)); const i0 = Math.floor(fb), fr = fb - i0;
      const v = b[i0] * (1 - fr) + b[i0 + 1] * fr;
      const env = Math.min(1, (1 - u) / 0.12) * (0.55 + 0.45 * Math.min(1, u * 6 + 0.2));   // гаснет к самому краю
      const amp = (ampLow + (ampHigh - ampLow) * u) * v * env;
      const w = 0.0025 + 0.022 * u;   // бас качается медленно, высокие — быстро
      const y = cy + amp * Math.sin(j * 2.1 + t * w + ph);
      xs.push(x); ys.push(y);
    }
  }
  let d = 'M ' + f1(xs[0]) + ' ' + f1(ys[0]);
  for (let i = 1; i < xs.length - 1; i++) d += ' Q ' + f1(xs[i]) + ' ' + f1(ys[i]) + ' ' + f1((xs[i] + xs[i + 1]) / 2) + ' ' + f1((ys[i] + ys[i + 1]) / 2);
  d += ' L ' + f1(xs[xs.length - 1]) + ' ' + f1(ys[ys.length - 1]);
  return d;
}
function Viz({ W, col, col2, col3, disp, time, dark }: any) {
  const c2 = col2 || col;   // линия переливается слева направо из первого цвета во второй
  const cy = VIZ_H / 2;
  const glow = { shadowColor: col, shadowOpacity: dark ? 0.9 : 0.55, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } };
  if (APath) {
    // Свечение линии раньше давала тень вокруг всего рисунка — телефону приходилось каждый кадр заново
    // считать её по форме линии (это и подтормаживало). Теперь свечение — три широкие полупрозрачные
    // линии той же формы под основной: выглядит так же мягко, а стоит в разы дешевле.
    // Форма линии считается один раз за кадр и используется всеми слоями.
    const dMain = useDerivedValue(() => vizPath(disp.value, time.value, W, cy, 40, 22, 0), [W]);
    const main = useAnimatedProps(() => ({ d: dMain.value }));
    const halo1 = useAnimatedProps(() => ({ d: dMain.value }));
    const halo2 = useAnimatedProps(() => ({ d: dMain.value }));
    const halo3 = useAnimatedProps(() => ({ d: dMain.value }));
    const echo = useAnimatedProps(() => ({ d: vizPath(disp.value, time.value, W, cy, 26, 14, 1.6) }), [W]);
    const g = dark ? 1 : 0.65;
    return (
      <View pointerEvents="none" style={{ width: W, height: VIZ_H }}>
        <SV.default width={W} height={VIZ_H}>
          <SV.Defs>
            <SV.LinearGradient id="vizfade" x1="0" y1="0" x2={W} y2="0" gradientUnits="userSpaceOnUse">
              {/* точки — готовым массивом: пустые места внутри градиента роняют react-native-svg */}
              {(col3 ? [[0, col, 0], [0.12, col, 1], [0.5, c2, 1], [0.88, col3, 1], [1, col3, 0]] : [[0, col, 0], [0.12, col, 1], [0.88, c2, 1], [1, c2, 0]]).map(([o, c, op]: any) => <SV.Stop key={String(o)} offset={o} stopColor={c} stopOpacity={op} />)}
            </SV.LinearGradient>
          </SV.Defs>
          <APath animatedProps={halo1} stroke="url(#vizfade)" strokeOpacity={0.05 * g} strokeWidth={16} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          <APath animatedProps={halo2} stroke="url(#vizfade)" strokeOpacity={0.08 * g} strokeWidth={10.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          <APath animatedProps={halo3} stroke="url(#vizfade)" strokeOpacity={0.14 * g} strokeWidth={6} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          <APath animatedProps={echo} stroke="url(#vizfade)" strokeOpacity={0.35} strokeWidth={1.6} fill="none" strokeLinejoin="round" strokeLinecap="round" />
          <APath animatedProps={main} stroke="url(#vizfade)" strokeWidth={2.6} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        </SV.default>
      </View>
    );
  }
  // без react-native-svg: зеркальный эквалайзер из тонких столбиков (центр — бас, края — высокие)
  const n = NBANDS * 2; const gap = W / (n + 1);
  return (
    <View pointerEvents="none" style={[{ width: W, height: VIZ_H }, glow]}>
      {Array.from({ length: n }, (_, i) => <VizBar key={i} i={i} n={n} x={gap * (i + 1)} col={col} disp={disp} />)}
    </View>
  );
}
function VizBar({ i, n, x, col, disp }: any) {
  const band = Math.min(NBANDS - 1, Math.floor(Math.abs(i - (n - 1) / 2)));
  const edge = Math.min(1, Math.min(i + 1, n - i) / 4);
  const st = useAnimatedStyle(() => { const h = 3 + (VIZ_H - 14) * disp.value[band] * edge; return { height: h, top: (VIZ_H - h) / 2 }; });
  return <Animated.View style={[{ position: 'absolute', left: x - 1.5, width: 3, borderRadius: 1.5, backgroundColor: col, opacity: 0.35 + 0.65 * edge }, st]} />;
}

// Иконки play/pause с мягкой сменой
const iconIn = () => { 'worklet'; return { initialValues: { opacity: 0, transform: [{ scale: 0.55 }] }, animations: { opacity: withTiming(1, { duration: 170 }), transform: [{ scale: withTiming(1, { duration: 230, easing: Easing.out(Easing.cubic) }) }] } }; };
const iconOut = () => { 'worklet'; return { initialValues: { opacity: 1, transform: [{ scale: 1 }] }, animations: { opacity: withTiming(0, { duration: 120 }), transform: [{ scale: withTiming(0.55, { duration: 140, easing: Easing.in(Easing.quad) }) }] } }; };

const RB = 56;   // круглые кнопки — 56
// круглая стеклянная кнопка: при нажатии сжимается только иконка (стекло не масштабируется — без «пикселей»)
function Round({ children, onPress, size = RB }: any) {
  return <GlassBtn onPress={onPress} size={size} strong={false}>{children}</GlassBtn>;
}
// Подсказка при первом показе стопки: стеклянная плашка поверх карточки, стрелки мягко «покачиваются» в стороны
function SwipeHint() {
  const T: any = useT(); const ty = useTy(); const k = useSharedValue(0);
  useEffect(() => { k.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.sin) }), -1, true); return () => cancelAnimation(k); }, []);
  const l = useAnimatedStyle(() => ({ transform: [{ translateX: -4 * k.value }] }));
  const r = useAnimatedStyle(() => ({ transform: [{ translateX: 4 * k.value }] }));
  return (
    <Animated.View pointerEvents="none" entering={FadeIn.duration(420).easing(EASE)} exiting={FadeOut.duration(320).easing(EASE)} style={{ position: 'absolute', bottom: 18, alignItems: 'center' }}>
      <Matte radius={22} strong style={{ paddingHorizontal: 18, paddingVertical: 12, alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Animated.View style={[{ flexDirection: 'row', alignItems: 'center', gap: 4 }, l]}><Ionicons name="arrow-back" size={16} color={T.accentText} /><Text style={[ty.footnote, { fontWeight: '700', color: T.ink }]}>назад</Text></Animated.View>
          <Text style={[ty.footnote, { color: T.ink3 }]}>свайп</Text>
          <Animated.View style={[{ flexDirection: 'row', alignItems: 'center', gap: 4 }, r]}><Text style={[ty.footnote, { fontWeight: '700', color: T.ink }]}>дальше</Text><Ionicons name="arrow-forward" size={16} color={T.accentText} /></Animated.View>
        </View>
        <Text style={[ty.caption, { color: T.ink3, marginTop: 4 }]}>Нажмите на карточку — откроется плеер</Text>
      </Matte>
    </Animated.View>
  );
}

// ================= Капсула управления «Моего пульса» =================
// Та же капсула, что мини-плеер на главной: то же место, размер, стекло и иконки. Внутри: дизлайк · пуск/пауза ·
// дальше · лайк. Лёгкие анимации: капсула всплывает; на смене трека по стеклу проходит мягкий блик цвета оформления;
// пуск/пауза сжимается при нажатии, «дальше» пролетает вправо и возвращается, сердце трескается или подпрыгивает.
// Действия берутся у стопки (bar), поэтому кнопки и свайпы работают одинаково.
const bar: { dislike: null | (() => void); next: null | (() => void) } = { dislike: null, next: null };
const BAR_H = 60, BAR_SPACE = 60 - 4;
function BarBtn({ onPress, children, k }: any) {
  const st = useAnimatedStyle(() => ({ transform: [{ scale: 0.84 + 0.16 * k.value }] }));
  return (
    <Pressable onPress={onPress} hitSlop={6} onPressIn={() => { k.value = withTiming(0, { duration: 90, easing: Easing.out(Easing.quad) }); }}
      onPressOut={() => { k.value = withTiming(1, { duration: 240, easing: Easing.out(Easing.cubic) }); }}
      style={{ flex: 1, height: 48, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={st}>{children}</Animated.View>
    </Pressable>
  );
}
export function PulseBar() {
  const P = usePlayer(); const T: any = useT(); const playing = usePlaying(); const t: Track | undefined = P.cur;
  const k1 = useSharedValue(1), k2 = useSharedValue(1), k3 = useSharedValue(1), k4 = useSharedValue(1);
  const split = useSharedValue(0);
  const nx = useSharedValue(0), no = useSharedValue(1);
  const nst = useAnimatedStyle(() => ({ opacity: no.value, transform: [{ translateX: nx.value }] }));
  const hk = useSharedValue(1), ring = useSharedValue(1);
  const hst = useAnimatedStyle(() => ({ transform: [{ scale: hk.value / 1.25 }] }));
  const rst = useAnimatedStyle(() => ({ opacity: ring.value < 1 ? (1 - ring.value) * 0.7 : 0, transform: [{ scale: 0.6 + 0.9 * ring.value }] }));
  const dislike = () => {
    split.value = withSequence(withTiming(1, { duration: 180, easing: Easing.out(Easing.quad) }), withTiming(0, { duration: 460, easing: EASE }));
    bar.dislike?.();
  };
  const next = () => {
    nx.value = withSequence(withTiming(30, { duration: 150, easing: Easing.in(Easing.cubic) }), withTiming(-18, { duration: 0 }), withTiming(0, { duration: 210, easing: Easing.out(Easing.cubic) }));
    no.value = withSequence(withTiming(0, { duration: 150, easing: Easing.in(Easing.quad) }), withTiming(0, { duration: 0 }), withTiming(1, { duration: 190 }));
    if (bar.next) bar.next(); else P.step(1);
  };
  const on = !!t && P.isFav(t);
  const like = () => {
    if (!t) return; const was = P.isFav(t); P.toggleFav(t); buzz(was ? 'light' : 'heartbeat'); if (!was) pulse.learn('like', t);
    hk.value = withSequence(withTiming(1.25, { duration: 130, easing: Easing.out(Easing.quad) }), withTiming(1, { duration: 280, easing: EASE }));
    if (!was) { ring.value = 0; ring.value = withTiming(1, { duration: 560, easing: Easing.out(Easing.cubic) }); }
  };
  // четыре одинаковые ячейки на всю ширину капсулы: иконки стоят по центрам ячеек — ровные промежутки
  // и симметрия относительно центра капсулы. Все иконки — одного визуального размера (24 pt).
  return (
    <View style={{ flex: 1, borderRadius: 30 }}>
      <View style={[abs, { borderRadius: 30, backgroundColor: T.dark ? (T.black ? '#141416' : '#1d1c23') : '#ffffff', elevation: T.dark ? 0 : 3 }]} />
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10 }}>
        <BarBtn onPress={dislike} k={k1}><HeartFill size={24} color={T.ink} crack split={split} /></BarBtn>
        {/* треугольник «пуск» уже оптически сдвинут вправо в самой иконке — ставим ровно по центру */}
        <BarBtn onPress={() => { hap('medium'); P.toggle(); }} k={k2}><View style={{ width: 26, height: 26 }}><PlayPause playing={playing} size={26} color={T.ink} /></View></BarBtn>
        <BarBtn onPress={next} k={k3}><Animated.View style={nst}><PIcon n="next" s={24} c={T.ink} /></Animated.View></BarBtn>
        <BarBtn onPress={like} k={k4}>
          <View style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: 40, height: 40, borderRadius: 20, borderWidth: 2, borderColor: T.accent }, rst]} />
            <Animated.View style={hst}><HeartFill size={30} color={on ? T.accent : T.ink} /></Animated.View>
          </View>
        </BarBtn>
      </View>
    </View>
  );
}

// Лайк — залитое сердце, как на обложке «Любимого» (без свечения): в «Любимом» — цветом оформления.
// Сердце нарисовано на 25% крупнее и в покое уменьшено — «подпрыгивая», оно не растягивается и не пикселит.
function PLike({ t }: { t: Track }) {
  const P = usePlayer(); const T: any = useT(); const on = P.isFav(t); const k = useSharedValue(1); const b = useSharedValue(1);
  const st = useAnimatedStyle(() => ({ transform: [{ scale: k.value / 1.25 }] }));
  const ring = useAnimatedStyle(() => ({ opacity: b.value < 1 ? (1 - b.value) * 0.8 : 0, transform: [{ scale: 0.7 + 1.1 * b.value }] }));
  const tap = () => {
    const was = P.isFav(t); P.toggleFav(t); buzz(was ? 'light' : 'heartbeat'); if (!was) pulse.learn('like', t);
    k.value = withSequence(withTiming(1.25, { duration: 130, easing: Easing.out(Easing.quad) }), withTiming(1, { duration: 280, easing: EASE }));
    if (!was) { b.value = 0; b.value = withTiming(1, { duration: 560, easing: Easing.out(Easing.cubic) }); }
  };
  return (
    <View>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: RB, height: RB, borderRadius: RB / 2, borderWidth: 2, borderColor: T.accent }, ring]} />
      <Round onPress={tap}><Animated.View style={[{ margin: -3 }, st]}><HeartFill size={30} color={on ? T.accent : T.ink} /></Animated.View></Round>
    </View>
  );
}

// ================= «Мой пульс» — стопка карточек =================
// До запуска: туманность в цвете профиля, падающие звёзды, большая звезда, «Мой пульс», кнопка настроек и «Запустить».
// Стопка: верхняя карточка — играющий трек. Свайп вправо — следующий трек, влево — предыдущий (он «въезжает» слева).
// Лайк — в «Любимое», дизлайк — бан: трек больше никогда не попадётся в «Моём пульсе» (вернуть — в профиле).
// Оптимизация: жест и движения карточек — на UI-потоке, без пружин; звёзды стоят, пока вкладка скрыта.
export function Cosmos({ on, active }: { on: boolean; active: boolean }) {
  const T: any = useT(); const { width: W, height: H } = useWin(); const dk = !!T.dark;
  const k = useSharedValue(on ? 0.3 : 1);
  useEffect(() => { k.value = withTiming(on ? 0.3 : 1, { duration: 900, easing: EASE }); }, [on]);
  const st = useAnimatedStyle(() => ({ opacity: k.value }));
  // всё — из цвета профиля (основа, оба пятна, звёзды); считается один раз на цвет и тему
  const C = cosmosOf(T); const c1 = C.g1, c2 = C.g2;
  if (!SV) return null;
  return (
    <Animated.View pointerEvents="none" style={[abs, st]}>
      <SV.default key={T.accentKey + (dk ? "d" : "l")} width={W} height={H} style={abs}>
        <SV.Defs>
          <SV.RadialGradient id="cbase" cx={W * 0.3} cy={H * 0.25} r={Math.max(W, H) * 0.95} gradientUnits="userSpaceOnUse">
            {(dk ? [[0, C.base[0]], [0.45, C.base[1]], [0.8, C.base[2]], [1, C.base[2]]] : [[0, C.base[0]], [0.5, C.base[1]], [1, C.base[2]]]).map(([o, c]: any) => <SV.Stop key={o} offset={o} stopColor={c} />)}
          </SV.RadialGradient>
          <SV.RadialGradient id="cpink" cx="50%" cy="50%" r="50%">{[[0, C.a1], [1, 0]].map(([o, a]: any) => <SV.Stop key={o} offset={o} stopColor={c1} stopOpacity={a} />)}</SV.RadialGradient>
          <SV.RadialGradient id="cviol" cx="50%" cy="50%" r="50%">{[[0, C.a2], [1, 0]].map(([o, a]: any) => <SV.Stop key={o} offset={o} stopColor={c2} stopOpacity={a} />)}</SV.RadialGradient>
        </SV.Defs>
        <SV.Rect x={0} y={0} width={W} height={H} fill="url(#cbase)" />
        <SV.Ellipse cx={W * 0.52} cy={H * 0.46} rx={W * 0.62} ry={H * 0.36} fill="url(#cpink)" />
        <SV.Ellipse cx={W * 0.36} cy={H * 0.36} rx={W * 0.52} ry={H * 0.3} fill="url(#cviol)" />
      </SV.default>
      <Sky w={W} h={H} run={active} nebula={false} />
    </Animated.View>
  );
}

// одна кнопка настроек: что сейчас выбрано + значок настроек — всё остальное в шторке, применяется сразу
// кнопка ИИ-диджея рядом с настройками: звезда «Пульса» в капсуле того же стекла
function AiBtn() {
  const T: any = useT(); const k = useSharedValue(1);
  const st = useAnimatedStyle(() => ({ opacity: 0.7 + 0.3 * k.value }));
  return (
    <Pressable onPress={() => { buzz('light'); openAi(); }} hitSlop={6} onPressIn={() => { k.value = withTiming(0, { duration: 110 }); }} onPressOut={() => { k.value = withTiming(1, { duration: 300, easing: EASE }); }}>
      <Animated.View style={st}>
        <Matte radius={18} style={{ height: 36, paddingLeft: 10, paddingRight: 14, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <AiIcon size={22} />
          <Text style={{ fontFamily: SF, fontSize: 14, fontWeight: '600', color: T.ink }}>ИИ</Text>
        </Matte>
      </Animated.View>
    </Pressable>
  );
}
function CfgButton({ cfg, onPress }: { cfg: pulse.Cfg; onPress: () => void }) {
  const T: any = useT(); const k = useSharedValue(1);
  const st = useAnimatedStyle(() => ({ opacity: 0.7 + 0.3 * k.value }));
  return (
    <Pressable onPress={onPress} hitSlop={6} onPressIn={() => { k.value = withTiming(0, { duration: 110 }); }} onPressOut={() => { k.value = withTiming(1, { duration: 300, easing: EASE }); }}>
      <Animated.View style={st}>
        <Matte radius={18} style={{ height: 36, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name="options-outline" size={17} color={T.accentText} />
          <Text style={{ fontFamily: SF, fontSize: 14, fontWeight: '600', color: T.ink }}>{pulse.cfgLabel(cfg)}</Text>
          <Ionicons name="chevron-down" size={14} color={T.ink3} />
        </Matte>
      </Animated.View>
    </Pressable>
  );
}

// слоты стопки: верхняя, вторая, третья (масштаб, поворот, сдвиг, прозрачность) — «веер»
const SLOTS = [{ s: 1, r: -2, x: 0, y: 0, o: 1 }, { s: 0.96, r: -4, x: -14, y: -8, o: 0.85 }, { s: 0.92, r: 6, x: 22, y: 2, o: 0.6 }, { s: 0.88, r: 8, x: 26, y: 6, o: 0 }];
function DeckCard({ t, slot, ckey, cw, ch, W, tx, ty, goneKey, inKey, inX, enter, dragK }: any) {
  const T: any = useT(); const top = slot === 0;
  // место в стопке меняется плавно: карточка сама «доезжает» до нового слота (новая третья — проявляется сзади)
  // свайп влево: прошлый трек «въезжает» слева. Его движение запускается, когда карточка уже появилась
  // (а не заранее — раньше часть анимации проходила до первого кадра и был рывок): мягкий доезд 560 мс,
  // с лёгким поворотом и масштабом, без резкой смены прозрачности
  const incoming = useRef(inKey.value === ckey).current;
  const ex = useSharedValue(incoming ? 1 : 0);
  useEffect(() => { if (incoming) { inKey.value = ''; ex.value = withTiming(0, { duration: 560, easing: Easing.bezier(0.22, 1, 0.36, 1) }); } }, []);
  const sv = useSharedValue(incoming ? slot : slot + 1);
  useEffect(() => { sv.value = withTiming(slot, { duration: 500, easing: EASE }); }, [slot]);
  const st = useAnimatedStyle(() => {
    const f = Math.max(0, Math.min(3, sv.value)); const i0 = Math.min(2, Math.floor(f)); const fr = f - i0;
    const A = SLOTS[i0], B = SLOTS[i0 + 1];
    const m = (k: 's' | 'r' | 'x' | 'y' | 'o') => A[k] + (B[k] - A[k]) * fr;
    const mine = dragK.value ? dragK.value === ckey : top;
    const xi = ex.value; const dx = (mine ? tx.value : 0) - xi * W * 1.15, dy = mine ? ty.value : 0;
    const e = enter.value;   // выезд стопки при запуске: снизу, по очереди
    const o = xi > 0 ? 1 : m('o');   // въезжающая карточка непрозрачна
    return {
      opacity: o * (goneKey.value === ckey ? 0 : 1) * Math.min(1, e * 1.4),
      transform: [{ translateX: m('x') + dx }, { translateY: m('y') + dy + (1 - e) * (260 + slot * 60) + xi * 18 }, { rotate: `${m('r') + (dx / W) * 9}deg` }, { scale: m('s') * (1 - 0.04 * xi) }],
    };
  });
  return (
    <Animated.View pointerEvents={top ? 'auto' : 'none'} style={[{ position: 'absolute', width: cw, height: ch, borderRadius: 22, backgroundColor: T.ph, shadowColor: T.accent, shadowOpacity: T.dark ? 0.5 : 0.3, shadowRadius: 24, shadowOffset: { width: 0, height: 16 } }, st]}>
      <View style={{ flex: 1, borderRadius: 22, overflow: 'hidden' }}>
        <Pic uri={api.artPx(t.cover, cw)} style={abs} />
        <LinearGradient colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.72)']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: ch * 0.4 }} />
        <View style={{ position: 'absolute', left: 18, right: 18, bottom: 18 }}>
          <Text numberOfLines={2} style={{ fontFamily: SF, fontSize: 26, lineHeight: 30, fontWeight: '700', letterSpacing: -0.4, color: '#fff' }}>{t.title}</Text>
          <Text numberOfLines={1} style={{ fontFamily: SF, fontSize: 17, lineHeight: 22, fontWeight: '500', color: 'rgba(255,255,255,0.82)', marginTop: 2 }}>{t.artist}</Text>
        </View>
      </View>
    </Animated.View>
  );
}

function Attract({ openFull, onReset, active = true }: { openFull: () => void; onReset: () => void; active?: boolean }) {
  const P = usePlayer(); const playing = usePlaying(); const T: any = useT(); const ty = useTy(); const ctx = useCtx(); const { W, H, avail } = useArea();
  const t: Track | undefined = P.src === 'pulse' ? P.cur : undefined; const on = !!t;
  const [cfg, setCfgS] = useState<pulse.Cfg>(pulse.DEFAULT_CFG);
  useEffect(() => { pulse.getCfg().then(setCfgS); if (!on) pulse.warm(ctx()); }, []);
  const [loading, setLoading] = useState(false); const [err, setErr] = useState(false); const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState(''); const tt = useRef<any>(null);
  // подсказка по управлению — один раз, при первом показе стопки: карточка сама слегка «качается» вправо и влево,
  // поверх всплывает подсказка; пропадает после первого свайпа/нажатия или через 6 с
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!on) return; let tm: any, tm2: any;
    AsyncStorage.getItem('pulse_hint_swipe').then((v) => {
      if (v) return;
      tm = setTimeout(() => {
        setHint(true);
        tx.value = withSequence(withTiming(46, { duration: 420, easing: EASE }), withTiming(-46, { duration: 620, easing: Easing.inOut(Easing.cubic) }), withTiming(0, { duration: 420, easing: EASE }));
        tm2 = setTimeout(hideHint, 6500);
      }, 900);
    }).catch(() => {});
    return () => { clearTimeout(tm); clearTimeout(tm2); };
  }, [on]);
  const hideHint = () => { setHint(false); AsyncStorage.setItem('pulse_hint_swipe', '1').catch(() => {}); };
  const say = (s: string) => { setToast(s); clearTimeout(tt.current); tt.current = setTimeout(() => setToast(''), 2200); };
  useEffect(() => () => clearTimeout(tt.current), []);

  // ---------- до запуска ----------
  const sw = Math.round(Math.min(W * 0.62, 250));
  const breath = useSharedValue(0), out = useSharedValue(0); const aw = useAwake();
  useEffect(() => {
    if (!active || on || !aw) { cancelAnimation(breath); return; }
    breath.value = withRepeat(withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => cancelAnimation(breath);
  }, [active, on, aw]);
  useEffect(() => { if (!on) out.value = withTiming(0, { duration: 600, easing: EASE }); }, [on]);
  const starSt = useAnimatedStyle(() => ({ opacity: 1 - out.value, transform: [{ translateY: -H * 0.22 * out.value }, { scale: (1 + 0.05 * breath.value) * (1 - 0.65 * out.value) }] }));
  const glowSt = useAnimatedStyle(() => ({ opacity: (0.45 + 0.25 * breath.value) * (1 - out.value) }));
  const idleSt = useAnimatedStyle(() => ({ opacity: 1 - out.value }));
  const launch = async () => {
    if (loading) return;
    setErr(false); setLoading(true); buzz('heartbeat');
    try {
      const [list] = await Promise.all([pulse.start(ctx()), wait(500)]);
      if (!list.length) throw new Error('empty');
      buzz('ok');
      out.value = withTiming(1, { duration: 560, easing: Easing.in(Easing.cubic) });   // звезда сжимается и уходит вверх
      await wait(380);
      P.go(list, 0, 'pulse');
    } catch { setErr(true); }
    setLoading(false);
  };
  const reset = () => { buzz('medium'); AsyncStorage.removeItem('pulse_seen').catch(() => {}); onReset(); };
  // настройки применяются сразу: подобранное «Далее» отфильтровывается на месте, недостающее догружается
  const apply = (c: pulse.Cfg) => {
    setCfgS(c); pulse.setCfg(c);
    if (!on) { pulse.warm(ctx()); return; }
    const rest = (P.queue as Track[]).slice(P.idx + 1).filter((x) => pulse.fit(x, c));
    P.setUpcoming(rest);
    pulse.more(ctx(), (P.queue as Track[]).slice(0, P.idx + 1).concat(rest), 10, c).then((l) => {
      if (l.length) P.setUpcoming([...rest, ...l]); else if (!rest.length) say('Под такие настройки ничего не нашлось — ослабьте фильтры');
    }).catch(() => {});
  };

  // ---------- стопка ----------
  const cw = Math.round(Math.min(W - 86, Math.max(200, (avail - 92 - BAR_SPACE) / 1.263))), ch = Math.round(cw * 1.263);
  const deck: Track[] = on ? (P.queue as Track[]).slice(P.idx, P.idx + 3) : [];
  const tx = useSharedValue(0), tyv = useSharedValue(0), goneKey = useSharedValue(''), inKey = useSharedValue(''), inX = useSharedValue(0), enter = useSharedValue(on ? 1 : 0);
  // dragK — какую карточку двигает палец: смещение остаётся у неё, даже когда она уже стала второй в стопке
  // (свайп назад) — тогда она плавно возвращается на место, а не прыгает
  const dragK = useSharedValue(''), topKS = useSharedValue('');
  useEffect(() => { if (on) enter.value = withTiming(1, { duration: 720, easing: EASE }); else enter.value = 0; }, [on]);
  // ключ карточки — id трека (не номер в очереди: очередь «Моего пульса» подрезается сзади, номера сдвигаются,
  // и карточки пересоздавались бы целиком). Спрятанную при свайпе вперёд карточку «забываем» после смены трека —
  // иначе при свайпе назад этот же трек возвращался невидимым (это и был глюк)
  const topKey = t ? t.id : '';
  useEffect(() => { goneKey.value = ''; }, [P.idx]);
  useEffect(() => { topKS.value = topKey; }, [topKey]);
  // вперёд: карточка улетела вправо и спрятана — включаем следующий, стопка плавно поднимается
  const goNext = () => { tx.value = 0; tyv.value = 0; dragK.value = ''; P.step(1); };
  // назад: предыдущий трек «въезжает» слева поверх стопки, текущая карточка встаёт второй
  const goPrev = () => {
    const pi = P.idx - 1; const prev = (P.queue as Track[])[pi];
    if (!prev) { say('Это первый трек'); return; }
    goneKey.value = ''; inKey.value = prev.id; P.step(-1);   // tx сам плавно возвращается к нулю (back)
  };
  const flyNext = () => {
    'worklet';
    const key = topKey; dragK.value = key;
    tyv.value = withTiming(tyv.value + 40, { duration: 320, easing: Easing.in(Easing.cubic) });
    tx.value = withTiming(W * 1.3, { duration: 320, easing: Easing.in(Easing.cubic) }, (f) => { if (f) { goneKey.value = key; runOnJS(goNext)(); } });
  };
  const back = () => { 'worklet'; tx.value = withTiming(0, { duration: 260, easing: EASE }); tyv.value = withTiming(0, { duration: 260, easing: EASE }); };
  const hintR = useRef(false); hintR.current = hint;
  const hideHintIf = () => { if (hintR.current) hideHint(); };
  const thr = W * 0.28;
  const pan = Gesture.Pan().minDistance(8)
    .onStart(() => { runOnJS(hideHintIf)(); })
    .onStart(() => { dragK.value = topKS.value; })
    // влево — с лёгким сопротивлением: карточка лишь «отходит», а прошлая въезжает поверх
    .onUpdate((e) => { tx.value = e.translationX < 0 ? e.translationX * 0.45 : e.translationX; tyv.value = e.translationY * 0.35; })
    .onEnd((e) => {
      if (e.translationX > thr || e.velocityX > 900) flyNext();
      else if (e.translationX < -thr || e.velocityX < -900) { back(); runOnJS(goPrev)(); }
      else back();
    });
  // нажатие на карточку — плеер «вырастает» из неё: запоминаем, где карточка на экране, и открываем
  const deckRef = useRef<View>(null);
  const openFromCard = () => {
    const v: any = deckRef.current; if (!v?.measure) { openFull(); return; }
    // measure (от корня приложения), а не measureInWindow: на Android окно начинается под строкой состояния
    v.measure((_a: number, _b: number, w: number, h: number, x: number, y: number) => {
      if (w > 0) setFullOrigin({ x: x + w / 2 - cw / 2 + SLOTS[0].x, y: y + h / 2 - ch / 2 + SLOTS[0].y, w: cw, h: ch });
      openFull();
    });
  };
  const tap = Gesture.Tap().maxDuration(260).onEnd((_e, ok) => { if (ok) { runOnJS(hideHintIf)(); runOnJS(openFromCard)(); } });
  const deckG = Gesture.Exclusive(pan, tap);
  useAnimatedReaction(() => (tx.value > thr ? 1 : tx.value < -thr ? -1 : 0), (v, p) => { if (p !== null && v !== p && v !== 0) runOnJS(buzz)('select'); }, [thr]);
  // дизлайк = бан: трек уходит и больше не попадётся. Кнопки — в капсуле внизу (PulseBar), она зовёт эти действия
  const dislikeBtn = () => { if (!t) return; buzz('error'); pulse.dislike(t); say('Больше не попадётся · вернуть можно в профиле'); flyNext(); };
  const nextBtn = () => { buzz('light'); flyNext(); };
  bar.dislike = dislikeBtn; bar.next = nextBtn;
  useEffect(() => () => { bar.dislike = null; bar.next = null; }, []);

  const filtered = [cfg.lang, cfg.era, cfg.len, cfg.words, cfg.clean].some((x) => x && x !== 'any');
  const sub = loading ? 'Ловим ваш пульс…' : err ? (filtered ? 'Под такие настройки ничего не нашлось — ослабьте фильтры' : 'Не получилось подобрать треки. Проверьте интернет и попробуйте ещё раз') : 'Бесконечная стопка треков под ваш вкус. Свайпайте — пульс учится.';
  return (
    <View style={{ flex: 1 }}>
      {!on ? (
        <Animated.View key="idle" exiting={FadeOut.duration(260).easing(EASE)} style={[{ flex: 1, alignItems: 'center', justifyContent: 'center' }, idleSt]}>
          <Animated.View style={starSt}>
            <Pressable onPress={launch} onLongPress={reset} delayLongPress={1600} hitSlop={20} style={{ width: sw, height: sw * LSTAR_RATIO + 40, alignItems: 'center', justifyContent: 'center' }}>
              <Animated.View style={[{ position: 'absolute' }, glowSt]}><LStar w={sw * 1.12} color={T.accent} blur={14} /></Animated.View>
              <LStar w={sw} color={T.dark ? '#ffffff' : T.accent} color2={T.dark ? undefined : T.duo ? T.accent2 : undefined} />
            </Pressable>
          </Animated.View>
          <Text style={[ty.title1, { fontSize: 30, lineHeight: 36, fontWeight: '700', letterSpacing: -0.5, marginTop: 18, color: T.dark ? '#f5f5f7' : T.ink }]}>Мой пульс</Text>
          <Animated.Text key={sub} entering={FadeIn.duration(320).easing(EASE)} style={[ty.subhead, { textAlign: 'center', marginTop: 6, marginHorizontal: 44, color: T.dark ? 'rgba(245,245,247,0.7)' : T.ink3 }]}>{sub}</Animated.Text>
          <View style={{ marginTop: 22, flexDirection: 'row', gap: 8 }}><CfgButton cfg={cfg} onPress={() => setSheet(true)} /></View>
          <Press onPress={launch} to={0.95} style={{ marginTop: 16, height: 52, paddingHorizontal: 32, borderRadius: 26, backgroundColor: T.primary, flexDirection: 'row', alignItems: 'center', gap: 10, opacity: loading ? 0.7 : 1, shadowColor: T.accent, shadowOpacity: T.dark ? 0.4 : 0.28, shadowRadius: 16, shadowOffset: { width: 0, height: 8 } }}>
            <LStar w={24} color={T.onPrimary} />
            <Text style={[ty.headline, { color: T.onPrimary }]}>{loading ? 'Подбираем…' : err ? 'Ещё раз' : 'Запустить'}</Text>
          </Press>
        </Animated.View>
      ) : (
        <Animated.View key="deck" entering={FadeIn.duration(300).easing(EASE)} style={{ flex: 1, alignItems: 'center' }}>
          <GestureDetector gesture={deckG}>
            <View ref={deckRef} collapsable={false} style={{ flex: 1, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}>
              {deck.slice().reverse().map((x, ri) => { const slot = deck.length - 1 - ri; const ck = deck.findIndex((y) => y.id === x.id) === slot ? x.id : x.id + '#' + slot; return (
                <DeckCard key={ck} ckey={ck} t={x} slot={slot} cw={cw} ch={ch} W={W} tx={tx} ty={tyv} dragK={dragK} goneKey={goneKey} inKey={inKey} inX={inX} enter={enter} />); })}
              {/* короткие сообщения («Больше не попадётся…») — всплывают над стопкой */}
              {!!toast && <Animated.View key={toast} pointerEvents="none" entering={FadeIn.duration(220).easing(EASE)} exiting={FadeOut.duration(260).easing(EASE)} style={{ position: 'absolute', top: 6 }}>
                <Matte radius={18} strong style={{ height: 36, paddingHorizontal: 16, justifyContent: 'center' }}><Text style={[ty.footnote, { fontWeight: '600', color: T.ink }]}>{toast}</Text></Matte>
              </Animated.View>}
              {hint && <SwipeHint />}
            </View>
          </GestureDetector>
          {/* фильтры — под стопкой, над капсулой управления */}
          <View style={{ marginTop: 12, marginBottom: 12, flexDirection: 'row', gap: 8 }}><CfgButton cfg={cfg} onPress={() => setSheet(true)} /></View>
          {/* место под капсулу управления — она стоит там же, где мини-плеер на главной */}
          <View style={{ height: BAR_SPACE }} />
        </Animated.View>
      )}
      {sheet && <PulseSheet cfg={cfg} onApply={apply} onClose={() => setSheet(false)} />}
    </View>
  );
}

// ================= Настройки потока (шторка снизу) =================
// Каждое нажатие применяется сразу (без «Сохранить»): стопка тут же перестраивается под настройки.
function PulseSheet({ cfg, onApply, onClose }: { cfg: pulse.Cfg; onApply: (c: pulse.Cfg) => void; onClose: () => void }) {
  const T: any = useT(); const ty = useTy(); const ins = useSafeAreaInsets(); const { height: H } = useWin();
  const [c, setC] = useState(cfg); const y = useSharedValue(1);
  useEffect(() => { y.value = withTiming(0, { duration: 460, easing: SHEET }); }, []);
  const shut = useRef(false);
  const close = () => { if (shut.current) return; shut.current = true; y.value = withTiming(1, { duration: 340, easing: SHEET }, (f) => { if (f) runOnJS(onClose)(); }); };
  const sheet = useAnimatedStyle(() => ({ transform: [{ translateY: y.value * H }] }));
  const dim = useAnimatedStyle(() => ({ opacity: 1 - y.value }));
  const pan = Gesture.Pan().activeOffsetY(10).failOffsetX([-25, 25])
    .onUpdate((e) => { y.value = Math.max(0, e.translationY / 700); })
    .onEnd((e) => { if (e.translationY > 110 || e.velocityY > 800) runOnJS(close)(); else y.value = withTiming(0, { duration: 300, easing: SHEET }); });
  const set = (patch: Partial<pulse.Cfg>) => { const n = { ...c, ...patch }; setC(n); buzz('select'); onApply(n); };
  const row = (title: string, items: [string, string][], val: string | undefined, key: keyof pulse.Cfg) => (
    <View style={{ marginTop: 16 }}>
      <Text style={[ty.footnote, { marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.6 }]}>{title}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {items.map(([k, lb]) => { const on = k === (val || 'any'); return (
          <Press key={k} onPress={() => !on && set({ [key]: k } as any)} to={0.95} style={{ height: 36, paddingHorizontal: 15, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? T.primary : T.glass, borderWidth: 1, borderColor: on ? 'transparent' : T.stroke }}>
            <Text style={[ty.miniTitle, { color: on ? T.onPrimary : T.ink }]}>{lb}</Text>
          </Press>); })}
      </View>
    </View>
  );
  const isDef = JSON.stringify({ ...pulse.DEFAULT_CFG }) === JSON.stringify({ ...pulse.DEFAULT_CFG, ...c });
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Animated.View style={[abs, dim]}><Pressable onPress={close} style={[abs, { backgroundColor: T.dark ? 'rgba(0,0,0,0.5)' : 'rgba(20,16,40,0.28)' }]} /></Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[{ position: 'absolute', left: 8, right: 8, bottom: ins.bottom + 8, maxHeight: H - ins.top - 40, borderRadius: 40, backgroundColor: T.sheet, borderWidth: 1, borderColor: T.stroke, padding: 16, paddingTop: 10, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 30, shadowOffset: { width: 0, height: 12 } }, sheet]}>
          <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: T.line, marginBottom: 12 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={ty.title2}>Настроить пульс</Text>
            {!isDef && <Pressable hitSlop={10} onPress={() => set({ ...pulse.DEFAULT_CFG })}><Text style={[ty.subhead, { color: T.accentText, fontWeight: '600' }]}>Сбросить</Text></Pressable>}
          </View>
          <Text style={[ty.subhead, { marginTop: 4 }]}>Применяется сразу — стопка перестраивается</Text>
          <ScrollView style={{ flexGrow: 0 }} showsVerticalScrollIndicator={false}>
            {row('Характер', pulse.KINDS, c.kind, 'kind')}
            {row('Настроение', pulse.MOODS, c.mood, 'mood')}
            {row('Слова', pulse.WORDS, c.words, 'words')}
            {row('Язык', pulse.LANGS, c.lang, 'lang')}
            {row('Годы', pulse.ERAS, c.era, 'era')}
            {row('Длина', pulse.LENS, c.len, 'len')}
            {row('Ненормативная лексика', pulse.CLEANS, c.clean, 'clean')}
            {/* ИИ-подбор убран */}
          </ScrollView>
          <Press onPress={close} style={{ marginTop: 18, height: 52, borderRadius: 26, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[ty.headline, { color: T.onPrimary }]}>Готово</Text>
          </Press>
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
    </Modal>
  );
}

// ИИ-подбор: сколько сигналов модель уже собрала и кого полюбила; сбросить — начать учиться заново
function TasteRow() {
  const T: any = useT(); const ty = useTy(); const [st, setSt] = useState<{ n: number; top: string[] }>({ n: 0, top: [] });
  useEffect(() => { const l = () => pulse.getTaste().then(async (tz) => setSt({ n: tz.n, top: await pulse.topTaste(3) })).catch(() => {}); l(); return pulse.onTaste(l); }, []);
  const word = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'сигнал' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'сигнала' : 'сигналов');
  return (
    <View style={{ marginTop: 18, padding: 14, borderRadius: 22, backgroundColor: T.glass, borderWidth: 1, borderColor: T.stroke }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <AiIcon size={20} />
        <Text style={[ty.headline, { flex: 1 }]}>ИИ-подбор</Text>
        {st.n > 0 && <Pressable hitSlop={10} onPress={() => pulse.resetTaste()}><Text style={[ty.footnote, { color: T.muted }]}>Сбросить</Text></Pressable>}
      </View>
      <Text style={[ty.footnote, { marginTop: 6, lineHeight: 18 }]}>{st.n
        ? `Учится на ваших лайках и на том, что вы дослушиваете или пролистываете: ${st.n} ${word(st.n)}.${st.top.length ? ' Сейчас в фаворитах: ' + st.top.join(', ') + '.' : ''}`
        : 'Лайкайте, дослушивайте или пролистывайте треки — подборка начнёт подстраиваться под вас.'}</Text>
    </View>
  );
}

// ================= Первый вход: скретч-карта =================
// Под фольгой — обложка первого трека. Каждое касание открывает круглое «окошко» с этой обложкой (кусочек картинки
// точно на своём месте), поэтому края стёртого получаются мягкими и круглыми. Стёрли больше половины — фольга
// рассыпается на осколки, обложка проявляется целиком.
const Stamp = React.memo(({ x, y, R, S, u }: { x: number; y: number; R: number; S: number; u: string }) => (
  <View style={{ position: 'absolute', left: x - R, top: y - R, width: 2 * R, height: 2 * R, borderRadius: R, overflow: 'hidden' }}>
    <Image source={{ uri: u }} style={{ position: 'absolute', left: -(x - R), top: -(y - R), width: S, height: S }} />
  </View>
));

function Shard({ S, i, color }: { S: number; i: number; color: string }) {
  const p = useSharedValue(0);
  const x0 = S * (0.15 + 0.7 * rnd(i * 3 + 1)), y0 = S * (0.15 + 0.7 * rnd(i * 5 + 2));
  const ang = Math.atan2(y0 - S / 2, x0 - S / 2) + (rnd(i) - 0.5) * 0.6, dist = S * (0.45 + 0.35 * rnd(i + 9));
  const r0 = rnd(i + 4) * 90, r1 = r0 + (rnd(i + 6) - 0.5) * 260, w = 10 + rnd(i + 8) * 12;
  useEffect(() => { p.value = withDelay(rnd(i + 11) * 140, withTiming(1, { duration: 900 + rnd(i) * 400, easing: Easing.out(Easing.cubic) })); }, []);
  const st = useAnimatedStyle(() => ({
    opacity: 1 - p.value,
    transform: [{ translateX: x0 + Math.cos(ang) * dist * p.value }, { translateY: y0 + Math.sin(ang) * dist * p.value + 40 * p.value * p.value }, { rotate: `${r0 + (r1 - r0) * p.value}deg` }, { scale: 1 - 0.4 * p.value }],
  }));
  return <Animated.View style={[{ position: 'absolute', left: -w / 2, top: -w * 0.3, width: w, height: w * 0.6, borderRadius: 2, backgroundColor: color }, st]} />;
}

function Scratch({ onDone }: { onDone: () => void }) {
  const P = usePlayer(); const T: any = useT(); const ty = useTy(); const ctx = useCtx(); const { W, avail } = useArea();
  const S = Math.round(Math.max(200, Math.min(W - 80, avail - 240, 320))); const R = Math.round(S * 0.085); const N = 12;
  const [list, setList] = useState<Track[] | null>(null); const [err, setErr] = useState(false); const [tryK, setTryK] = useState(0);
  const [stamps, setStamps] = useState<{ x: number; y: number; k: number }[]>([]); const [prog, setProg] = useState(0);
  const [done, setDone] = useState(false); const [touched, setTouched] = useState(false);
  const cells = useRef(new Set<number>()); const last = useRef<{ x: number; y: number } | null>(null); const kk = useRef(0); const doneR = useRef(false); const ticks = useRef(0);

  useEffect(() => {
    let ok = true; setErr(false);
    pulse.start(ctx()).then((l) => { if (!ok) return; if (!l.length) setErr(true); else { setList(l); prefetchPic(api.hiArt(l[0].cover)); } }).catch(() => ok && setErr(true));
    return () => { ok = false; };
  }, [tryK]);
  const first = list?.[0]; const u = first ? api.hiArt(first.cover) : '';

  const complete = () => {
    if (doneR.current) return; doneR.current = true;
    setDone(true); buzz('ramp'); AsyncStorage.setItem('pulse_seen', '1').catch(() => {});
  };
  const stamp = (x: number, y: number) => {
    if (!first || doneR.current) return;
    x = Math.max(0, Math.min(S, x)); y = Math.max(0, Math.min(S, y));
    const l = last.current; const pts: { x: number; y: number }[] = [];
    if (l) {
      const d = Math.hypot(x - l.x, y - l.y); if (d < R * 0.45) return;
      const n = Math.max(1, Math.floor(d / (R * 0.5)));
      for (let i = 1; i <= n; i++) pts.push({ x: l.x + ((x - l.x) * i) / n, y: l.y + ((y - l.y) * i) / n });
    } else pts.push({ x, y });
    last.current = pts[pts.length - 1];
    const cw = S / N;
    for (const p of pts) for (let cy = 0; cy < N; cy++) for (let cx = 0; cx < N; cx++) {
      if (Math.hypot((cx + 0.5) * cw - p.x, (cy + 0.5) * cw - p.y) <= R) cells.current.add(cy * N + cx);
    }
    setStamps((s) => [...s, ...pts.map((p) => ({ ...p, k: kk.current++ }))]);
    const f = cells.current.size / (N * N); setProg(f);
    if ((ticks.current += pts.length) >= 10) { ticks.current = 0; buzz('select'); }
    if (f >= 0.5) complete();
  };

  // большая звезда на фольге: пульсирует, пока подбирается трек; гаснет при первом касании
  const beat = useSharedValue(1); const hintO = useSharedValue(1); const fh = useSharedValue(0); const foilO = useSharedValue(1); const flash = useSharedValue(0);
  useEffect(() => { beat.value = withRepeat(withSequence(withTiming(1.08, { duration: 160 }), withTiming(1, { duration: 200 }), withTiming(1.04, { duration: 140 }), withTiming(1, { duration: 900 })), -1, false); }, []);
  useEffect(() => { hintO.value = withTiming(touched ? 0 : 1, { duration: 350 }); }, [touched]);
  useEffect(() => { fh.value = withRepeat(withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }), -1, true); }, []);
  useEffect(() => {
    if (!done) return;
    foilO.value = withTiming(0, { duration: 500, easing: Easing.out(Easing.cubic) });
    flash.value = withSequence(withTiming(1, { duration: 160 }), withTiming(0, { duration: 800, easing: Easing.out(Easing.cubic) }));
  }, [done]);
  const starSt = useAnimatedStyle(() => ({ opacity: hintO.value, transform: [{ scale: beat.value }] }));
  const finger = useAnimatedStyle(() => ({ opacity: hintO.value * 0.9, transform: [{ translateX: S * (0.22 + 0.56 * fh.value) - 22 }, { translateY: S * 0.72 + Math.sin(fh.value * Math.PI * 3) * S * 0.07 - 22 }] }));
  const foilSt = useAnimatedStyle(() => ({ opacity: foilO.value }));
  const flashSt = useAnimatedStyle(() => ({ opacity: flash.value, transform: [{ scale: 0.6 + 0.9 * flash.value }] }));

  const pattern = useMemo(() => { const a: { x: number; y: number }[] = []; const g = 30; for (let y = 0; y * g < S; y++) for (let x = 0; x * g < S + g; x++) a.push({ x: x * g + (y % 2 ? g / 2 : 0) + 8, y: y * g + 10 }); return a; }, [S]);
  const ready = !!first;

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: S, height: S }}>
        <View style={{ position: 'absolute', left: 0, top: 0, width: S, height: S, borderRadius: 40, backgroundColor: T.ph, shadowColor: T.accent, shadowOpacity: 0.35, shadowRadius: 30, shadowOffset: { width: 0, height: 18 } }} />
        <View
          onStartShouldSetResponder={() => ready && !done} onMoveShouldSetResponder={() => ready && !done} onResponderTerminationRequest={() => false}
          onResponderGrant={(e) => { setTouched(true); last.current = null; stamp(e.nativeEvent.locationX, e.nativeEvent.locationY); }}
          onResponderMove={(e) => stamp(e.nativeEvent.locationX, e.nativeEvent.locationY)}
          onResponderRelease={() => { last.current = null; }}
          style={{ width: S, height: S, borderRadius: 40, overflow: "hidden" }}>
          <View pointerEvents="none" style={abs}>
            {!!u && <Image source={{ uri: u }} style={abs} />}
            <Animated.View style={[abs, foilSt]}>
              <LinearGradient colors={(T as any).duo ? [T.accent, T.accentSoft, (T as any).accentGlow, (T as any).accent2] : [T.accentSoft, T.accent, T.accentGlow, T.accent]} locations={[0, 0.45, 0.62, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={abs} />
              {pattern.map((p, i) => <View key={i} style={{ position: 'absolute', left: p.x, top: p.y, opacity: 0.22 }}><LStar w={11} color="#ffffff" /></View>)}
              {stamps.map((s) => <Stamp key={s.k} x={s.x} y={s.y} R={R} S={S} u={u} />)}
              <Animated.View style={[abs, { alignItems: 'center', justifyContent: 'center' }, starSt]}>
                <LStar w={S * 0.46} color="#ffffff" blur={10} style={{ position: 'absolute', opacity: 0.7 }} />
                <LStar w={S * 0.4} color="#ffffff" />
              </Animated.View>
            </Animated.View>
          </View>
        </View>
        {ready && !done && <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0 }, finger]}><Matte radius={22} shadow={false} style={{ width: 44, height: 44 }} /></Animated.View>}
        {done && <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0 }}>{Array.from({ length: 18 }, (_, i) => <Shard key={i} S={S} i={i} color={i % 3 ? T.accent : T.accentSoft} />)}</View>}
        <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: -S * 0.2, top: -S * 0.2, width: S * 1.4, height: S * 1.4, alignItems: 'center', justifyContent: 'center' }, flashSt]}><Glow size={S * 1.4} color="#ffffff" /></Animated.View>
      </View>

      <View style={{ height: 176, alignSelf: 'stretch', marginTop: 22 }}>
        {done && first ? (
          <Animated.View key="done" entering={FadeIn.duration(500).easing(EASE).delay(250)} style={[abs, { alignItems: 'center', paddingHorizontal: 24 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', maxWidth: '100%' }}>
              <Text numberOfLines={1} adjustsFontSizeToFit={Platform.OS === 'ios'} minimumFontScale={0.75} style={{ fontFamily: SF, fontSize: 22, lineHeight: 28, fontWeight: '600', letterSpacing: -0.3, color: T.ink, flexShrink: 1 }}>{first.title}</Text>
              {!!first.explicit && <Explicit />}
            </View>
            <Text numberOfLines={1} style={{ fontFamily: SF, fontSize: 22, lineHeight: 28, fontWeight: '400', letterSpacing: -0.3, color: T.ink3 }}>{first.artist}</Text>
            <Text style={[ty.footnote, { marginTop: 8 }]}>Ваш пульс найден ✦</Text>
            <Press onPress={() => { if (list) P.go(list, 0, 'pulse'); onDone(); }} style={{ marginTop: 16, height: 52, paddingHorizontal: 30, borderRadius: 26, backgroundColor: T.primary, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <PIcon n="play" s={20} c={T.onPrimary} /><Text style={[ty.headline, { color: T.onPrimary }]}>Слушать мой пульс</Text>
            </Press>
          </Animated.View>
        ) : (
          <Animated.View key="todo" exiting={FadeOut.duration(250).easing(EASE)} style={[abs, { alignItems: 'center', paddingHorizontal: 32 }]}>
            <Text style={[ty.title1, { fontWeight: '700', letterSpacing: -0.4 }]}>{err ? 'Нет связи' : ready ? (prog > 0.2 ? 'Ещё немного…' : 'Сотрите фольгу') : 'Подбираем трек…'}</Text>
            <Text style={[ty.subhead, { textAlign: 'center', marginTop: 4 }]}>{err ? 'Не получилось подобрать трек. Проверьте интернет' : 'Под ней — первый трек, который Пульс подобрал для вас'}</Text>
            {err ? (
              <Press onPress={() => setTryK((k) => k + 1)} style={{ marginTop: 16, height: 52, paddingHorizontal: 26, borderRadius: 26, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center' }}><Text style={[ty.headline, { color: T.onPrimary }]}>Повторить</Text></Press>
            ) : (
              <>
                <View style={{ width: 200, height: 4, borderRadius: 2, backgroundColor: T.line, marginTop: 18, overflow: 'hidden' }}>
                  <View style={{ width: `${Math.min(100, (prog / 0.5) * 100)}%`, height: 4, borderRadius: 2, backgroundColor: T.accent }} />
                </View>
                <Text style={[ty.footnote, { marginTop: 8 }]}>Только один раз — при первом входе</Text>
              </>
            )}
          </Animated.View>
        )}
      </View>
    </View>
  );
}

// Бегущая строка по центру: короткий текст стоит по центру, длинный едет (как в плеере)
function CenterMarquee({ text, style }: { text: string; style: any }) {
  const [fits, setFits] = useState(true); const [w, setW] = useState(0); const [W, setWW] = useState(0);
  useEffect(() => { setFits(!(W > 0 && w > W + 1)); }, [w, W]);
  return (
    <View onLayout={(e) => setWW(e.nativeEvent.layout.width)} style={{ alignSelf: 'stretch', height: 28 }}>
      <View pointerEvents="none" style={{ position: 'absolute', width: 4000, opacity: 0, alignItems: 'flex-start' }}><Text style={style} onLayout={(e) => setW(e.nativeEvent.layout.width)}>{text}</Text></View>
      {fits ? <Text numberOfLines={1} style={[style, { textAlign: 'center' }]}>{text}</Text> : <Marquee text={text} height={28} style={style} />}
    </View>
  );
}

// Номер сборки файла. Все файлы папки src должны быть из одной сборки — иначе приложение покажет подсказку, а не ошибку.
export const BUILD = 64;
