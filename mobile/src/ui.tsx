import React, { useContext, useEffect, useMemo, useState } from 'react';
import { Pressable, Image, View, Text, StyleSheet, Platform, AppState, useWindowDimensions, Dimensions } from 'react-native';
import { BlurView as XBlur } from 'expo-blur';
// Матовое стекло. На Android обычный BlurView не размывает (только полупрозрачная заливка) — включаем
// настоящее размытие (как на iPhone); на iOS всё как было.
// На Android настоящее размытие дорогое (каждый кадр заново размывается весь экран под стеклом), поэтому оно
// включено только у постоянных элементов — меню, мини-плеера и верхней кромки (live). Остальное стекло на Android —
// плотная полупрозрачная заливка без размытия: выглядит так же спокойно, но не грузит телефон.
const AND = Platform.OS === 'android';
// На Android размытия нет совсем: оно захватывает и текст поверх стекла (текст «светился») и сильно грузит
// старые телефоны. Стекло на Android — плотная полупрозрачная заливка.
export const BlurView = ({ live, ...p }: any) => (AND ? null : <XBlur {...p} />);
// облегчённый режим для Android: без масок, размытия и частых перерисовок фона
export const LITE = AND;
// Единый размер обложки во всех лентах и сетках (плейлисты, подборки, релизы, чарт, «Моя музыка»): ровно два
// в ряд по ширине экрана, но не больше 176 — так на любом телефоне все обложки одного размера. Скругление 22.
export const CARD = Math.min(176, Math.floor((Dimensions.get('window').width - 48) / 2));
import { LinearGradient } from 'expo-linear-gradient';
import { LOGO_URI, LOGO_RATIO, STAR_URI, IMP_URI, IMP_RATIO, IMP_STAR_URI, STAR4_URI, STAR_HD_URI, STAR_OUT_URI, GLOW_URI, LSTAR_URI, LSTAR_RATIO, LSTAR_PAD, LSTAR_ICON_URI, LSTAR_ICON_OUT_URI, LSTAR_ICON_PAD, LSTAR_HD_URI, LSTAR_HD_PAD, LSTAR_LINE_URI, STAR_GLOW_URI, STAR_GLOW_PAD, STAR_SOFT_URI, STAR_SOFT_PAD, IMP_STAR_GLOW_URI, IMP_STAR_GLOW_PAD, IMP_STAR_SOFT_URI, IMP_STAR_SOFT_PAD, LSTAR_GLOW_URI, LSTAR_GLOW_PAD, STAR_FADE_URI, IMP_STAR_FADE_URI, LSTAR_FADE_URI, LSTAR_HD_FADE_URI } from './logoData';
import { Ionicons, Feather } from '@expo/vector-icons';
// react-native-svg — для мягких иконок плеера (npx expo install react-native-svg). Без неё — обычные иконки.
let SVG: any = null;
// expo-image (npx expo install expo-image) — кэш картинок в памяти и на диске + плавное появление. Без неё — обычный Image.
let XImage: any = null;
try { XImage = require('expo-image').Image; } catch { XImage = null; }
try { SVG = require('react-native-svg'); } catch { SVG = null; }
import Animated, { useSharedValue, useAnimatedStyle, useAnimatedProps, withRepeat, withTiming, withDelay, withSequence, FadeIn, Easing, interpolate, cancelAnimation, makeMutable, useFrameCallback } from 'react-native-reanimated';
import { usePlayer, useCurId, usePlaying, useTheme } from './player';
import { artistPhoto, artistPhotoBy, bigArt, smallArt, artPx, KIND_LABEL, warmStream } from './api';
import { RAYS_A, RAYS_B, LIGHT_GLOW } from './waterData';
import type { Track } from './api';

// Настоящий размер экрана приложения. На Android «окно» без системных полос меньше, чем то, что
// рисует приложение от края до края, — из-за этого полный плеер раньше открывался не до конца.
// Корень приложения сообщает свой размер (onLayout), и все экраны считают от него.
let rootW = 0, rootH = 0; const rootL = new Set<() => void>();
export function setRootSize(w: number, h: number) { if (Math.abs(w - rootW) < 1 && Math.abs(h - rootH) < 1) return; rootW = w; rootH = h; rootL.forEach((f) => f()); }
export function useWin() {
  const d = useWindowDimensions(); const [, f] = useState(0);
  useEffect(() => { const g = () => f((x) => x + 1); rootL.add(g); return () => { rootL.delete(g); }; }, []);
  return rootH ? { ...d, width: rootW, height: rootH } : d;
}

// Цвета темы — из отдельного контекста: компоненты, которым нужны только цвета, не перерисовываются
// при смене трека, паузе, лайках и т.п. (раньше любое изменение в плеере перерисовывало весь интерфейс).
export const useT = () => useTheme();

// Виден ли сейчас этот участок интерфейса. Скрытые вкладки и экраны под другими экранами ставят false —
// тогда бесконечные украшающие анимации (свечение логотипа, бегущая строка, эквалайзер) там ставятся на паузу
// и не нагружают телефон каждый кадр. Когда участок снова виден — анимации продолжаются.
export const VisCtx = React.createContext(true);
export const useVisible = () => useContext(VisCtx);
// Переключение «виден → скрыт» откладываем, пока не закончится анимация перехода (экран въезжает, вкладка гаснет,
// плеер раскрывается). Иначе в первые кадры перехода телефон одновременно перестраивает скрываемое — и анимация
// подтормаживает. «Скрыт → виден» применяется сразу.
export function useLater(v: boolean, ms = 480) {
  const [d, setD] = useState(v);
  useEffect(() => { if (v) { setD(true); return; } const t = setTimeout(() => setD(false), ms); return () => clearTimeout(t); }, [v]);
  return v || d;
}

// ---------- Типографика дизайн-системы (SF Pro) ----------
export const useTy = () => {
  const T = useT();
  const F = Platform.OS === 'ios' ? 'System' : undefined;   // SF Pro
  const st = useMemo(() => StyleSheet.create({
    largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: -0.6, color: T.ink },
    title1: { fontSize: 28, lineHeight: 34, fontWeight: '600', color: T.ink },
    title2: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3, color: T.ink },
    wordmark: { fontSize: 24, lineHeight: 28, fontWeight: '700', letterSpacing: -0.5, color: T.ink },
    headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', color: T.ink },
    body: { fontSize: 17, lineHeight: 22, fontWeight: '400', color: T.ink },
    callout: { fontSize: 15, lineHeight: 22, fontWeight: '400', color: T.ink2 },
    subhead: { fontSize: 15, lineHeight: 20, fontWeight: '400', color: T.ink3 },
    miniTitle: { fontSize: 15, lineHeight: 20, fontWeight: '600', color: T.ink },
    footnote: { fontSize: 13, lineHeight: 18, fontWeight: '500', color: T.ink3 },
    duration: { fontSize: 15, lineHeight: 20, fontWeight: '500', color: T.muted, fontVariant: ['tabular-nums'] },
    caption: { fontSize: 11, lineHeight: 13, fontWeight: '600', color: T.muted },
  } as const), [T]);
  // каждому стилю — системный шрифт Apple
  return useMemo(() => { const o: any = {}; for (const k in st) o[k] = [{ fontFamily: F }, (st as any)[k]]; return o as typeof st; }, [st]);
};

// ---------- Иконки: один набор (Ionicons), 22–24 pt ----------
const N: Record<string, string> = { home: 'home', search: 'search', music: 'musical-notes', 'chevron-left': 'chevron-back', 'chevron-down': 'chevron-down', heart: 'heart', 'heart-outline': 'heart-outline', camera: 'camera', plus: 'add', play: 'play', pause: 'pause', shuffle: 'shuffle', repeat: 'repeat', rewind: 'play-back', 'fast-forward': 'play-forward', 'dots-horizontal': 'ellipsis-horizontal', 'volume-low': 'volume-low', 'volume-high': 'volume-high', list: 'list', sun: 'sunny', moon: 'moon' };
export const Ic = ({ n, s = 22, c }: { n: string; s?: number; c?: string }) => { const T = useT(); return <Ionicons name={(N[n] || n) as any} size={s} color={c || T.ink} />; };

