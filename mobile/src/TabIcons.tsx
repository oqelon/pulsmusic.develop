// Иконки нижнего меню, которые «рисуются» при переходе в раздел (~0,5 с, без прыжков).
// Все три скруглены одинаково: линия 1,8 pt, круглые концы и стыки, мягкие углы.
//  • Главная — домик обводится одной линией (стена → крыша → стена → дверь), затем цвет наполняет его снизу, как вода.
//  • Пульс — линия «ударяет» вверх и обводит звезду логотипа, звезда заливается от центра, вспыхивает искра.
//  • Моя музыка — штиль, ребро, второй штиль, головки нот обводятся и заливаются, от нот уходит звуковая волна.
// Нужна react-native-svg. Без неё меню показывает прежние иконки (HAS_TAB_ICONS = false).
import React, { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { useSharedValue, useAnimatedProps, useAnimatedStyle, withTiming, Easing, FadeIn, FadeOut } from 'react-native-reanimated';
import { SVGLIB, Glow } from './ui';
import { LSTAR_UP, LSTAR_LO } from './logoData';

const SV: any = SVGLIB;
export const HAS_TAB_ICONS = !!SV;
const APath: any = SV ? Animated.createAnimatedComponent(SV.Path) : null;
const SW = 1.8;

const HOME = 'M4.5 19.2 V11.4 Q4.5 10.6 5.1 10.1 L10.9 5.1 Q12 4.2 13.1 5.1 L18.9 10.1 Q19.5 10.6 19.5 11.4 V19.2 Q19.5 20.6 18.1 20.6 H15.2 Q14.6 20.6 14.6 20 V16 Q14.6 14.8 13.4 14.8 H10.6 Q9.4 14.8 9.4 16 V20 Q9.4 20.6 8.8 20.6 H5.9 Q4.5 20.6 4.5 19.2 Z';
const L_HOME = 63.3;
const star = (arr: number[]) => { let d = ''; for (let i = 0; i < arr.length; i += 2) d += (i ? ' L' : 'M') + (12 + arr[i] * 22).toFixed(2) + ',' + (12 + arr[i + 1] * 22).toFixed(2); return d; };
const S_UP = star(LSTAR_UP), S_LO = star(LSTAR_LO), S_FILL = S_UP + ' ' + S_LO.replace('M', 'L') + ' Z';
const L_STAR = 32.6;
const N_STEML = 'M9 18 V5.5', N_BEAM = 'M9 5.5 L20 3.5', N_STEMR = 'M20 3.5 V16';
const N_HEADL = 'M6.5 15.5 A2.5 2.5 0 1 1 6.49 15.5', N_HEADR = 'M17.5 13.5 A2.5 2.5 0 1 1 17.49 13.5';
const L_STEM = 12.5, L_BEAM = 11.2, L_HEAD = 15.7;
const ARCS = 'M21.5 8 q1.4 3 0 6 M23.1 6.8 q2 4.1 0 8.2';

// доля этапа: t от a до b → 0…1, плавно и в начале, и в конце (этапы перекрываются — без остановок между ними)
const seg = (t: number, a: number, b: number) => { 'worklet'; const x = Math.min(1, Math.max(0, (t - a) / (b - a))); return x * x * (3 - 2 * x); };
// короткая «вспышка»: 0 → 1 → 0 на отрезке a…b
const bump = (t: number, a: number, b: number) => { 'worklet'; const x = (t - a) / (b - a); return x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x); };

