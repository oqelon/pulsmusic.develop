// Анимация запуска: звезда разворачивается из точки, из неё в обе стороны вылетают буквы («пу» — влево,
// «льс» — вправо), звезда разгорается тем же свечением, что у логотипа в приложении. Пока главная грузится,
// звезда тихо «дышит» светом; как только стартовая страница готова (чарт пришёл) — логотип улетает на своё
// место в шапке, чёрный фон тает и открывается главная. Не дольше ~4,5 с, даже без сети.
// Только движение и прозрачность (без размытия) — лёгкая для слабых телефонов.
import React, { useEffect, useRef, useState } from 'react';
import { View, Image, StatusBar, StyleSheet, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, withDelay, withSequence, withRepeat, Easing, interpolate, runOnJS, cancelAnimation } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlayer } from './player';
import { onBoot } from './boot';
import { LOGO_URI, STAR_URI, LOGO_RATIO, STAR_GLOW_URI, STAR_GLOW_PAD, STAR_SOFT_URI, STAR_SOFT_PAD, STAR_FADE_URI } from './logoData';

const E1 = Easing.bezier(0.22, 1, 0.36, 1);
const EIO = Easing.inOut(Easing.sin);
// буквы по группам (доли ширины логотипа): п | у | л | ьс; центр звезды — 48,75 %
const GR: [number, number][] = [[0.008, 0.197], [0.205, 0.417], [0.481, 0.664], [0.673, 0.992]];
const SC = 0.4875;
const AT = 220;          // буквы начинают вылетать, когда звезда почти встала
const MIN_MS = 600;      // раньше этого логотип не улетает — вся заставка около секунды (как на ПК)
const MAX_MS = 3500;     // а дольше этого не ждём, даже если главная ещё грузится
let shown = false;       // один раз за запуск приложения
// системная заставка: в сборке 7 — тёмно-фиолетовая (её цвет мягко уводим в чёрный), с 8-й — уже чёрная
let NATIVE_BG = '';
try { NATIVE_BG = String(require('expo-updates').runtimeVersion || '') === '7' ? '#1a0b33' : ''; } catch { NATIVE_BG = ''; }

function Group({ i, w, h, ink, inkOn, p, inkP }: { i: number; w: number; h: number; ink: string; inkOn: boolean; p: any; inkP: any }) {
  const [l, r] = GR[i]; const c = (l + r) / 2; const dx = (SC - c) * w;
  const st = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateX: dx * (1 - p.value) }, { scale: 0.6 + 0.4 * p.value }] }));
  const inkSt = useAnimatedStyle(() => ({ opacity: inkP.value }));
  const box = { position: 'absolute' as const, left: l * w, top: 0, width: (r - l) * w, height: h, overflow: 'hidden' as const };
  const img = { position: 'absolute' as const, left: -l * w, top: 0, width: w, height: h };
  return (
    <Animated.View style={[box, st]}>
      <Image source={{ uri: LOGO_URI }} style={[img, { tintColor: '#ffffff' }]} resizeMode="contain" />
      {inkOn && <Animated.Image source={{ uri: LOGO_URI }} style={[img, { tintColor: ink }, inkSt]} resizeMode="contain" />}
    </Animated.View>
  );
}