// ---------- Общие кривые движения ----------
// EASE_OUT — мягкое «доезжание» (появление, въезд), EASE_IO — плавно и в начале, и в конце (смены состояний).
export const EASE_OUT = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_IO = Easing.bezier(0.45, 0, 0.2, 1);
// Шторки снизу и смена экранов — кривая системных шторок iOS: быстро трогается и очень мягко доезжает
export const SHEET = Easing.bezier(0.32, 0.72, 0, 1);
// Появление элементов списков и лент: не просто проявляются, а чуть «всплывают» снизу (на 10 pt) —
// плавнее и живее. Работает целиком в потоке анимаций, ничего не нагружает.
export const rise = (delay = 0, dy = 6, dur = 520) => () => {
  'worklet';
  return {
    initialValues: { opacity: 0, transform: [{ translateY: dy }] },
    animations: {
      opacity: withDelay(delay, withTiming(1, { duration: dur * 0.85, easing: EASE_OUT })),
      transform: [{ translateY: withDelay(delay, withTiming(0, { duration: dur, easing: EASE_OUT })) }],
    },
  };
};

// ---------- Нажатие: плавный scale без пружины ----------
const AP = Animated.createAnimatedComponent(Pressable);
// ---------- Тактильная отдача (вибрация) — одна на всё приложение ----------
// Сила подбирается по смыслу действия:
//   select  — едва заметный «щелчок»: вкладки, фильтры, чипы, выбор цвета, ползунки;
//   light   — обычное нажатие: строки треков, кнопки, «дальше»;
//   medium  — заметное действие: пуск/пауза, долгое нажатие, тема;
//   heavy / rigid — весомое: удаление, бан, начало чего-то большого;
//   success / warning / error — системные «уведомления» iPhone (2–3 импульса);
//   heartbeat — «тук-тук» как пульс (лайк, запуск «Моего пульса»);
//   double — два быстрых лёгких (сохранено, добавлено);
//   ramp — нарастающая серия light → medium → heavy (победа в квизе, раскрытие скретч-карты).
// Без expo-haptics всё работает молча. Частые «щелчки» не чаще раза в 35 мс — не жужжит при прокрутке.
let HP: any = null; try { HP = require('expo-haptics'); } catch { HP = null; }
export type Hap = 'select' | 'light' | 'medium' | 'heavy' | 'soft' | 'rigid' | 'success' | 'warning' | 'error' | 'heartbeat' | 'double' | 'ramp';
let hapAt = 0;
export function hap(k: Hap = 'light') {
  if (!HP) return; const now = Date.now();
  if ((k === 'select' || k === 'light') && now - hapAt < 35) return; hapAt = now;
  const I = HP.ImpactFeedbackStyle || {}; const N = HP.NotificationFeedbackType || {};
  const imp = (st: any) => { try { HP.impactAsync(st); } catch {} };
  const later = (ms: number, f: () => void) => setTimeout(f, ms);
  try {
    switch (k) {
      case 'select': HP.selectionAsync(); break;
      case 'light': imp(I.Light); break;
      case 'medium': imp(I.Medium); break;
      case 'heavy': imp(I.Heavy); break;
      case 'soft': imp(I.Soft ?? I.Light); break;
      case 'rigid': imp(I.Rigid ?? I.Medium); break;
      case 'success': HP.notificationAsync(N.Success); break;
      case 'warning': HP.notificationAsync(N.Warning); break;
      case 'error': HP.notificationAsync(N.Error); break;
      case 'heartbeat': imp(I.Medium); later(150, () => imp(I.Soft ?? I.Light)); break;
      case 'double': imp(I.Light); later(90, () => imp(I.Light)); break;
      case 'ramp': imp(I.Light); later(80, () => imp(I.Medium)); later(170, () => imp(I.Heavy)); later(320, () => imp(I.Rigid ?? I.Heavy)); break;
    }
  } catch {}
}

export function Press({ onPress, onLongPress, style, children, hitSlop, to = 0.97, hap: hk, onPressIn: pin }: any) {
  const k = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: k.value }] }));
  return (
    <AP onPress={onPress ? (e: any) => { if (hk) hap(hk); onPress(e); } : undefined} onLongPress={onLongPress ? (e: any) => { hap('rigid'); onLongPress(e); } : undefined} delayLongPress={380} hitSlop={hitSlop} style={[a, style]}
      onPressIn={() => { pin?.(); k.value = withTiming(to, { duration: 120, easing: Easing.out(Easing.quad) }); }}
      onPressOut={() => { k.value = withTiming(1, { duration: 320, easing: EASE_OUT }); }}>
      {children}
    </AP>
  );
}

// ---------- Стекло ----------
// glass — в потоке страницы: полупрозрачная заливка без размытия.
// Matte — матовое стекло для плавающих элементов (меню, мини-плеер, кнопки поверх контента):
// ровное размытие + полупрозрачная заливка + тонкая светлая кромка. Без бликов и «жидких» переливов — фон мягко просвечивает.
// Тени у прозрачного стекла убраны: у вида без сплошной заливки iOS не может закешировать форму тени и
// пересчитывает её каждый кадр, пока под стеклом что-то движется (свет, звёзды, прокрутка) — это грело телефон
// и роняло частоту со 120 до 60 Гц. Стекло читается за счёт размытия и тонкой обводки.
const GLASS_OVER = { position: 'absolute' as const, left: -14, right: -14, top: -14, bottom: -14 };
export const Matte = ({ style, children, radius = 22, strong, shadow = false, pointerEvents, live }: any) => {
  const T: any = useT();
  return (
    <View pointerEvents={pointerEvents} style={[{ borderRadius: radius }, shadow && { shadowColor: T.dark ? '#000' : '#2a1e50', shadowOpacity: T.dark ? 0.45 : 0.12, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } }, style]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden', borderWidth: 1, borderColor: T.matteStroke }]}>
        {/* размытие чуть больше самой кнопки и обрезано по скруглению: у края размытия iOS подмешивает фон
            снаружи — получалось светлое кольцо внутри (будто кнопка залита не до края). Теперь край ровный */}
        <BlurView live={live} intensity={T.blur} tint={T.tint} style={GLASS_OVER} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: strong || AND ? T.matteStrong : T.matte }]} />
      </View>
      {children}
    </View>
  );
};

export const Glass = ({ style, children, radius = 22, float }: any) => {
  const T = useT();
  if (float) return <Matte radius={radius} strong style={style}>{children}</Matte>;
  return (
    <View style={[{ borderRadius: radius, overflow: 'hidden', borderWidth: 1, borderColor: T.stroke }, style]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: T.glass }]} />
      {children}
    </View>
  );
};

// Карточка поверх цветного фона (статистика артиста) — тоже матовое стекло, без блика.
// tone='dark' — тёмное матовое стекло для тёмного верха страницы
export const GlassCard = ({ style, children, radius = 22, tone }: any) => {
  const T0: any = useT(); const dk = tone === 'dark' || T0.dark;
  return (
    <View style={[{ borderRadius: radius }, style]}>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden', borderWidth: 1, borderColor: dk ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.55)' }]}>
        <BlurView intensity={T0.blur} tint={dk ? 'dark' : 'light'} style={GLASS_OVER} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: AND ? (dk ? 'rgba(30,30,36,0.55)' : 'rgba(255,255,255,0.6)') : dk ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.36)' }]} />
      </View>
      {children}
    </View>
  );
};

// Любая картинка-обложка: expo-image (один общий кэш в памяти и на диске, сам уменьшает картинку под размер места).
// Без библиотеки — обычный Image. Так все обложки живут в ОДНОМ кэше, а не в двух (Image + expo-image) сразу.
export const Pic = ({ uri, style, fit = 'cover', fade, onLoad }: { uri?: string; style: any; fit?: 'cover' | 'contain'; fade?: boolean; onLoad?: () => void }) => {
  if (XImage) return <XImage source={uri ? { uri } : undefined} style={style} contentFit={fit} cachePolicy="memory-disk" transition={fade ? 180 : 0} recyclingKey={uri} onLoad={onLoad} />;
  return <Image source={uri ? { uri } : undefined} style={style} resizeMode={fit} onLoad={onLoad} />;
};
// заранее скачать картинку на диск (не в память) — появится мгновенно, но не занимает оперативку, пока не нужна
export const prefetchPic = (uri?: string) => { if (!uri) return; try { if (XImage && XImage.prefetch) XImage.prefetch(uri, 'disk'); else Image.prefetch(uri).catch(() => {}); } catch {} };
// приложение ушло в фон (музыка играет дальше) — отпускаем картинки из памяти: Android реже выгружает приложение
try { AppState.addEventListener('change', (s) => { if (s === 'background' && XImage && XImage.clearMemoryCache) XImage.clearMemoryCache().catch?.(() => {}); }); } catch {}