type Kind = 'home' | 'pulse' | 'lib';
// on — выбрана: иконка рисуется цветом color поверх серого контура (idle), который плавно гаснет.
// Ушли с вкладки — залитая иконка мягко растворяется, а серый контур проявляется.
// color2 — второй цвет двухцветного оформления: линии и заливка переливаются из color в color2 по диагонали
export function TabIcon({ kind, on, color, color2, color3, idle, size = 26 }: { kind: Kind; on: boolean; color: string; color2?: string; color3?: string; idle: string; size?: number }) {
  const box = { position: 'absolute' as const, left: 0, top: 0, width: size, height: size };
  return (
    <View style={{ width: size, height: size }}>
      {on
        ? <Animated.View key="on" exiting={FadeOut.duration(240)} style={box}><Active kind={kind} color={color} color2={color2} color3={color3} idle={idle} size={size} /></Animated.View>
        : <Animated.View key="off" entering={FadeIn.duration(300)} style={box}><Static kind={kind} color={idle} size={size} /></Animated.View>}
    </View>
  );
}

function Static({ kind, color, size }: { kind: Kind; color: string; size: number }) {
  const S = SV.default, Path = SV.Path, line = { stroke: color, strokeWidth: SW, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <S width={size} height={size} viewBox="0 0 24 24">
      {kind === 'home' && <Path d={HOME} {...line} />}
      {kind === 'pulse' && <Path d={S_FILL} {...line} />}
      {kind === 'lib' && <><Path d={N_STEML + ' ' + N_BEAM + ' ' + N_STEMR} {...line} /><Path d={N_HEADL} {...line} /><Path d={N_HEADR} {...line} /></>}
    </S>
  );
}