function SplashBody({ onDone }: { onDone: () => void }) {
  const P: any = usePlayer(); const T: any = P.T; const win = useWindowDimensions(); const ins = useSafeAreaInsets();
  // размер самого слоя (на Android окно и экран могут отличаться на высоту строки состояния)
  const [box, setBox] = useState<{ w: number; h: number } | null>(null); const W = box ? box.w : win.width, H = box ? box.h : win.height;
  const LW = Math.min(W * 0.44, 220), LH = LW / LOGO_RATIO;
  // куда улетает: логотип в шапке главной (высота 30, по центру полосы 56 под строкой состояния)
  const HH = 30, ty = ins.top + 28 - H / 2, k = HH / LH;
  const starFill = T.accentMedia || T.accent, starFill2 = T.accentMedia2;
  const sp = useSharedValue(0);                       // звезда: 0 → 1
  const lp = [useSharedValue(0), useSharedValue(0), useSharedValue(0), useSharedValue(0)];
  const g = useSharedValue(0);                        // свечение звезды
  const fly = useSharedValue(0);                      // перелёт в шапку
  const bg = useSharedValue(1);                       // чёрный фон
  const inkP = useSharedValue(0);                     // буквы перекрашиваются в цвет шапки (светлая тема)
  const started = useRef(false); const t0 = useRef(Date.now());
  const nat = useSharedValue(1); useEffect(() => { nat.value = withTiming(0, { duration: 420, easing: EIO }); }, []);
  const nativeSt = useAnimatedStyle(() => ({ opacity: nat.value }));

  // старт — когда известны цвета оформления (сохранённые настройки прочитаны), иначе звезда сменила бы цвет посреди анимации
  useEffect(() => {
    const go = () => {
      if (started.current) return; started.current = true; t0.current = Date.now();
      sp.value = withDelay(30, withTiming(1, { duration: 380, easing: E1 }));
      GR.forEach(([l, r], i) => { const c = (l + r) / 2; lp[i].value = withDelay(AT + Math.abs(SC - c) * 180, withTiming(1, { duration: 400, easing: E1 })); });
      // разгорается, как у логотипа в приложении, и дальше тихо «дышит», пока ждём главную
      g.value = withDelay(300, withSequence(withTiming(1, { duration: 420, easing: EIO }), withRepeat(withSequence(withTiming(0.45, { duration: 900, easing: EIO }), withTiming(1, { duration: 900, easing: EIO })), -1, false)));
    };
    if (P.ready) go(); else { const tm = setTimeout(go, 600); return () => clearTimeout(tm); }
  }, [P.ready]);

  // уход: главная готова (или ждём слишком долго), но не раньше, чем доиграла анимация
  useEffect(() => {
    let left = false; let tMax: any = null, tMin: any = null; let ready = false;
    const leave = () => {
      if (left) return; left = true; clearTimeout(tMax); clearTimeout(tMin);
      cancelAnimation(g); g.value = withTiming(0, { duration: 380, easing: EIO });
      fly.value = withTiming(1, { duration: 440, easing: E1 });
      inkP.value = withDelay(120, withTiming(1, { duration: 300 }));
      bg.value = withDelay(60, withTiming(0, { duration: 320, easing: Easing.out(Easing.quad) }, (f) => { if (f) runOnJS(onDone)(); }));
    };
    const tryLeave = () => { if (ready && Date.now() - t0.current >= MIN_MS) leave(); };
    const off = onBoot(() => { ready = true; const wait = MIN_MS - (Date.now() - t0.current); if (wait > 0) tMin = setTimeout(tryLeave, wait + 30); else tryLeave(); });
    tMax = setTimeout(leave, MAX_MS);
    return () => { off(); clearTimeout(tMax); clearTimeout(tMin); };
  }, []);

  const bgSt = useAnimatedStyle(() => ({ opacity: bg.value }));
  const logoSt = useAnimatedStyle(() => ({ transform: [{ translateY: ty * fly.value }, { scale: 1 + (k - 1) * fly.value }] }));
  const starSt = useAnimatedStyle(() => {
    const v = sp.value; const s = v < 0.7 ? interpolate(v, [0, 0.7], [0, 1.18]) : interpolate(v, [0.7, 1], [1.18, 1]);
    const r = v < 0.7 ? interpolate(v, [0, 0.7], [-90, 6]) : interpolate(v, [0.7, 1], [6, 0]);
    return { opacity: Math.min(1, v * 2), transform: [{ translateX: (SC - 0.5) * LW }, { scale: s }, { rotate: r + 'deg' }, { translateX: -(SC - 0.5) * LW }] };
  });
  const wide = useAnimatedStyle(() => ({ opacity: g.value * 0.85 }));
  const tight = useAnimatedStyle(() => ({ opacity: g.value }));
  const core = useAnimatedStyle(() => ({ opacity: g.value * 0.55 }));
  const padBox = (pd: number[]) => ({ position: 'absolute' as const, left: -LW * pd[0], top: -LH * pd[1], width: LW * (1 + 2 * pd[0]), height: LH * (1 + 2 * pd[1]) });
  const base = { position: 'absolute' as const, left: 0, top: 0, width: LW, height: LH };
  return (
    <View pointerEvents="none" onLayout={(e) => { const { width, height } = e.nativeEvent.layout; setBox((b) => (b && b.w === width && b.h === height ? b : { w: width, h: height })); }} style={[StyleSheet.absoluteFill, { zIndex: 999, elevation: 999 }]}>
      <StatusBar barStyle="light-content" />
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, bgSt]}>
        {/* системная заставка Android — тёмно-фиолетовая; первые доли секунды её цвет мягко уходит в чёрный, без резкой смены */}
        {!!NATIVE_BG && <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: NATIVE_BG }, nativeSt]} />}
      </Animated.View>
      {!!box && <Animated.View style={[{ position: 'absolute', left: W / 2 - LW / 2, top: H / 2 - LH / 2, width: LW, height: LH }, logoSt]}>
        {GR.map((_, i) => <Group key={i} i={i} w={LW} h={LH} ink={T.ink} inkOn={!T.dark} p={lp[i]} inkP={inkP} />)}
        <Animated.Image source={{ uri: STAR_GLOW_URI }} style={[padBox(STAR_GLOW_PAD), { tintColor: T.accentGlow || starFill }, wide]} resizeMode="stretch" />
        <Animated.View style={[base, starSt]}>
          <Image source={{ uri: STAR_URI }} style={[base, { tintColor: starFill }]} resizeMode="contain" />
          {!!T.duo && !!starFill2 && <Image source={{ uri: STAR_FADE_URI }} style={[base, { tintColor: starFill2 }]} resizeMode="contain" />}
        </Animated.View>
        <Animated.Image source={{ uri: STAR_SOFT_URI }} style={[padBox(STAR_SOFT_PAD), { tintColor: T.accentCore || '#fff' }, tight]} resizeMode="stretch" />
        <Animated.Image source={{ uri: STAR_URI }} style={[base, { tintColor: '#ffffff' }, core]} resizeMode="contain" />
      </Animated.View>}
    </View>
  );
}

export function BootSplash() {
  const [on, setOn] = useState(!shown);
  useEffect(() => { shown = true; }, []);
  if (!on) return null;
  return <SplashBody onDone={() => setOn(false)} />;
}