export const Cover = ({ u, size, r = 12 }: { u?: string; size: number; r?: number }) => {
  const T = useT(); const st = { width: size, height: size, borderRadius: r, backgroundColor: T.ph };
  if (XImage) return <XImage source={u ? { uri: u } : undefined} style={st} contentFit="cover" cachePolicy="memory-disk" transition={180} recyclingKey={u} />;
  return <Image source={u ? { uri: u } : undefined} style={st} />;
};

// Значок «E» — трек с ненормативной лексикой (пометка iTunes trackExplicitness = explicit)
export const Explicit = () => {
  const T = useT();
  return (
    <View style={{ width: 15, height: 15, borderRadius: 3.5, backgroundColor: T.dark ? 'rgba(255,255,255,0.32)' : 'rgba(0,0,0,0.30)', alignItems: 'center', justifyContent: 'center', marginLeft: 6 }}>
      <Text style={{ fontSize: 9.5, lineHeight: 11, fontWeight: '800', color: T.dark ? '#000' : '#fff' }}>E</Text>
    </View>
  );
};

export function Skel({ n = 3, size = CARD }: { n?: number; size?: number }) {
  const T = useT(); const o = useSharedValue(0.4); const vis = useVisible();
  useEffect(() => { if (!vis) { cancelAnimation(o); return; } o.value = withRepeat(withTiming(1, { duration: 800 }), -1, true); return () => cancelAnimation(o); }, [vis]);
  const a = useAnimatedStyle(() => ({ opacity: o.value }));
  return <View style={{ flexDirection: 'row', gap: 12, paddingHorizontal: 16 }}>{Array.from({ length: n }).map((_, i) => <Animated.View key={i} style={[a, { width: size, height: size, borderRadius: 22, backgroundColor: T.ph }]} />)}</View>;
}

// Пометка «альфа» над логотипом справа — маленькая, приглушённая, как надстрочный индекс
const Alpha = ({ h, color }: { h: number; color?: string }) => {
  const T = useT(); const fs = Math.max(8, Math.round(h * 0.3));
  return <Text allowFontScaling={false} style={{ position: 'absolute', right: -1, top: -fs - 2, fontSize: fs, lineHeight: fs + 2, fontWeight: '700', letterSpacing: 0.4, color: color ? 'rgba(255,255,255,0.72)' : T.ink3 }}>альфа</Text>;
};
// ---------- Логотип «пульс»: буквы + звезда, которая время от времени мягко светится ----------
export const Logo = ({ height = 30, color, variant }: { height?: number; color?: string; variant?: 'impulse' }) => {
  const T = useT();
  const imp = variant === 'impulse';   // «импульс» — логотип подписки в том же стиле
  const LU = imp ? IMP_URI : LOGO_URI, SU = imp ? IMP_STAR_URI : STAR_URI;
  // свечение — заранее размытые картинки с запасом по краям: ореол не упирается в рамку картинки
  const GW = imp ? IMP_STAR_GLOW_URI : STAR_GLOW_URI, GWP = imp ? IMP_STAR_GLOW_PAD : STAR_GLOW_PAD;
  const GS = imp ? IMP_STAR_SOFT_URI : STAR_SOFT_URI, GSP = imp ? IMP_STAR_SOFT_PAD : STAR_SOFT_PAD; const w = height * (imp ? IMP_RATIO : LOGO_RATIO);
  const g = useSharedValue(0); const vis = useVisible(); const aw = useAwake();
  useEffect(() => {
    // пауза несколько секунд → плавно разгорается → плавно гаснет. Пока логотип не виден или покой — свечение на паузе.
    if (!vis || !aw) { cancelAnimation(g); g.value = withTiming(0, { duration: 600 }); return; }
    g.value = withRepeat(withSequence(withDelay(3600, withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.sin) })), withTiming(0, { duration: 1600, easing: Easing.inOut(Easing.sin) })), -1, false);
    return () => cancelAnimation(g);
  }, [vis, aw]);
  const wide = useAnimatedStyle(() => ({ opacity: g.value * 0.85 }));
  const tight = useAnimatedStyle(() => ({ opacity: g.value }));
  const core = useAnimatedStyle(() => ({ opacity: g.value * 0.55 }));
  // звезда розовая в тёмной теме и когда логотип белый поверх тёмной обложки; в светлой теме — белая с розовым свечением
  // логотип «Импульс» всегда со звездой цвета оформления; «Пульс» — со звездой акцента в тёмной теме и на тёмной обложке
  // звезда всегда в цвете оформления (светлая и тёмная тема), с мягкой «вспышкой» свечения
  const pink = true;
  const T2: any = T; const starFill = T.dark || color ? T2.accentMedia : T.accent;
  // двухцветное оформление: поверх звезды первого цвета — звезда второго цвета, проявляющаяся по диагонали
  const starFill2 = T.dark || color ? T2.accentMedia2 : T2.accent2; const SF = imp ? IMP_STAR_FADE_URI : STAR_FADE_URI;
  const base = { position: 'absolute' as const, width: w, height };
  const padBox = (pd: number[]) => ({ position: 'absolute' as const, left: -w * pd[0], top: -height * pd[1], width: w * (1 + 2 * pd[0]), height: height * (1 + 2 * pd[1]) });
  const gw = padBox(GWP), gs = padBox(GSP);
  if (pink) {
    // Розовая звезда: свечение делаем СВЕТЛЕЕ самой звезды — широкий розовый ореол + светлое ядро,
    // поэтому при «вспышке» звезда заметно разгорается (раньше розовый ореол сливался с розовой звездой)
    return (
      <View style={{ width: w, height }}>
        <Image source={{ uri: LU }} style={{ width: w, height, tintColor: color || T.ink }} resizeMode="contain" />
        <Animated.Image source={{ uri: GW }} style={[gw, { tintColor: T2.accentGlow }, wide]} resizeMode="stretch" />
        <Image source={{ uri: SU }} style={[base, { tintColor: starFill }]} resizeMode="contain" />
        {T2.duo && <Image source={{ uri: SF }} style={[base, { tintColor: starFill2 }]} resizeMode="contain" />}
        <Animated.Image source={{ uri: GS }} style={[gs, { tintColor: T2.accentCore }, tight]} resizeMode="stretch" />
        <Animated.Image source={{ uri: SU }} style={[base, { tintColor: '#ffffff' }, core]} resizeMode="contain" />
        {!imp && <Alpha h={height} color={color} />}
      </View>
    );
  }
  // светлая тема: белая звезда с розовым свечением
  return (
    <View style={{ width: w, height }}>
      <Image source={{ uri: LU }} style={{ width: w, height, tintColor: color || T.ink }} resizeMode="contain" />
      <Image source={{ uri: SU }} style={[base, { tintColor: '#fff' }]} resizeMode="contain" />
      <Animated.Image source={{ uri: GW }} style={[gw, { tintColor: T.accent }, wide]} resizeMode="stretch" />
      <Animated.Image source={{ uri: GS }} style={[gs, { tintColor: T.accent }, tight]} resizeMode="stretch" />
    </View>
  );
};

// ---------- NavBar: слева «назад» или аватар, по центру логотип, справа действие ----------
// Логотип в «плавающей» капсуле из матового стекла: шапка прозрачная, а логотип читается поверх любого
// содержимого, которое проезжает под ним при прокрутке (как плавающие кнопки в iOS 26). Высота 44 — как у кнопок.
export const LogoPill = ({ color }: { color?: string }) => (
  <Matte radius={22} strong style={{ height: 44, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' }}><Logo color={color} /></Matte>
);
export const NavBar = ({ left, right }: { left?: React.ReactNode; right?: React.ReactNode }) => (
  <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 }}>
    <View style={{ width: 44, alignItems: 'flex-start' }}>{left}</View>
    <Logo />
    <View style={{ width: 44, alignItems: 'flex-end' }}>{right}</View>
  </View>
);

