// Живые иконки плеера — те же рисунки и движения, что в версии для Windows (0.13.5):
// назад/вперёд — треугольники «проскакивают», перемешать — стрелки выпрыгивают, повтор — петля делает оборот
// и «1» подпрыгивает, текст — облачко пружинит и строки дописываются, очередь — строки въезжают по очереди.
// Двигаются только маленькие слои (transform/opacity) — дёшево. Без react-native-svg — обычные иконки.
import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing, SharedValue } from 'react-native-reanimated';
import { Feather, Ionicons } from '@expo/vector-icons';
import { SVGLIB } from './ui';

const SV: any = SVGLIB;
const EO = Easing.bezier(0.22, 1, 0.36, 1);
const TRI = (c: string) => ({ fill: c, stroke: c, strokeWidth: 2.4, strokeLinejoin: 'round' as const });
const LINE = (c: string, w = 2) => ({ fill: 'none', stroke: c, strokeWidth: w, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const });

// при смене dep (кроме первого показа) — прогон v: 0 → 1
function useGo(dep: any, ms: number) {
  const v = useSharedValue(1); const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } v.value = 0; v.value = withTiming(1, { duration: ms, easing: Easing.linear }); }, [dep]);
  return v;
}
// кусочно-линейная кривая по ключевым точкам [t, value] с плавностью внутри отрезков
function kf(v: number, pts: [number, number][]) {
  'worklet';
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) { const a = pts[i - 1], b = pts[i]; let p = (v - a[0]) / Math.max(1e-6, b[0] - a[0]); p = 1 - Math.pow(1 - p, 3); return a[1] + (b[1] - a[1]) * p; }
  }
  return pts[pts.length - 1][1];
}
const Layer = ({ s, st, children }: { s: number; st?: any; children: any }) => (
  <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: s, height: s }, st]}>
    <SV.default width={s} height={s} viewBox="0 0 24 24">{children}</SV.default>
  </Animated.View>
);

// назад / вперёд. go — счётчик нажатий. Треугольники нарисованы остриём влево, поэтому «вперёд» (dir = 1) зеркалим
export function ASkip({ dir, s = 38, c = '#fff', go }: { dir: 1 | -1; s?: number; c?: string; go: number }) {
  const v = useGo(go, 560); const u = s / 24;
  const t1 = useAnimatedStyle(() => ({ transform: [{ translateX: kf(v.value, [[0, 0], [0.35, -3.5 * u], [1, 0]]) }] }));
  const t2 = useAnimatedStyle(() => {
    const x = v.value < 0.45 ? kf(v.value, [[0, 0], [0.45, -6 * u]]) : v.value < 0.46 ? 6 * u : kf(v.value, [[0.46, 6 * u], [1, 0]]);
    const o = v.value < 0.45 ? kf(v.value, [[0, 1], [0.45, 0.3]]) : v.value < 0.46 ? 0 : kf(v.value, [[0.46, 0], [1, 1]]);
    return { opacity: o, transform: [{ translateX: x }] };
  });
  if (!SV) return <Ionicons name={dir < 0 ? 'play-back' : 'play-forward'} size={s} color={c} />;
  return (
    <View style={{ width: s, height: s, transform: [{ scaleX: -dir }] }}>
      <Layer s={s} st={t1}><SV.Path d="M11.3 7.6L4.9 12L11.3 16.4Z" {...TRI(c)} /></Layer>
      <Layer s={s} st={t2}><SV.Path d="M19.4 7.6L13 12L19.4 16.4Z" {...TRI(c)} /></Layer>
    </View>
  );
}

// перемешать: линии проявляются, стрелки выпрыгивают с пружинкой
export function AShuffle({ s = 22, c = '#fff', on }: { s?: number; c?: string; on: boolean }) {
  const v = useGo(on, 750);
  const ln = useAnimatedStyle(() => ({ opacity: kf(v.value, [[0, 0.2], [0.55, 1]]) }));
  const ar = useAnimatedStyle(() => ({ opacity: kf(v.value, [[0, 0], [0.4, 0], [0.7, 1]]), transform: [{ scale: kf(v.value, [[0, 0.3], [0.4, 0.3], [0.75, 1.25], [1, 1]]) }] }));
  if (!SV) return <Feather name="shuffle" size={s} color={c} />;
  return (
    <View style={{ width: s, height: s }}>
      <Layer s={s} st={ln}><SV.Path d="M4 20L21 3M4 4l5 5M15 15l6 6" {...LINE(c)} /></Layer>
      <Layer s={s} st={ar}><SV.Path d="M16 3h5v5M21 16v5h-5" {...LINE(c)} /></Layer>
    </View>
  );
}