function Active({ kind, color: c1, color2, color3, idle, size }: { kind: Kind; color: string; color2?: string; color3?: string; idle: string; size: number }) {
  const duo = !!color2 && color2 !== c1; const color = duo ? 'url(#tg)' : c1;
  const defs = duo ? <SV.Defs><SV.LinearGradient id="tg" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">{(color3 ? [[0, c1], [0.5, color2], [1, color3]] : [[0, c1], [1, color2]]).map(([o, c]) => <SV.Stop key={String(o)} offset={o as number} stopColor={c as string} />)}</SV.LinearGradient></SV.Defs> : null;
  const t = useSharedValue(0);
  // быстро, но мягко: стартует сразу и долго, плавно «досаживается» в конце
  useEffect(() => { t.value = withTiming(1, { duration: 640, easing: Easing.out(Easing.quad) }); }, []);
  const base = useAnimatedStyle(() => ({ opacity: 1 - seg(t.value, 0.1, 0.55) }));
  const S = SV.default, Path = SV.Path;
  const dash = (len: number, a: number, b: number) => useAnimatedProps(() => ({ strokeDashoffset: len * (1 - seg(t.value, a, b)) }));
  const line = (len: number) => ({ stroke: color, strokeWidth: SW, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none', strokeDasharray: [len, len] });
  const glow = useAnimatedStyle(() => ({ opacity: 0.45 * bump(t.value, 0.5, 1) }));
  const abs = { position: 'absolute' as const, left: 0, top: 0, width: size, height: size };
  const Base = <Animated.View pointerEvents="none" style={[abs, base]}><Static kind={kind} color={idle} size={size} /></Animated.View>;
  const Halo = null; const _halo = <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: -size * 0.5, top: -size * 0.5, width: size * 2, height: size * 2, alignItems: 'center', justifyContent: 'center' }, glow]}><Glow size={size * 2} color={c1} /></Animated.View>;

  if (kind === 'home') {
    const p = dash(L_HOME, 0, 0.58);
    // заливка поднимается снизу: видимая часть растёт от низа домика (20.6) до конька (4.2)
    const fill = useAnimatedStyle(() => { const f = seg(t.value, 0.36, 0.92); const y = 20.6 - (20.6 - 4.2) * f; return { height: ((24 - y) / 24) * size }; });
    return (
      <View style={{ width: size, height: size }}>
        {Halo}{Base}
        <S width={size} height={size} viewBox="0 0 24 24" style={abs}>{defs}<APath d={HOME} {...line(L_HOME)} animatedProps={p} /></S>
        <Animated.View style={[{ position: 'absolute', left: 0, right: 0, bottom: 0, overflow: 'hidden' }, fill]}>
          <S width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', left: 0, bottom: 0 }}>{defs}<Path d={HOME} fill={color} stroke={color} strokeWidth={SW} strokeLinejoin="round" /></S>
        </Animated.View>
      </View>
    );
  }
  if (kind === 'pulse') {
    // обе половины звезды обводятся одновременно от левого кончика — симметрично и плавно
    const up = dash(L_STAR, 0, 0.52), lo = dash(L_STAR, 0, 0.52);
    const fill = useAnimatedStyle(() => { const f = seg(t.value, 0.34, 0.88); return { opacity: f, transform: [{ scale: 0.55 + 0.45 * f }] }; });
    const spark = useAnimatedStyle(() => ({ opacity: 0.8 * bump(t.value, 0.58, 1), transform: [{ scale: 0.92 + 0.16 * seg(t.value, 0.58, 1) }] }));
    return (
      <View style={{ width: size, height: size }}>
        {Halo}{Base}
        <S width={size} height={size} viewBox="0 0 24 24" style={abs}>{defs}
          <APath d={S_UP} {...line(L_STAR)} animatedProps={up} />
          <APath d={S_LO} {...line(L_STAR)} animatedProps={lo} />
        </S>
        <Animated.View style={[abs, fill]}>
          <S width={size} height={size} viewBox="0 0 24 24">{defs}<Path d={S_FILL} fill={color} stroke={color} strokeWidth={SW} strokeLinejoin="round" /></S>
        </Animated.View>
        <Animated.View pointerEvents="none" style={[abs, spark]}>
          <S width={size} height={size} viewBox="0 0 24 24" style={{ overflow: 'visible' }}>{defs}
            <Path d="M4.2 4.2 L2.5 2.5 M19.8 4.2 L21.5 2.5 M4.2 19.8 L2.5 21.5 M19.8 19.8 L21.5 21.5" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
          </S>
        </Animated.View>
      </View>
    );
  }
  // «Моя музыка»
  const sl = dash(L_STEM, 0, 0.28), bm = dash(L_BEAM, 0.14, 0.42), sr = dash(L_STEM, 0.26, 0.54), hl = dash(L_HEAD, 0.38, 0.68), hr = dash(L_HEAD, 0.42, 0.72);
  const heads = useAnimatedStyle(() => ({ opacity: seg(t.value, 0.52, 0.86) }));
  const arcs = useAnimatedStyle(() => ({ opacity: 0.85 * bump(t.value, 0.6, 1), transform: [{ translateX: 2 * seg(t.value, 0.6, 1) }] }));
  return (
    <View style={{ width: size, height: size }}>
      {Halo}{Base}
      <S width={size} height={size} viewBox="0 0 24 24" style={abs}>{defs}
        <APath d={N_STEML} {...line(L_STEM)} animatedProps={sl} />
        <APath d={N_BEAM} {...line(L_BEAM)} animatedProps={bm} />
        <APath d={N_STEMR} {...line(L_STEM)} animatedProps={sr} />
        <APath d={N_HEADL} {...line(L_HEAD)} animatedProps={hl} />
        <APath d={N_HEADR} {...line(L_HEAD)} animatedProps={hr} />
      </S>
      <Animated.View style={[abs, heads]}>
        <S width={size} height={size} viewBox="0 0 24 24">{defs}<Path d={N_HEADL + ' ' + N_HEADR} fill={color} stroke={color} strokeWidth={SW} /></S>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[abs, arcs]}>
        <S width={size} height={size} viewBox="0 0 24 24" style={{ overflow: 'visible' }}>{defs}<Path d={ARCS} stroke={color} strokeWidth={1.2} strokeLinecap="round" fill="none" /></S>
      </Animated.View>
    </View>
  );
}

// Номер сборки файла. Все файлы папки src должны быть из одной сборки — иначе приложение покажет подсказку, а не ошибку.
export const BUILD = 64;