// ---------- Кнопки ----------
// Круглая стеклянная кнопка без «пикселей». Раньше при нажатии сжималась вся кнопка вместе с матовым стеклом —
// iOS на время такой анимации рисует размытие картинкой, и кнопка становилась пиксельной. Теперь стекло стоит
// на месте и лишь чуть темнеет, а сжимается только иконка (вектор — остаётся чёткой).
export function GlassBtn({ onPress, onLongPress, size = 44, strong = true, children, hitSlop = 6, style, hap: hk = 'light' }: any) {
  const k = useSharedValue(1);
  const ic = useAnimatedStyle(() => ({ transform: [{ scale: 0.86 + 0.14 * k.value }] }));
  const dim = useAnimatedStyle(() => ({ opacity: 0.1 * (1 - k.value) }));
  return (
    <Pressable onPress={onPress ? (e: any) => { if (hk) hap(hk); onPress(e); } : undefined} onLongPress={onLongPress} hitSlop={hitSlop}
      onPressIn={() => { k.value = withTiming(0, { duration: 110, easing: Easing.out(Easing.quad) }); }}
      onPressOut={() => { k.value = withTiming(1, { duration: 320, easing: EASE_OUT }); }}>
      <Matte radius={size / 2} strong={strong} style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}>
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: size / 2, backgroundColor: '#000' }, dim]} />
        <Animated.View style={ic}>{children}</Animated.View>
      </Matte>
    </Pressable>
  );
}
export const IconBtn = ({ icon, onPress, size = 44, plain, color }: any) => {
  if (plain) return <Press onPress={onPress} hap="light" to={0.94} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}><Ic n={icon} c={color} /></Press>;
  // круглая кнопка из того же матового стекла, что и капсула логотипа
  return (
    <GlassBtn onPress={onPress} size={size}><Ic n={icon} c={color} /></GlassBtn>
  );
};

// иконки кнопок — те же, что на ПК (PcIcons подключается при отрисовке: он сам берёт SVG отсюда)
const PC_SET = new Set(['play', 'pause', 'shuffle', 'plus', 'pencil', 'trash', 'download', 'heart', 'heartO', 'check', 'close', 'more', 'search', 'queue', 'repeat', 'user', 'gear', 'clock', 'moon', 'camera', 'lyrics', 'listAdd', 'spark']);
export const Btn = ({ label, icon, kind = 'primary', onPress, style, inv }: any) => {
  const T0 = useT(); const ty = useTy(); const p = kind === 'primary';
  // inv — плотная светлая кнопка поверх тёмного фона (читается на любом цвете)
  const T = inv && !p ? { ...T0, glass: 'rgba(255,255,255,0.92)', stroke: 'transparent', ink: '#1d1d22' } : T0;
  return (
    <Press onPress={onPress} hap={p ? 'medium' : 'light'} style={[{ flex: 1, minWidth: 0, height: 52, borderRadius: 999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: p ? T.primary : T.glass, borderWidth: 1, borderColor: p ? 'transparent' : T.stroke }, style]}>
      {!!icon && (PC_SET.has(icon) ? React.createElement(require('./PcIcons').PcIcon, { n: icon, s: 18, c: p ? T.onPrimary : T.ink }) : <Ic n={icon} s={18} c={p ? T.onPrimary : T.ink} />)}
      <Text style={[ty.headline, { color: p ? T.onPrimary : T.ink }]}>{label}</Text>
    </Press>
  );
};

// ---------- Карточка статистики ----------
export const StatCard = ({ k, children, style }: any) => {
  const ty = useTy();
  return (
    <Glass radius={22} style={[{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16 }, style]}>
      <Text style={ty.footnote}>{k}</Text>
      <View style={{ marginTop: 4 }}>{children}</View>
    </Glass>
  );
};

// ---------- Эквалайзер «сейчас играет» ----------
export function Eq({ playing }: { playing: boolean }) {
  const T = useT();
  const h = [useSharedValue(6), useSharedValue(12), useSharedValue(8)]; const vis = useVisible(); const aw = useAwake();
  useEffect(() => {
    h.forEach((v, i) => {
      if (playing && vis && aw) v.value = withDelay(i * 150, withRepeat(withTiming(i === 1 ? 4 : 12, { duration: 420 + i * 90, easing: Easing.inOut(Easing.quad) }), -1, true));
      else v.value = withTiming([6, 12, 8][i], { duration: 200 });
    });
  }, [playing, vis, aw]);
  useEffect(() => () => h.forEach((v) => cancelAnimation(v)), []);
  const st = h.map((v) => useAnimatedStyle(() => ({ height: v.value })));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 12, marginRight: 6 }}>
      {st.map((s, i) => <Animated.View key={i} style={[{ width: 3, borderRadius: 2, backgroundColor: (T as any).tri ? [T.accent, (T as any).accent2, (T as any).accent3][i % 3] : (T as any).duo && i % 2 ? (T as any).accent2 : T.accentText }, s]} />)}
    </View>
  );
}

// ---------- Карточки лент ----------
export const Card = React.memo(function Card({ t, i, onPress }: { t: Track; i: number; onPress: () => void }) {
  const T = useT(); const ty = useTy();
  return (
    <Animated.View entering={i < 10 ? rise(Math.min(i, 8) * 45) : undefined}>
      <Press onPress={onPress} style={{ width: CARD }}>
        <View style={{ borderRadius: 22, backgroundColor: T.ph, marginBottom: 8 }}><Cover u={artPx(t.cover, CARD)} size={CARD} r={22} /></View>
        <Text numberOfLines={1} style={ty.miniTitle}>{t.title}</Text>
        <Text numberOfLines={1} style={ty.footnote}>{t.artist}</Text>
      </Press>
    </Animated.View>
  );
});

export const AlbumCard = React.memo(function AlbumCard({ x, onPress, i = 0, sub }: any) {
  const T = useT(); const ty = useTy();
  return (
    <Animated.View entering={i < 10 ? rise(Math.min(i, 8) * 45) : undefined}>
      <Press onPress={onPress} style={{ width: CARD }}>
        <View style={{ borderRadius: 22, backgroundColor: T.ph, marginBottom: 8 }}><Cover u={artPx(x.artworkUrl100, CARD)} size={CARD} r={22} /></View>
        <Text numberOfLines={1} style={ty.miniTitle}>{x.collectionName}</Text>
        <Text numberOfLines={1} style={ty.footnote}>{sub === 'year' ? [(x.releaseDate || '').slice(0, 4), x.trackCount > 1 ? `${x.trackCount} тр.` : ''].filter(Boolean).join(' · ') : [x.artistName, (x.releaseDate || '').slice(0, 4)].filter(Boolean).join(' · ')}</Text>
      </Press>
    </Animated.View>
  );
});

export const MoreCard = ({ onPress, count }: { onPress: () => void; count: number }) => {
  const ty = useTy();
  return (
    <Press onPress={onPress} style={{ width: CARD }}>
      <Glass radius={22} style={{ width: CARD, height: CARD, alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>
        <Ic n="chevron-forward" s={28} />
        <Text style={[ty.headline, { marginTop: 4 }]}>Ещё</Text>
      </Glass>
      <Text style={[ty.footnote, { textAlign: 'center' }]}>Весь список · {count}</Text>
    </Press>
  );
};

const fmtDur = (s?: number) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '');

// ---------- TrackRow: обложка 48 · текст · длительность · лайк 44 ----------
// Эквалайзер у играющего трека: только он следит за «играет/пауза», а не весь список
const NowEq = () => { const playing = usePlaying(); return <Eq playing={playing} />; };
// Строка трека. Оптимизация: следит только за id играющего трека (а не за всем плеером) и перерисовывается,
// только если изменился сам трек, его место, лайк или вид строки — смена трека больше не перерисовывает весь список.
// Плавное появление — только у первых 14 строк (дальше их всё равно не видно, а анимации стоили бы кадров).
const RowImpl = ({ t, i, onPress, onLongPress, onArtist, fav, onFav, noFav, noCover, num }: any) => {
  const cur = useCurId(); const T = useT(); const ty = useTy();
  const now = cur === t.id;
  return (
    <Animated.View entering={i < 14 ? rise(Math.min(i, 10) * 35, 5, 520) : undefined}>
      <Press onPress={onPress} onPressIn={() => warmStream(t)} hap="light" onLongPress={onLongPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: noCover ? 11 : 8, paddingLeft: num ? 8 : 16 }}>
        {!!num && <Text style={[ty.subhead, { width: 24, textAlign: 'center', fontVariant: ['tabular-nums'] }]}>{i + 1}</Text>}
        {!noCover && <Cover u={smallArt(t.cover)} size={48} r={12} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {now && <NowEq />}
            <Text numberOfLines={1} style={[ty.headline, { flexShrink: 1 }, now && { color: T.accentText }]}>{t.title}</Text>
            {!!t.explicit && <Explicit />}
          </View>
          <Text numberOfLines={1} style={[ty.subhead, { marginTop: 2 }]} onPress={onArtist}>{t.artist}</Text>
        </View>
        {!!t.dur && <Text style={ty.duration}>{fmtDur(t.dur)}</Text>}
        {noFav ? <View style={{ width: 16 }} /> : <Pressable hitSlop={6} onPress={() => { hap(fav ? 'light' : 'heartbeat'); onFav?.(); }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Ionicons name={fav ? 'heart' : 'heart-outline'} size={22} color={fav ? T.accent : T.muted} />
        </Pressable>}
      </Press>
    </Animated.View>
  );
};

export const Row = React.memo(RowImpl, (a: any, b: any) => a.t === b.t && a.i === b.i && a.fav === b.fav && a.noFav === b.noFav && a.noCover === b.noCover && a.num === b.num);

export const AlbumRow = React.memo(function AlbumRow({ x, i, onPress }: any) {
  const ty = useTy();
  return (
    <Animated.View entering={i < 14 ? rise(Math.min(i, 10) * 35, 5, 520) : undefined}>
      <Press onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 14 }}>
        <Cover u={smallArt(x.artworkUrl100)} size={48} r={12} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={ty.headline}>{x.collectionName}</Text>
          <Text numberOfLines={1} style={[ty.subhead, { marginTop: 2 }]}>{[x.kind ? KIND_LABEL[x.kind as 'album'] : '', (x.releaseDate || '').slice(0, 4), x.trackCount ? `${x.trackCount} тр.` : ''].filter(Boolean).join(' · ')}</Text>
        </View>
      </Press>
    </Animated.View>
  );
});