// повтор: петля делает оборот; в режиме «повтор трека» внутри появляется и подпрыгивает «1»
export function ARepeat({ s = 22, c = '#fff', mode }: { s?: number; c?: string; mode: number }) {
  const v = useGo(mode, 1200);
  const loop = useAnimatedStyle(() => ({ transform: [{ rotate: kf(v.value, [[0, 0], [0.66, 360]]) + 'deg' }] }));
  const one = useAnimatedStyle(() => ({
    opacity: mode === 2 ? kf(v.value, [[0, 0], [0.3, 0], [0.55, 1]]) : 0,
    transform: [{ translateY: kf(v.value, [[0, 0], [0.55, 0], [0.75, -1.6 * (s / 24)], [1, 0]]) }, { scale: kf(v.value, [[0, 0.4], [0.3, 0.4], [0.55, 1], [0.75, 1.15], [1, 1]]) }],
  }), [mode]);
  if (!SV) return <Feather name="repeat" size={s} color={c} />;
  return (
    <View style={{ width: s, height: s }}>
      <Layer s={s} st={loop}><SV.Path d="M17 1.5l3.5 3.5L17 8.5M3.5 11V9.5A4.5 4.5 0 0 1 8 5h12.5M7 22.5L3.5 19 7 15.5M20.5 13v1.5A4.5 4.5 0 0 1 16 19H3.5" {...LINE(c)} /></Layer>
      <Layer s={s} st={one}><SV.Path d="M10.9 10.4l1.4-1v5.2" {...LINE(c, 1.9)} /></Layer>
    </View>
  );
}

// текст песни: облачко сжимается и пружинит, строки дописываются по очереди
export function ALyrics({ s = 21, c = '#fff', on }: { s?: number; c?: string; on: boolean }) {
  const v = useGo(on, 720);
  const bub = useAnimatedStyle(() => ({ transform: [{ scale: kf(v.value, [[0, 1], [0.28, 0.88], [0.55, 1.08], [0.7, 1]]) }] }));
  const l1 = useAnimatedStyle(() => ({ opacity: kf(v.value, [[0, 1], [0.01, 0], [0.28, 0], [0.55, 1]]), transform: [{ scaleX: kf(v.value, [[0, 1], [0.01, 0.2], [0.28, 0.2], [0.55, 1]]) }] }));
  const l2 = useAnimatedStyle(() => ({ opacity: kf(v.value, [[0, 1], [0.01, 0], [0.55, 0], [0.8, 1]]), transform: [{ scaleX: kf(v.value, [[0, 1], [0.01, 0.2], [0.55, 0.2], [0.8, 1]]) }] }));
  if (!SV) return <Ionicons name="chatbox-ellipses-outline" size={s} color={c} />;
  return (
    <View style={{ width: s, height: s }}>
      <Layer s={s} st={bub}><SV.Path d="M7.5 4h9A4.5 4.5 0 0 1 21 8.5v5a4.5 4.5 0 0 1-4.5 4.5H12l-3.9 2.9a.7.7 0 0 1-1.1-.6V18A4.5 4.5 0 0 1 3 13.5v-5A4.5 4.5 0 0 1 7.5 4z" {...LINE(c)} /></Layer>
      <Layer s={s} st={l1}><SV.Path d="M8 9.5h8" {...LINE(c)} /></Layer>
      <Layer s={s} st={l2}><SV.Path d="M8 13h5" {...LINE(c)} /></Layer>
    </View>
  );
}

// очередь: строки въезжают справа одна за другой
function useRow(v: SharedValue<number>, d: number, u: number) {
  return useAnimatedStyle(() => ({ opacity: kf(v.value, [[0, 0], [d, 0], [d + 0.55, 1]]), transform: [{ translateX: kf(v.value, [[0, 6 * u], [d, 6 * u], [d + 0.55, 0]]) }] }));
}
export function AQueue({ s = 21, c = '#fff', on }: { s?: number; c?: string; on: boolean }) {
  const v = useGo(on, 560); const u = s / 24;
  const q1 = useRow(v, 0, u), q2 = useRow(v, 0.15, u), q3 = useRow(v, 0.3, u);
  if (!SV) return <Feather name="list" size={s} color={c} />;
  const row = (y: number) => <><SV.Path d={`M8 ${y}h13`} {...LINE(c)} /><SV.Circle cx={3.6} cy={y} r={1.1} fill={c} /></>;
  return (
    <View style={{ width: s, height: s }}>
      <Layer s={s} st={q1}>{row(6)}</Layer>
      <Layer s={s} st={q2}>{row(12)}</Layer>
      <Layer s={s} st={q3}>{row(18)}</Layer>
    </View>
  );
}