// Кружок исполнителя: фото из Deezer, а если не нашлось — обложка трека
export function ArtistDot({ name, id, fallback, size = 62, onPress }: { name: string; id?: number; fallback?: string; size?: number; onPress?: () => void }) {
  const [u, setU] = useState('');
  // для маленьких кружков — маленькое фото, для большого на странице артиста — большое. Есть id — ищем по нему (точнее)
  useEffect(() => { let ok = true; setU(''); artistPhotoBy(name, id, size <= 100).then((x) => ok && x && setU(x)).catch(() => {}); return () => { ok = false; }; }, [name, id, size]);
  const body = <Cover u={u || fallback} size={size} r={size / 2} />;
  return onPress ? <Press onPress={onPress}>{body}</Press> : body;
}

// ---------- Иконки плеера: скруглённые углы и мягкие формы ----------
// Залитые фигуры обводятся тем же цветом с круглыми стыками — так острые углы треугольников становятся мягкими.
type PN = 'play' | 'pause' | 'next' | 'prev';
const PFALL: Record<PN, string> = { play: 'play', pause: 'pause', next: 'play-forward', prev: 'play-back' };
export function PIcon({ n, s = 24, c = '#fff' }: { n: PN; s?: number; c?: string }) {
  if (!SVG) return <Ionicons name={PFALL[n] as any} size={s} color={c} />;
  const S = SVG.default, Path = SVG.Path, Rect = SVG.Rect;
  const soft = { fill: c, stroke: c, strokeWidth: 2.4, strokeLinejoin: 'round' as const };
  return (
    <S width={s} height={s} viewBox="0 0 24 24">
      {n === 'play' && <Path d="M8.6 6.2 L18.2 12 L8.6 17.8 Z" {...soft} />}
      {n === 'pause' && <><Rect x={6.3} y={5.2} width={4.3} height={13.6} rx={1.9} fill={c} /><Rect x={13.4} y={5.2} width={4.3} height={13.6} rx={1.9} fill={c} /></>}
      {n === 'next' && <><Path d="M4.6 7.6 L11 12 L4.6 16.4 Z" {...soft} /><Path d="M12.7 7.6 L19.1 12 L12.7 16.4 Z" {...soft} /></>}
      {n === 'prev' && <><Path d="M19.4 7.6 L13 12 L19.4 16.4 Z" {...soft} /><Path d="M11.3 7.6 L4.9 12 L11.3 16.4 Z" {...soft} /></>}
    </S>
  );
}
// Линейные иконки плеера — Feather: круглые концы и стыки линий
export const LIcon = ({ n, s = 22, c = '#fff' }: { n: string; s?: number; c?: string }) => <Feather name={n as any} size={s} color={c} />;

export const HAS_SVG = !!SVG;
// Звезда «Пульса» (4 луча с вогнутыми гранями) — для бегунка ползунка. Обычная картинка с tintColor:
// работает без дополнительных библиотек.
export function StarShape({ size, color }: { size: number; color: string }) {
  return <Image source={{ uri: STAR4_URI }} style={{ width: size, height: size, tintColor: color }} resizeMode="contain" />;
}

// Большая звезда (256 px) — не теряет чёткость в крупном размере. blur — мягкое свечение
export function StarHD({ size, color, blur, style }: { size: number; color: string; blur?: number; style?: any }) {
  return <Image source={{ uri: STAR_HD_URI }} blurRadius={blur} style={[{ width: size, height: size, tintColor: color }, style]} resizeMode="contain" />;
}
// Контур звезды — для иконки неактивной вкладки «Пульс»
export function StarOutline({ size, color }: { size: number; color: string }) {
  return <Image source={{ uri: STAR_OUT_URI }} style={{ width: size, height: size, tintColor: color }} resizeMode="contain" />;
}
// Круглое мягкое свечение заданного цвета
export function Glow({ size, color, style }: { size: number; color: string; style?: any }) {
  return <Image source={{ uri: GLOW_URI }} style={[{ width: size, height: size, tintColor: color }, style]} resizeMode="stretch" />;
}

// Звезда логотипа «Пульс» (симметричная). w — ширина от кончика до кончика луча; картинка центрируется по центру звезды.
// Крупная звезда (больше 120 pt) берётся из картинки высокого разрешения — без «пикселей». line — только контур.
export function LStar({ w, color, color2, blur, style, line }: { w: number; color: string; color2?: string; blur?: number; style?: any; line?: boolean }) {
  const hd = line || w > 120; const pad = hd ? LSTAR_HD_PAD : LSTAR_PAD;
  const iw = w * (1 + 2 * pad), ih = w * (LSTAR_RATIO + 2 * pad);
  // свечение (blur) — заранее размытая звезда с прозрачным запасом: ореол мягко уходит в ноль, без рамок.
  // Запас добавлен поровну со всех сторон, поэтому звезда-свечение остаётся точно по центру звезды.
  if (blur) {
    const gx = iw * LSTAR_GLOW_PAD[0], gy = ih * LSTAR_GLOW_PAD[1];
    return <Image source={{ uri: LSTAR_GLOW_URI }} style={[{ width: iw + 2 * gx, height: ih + 2 * gy, marginHorizontal: -gx, marginVertical: -gy, tintColor: color }, style]} resizeMode="stretch" />;
  }
  // color2 — второй цвет: звезда переливается по диагонали из color в color2
  if (color2 && color2 !== color && !line) return (
    <View style={[{ width: iw, height: ih }, style]}>
      <Image source={{ uri: hd ? LSTAR_HD_URI : LSTAR_URI }} style={{ position: 'absolute', width: iw, height: ih, tintColor: color }} resizeMode="stretch" />
      <Image source={{ uri: hd ? LSTAR_HD_FADE_URI : LSTAR_FADE_URI }} style={{ position: 'absolute', width: iw, height: ih, tintColor: color2 }} resizeMode="stretch" />
    </View>
  );
  return <Image source={{ uri: line ? LSTAR_LINE_URI : hd ? LSTAR_HD_URI : LSTAR_URI }} style={[{ width: iw, height: ih, tintColor: color }, style]} resizeMode="stretch" />;
}
export const SVGLIB = SVG;

// Защита от двойного нажатия: действие срабатывает один раз, повторные нажатия в течение ms игнорируются.
// Для действий, которые что-то создают или открывают (экран, плейлист, «Поделиться»).
let onceAt = 0;
export const once = (fn: () => void, ms = 600) => { const n = Date.now(); if (n - onceAt < ms) return; onceAt = n; fn(); };

// ---------- Градиент «как в референсе»: мягкое радиальное пятно из трёх цветов ----------
// colors = [центр, кольцо, края]; позиции как в макете: 0 → 0,42 → 1. Рисуется одной векторной фигурой (SVG),
// поэтому сам подстраивается под любой размер (обложка 44 pt или фон 400 pt) и стоит копейки: ни картинок, ни анимаций.
// fade — края растворяются в прозрачность (для фонов поверх экрана), cx/cy — где центр пятна (доли 0…1).
let gid = 0;
// Плавный переход: вместо трёх опорных цветов (между ними линейный переход давал заметные «кольца»)
// считаем 13 промежуточных точек, и внутри каждого участка цвет меняется по мягкой S-кривой.
// Так центр, кольцо и края перетекают друг в друга без видимых границ.
const hx = (c: string) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mixc = (a: number[], b: number[], k: number) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;
const ss = (x: number) => x * x * (3 - 2 * x);
const STEPS = Array.from({ length: 13 }, (_, i) => i / 12);
const smoothStops = (colors: string[], fade?: boolean, strength = 1) => {
  const c = colors.map(hx); const mid = 0.42;
  return STEPS.map((t) => {
    const col = t <= mid ? mixc(c[0], c[1], ss(t / mid)) : mixc(c[1], c[2], ss((t - mid) / (1 - mid)));
    // для фона поверх экрана: прозрачность тоже уходит в ноль плавно (по S-кривой), без края
    const op = fade ? strength * (1 - ss(t)) : strength;
    return { t, col, op };
  });
};
const stopCache = new Map<string, { t: number; col: string; op: number }[]>();
export const RadialFill = React.memo(function RadialFill({ colors, style, fade, cx = 0.5, cy = 0.5, strength = 1 }: { colors: string[]; style?: any; fade?: boolean; cx?: number; cy?: number; strength?: number }) {
  const id = useMemo(() => 'rg' + ++gid, []);
  const key = colors.join() + (fade ? 'f' : '') + strength;
  let stops = stopCache.get(key); if (!stops) { stops = smoothStops(colors, fade, strength); if (stopCache.size > 60) stopCache.clear(); stopCache.set(key, stops); }
  if (!SVG) return <LinearGradient pointerEvents="none" colors={stops.map((x) => x.col) as any} locations={STEPS as any} start={{ x: 0.2, y: 0.2 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, style]} />;
  const S = SVG.default;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, style]}>
      <S width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
        <SVG.Defs>
          <SVG.RadialGradient id={id} cx={cx * 100} cy={cy * 100} r={50} fx={cx * 100} fy={cy * 100} gradientUnits="userSpaceOnUse">
            {stops.map((x) => <SVG.Stop key={x.t} offset={x.t} stopColor={x.col} stopOpacity={x.op} />)}
          </SVG.RadialGradient>
        </SVG.Defs>
        {!fade && <SVG.Rect x="0" y="0" width="100" height="100" fill={colors[2]} fillOpacity={strength} />}
        <SVG.Rect x="0" y="0" width="100" height="100" fill={`url(#${id})`} />
      </S>
    </View>
  );
});   // react-native-svg, если установлена (иначе null)

// «Разбитое сердце» для дизлайка: то же сердце, что у лайка (контур Ionicons), разделённое на две половинки,
// которые чуть расходятся в стороны. split — насколько разошлись (0…1), для анимации.
export function BrokenHeart({ size, color, split = 0 }: { size: number; color: string; split?: any }) {
  const half = size / 2;
  const L = useAnimatedStyle(() => { const k = typeof split === 'number' ? split : split.value; return { transform: [{ translateX: -1.2 - 2.5 * k }, { translateY: size * 0.3 }, { rotate: `${-8 - 10 * k}deg` }, { translateY: -size * 0.3 }] }; });
  const R = useAnimatedStyle(() => { const k = typeof split === 'number' ? split : split.value; return { transform: [{ translateX: 1.2 + 2.5 * k }, { translateY: size * 0.3 }, { rotate: `${8 + 10 * k}deg` }, { translateY: -size * 0.3 }] }; });
  return (
    <View style={{ width: size + 4, height: size, flexDirection: 'row', justifyContent: 'center' }}>
      <Animated.View style={[{ width: half, height: size, overflow: 'hidden' }, L]}><Ionicons name="heart-outline" size={size} color={color} /></Animated.View>
      <Animated.View style={[{ width: half, height: size, overflow: 'hidden' }, R]}><View style={{ marginLeft: -half }}><Ionicons name="heart-outline" size={size} color={color} /></View></Animated.View>
    </View>
  );
}
// ---------- Сердце: лайк и дизлайк в одном стиле ----------
// Залитое сердце той же формы, что на обложке «Любимого». crack — дизлайк: то же сердце с ПРОЗРАЧНОЙ трещиной
// (две половины с зазором по зигзагу); split (0…1) — половинки расходятся при нажатии. Вектор — чёткий в любом размере.
const HEART_D = 'M256 448a32 32 0 01-18-5.57c-78.59-53.35-112.62-89.93-131.39-112.8-40-48.75-59.15-98.8-58.61-153C48.63 114.52 98.46 64 159.08 64c44.08 0 74.61 24.83 92.39 45.51a6 6 0 009.06 0C278.31 88.81 308.84 64 352.92 64c60.62 0 110.45 50.52 111.08 112.64.54 54.21-18.63 104.26-58.61 153-18.77 22.87-52.8 59.45-131.39 112.8a32 32 0 01-18 5.56z';
const ZIG = [[262, 96], [236, 188], [286, 252], [236, 322], [272, 384], [256, 466]];
const zigPoly = (side: number, g: number) => (side < 0
  ? ['0,0', ...ZIG.map(([x, y]) => `${x - g},${y}`), '0,512']
  : ['512,0', ...ZIG.map(([x, y]) => `${x + g},${y}`), '512,512']).join(' ');
let hid = 0;
export function HeartFill({ size, color, crack, split }: { size: number; color: string; crack?: boolean; split?: any }) {
  const id = useMemo(() => 'hc' + ++hid, []);
  const L = useAnimatedStyle(() => { const k = split ? split.value : 0; return { transform: [{ translateX: -size * 0.05 * k }, { rotate: `${-7 * k}deg` }] }; });
  const R = useAnimatedStyle(() => { const k = split ? split.value : 0; return { transform: [{ translateX: size * 0.05 * k }, { rotate: `${7 * k}deg` }] }; });
  if (!SVG) return crack ? <BrokenHeart size={size} color={color} split={split} /> : <Ionicons name="heart" size={size} color={color} />;
  const S = SVG.default;
  if (!crack) return <S width={size} height={size} viewBox="0 0 512 512"><SVG.Path d={HEART_D} fill={color} /></S>;
  const half = (side: number) => (
    <S width={size} height={size} viewBox="0 0 512 512">
      <SVG.Defs><SVG.ClipPath id={id + side}><SVG.Polygon points={zigPoly(side, 15)} /></SVG.ClipPath></SVG.Defs>
      <SVG.Path d={HEART_D} fill={color} clipPath={`url(#${id + side})`} />
    </S>
  );
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View style={[StyleSheet.absoluteFill, L]}>{half(-1)}</Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, R]}>{half(1)}</Animated.View>
    </View>
  );
}
// Иконка вкладки «Пульс»: залитая — активная, контур — неактивная (одинаковый размер, без сдвига при переключении)
export function LStarIcon({ w, color, on }: { w: number; color: string; on: boolean }) {
  const iw = w * (1 + 2 * LSTAR_ICON_PAD), ih = w * (LSTAR_RATIO + 2 * LSTAR_ICON_PAD);
  return <Image source={{ uri: on ? LSTAR_ICON_URI : LSTAR_ICON_OUT_URI }} style={{ width: iw, height: ih, tintColor: color }} resizeMode="stretch" />;
}

// ---------- Бегущая строка для длинных названий (как в Spotify) ----------
// Если текст помещается — обычная строка. Если нет — через паузу он плавно уезжает влево до конца,
// следом подъезжает его копия, и так бесконечно. Края мягко растворяются: справа всегда,
// слева — только пока текст едет (в покое первая буква не «тает»).
let MV: any = null;
try { MV = AND ? null : require('@react-native-masked-view/masked-view').default; } catch { MV = null; }
const GAP = 56, SPEED = 34;   // зазор между копиями (pt) и скорость (pt/с)
export function Marquee({ text, style, height, onPress, fade = 26 }: { text: string; style: any; height: number; onPress?: () => void; fade?: number }) {
  const [W, setW] = useState(0); const [w, setTw] = useState(0); const vis = useVisible(); const aw = useAwake();
  const x = useSharedValue(0); const D = useSharedValue(1);
  const over = W > 0 && w > W + 1;
  useEffect(() => {
    cancelAnimation(x); x.value = 0;
    if (!over || !vis || !aw) return;   // скрытая бегущая строка и строка в покое не крутятся
    const dist = w + GAP; D.value = dist;
    // два прохода, затем строка стоит (новый трек или касание — снова два прохода)
    x.value = withRepeat(withSequence(
      withDelay(1800, withTiming(-dist, { duration: (dist / SPEED) * 1000, easing: Easing.linear })),
      withTiming(0, { duration: 0 })), 2, false);
    return () => cancelAnimation(x);
  }, [over, w, W, text, vis, aw]);
  const move = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  // левый край «включается» только когда текст сдвинулся (и плавно — без скачка при повторе)
  const rest = useAnimatedStyle(() => ({ opacity: Math.max(interpolate(x.value, [-14, 0], [0, 1], 'clamp'), interpolate(x.value, [-D.value, -D.value + 14], [1, 0], 'clamp')) }));
  const abs = StyleSheet.absoluteFill;
  const measure = (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: 4000, opacity: 0, alignItems: 'flex-start' }}>
      <Text style={style} onLayout={(e) => setTw(Math.ceil(e.nativeEvent.layout.width))}>{text}</Text>
    </View>
  );
  const row = (
    <Animated.View style={[{ position: 'absolute', left: 0, top: 0, flexDirection: 'row', width: w * 2 + GAP + 4 }, move]}>
      <Text style={style} onPress={onPress}>{text}</Text>
      <View style={{ width: GAP }} />
      <Text style={style} onPress={onPress}>{text}</Text>
    </Animated.View>
  );
  return (
    <View onLayout={(e) => setW(Math.floor(e.nativeEvent.layout.width))} style={{ height, overflow: 'hidden', alignSelf: 'stretch' }}>
      {measure}
      {!over ? <Text numberOfLines={1} style={style} onPress={onPress}>{text}</Text>
        : MV ? (
          <MV style={{ flex: 1 }} maskElement={
            <View style={{ flex: 1, flexDirection: 'row' }}>
              <View style={{ width: fade * 0.7 }}>
                <LinearGradient colors={['rgba(0,0,0,0)', '#000']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={abs} />
                <Animated.View style={[abs, { backgroundColor: '#000' }, rest]} />
              </View>
              <View style={{ flex: 1, backgroundColor: '#000' }} />
              <LinearGradient colors={['#000', 'rgba(0,0,0,0)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ width: fade }} />
            </View>
          }>{row}</MV>
        ) : row}
    </View>
  );
}

// ---------- Кнопка «играть / пауза»: значок плавно перетекает из треугольника в две полоски и обратно ----------
// Треугольник собран из двух четырёхугольников (левая и правая половины), пауза — из двух полосок.
// Вершины плавно переезжают; обводка того же цвета с круглыми стыками делает углы мягкими.
// Треугольник сдвинут так, чтобы его оптический центр (а не рамка) был ровно в центре круга.
// формы — прежние: треугольник 8.6/18.2 и полоски 6.3–10.6 и 13.4–17.7 (с мягкой обводкой 2.4 те же размеры)
const PP_PLAY = [[8.6, 6.2, 13.4, 9.1, 13.4, 14.9, 8.6, 17.8], [13.4, 9.1, 18.2, 12, 18.2, 12, 13.4, 14.9]];
const PP_PAUSE = [[7.5, 6.4, 9.4, 6.4, 9.4, 17.6, 7.5, 17.6], [14.6, 6.4, 16.5, 6.4, 16.5, 17.6, 14.6, 17.6]];
const ppPath = (k: number, i: number) => {
  'worklet';
  const a = PP_PLAY[i], b = PP_PAUSE[i]; let d = '';
  for (let j = 0; j < 8; j += 2) d += (j ? ' L' : 'M') + (a[j] + (b[j] - a[j]) * k).toFixed(2) + ' ' + (a[j + 1] + (b[j + 1] - a[j + 1]) * k).toFixed(2);
  return d + ' Z';
};
const APP: any = SVG ? Animated.createAnimatedComponent(SVG.Path) : null;
export function PlayPause({ playing, size = 32, color = '#fff' }: { playing: boolean; size?: number; color?: string }) {
  const k = useSharedValue(playing ? 1 : 0); const sc = useSharedValue(1);
  useEffect(() => {
    k.value = withTiming(playing ? 1 : 0, { duration: 300, easing: Easing.bezier(0.45, 0, 0.2, 1) });
    sc.value = withSequence(withTiming(0.9, { duration: 110, easing: Easing.out(Easing.quad) }), withTiming(1, { duration: 240, easing: Easing.out(Easing.cubic) }));
  }, [playing]);
  const p0 = APP ? useAnimatedProps(() => ({ d: ppPath(k.value, 0) })) : null;
  const p1 = APP ? useAnimatedProps(() => ({ d: ppPath(k.value, 1) })) : null;
  const st = useAnimatedStyle(() => ({ transform: [{ scale: sc.value }] }));
  if (!APP) return <Animated.View style={st}><PIcon n={playing ? 'pause' : 'play'} s={size} c={color} /></Animated.View>;
  const S = SVG.default;
  const soft = { fill: color, stroke: color, strokeWidth: 2.4, strokeLinejoin: 'round' as const };
  return (
    <Animated.View style={st}>
      <S width={size} height={size} viewBox="0 0 24 24"><APP animatedProps={p0} {...soft} /><APP animatedProps={p1} {...soft} /></S>
    </Animated.View>
  );
}

// Номер сборки файла. Все файлы папки src должны быть из одной сборки — иначе приложение покажет подсказку, а не ошибку.
export const BUILD = 64;

// ---------- Иконка ИИ-диджея: звезда «Пульса» и две искры ----------
// Минималистичная и плоская, в цветах профиля: один цвет — заливка цветом оформления, градиентная тема —
// мягкий переход её цветов по диагонали. Векторная — не пикселит на любом размере.
let aiIconN = 0;
function aiStarPath(cx: number, cy: number, a: number, b: number, k: number) {
  const ka = a * k, kb = b * k;   // одинаково по горизонтали и вертикали — звезда не сплющена
  return `M${cx} ${cy - b} Q${cx + ka} ${cy - kb} ${cx + a} ${cy} Q${cx + ka} ${cy + kb} ${cx} ${cy + b} Q${cx - ka} ${cy + kb} ${cx - a} ${cy} Q${cx - ka} ${cy - kb} ${cx} ${cy - b}Z`;
}
export function AiIcon({ size = 24, color }: { size?: number; color?: string }) {
  const T: any = useT(); const id = useMemo(() => 'ai' + (aiIconN++), []);
  const S: any = SVGLIB;
  const c1 = color || T.accent; const cs: string[] = color ? [c1] : [T.accent, T.accent2, T.accent3].filter(Boolean);
  if (!S) return <Ionicons name="sparkles" size={size} color={c1} />;
  const st = cs.length > 1 ? cs : [c1, c1]; const fill = `url(#${id})`;
  return (
    <S.default width={size} height={size} viewBox="0 0 100 100">
      <S.Defs><S.LinearGradient id={id} x1="0" y1="0" x2="1" y2="1">
        {st.map((c, i) => <S.Stop key={i} offset={i / (st.length - 1)} stopColor={c} />)}
      </S.LinearGradient></S.Defs>
      <S.Path d={aiStarPath(40, 58, 31, 31, 0.2)} fill={fill} />
      <S.Path d={aiStarPath(77, 22, 13, 13, 0.22)} fill={fill} />
      <S.Path d={aiStarPath(88, 48, 8, 8, 0.24)} fill={fill} />
    </S.default>
  );
}


// ---------- Режим покоя (главное против нагрева при долгом прослушивании) ----------
// Пока вы трогаете экран, фон живой: свет плывёт, бегущие строки едут, эквалайзеры прыгают.
// Через 12 секунд без касаний всё декоративное плавно замирает (свет — за 2,5 с, незаметно):
// телефон перестаёт каждый кадр перерисовывать свет и заново размывать стекло поверх него.
// Музыка, прогресс трека и переключение треков работают как обычно. Первое же касание — всё оживает.
const IDLE_MS = 12000;
let awakeNow = true; let idleT: any = null; const awakeSubs = new Set<(v: boolean) => void>();
export const AWAKE = makeMutable(1);
const setAwake = (v: boolean) => { if (awakeNow === v) return; awakeNow = v; AWAKE.value = v ? 1 : 0; awakeSubs.forEach((f) => f(v)); };
export function poke() { setAwake(true); clearTimeout(idleT); idleT = setTimeout(() => setAwake(false), IDLE_MS); }
export const isAwake = () => awakeNow;
export function useAwake() {
  const [a, setA] = useState(awakeNow);
  useEffect(() => { awakeSubs.add(setA); setA(awakeNow); return () => { awakeSubs.delete(setA); }; }, []);
  return a;
}
poke();
try { AppState.addEventListener('change', (st) => { if (st === 'active') poke(); }); } catch {}

// ---------- Общие «фоновые часы» (свет сверху, звёзды) ----------
// Фоновые движения очень медленные, поэтому им не нужны 120 кадров в секунду: одни общие часы тикают
// 30 раз в секунду и только пока хоть один такой фон на экране и приложение открыто. Это главное в
// оптимизации: раньше свет и звёзды обновлялись 120 раз в секунду, и вместе с ними 120 раз в секунду
// заново размывалось всё стекло поверх (меню, мини-плеер, кнопки) — телефон грелся и сбрасывал частоту.
// Теперь стекло переразмывается в 4 раза реже, а прокрутка и жесты по-прежнему идут на 120 Гц.
export const AMB = makeMutable(0);
// Часы тикают на UI-потоке (а не таймером в JavaScript): когда JS занят — подбор треков, загрузка, — фон
// не замирает и не дёргается. Каждый кадр дисплея только копится время; раз в ~33 мс оно добавляется к AMB.
let ambN = 0, ambActive = true; const ambSubs = new Set<() => void>();
const ambSync = () => ambSubs.forEach((f) => f());
try { AppState.addEventListener('change', (st) => { ambActive = st === 'active'; ambSync(); }); } catch {}
const AMB_ACC = makeMutable(0);
// на Android фон обновляется 10 раз в секунду (на iPhone — 30): свет медленный, разницы не видно, а стекло размывается вдвое реже
const AMB_STEP = Platform.OS === 'android' ? 100 : 33;
const AMB_SPD = makeMutable(1);   // скорость фона: 1 — обычная, 0 — замер (плавный переход между ними)
export function AmbientDriver() {
  const [on, setOn] = useState(false); const aw = useAwake();
  useEffect(() => { const f = () => setOn(ambN > 0 && ambActive); ambSubs.add(f); f(); return () => { ambSubs.delete(f); }; }, []);
  const fc = useFrameCallback((fi) => {
    'worklet';
    const dt = Math.min(100, fi.timeSincePreviousFrame ?? 16) * AMB_SPD.value;
    AMB_ACC.value += dt;
    if (AMB_ACC.value >= AMB_STEP) { AMB.value = AMB.value + AMB_ACC.value / 1000; AMB_ACC.value = 0; }
  }, false);
  useEffect(() => {
    if (!on) { fc.setActive(false); return; }
    if (aw) { fc.setActive(true); AMB_SPD.value = withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.quad) }); return; }
    // покой: свет плавно замедляется до остановки, потом часы выключаются совсем
    AMB_SPD.value = withTiming(0, { duration: 2500, easing: Easing.inOut(Easing.quad) });
    const t = setTimeout(() => fc.setActive(false), 2600);
    return () => clearTimeout(t);
  }, [on, aw]);
  return null;
}
export function useAmbient(on: boolean) { useEffect(() => { if (!on) return; ambN++; ambSync(); return () => { ambN--; ambSync(); }; }, [on]); }

// ---------- «Свет сквозь воду» — общий для всех разделов ----------
// Мягкое пятно света сверху и веер размытых лучей (заранее размытые картинки, без резких краёв), в цвете профиля.
// Фаза считается из общих часов AMB — у всех экранов одна и та же, при переходах свет не перезапускается.
// Движение: весь свет плывёт вдоль верха (60 с туда-обратно); два слоя лучей покачиваются в разные стороны,
// «дышат» шириной и длиной и по очереди разгораются (22 и 15 с); пятно света чуть пульсирует (26 с).
// Анимируется только видимый экран; на скрытых свет стоит (неподвижный снимок той же фазы).
function lightAt(t: number, W: number) {
  'worklet';
  const P2 = Math.PI * 2;
  const k = Math.sin((P2 * t) / 60), a = 0.5 - 0.5 * Math.cos((P2 * t) / 22), b = 0.5 - 0.5 * Math.cos((P2 * t) / 15.2), c = 0.5 - 0.5 * Math.cos((P2 * t) / 26);
  return {
    drift: { transform: [{ translateX: k * W * 0.1 }] },
    la: { opacity: 0.7 + 0.3 * a, transform: [{ rotate: `${-2 + 4 * a}deg` }, { scaleX: 0.94 + 0.12 * b }] },
    lb: { opacity: 0.9 - 0.45 * b, transform: [{ rotate: `${2.5 - 5 * b}deg` }, { scaleY: 0.94 + 0.1 * c }] },
    gl: { opacity: 0.8 + 0.2 * c, transform: [{ scale: 0.96 + 0.08 * c }] },
  };
}
function LightLive({ W, H, dim }: { W: number; H: number; dim: number }) {
  useAmbient(true);
  const drift = useAnimatedStyle(() => lightAt(AMB.value, W).drift);
  const la = useAnimatedStyle(() => lightAt(AMB.value, W).la);
  const lb = useAnimatedStyle(() => lightAt(AMB.value, W).lb);
  const gl = useAnimatedStyle(() => lightAt(AMB.value, W).gl);
  return <LightBody W={W} H={H} dim={dim} st={{ drift, la, lb, gl }} />;
}
function LightStill({ W, H, dim }: { W: number; H: number; dim: number }) {
  const v = lightAt(AMB.value, W);
  return <LightBody W={W} H={H} dim={dim} st={v} />;
}
function LightBody({ W, H, dim, st }: { W: number; H: number; dim: number; st: any }) {
  const T: any = useT();
  const dk = !!T.dark; const c1 = T.lightA || T.accent; const c2 = T.lightB || c1;
  // в светлой теме свет плотнее — иначе на белом он бледнеет; у пастельных (градиентных) тем — ещё плотнее
  const past = !dk && !!T.grad;
  const oR = (dk ? 0.7 : past ? 0.9 : 0.62) * dim, oG = (dk ? 0.6 : past ? 0.85 : 0.55) * dim;
  const iw = W * 1.6, ih = H * 0.9;
  const box = { position: 'absolute' as const, left: W * 0.58 - iw / 2, top: 0, width: iw, height: ih, transformOrigin: `${iw / 2}px 0px` } as any;
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, st.drift]}>
      <Animated.View style={[box, st.gl]}><Image source={{ uri: LIGHT_GLOW }} style={{ width: iw, height: ih, tintColor: c1, opacity: oG }} resizeMode="stretch" /></Animated.View>
      <Animated.View style={[box, st.la]}><Image source={{ uri: RAYS_A }} style={{ width: iw, height: ih, tintColor: c1, opacity: oR }} resizeMode="stretch" /></Animated.View>
      <Animated.View style={[box, st.lb]}><Image source={{ uri: RAYS_B }} style={{ width: iw, height: ih, tintColor: c2, opacity: oR * 0.75 }} resizeMode="stretch" /></Animated.View>
    </Animated.View>
  );
}
export const WaterLight = React.memo(function WaterLight({ W, H, dim = 1, still }: { W: number; H: number; dim?: number; still?: boolean }) {
  const vis = useVisible(); const T: any = useT();
  if (T.noLight) return null;   // чёрная тема — только чёрный фон
  return vis && !still ? <LightLive W={W} H={H} dim={dim} /> : <LightStill W={W} H={H} dim={dim} />;
});

// откуда раскрывать полный плеер (прямоугольник на экране) — задаёт «Мой пульс» перед открытием; читается один раз
let fullOrigin: { x: number; y: number; w: number; h: number } | null = null;
export const setFullOrigin = (r: { x: number; y: number; w: number; h: number } | null) => { fullOrigin = r; };
export const takeFullOrigin = () => { const r = fullOrigin; fullOrigin = null; return r; };
