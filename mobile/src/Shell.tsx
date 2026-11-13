import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Keyboard, Linking, View, Text, ScrollView as RNScroll, TextInput, Modal, StyleSheet, Pressable, Image, ActivityIndicator, Platform, StatusBar, KeyboardAvoidingView, useWindowDimensions, ActionSheetIOS, Switch, RefreshControl, BackHandler, AppState } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, useAnimatedProps, useDerivedValue, withRepeat, withTiming, withSequence, withDelay, cancelAnimation, FadeIn, FadeOut, SlideInDown, SlideInRight, SlideOutRight, runOnJS, runOnUI, Easing, interpolate, interpolateColor, LinearTransition, useAnimatedScrollHandler, useAnimatedReaction, useAnimatedKeyboard } from 'react-native-reanimated';
import * as api from './api';
import * as upd from './updater';
import * as ota from './ota';
import { MenuHost, openMenu, openDialog } from './menu';
import { useFollow, toggleFollow } from './follow';
import { BootSplash } from './Splash';
import { bootReady } from './boot';
import { useSleep, sleepSet, sleepGet, sleepLabel } from './sleep';
import { RingDot, MixCard, MixCover, BestCard, BestCover, YplCard, useBestArtists, CARD, tracksWord, useCoverTint } from './Home2';
import { PcIcon, Verified } from './PcIcons';
import { heardSeed, markHeard, useHeard } from './heard';
import { APP_VERSION } from './version';
import type { Track } from './api';
// чарт и новинки главной начинают грузиться сразу при запуске, ещё до первого кадра
api.warmHome();
import { usePlayer, usePlaying, useProgress, dayKey, useCurId } from './player';
import type { DayStat } from './player';
import { DARK, LIGHT, ACCENTS, SOLO, GRADIENTS, second, gradOf, blendHex } from './theme';
import { Ic, Press, Glass, GlassCard, Cover, Skel, Card, AlbumCard, AlbumRow, MoreCard, Row, ArtistDot, NavBar, Logo, IconBtn, Btn, StatCard, Eq, PIcon, LIcon, StarShape, StarOutline, LStarIcon, LStar, Glow, Matte, Explicit, LogoPill, Marquee, PlayPause, HAS_SVG, SVGLIB, RadialFill, once, GlassBtn, AiIcon, hap, WaterLight, AMB, useAmbient, takeFullOrigin, AmbientDriver, useTy, useWin, BlurView, useT, VisCtx, useVisible, useLater, rise, EASE_OUT, EASE_IO, SHEET } from './ui';
import type { Playlist } from './player';
import { keepImage, dropImage } from './audioCache';
import { PulseScreen, PulseFeeder, PulseLearner, PulseBar } from './PulseTab';
import { TabIcon, HAS_TAB_ICONS } from './TabIcons';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
// Номер сборки. Все файлы папки src должны быть из одной сборки — иначе приложение покажет подсказку, а не ошибку.
export const BUILD = 64;
// для проверки, что все файлы папки src — из одной сборки
import { poke, useAwake, isAwake, Pic, prefetchPic } from './ui';
// касание любого места экрана — «будит» фон (см. режим покоя в ui.tsx); палец при этом никому не перехватываем
const wakeCapture = () => { poke(); return false; };
import * as M_ui from './ui'; import * as M_player from './player'; import * as M_pulseTab from './PulseTab';
import * as M_tabIcons from './TabIcons'; import * as M_audio from './audioCache'; import * as M_pulse from './pulse';
import * as M_spectrum from './spectrum'; import * as M_theme from './theme'; import * as M_logo from './logoData';
import { LSTAR_PAD } from './logoData';
import { QuizScreen, QuizCard, canQuiz } from './Quiz';
import { LiveLyrics } from './LiveLyrics';
import { ASkip, AShuffle, ARepeat, ALyrics, AQueue } from './AIcons';
import * as M_water from './waterData';
import * as M_ym from './yandex';
import * as M_quiz from './Quiz'; import * as M_quizData from './quizData'; import * as M_ai from './ai';

const BOTTOM = 170;        // нижний отступ прокрутки по дизайн-системе
// Единые размеры: капсулы (меню, мини-плеер, управление «Моего пульса», поле ИИ) — 60; большие кнопки и поля — 52;
// маленькие «пилюли» (фильтры, чипы, мелкие действия) — 36. Скругление карточек и плашек — 22, обложек в строках — 12.
const TAB_H = 60, DOCK_B = 24, MINI_H = 60;
const SF = Platform.OS === 'ios' ? 'System' : undefined;   // системный шрифт Apple — SF Pro
// ОТКАТ: поставь false — вернётся прежний ползунок с белым кружком
const NEW_SLIDER = true;
const AV = 56;              // кнопка профиля в шапке главной — того же размера, что кружки «Недавних»
const EASE = Easing.bezier(0.22, 1, 0.36, 1);

// expo-haptics — необязательно: лёгкий «щелчок», когда сработало долгое нажатие. Без неё всё работает.
let Haptics: any = null;
try { Haptics = require('expo-haptics'); } catch { Haptics = null; }
const tick = () => hap('rigid');

const useTopPad = () => { const ins = useSafeAreaInsets(); return Math.max(ins.top, Platform.OS === 'ios' ? 47 : 0); };
// Где «растворяется» аватар: Dynamic Island (iPhone 14 Pro и новее), вырез или просто верх экрана
// Положение острова считаем по безопасной зоне сверху, которую сообщает сама iOS для этого устройства:
// остров всегда посередине этой зоны (iPhone 14 Pro…17 Pro: зона 59 pt → центр 29,5; у iPhone Air зона выше →
// остров ниже, и всё подстраивается само; модели с «чёлкой» — 16 pt). Никаких опросов и таблиц моделей — одно число.
const island = (padT: number) => (Platform.OS === 'ios' ? (padT >= 51 ? { y: padT / 2, h: 37 } : { y: 16, h: 30 }) : { y: padT / 2, h: 24 });
// @react-native-masked-view/masked-view (npx expo install @react-native-masked-view/masked-view) — для мягкого
// размытия у верхнего края. Без неё край просто плавно растворяется в цвет фона.
let MaskedView: any = null;
// на Android маски не используем: они перерисовывают весь экран в отдельный буфер на каждом кадре прокрутки
try { MaskedView = Platform.OS === 'android' ? null : require('@react-native-masked-view/masked-view').default; } catch { MaskedView = null; }
// для верхней панели маска нужна и на Android: там она маленькая (только полоса под логотипом), а внутри — копия фона,
// которая не прокручивается, поэтому перерисовывать при прокрутке нечего
let MaskTop: any = null;
try { MaskTop = require('@react-native-masked-view/masked-view').default; } catch { MaskTop = null; }

// Аватар, который при прокрутке вверх уходит в «остров»: уменьшается, размывается, темнеет и исчезает в нём —
// как в Telegram. p — прогресс 0…1 (0 — на месте, 1 — уже в острове).
// На Android острова нет: кружок просто уезжает вверх вместе со страницей, чуть уменьшается и плавно растворяется.
// Только прозрачность и сдвиг/масштаб одного слоя — без размытия, затемнения и теней (они и давали подтормаживания).
const ANDROID_FLY = Platform.OS === 'android';
function useIslandStyle(p: any, size: number, extraTop?: any) {
  const padT = useTopPad(); const isl = island(padT);
  const k = isl.h / size;
  const body = useAnimatedStyle(() => {
    if (ANDROID_FLY) {
      const q = Math.min(1, Math.max(0, p.value));
      const o = 1 - q * q * (3 - 2 * q);   // плавная S-кривая: начинает и заканчивает растворяться мягко
      return { opacity: o, transform: [...(extraTop ? [{ translateY: extraTop.value }] : []), { scale: 1 - 0.12 * q }] };
    }
    const q = Math.min(1, Math.max(0, p.value));
    const e = Math.pow(q, 1.25);
    const s = 1 - (1 - k) * e;
    const stretch = 1 + 0.55 * interpolate(q, [0.8, 1], [0, 1], 'clamp');   // у самого острова чуть вытягивается в «капсулу»
    return { opacity: interpolate(q, [0.84, 1], [1, 0], 'clamp'), transform: [...(extraTop ? [{ translateY: extraTop.value }] : []), { scaleX: s * stretch }, { scaleY: s }] };
  });
  const blur = useAnimatedStyle(() => ({ opacity: ANDROID_FLY ? 0 : interpolate(p.value, [0.1, 0.65], [0, 1], 'clamp') }));
  const dark = useAnimatedStyle(() => ({ opacity: ANDROID_FLY ? 0 : interpolate(p.value, [0.35, 0.95], [0, 1], 'clamp') }));
  const lift = useAnimatedStyle(() => ({ opacity: ANDROID_FLY ? 1 : interpolate(p.value, [0, 0.4], [1, 0], 'clamp') }));   // тень и значки уходят первыми
  return { body, blur, dark, lift, isl };
}

// Мягкий верхний край: то, что уже почти ушло за верх, плавно размывается и растворяется
// Верхний край без «белого света»: ничего не накладываем поверх — само содержимое у верха становится прозрачным
// и плавно перетекает в настоящий фон экрана (градиент вкладки, цвет страницы). Маска — плавная S-кривая.
// animP (необязательно) — 0…1: насколько край включён (на страницах артиста/альбома/профиля — только после начала прокрутки).
function FadeTop({ children, animP }: { children: React.ReactNode; animP?: any }) {
  // под статус-баром и логотипом содержимое полностью прозрачно, ниже — плавно (S-кривая) проявляется
  const padT = useTopPad(); const clear = padT + 36, band = padT + 56 + 44;
  const solid = useAnimatedStyle(() => ({ opacity: animP ? 1 - animP.value : 0 }));
  if (!MaskedView) return <>{children}</>;
  const g = smooth('0,0,0', 0, 1, clear / band, 1, 14);
  return (
    <MaskedView style={{ flex: 1 }} maskElement={
      <View style={{ flex: 1 }}>
        <View style={{ height: band }}>
          <LinearGradient colors={['rgba(0,0,0,0)', ...g.colors] as any} locations={[0, ...g.locations] as any} style={StyleSheet.absoluteFill} />
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, solid]} />
        </View>
        <View style={{ flex: 1, backgroundColor: '#000' }} />
      </View>
    }>{children}</MaskedView>
  );
}
function SoftEdge({ height, strong }: { height: number; strong?: boolean }) {
  const T = useT();
  if (!MaskedView) return null;
  return (
    <MaskedView pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, height, zIndex: 2 }}
      maskElement={<LinearGradient colors={['#000', '#000', 'rgba(0,0,0,0)']} locations={[0, 0.5, 1]} style={{ flex: 1 }} />}>
      <BlurView live intensity={strong ? 40 : T.dark ? 28 : 22} tint={T.tint} style={{ flex: 1 }} />
    </MaskedView>
  );
}

// Длинные списки (любимые, плейлисты, альбомы, треки артиста) строятся частями: сначала 30 строк, следующие 30 —
// когда до конца нарисованного осталось меньше 2,5 экрана. Сотни строк с обложками не держатся в памяти сразу.
type MoreApi = { sub: (f: () => void) => () => void };
const MoreCtx = React.createContext<MoreApi | null>(null);
const ROWS_STEP = 30;
// Вертикальная прокрутка экрана уходит под верхнюю панель (флаг screen), горизонтальные ленты — как обычно
const ScrollView = (p: any) => {
  const top = useTopPad() + 56;
  const subs = useRef(new Set<() => void>());
  const more = useMemo<MoreApi>(() => ({ sub: (f) => { subs.current.add(f); return () => { subs.current.delete(f); }; } }), []);
  const near = (e: any) => { const n = e?.nativeEvent; if (n && n.contentOffset.y + n.layoutMeasurement.height * 3.5 >= n.contentSize.height) subs.current.forEach((f) => f()); };
  const edge = useContext(EdgeCtx);
  if (p.screen) {
    const C: any = p.anim ? Animated.ScrollView : RNScroll;
    const onScroll = edge && !p.anim ? (e: any) => { edge.value = e.nativeEvent.contentOffset.y; p.onScroll?.(e); } : p.onScroll;
    return (
      <MoreCtx.Provider value={more}>
        <C showsVerticalScrollIndicator={false} scrollEventThrottle={16} {...p} onScroll={onScroll} contentContainerStyle={{ paddingTop: top, paddingBottom: BOTTOM }}
          onScrollEndDrag={(e: any) => { near(e); p.onScrollEndDrag?.(e); }} onMomentumScrollEnd={(e: any) => { near(e); p.onMomentumScrollEnd?.(e); }}
          onScrollBeginDrag={(e: any) => { near(e); p.onScrollBeginDrag?.(e); }} />
      </MoreCtx.Provider>
    );
  }
  return <RNScroll {...p} />;
};

// Экран только что открылся и ещё въезжает (переход ~460 мс). Тяжёлое — длинные списки, ленты обложек,
// блок «Об исполнителе» — рисуем, когда переход закончился: иначе их построение совпадает с анимацией
// и она подтормаживает. Потом они мягко всплывают (rise) — снаружи выглядит как обычное появление.
function useSettled(ms = 480) {
  const [ok, setOk] = useState(false);
  useEffect(() => { const t = setTimeout(() => setOk(true), ms); return () => clearTimeout(t); }, []);
  return ok;
}
// keep — при обновлении (потянули вниз) прежние данные остаются на экране, пока не пришли новые: без мигания заглушек
function useAsync<T>(f: () => Promise<T>, d: any[], keep = false) {
  const [v, setV] = useState<T | null>(null); const [err, setErr] = useState(false);
  useEffect(() => { let ok = true; if (!keep) setV(null); setErr(false); f().then((x) => ok && setV(x)).catch(() => ok && (keep ? setErr((e) => e) : setErr(true))); return () => { ok = false; }; }, d);
  return { v, err };
}

// Фон экрана: вертикальный градиент bg-top → bg-base (до 60%) + розовое свечение справа сверху
// Фон экранов: «свет сквозь воду» (общий WaterLight из ui.tsx) — под обложками и текстом, в каждом разделе,
// в одной фазе на всех экранах: при переходах не перезапускается.
function Bg({ plain, still }: { plain?: boolean; still?: boolean }) {
  const T: any = useT(); const { width: W, height: H } = useWin();
  if (plain) return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: T.bgBase }]} />;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: T.bgBase, overflow: 'hidden' }]}>
      <LinearGradient colors={[T.bgTop, T.bgBase]} locations={[0, 0.6]} style={StyleSheet.absoluteFill} />
      <WaterLight W={W} H={H} still={still} />
    </View>
  );
}

// Верхняя панель: контент плавно растворяется под ней (мягкое затухание вместо жёсткой рамки)
function Top({ left, right, home, plain, extra, edge = true }: { left?: React.ReactNode; right?: React.ReactNode; home?: boolean; plain?: boolean; extra?: React.ReactNode; edge?: boolean }) {
  const T = useT(); const padT = useTopPad();
  const c = plain ? (T.dark ? '0,0,0' : '255,255,255') : (T.dark ? '13,14,20' : '215,221,237');
  const g = plain ? smooth(c, 0.62, 0, 0, 1, 7) : { colors: [`rgba(${c},0.98)`, `rgba(${c},0.88)`, `rgba(${c},0)`], locations: [0, 0.62, 1] };
  // на Android (без масок) кромка легче — сквозь неё видны лучи света
  if (Platform.OS === 'android' && !plain) { g.colors = [`rgba(${c},0.72)`, `rgba(${c},0.45)`, `rgba(${c},0)`]; }
  return (
    <>
      {/* без masked-view — прежнее мягкое растворение в цвет фона; с ней содержимое тает само (FadeTop) */}
      {false && edge && <LinearGradient pointerEvents="none" colors={g.colors as any} locations={g.locations as any} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: padT + 56 + (plain ? 50 : 34), zIndex: 2 }} />}
      <View style={{ position: 'absolute', top: padT, left: 0, right: 0, zIndex: 3 }}>
        {home
          ? <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 }}>
              <View style={{ width: AV }}>{right}</View><Logo /><View style={{ width: AV }}>{extra}</View>
            </View>
          : <NavBar left={left} right={right} />}
      </View>
    </>
  );
}
// Верх экрана (вариант Г): при прокрутке под логотипом проявляется сам фон приложения — с цветом оформления
// и светом — и стоит на месте; ниже он без края, по S-кривой, тает в прозрачность. Лента целиком уходит под него.
// На iPhone под фоном ещё лёгкое размытие; на Android размытия нет (дорого для слабых телефонов) — только фон.
const EdgeCtx = React.createContext<any>(null);
// '#rrggbb' или 'rgba(r,g,b,a)' → [r, g, b, a]
function rgbOf(c: string): number[] {
  const s = String(c || '#000');
  if (s[0] === '#') { const n = parseInt(s.slice(1, 7), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  const m = s.match(/[\d.]+/g) || ['0', '0', '0']; return [+m[0], +m[1], +m[2], m[3] != null ? +m[3] : 1];
}
function TopEdge({ sy, plain }: { sy: any; plain?: boolean }) {
  const padT = useTopPad(); const { width: W, height: H } = useWin(); const T: any = useT();
  const solidH = padT + 56, h = solidH + 70;
  const st = useAnimatedStyle(() => ({ opacity: interpolate(sy.value, [2, 40], [0, 1], 'clamp') }));
  // пока экран не прокручен, панели не видно — и ничего не рисуем (маска с копией фона не держится на каждом экране)
  const [on, setOn] = useState(false);
  useAnimatedReaction(() => sy.value > 1, (v, p) => { if (v !== p) runOnJS(setOn)(v); }, []);
  if (!on) return null;
  if (!MaskTop) {
    // без маски (модуль не подключён): тот же фон, нарисованный градиентом — цвет в каждой точке как у фона экрана
    // (переход bgTop → bgBase на 60 % высоты окна), прозрачность: сплошной под логотипом, ниже S-кривая до нуля
    const base = rgbOf(T.bgBase), top = plain ? base : rgbOf(T.bgTop); const n = 16; const colors: string[] = [], locations: number[] = [];
    for (let i = 0; i <= n; i++) {
      const y = (h * i) / n; const f = Math.min(1, y / (H * 0.6));
      const a1 = top[3] * (1 - f) + 1 * f;   // непрозрачность градиента фона в этой точке (поверх bgBase)
      const c = [0, 1, 2].map((k) => Math.round((top[k] * (1 - f) + base[k] * f) * a1 + base[k] * (1 - a1)));
      const tt = y <= solidH ? 0 : (y - solidH) / (h - solidH); const e = tt * tt * (3 - 2 * tt);
      colors.push(`rgba(${c.join(',')},${(1 - e).toFixed(3)})`); locations.push(i / n);
    }
    return <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: h, zIndex: 2 }, st]}><LinearGradient colors={colors as any} locations={locations as any} style={{ flex: 1 }} /></Animated.View>;
  }
  const g = smooth('0,0,0', 1, 0, solidH / h, 1, 14);
  const ios = Platform.OS === 'ios';
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: h, zIndex: 2 }, st]}>
      <MaskTop style={{ flex: 1 }} maskElement={<LinearGradient colors={['#000', ...g.colors] as any} locations={[0, ...g.locations] as any} style={{ flex: 1 }} />}>
        <View style={{ width: W, height: h, overflow: 'hidden' }}>
          {ios && <BlurView intensity={T.dark ? 22 : 18} tint={T.tint} style={StyleSheet.absoluteFill} />}
          {/* копия фона экрана во всю высоту окна, обрезанная сверху, — цвета и свет совпадают с фоном под лентой */}
          <View style={{ position: 'absolute', top: 0, left: 0, width: W, height: H, opacity: ios ? 0.82 : 1 }}><Bg plain={plain} still={!ios} /></View>
        </View>
      </MaskTop>
    </Animated.View>
  );
}
function Layer({ children, left, right, home, plain, extra, edge = true }: any) {
  const sy = useSharedValue(0);
  return (
    <EdgeCtx.Provider value={edge ? sy : null}>
      <View style={{ flex: 1 }}><Bg plain={plain} />{children}{edge && <TopEdge sy={sy} plain={plain} />}<Top left={left} right={right} home={home} plain={plain} extra={extra} edge={edge} /></View>
    </EdgeCtx.Provider>
  );
}

// Плавный градиент без «ступенек»: прозрачность меняется по S-кривой через много точек (линейный в 2–3 точки даёт заметные полосы)
const hexRgb = (h: string) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim()); if (!m) return '255,255,255'; const n = parseInt(m[1], 16); return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`; };
function smooth(rgb: string, a0: number, a1: number, from: number, to: number, n = 9) {
  const colors: string[] = [], locations: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, e = t * t * (3 - 2 * t);
    colors.push(`rgba(${rgb},${(a0 + (a1 - a0) * e).toFixed(3)})`); locations.push(from + (to - from) * t);
  }
  return { colors, locations };
}

// Кольцо вокруг аватара. У двухцветного оформления — переход из первого цвета во второй по кругу (SVG-обводка
// с градиентом): так оба цвета видны сразу. Без react-native-svg или с одним цветом — обычная рамка.
const SVR: any = SVGLIB;
function Ring({ size, w, c1, c2, c3 }: { size: number; w: number; c1: string; c2?: string; c3?: string }) {
  if (!c2 || c2 === c1 || !SVR) return <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: size, height: size, borderRadius: size / 2, borderWidth: w, borderColor: c1 }} />;
  const r = (size - w) / 2;
  return (
    <SVR.default pointerEvents="none" width={size} height={size} style={{ position: 'absolute', left: 0, top: 0 }}>
      <SVR.Defs><SVR.LinearGradient id="rg" x1="0" y1="0" x2="1" y2="1">{(c3 ? [[0.1, c1], [0.5, c2], [0.9, c3]] : [[0.1, c1], [0.9, c2]]).map(([o, c]) => <SVR.Stop key={String(o)} offset={o as number} stopColor={c as string} />)}</SVR.LinearGradient></SVR.Defs>
      <SVR.Circle cx={size / 2} cy={size / 2} r={r} stroke="url(#rg)" strokeWidth={w} fill="none" />
    </SVR.default>
  );
}

// Кнопка профиля в шапке: аватар в розово-фиолетовом кольце (в тон звезде логотипа)
function AvatarBtn({ onPress }: { onPress: () => void }) {
  const T = useT();
  return (
    <Press onPress={onPress} to={0.92} hitSlop={8} style={{ width: AV, height: AV, borderRadius: AV / 2, alignItems: 'center', justifyContent: 'center', backgroundColor: T.ph, shadowColor: T.accent, shadowOpacity: T.dark ? 0.45 : 0.28, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }}>
      <Avatar size={AV - 5} bare />
      <Ring size={AV} w={2.5} c1={T.accent} c2={(T as any).duo ? (T as any).accent2 : undefined} c3={(T as any).tri ? (T as any).accent3 : undefined} />
    </Press>
  );
}

// Поиск на главной — справа от логотипа: круг того же размера, что и профиль, из матового стекла
function SearchBtn({ onPress }: { onPress: () => void }) {
  const T = useT();
  return (
    <GlassBtn onPress={onPress} size={AV} strong={false} hitSlop={8}><Ionicons name="search" size={24} color={T.ink} /></GlassBtn>
  );
}

// стрелка «дальше» — та же, что на ПК (back, развёрнутая)
const Chev = ({ c }: { c: string }) => <View style={{ transform: [{ rotate: '180deg' }] }}><PcIcon n="back" s={17} c={c} /></View>;
const Sec = ({ children, right }: { children: string; right?: React.ReactNode }) => {
  const ty = useTy();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginHorizontal: 16, marginTop: 28, marginBottom: 12 }}>
      <Text style={ty.title2}>{children}</Text>{right}
    </View>
  );
};
const Hint = ({ children, center }: { children: string; center?: boolean }) => { const ty = useTy(); return <Text style={[ty.subhead, { marginHorizontal: 16 }, center && { textAlign: 'center' }]}>{children}</Text>; };
const Spin = () => { const top = useTopPad() + 56; return <ActivityIndicator style={{ marginTop: top + 40 }} />; };

// Лента: сначала 5 крупных карточек, справа — «Ещё» (весь список с миниатюрами)
const Strip = ({ title, data, err, empty, open }: { title: string; data: Track[] | null; err?: boolean; empty?: string; open: (s: any) => void }) => {
  const P = usePlayer();
  return (
    <View>
      <Sec>{title}</Sec>
      {!data && !err ? <Skel /> : err ? <Hint>Не удалось загрузить</Hint> : !data?.length ? <Hint>{empty || 'Пока пусто'}</Hint> :
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
          {data.slice(0, 5).map((t, i) => <Card key={t.id} t={t} i={i} onPress={() => P.go(data, i)} />)}
          {data.length > 5 && <MoreCard count={data.length} onPress={() => open({ k: 'list', title, tracks: data })} />}
        </ScrollView>}
    </View>
  );
};

const AlbumStrip = ({ title, albums, open, sub, max = 5 }: { title: string; albums: any[]; open: (s: any) => void; sub?: string; max?: number }) => (
  <View>
    <Sec>{title}</Sec>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>
      {albums.slice(0, max).map((x, i) => <AlbumCard key={x.collectionId} x={x} i={i} sub={sub} onPress={() => open({ k: 'album', id: x.collectionId })} />)}
      {albums.length > max && <MoreCard count={albums.length} onPress={() => open({ k: 'albums', title, albums })} />}
    </ScrollView>
  </View>
);

// queue — что играть (по умолчанию сам список): на странице артиста видно 5 треков, а играют все его треки;
// from — откуда включили (для «дальше» после конца очереди)
const Rows = ({ list, open, noFav, selfId, noCover, queue, from, num }: { list: Track[]; open: (s: any) => void; noFav?: boolean; selfId?: number; noCover?: boolean; queue?: Track[]; from?: string; num?: boolean }) => {
  const P = usePlayer(); const addTo = useContext(AddCtx);
  // строки запоминаются (memo) — поэтому нажатие берёт актуальный список через ref, а не тот, что был при первой отрисовке
  const lr = useRef(list); lr.current = list; const qr = useRef(queue); qr.current = queue; const fr = useRef(from); fr.current = from;
  const play = (i: number) => { const q = qr.current; if (!q) return P.go(lr.current, i, fr.current); const j = q.findIndex((x) => x.id === lr.current[i]?.id); P.go(j >= 0 ? q : lr.current, j >= 0 ? j : i, fr.current); };
  const more = useContext(MoreCtx); const [lim, setLim] = useState(ROWS_STEP);
  useEffect(() => (more ? more.sub(() => setLim((l) => (l < lr.current.length ? l + ROWS_STEP : l))) : undefined), [more]);
  const shown = more && list.length > lim ? list.slice(0, lim) : list;
  return <>{shown.map((t, i) => <Row key={t.id + i} t={t} i={i} num={num} noFav={noFav} noCover={noCover} fav={P.isFav(t)} onFav={() => P.toggleFav(t)} onPress={() => play(i)} onLongPress={() => addTo(t)}
    onArtist={() => (t.artistId && t.artistId !== selfId ? open({ k: 'artist', id: t.artistId, name: t.artist }) : null)} />)}</>;
};

function Avatar({ size, bare }: { size: number; bare?: boolean }) {
  const P = usePlayer(); const T = useT(); const ty = useTy(); const n = ((P.profile.name || '?')[0] || '?').toUpperCase();
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden', backgroundColor: T.glass, alignItems: 'center', justifyContent: 'center', borderWidth: bare ? 0 : 1, borderColor: T.stroke }}>
      {P.profile.photo ? <Image source={{ uri: P.profile.photo }} style={{ width: size, height: size }} /> : <Text style={[ty.headline, { fontSize: size * 0.4, color: T.ink3 }]}>{n}</Text>}
    </View>
  );
}

const Title = ({ children }: { children: string }) => { const ty = useTy(); return <Text style={[ty.largeTitle, { marginHorizontal: 16, marginTop: 8 }]}>{children}</Text>; };

// ссылка справа от заголовка раздела («Весь чарт», «Смотреть все», «Мой пульс →») — как на ПК
const SecLink = ({ children, onPress }: { children: string; onPress: () => void }) => { const T: any = useT(); const ty = useTy(); return <Pressable hitSlop={10} onPress={onPress}><Text style={[ty.subhead, { color: T.accentText, fontWeight: '600' }]}>{children}</Text></Pressable>; };
const HScroll = ({ children }: { children: React.ReactNode }) => <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 12 }}>{children}</ScrollView>;

// Главная — как в версии для ПК: «Недавние» с кольцами, чарт строками, «Любимое», «Собрано для вас»,
// «Лучшее артистов», «Новые релизы», «Ваши плейлисты», «Подборки». Все обложки в лентах — CARD × CARD.
function Home({ open, onPulse }: any) {
  const P = usePlayer(); const ty = useTy(); const T = useT(); const { width: W } = useWin();
  const [rk, setRk] = useState(0); const [rf, setRf] = useState(false);
  const ru = useAsync(() => api.chart('ru'), [rk], true);
  // с Яндексом новинки не зависят от чарта — грузятся одновременно с ним
  const nw = useAsync(() => (api.YB ? api.newReleases('ru', []) : ru.v ? api.newReleases('ru', ru.v) : Promise.resolve(null)), api.YB ? [rk] : [ru.v], true);
  const land = useAsync(() => api.landing(), [rk], true);
  // стартовая страница получила первые данные — заставка может уходить
  useEffect(() => { if (ru.v || ru.err) bootReady(); }, [!!ru.v, ru.err]);
  const refresh = () => { setRf(true); api.clearCache(); setRk((k) => k + 1); setTimeout(() => setRf(false), 900); };
  // один артист — один кружок: сравниваем по основному имени (без feat./соавторов) и по id
  const arts = useMemo(() => {
    const seenN = new Set<string>(); const seenI = new Set<number>(); const out: { name: string; id?: number; cover: string }[] = [];
    for (const t of [...(P.recent as Track[]), ...((ru.v || []) as Track[])]) {
      const name = api.baseArtist(t.artist); const k = name.toLowerCase().replace(/ё/g, 'е');
      if (!k || seenN.has(k) || (t.artistId && seenI.has(t.artistId))) continue;
      seenN.add(k); if (t.artistId) seenI.add(t.artistId); out.push({ name, id: t.artistId, cover: t.cover });
      if (out.length >= 12) break;
    }
    return out;
  }, [P.recent, ru.v]);
  const best = useBestArtists(P.favs as Track[], P.recent as Track[], ru.v);
  const favs = P.favs as Track[];
  const gw = Math.floor((W - 32 - 2 * 12) / 3);   // «Любимое»: три в ряд
  const lists = [...(P.lists as Playlist[])].sort((a, b) => b.at - a.at);
  const L = land.v || { personal: [], playlists: [] };
  return (
    <ScrollView screen refreshControl={<RefreshControl refreshing={rf} onRefresh={refresh} tintColor={T.muted} progressViewOffset={100} />}>
      {arts.length > 0 && (<>
        <Sec right={onPulse ? <SecLink onPress={onPulse}>Мой пульс →</SecLink> : undefined}>{P.recent.length ? 'Недавние' : 'Артисты'}</Sec>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, gap: 4 }}>
          {arts.map((a, i) => <RingDot key={a.name} a={a} i={i} onPress={() => (a.id ? open({ k: 'artist', id: a.id, name: a.name }) : undefined)} />)}
        </ScrollView>
      </>)}
      <Sec right={ru.v && ru.v.length ? <SecLink onPress={() => open({ k: 'chart' })}>Весь чарт</SecLink> : undefined}>Чарты</Sec>
      {/* заглушка — те же 5 строк, что и чарт (раньше тут мелькали карточки прежнего вида) */}
      {!ru.v && !ru.err ? <RowSkel n={5} /> : !ru.v ? <Hint>Не удалось загрузить</Hint> : <Rows list={ru.v!.slice(0, 5)} queue={ru.v!} from="chart" open={open} num noFav />}
      <Sec right={favs.length ? <SecLink onPress={() => open({ k: 'favs' })}>Смотреть все</SecLink> : undefined}>Любимое</Sec>
      {favs.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingHorizontal: 16 }}>
          {favs.slice(0, 6).map((t, i) => (
            <Animated.View key={t.id} entering={rise(Math.min(i, 8) * 40)}>
              <Press onPress={() => P.go(favs, i, 'likes')} style={{ width: gw }}>
                <View style={{ width: gw, height: gw, borderRadius: 22, overflow: 'hidden', backgroundColor: T.ph, marginBottom: 6 }}><Pic uri={api.artPx(t.cover, gw)} style={{ width: gw, height: gw }} /></View>
                <Text numberOfLines={1} style={[ty.miniTitle, { fontSize: 13 }]}>{t.title}</Text>
                <Text numberOfLines={1} style={[ty.footnote, { fontSize: 12 }]}>{t.artist}</Text>
              </Press>
            </Animated.View>
          ))}
        </View>
      ) : <Hint>Ставьте ♥ трекам — они появятся здесь</Hint>}
      {(L.personal.length > 0 || (!land.v && !land.err && api.YB)) && (<>
        <Sec>Собрано для вас</Sec>
        {!land.v ? <Skel /> : <HScroll>{L.personal.map((p, i) => <MixCard key={p.uid + p.kind} p={p} i={i} onOpen={() => open({ k: 'coll', type: 'ypl', p })} onPlay={(l) => P.go(l, 0, 'ypl:' + p.uid + ':' + p.kind)} />)}</HScroll>}
      </>)}
      {best.length > 0 && (<>
        <Sec>Лучшее артистов</Sec>
        <HScroll>{best.map((a, i) => <BestCard key={a.id} a={a} i={i} onOpen={(ph) => open({ k: 'coll', type: 'best', a, photo: ph })} onPlay={(l) => P.go(l, 0, 'artist:' + a.id)} />)}</HScroll>
      </>)}
      {!!nw.v && nw.v.length > 0 ? <AlbumStrip title="Новые релизы" albums={nw.v} open={open} max={10} /> : !nw.v && !nw.err && (api.YB || !!ru.v) ? <View><Sec>Новые релизы</Sec><Skel /></View> : null}
      {lists.length > 0 && (<>
        <Sec>Ваши плейлисты</Sec>
        <HScroll>{lists.map((pl, i) => (
          <Animated.View key={pl.id} entering={rise(Math.min(i, 8) * 45)}>
            <Press onPress={() => open({ k: 'playlist', id: pl.id })} style={{ width: CARD }}>
              <View style={{ marginBottom: 8 }}><PlCover pl={pl} size={CARD} /></View>
              <Text numberOfLines={1} style={ty.miniTitle}>{pl.name}</Text>
              <Text numberOfLines={1} style={ty.footnote}>{tracksWord(pl.tracks.length)}</Text>
            </Press>
          </Animated.View>
        ))}</HScroll>
      </>)}
      {L.playlists.length > 0 && (<>
        <Sec>Подборки</Sec>
        <HScroll>{L.playlists.slice(0, 16).map((p, i) => <YplCard key={p.uid + p.kind} p={p} i={i} onOpen={() => open({ k: 'coll', type: 'ypl', p, plain: true })} />)}</HScroll>
      </>)}
      <View style={{ alignItems: 'center', marginTop: 34 }}>
        <Glass radius={999} style={{ paddingHorizontal: 13, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#ffb020' }} /><Text style={[ty.caption, { color: T.ink }]}>пульс · альфа {APP_VERSION}{ota.otaLabel() ? ' · ' + ota.otaLabel() : ''}</Text>
        </Glass>
        <Text style={[ty.caption, { fontWeight: '400', textAlign: 'center', maxWidth: 290, marginTop: 10, lineHeight: 16 }]}>Приложение находится в разработке. Возможны баги, недоработки и внезапные изменения.</Text>
      </View>
    </ScrollView>
  );
}

// «Весь чарт» — как на ПК: подпись «ЧАРТ · РОССИЯ», заголовок, «Перемешать» и «Слушать», все треки с номерами
function ChartScreen({ open }: any) {
  const P = usePlayer(); const ty = useTy(); const T: any = useT();
  const r = useAsync(() => api.chart('ru'), []);
  const l = (r.v || []) as Track[];
  return (
    <ScrollView screen>
      <View style={{ marginHorizontal: 16, marginTop: 8 }}>
        <Text style={[ty.caption, { letterSpacing: 1.2, fontWeight: '700' }]}>ЧАРТ · РОССИЯ</Text>
        <Text style={[ty.largeTitle, { marginTop: 2 }]}>Топ-{l.length || 100}</Text>
        <Text style={[ty.subhead, { marginTop: 2 }]}>обновляется каждый день</Text>
      </View>
      <PlayBtns list={l} from="chart" />
      {!r.v && !r.err ? <RowSkel n={10} /> : r.err ? <Hint>Не удалось загрузить</Hint> : <Rows list={l} from="chart" open={open} num noFav />}
    </ScrollView>
  );
}
// «Перемешать» и «Слушать» — капсулы 52 рядом (как на ПК)
// «N треков · 1 ч 12 мин» — как в шапке плейлиста и альбома на ПК
function listMeta(list: Track[]) {
  const sec = list.reduce((s, x) => s + (x.dur || 0), 0); const m = Math.round(sec / 60);
  const d = !m ? '' : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
  return [plural(list.length, ['трек', 'трека', 'треков']), d].filter(Boolean).join(' · ');
}
function PlayBtns({ list, from, inv, mt = 18 }: { list: Track[]; from: string; inv?: boolean; mt?: number }) {
  const P = usePlayer(); const T: any = useT();
  const shuffle = () => { if (!list.length) return; const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } P.go(a, 0, from); };
  return (
    <View style={{ flexDirection: 'row', gap: 10, marginHorizontal: 16, marginTop: mt, marginBottom: 8 }}>
      <Btn kind="secondary" icon="shuffle" label="Перемешать" inv={inv} onPress={shuffle} />
      <Btn kind="primary" icon="play" label="Слушать" onPress={() => list.length && P.go(list, 0, from)} />
    </View>
  );
}
// Подборка: плейлист Яндекса («Собрано для вас», «Подборки») или «Лучшее» артиста — большая обложка как на главной
function CollScreen({ s, open }: any) {
  const ty = useTy(); const { width: W } = useWin();
  const isBest = s.type === 'best';
  const r = useAsync(() => (isBest ? api.artist(s.a.id).then((x: any) => ({ info: null, tracks: (x.tracks || []).slice(0, 30) })) : api.yplaylist(s.p.uid, s.p.kind)), [isBest ? s.a.id : s.p.uid + s.p.kind]);
  const l = ((r.v && r.v.tracks) || []) as Track[];
  const dur = l.reduce((a, t) => a + (t.dur || 0), 0);
  const size = Math.min(W - 64, 320);
  const covers = useMemo(() => { const seen = new Set<string>(); const out: string[] = []; for (const t of l) if (t.cover && !seen.has(t.cover)) { seen.add(t.cover); out.push(t.cover); if (out.length >= 12) break; } return out; }, [r.v]);
  return (
    <ScrollView screen>
      <View style={{ alignItems: 'center', marginTop: 4 }}>
        {isBest ? <BestCover a={s.a} ph={s.photo ? api.artPx(s.photo, size) : ''} stat={l.length ? { n: l.length, dur } : null} size={size} big />
          : s.plain ? <View style={{ width: size, height: size, borderRadius: 22, overflow: 'hidden' }}><Pic uri={api.artPx(s.p.coverBig || s.p.cover, size)} style={{ width: size, height: size }} /></View>
          : <MixCover p={s.p} covers={covers} n={l.length || undefined} dur={dur} size={size} big />}
      </View>
      {(s.plain || !isBest) && s.plain && <View style={{ marginHorizontal: 16, marginTop: 16, alignItems: 'center' }}>
        <Text style={[ty.title2, { textAlign: 'center' }]}>{s.p.title}</Text>
        {!!s.p.desc && <Text style={[ty.subhead, { textAlign: 'center', marginTop: 4 }]} numberOfLines={3}>{s.p.desc}</Text>}
      </View>}
      <PlayBtns list={l} from={isBest ? 'artist:' + s.a.id : 'ypl:' + s.p.uid + ':' + s.p.kind} />
      {!r.v && !r.err ? <RowSkel n={8} /> : r.err ? <Hint>Не удалось загрузить</Hint> : <Rows list={l} from={isBest ? 'artist:' + s.a.id : 'ypl'} open={open} num />}
    </ScrollView>
  );
}

const norm = (x: string) => x.toLowerCase().replace(/ё/g, 'е').trim();
type Filt = 'all' | 'tracks' | 'artists' | 'albums';

// ---------- Релевантность (как в Spotify: чем точнее запрос, тем выше точное совпадение) ----------
// 100 — совпадает целиком, 80 — начинается с запроса, 60 — запрос начинается с начала какого-то слова,
// 55 — каждое слово запроса — начало одного из слов (в любом порядке: «sky carti»), 40 — запрос встречается внутри,
// 30 — все слова запроса встречаются внутри, 0 — совпадений нет.
const SEP = ' -–—(),.&/\'"!?:';
function matchScore(text: string | undefined, q: string): number {
  const t = norm(text || ''); if (!t || !q) return 0;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  for (let i = t.indexOf(q); i > 0; i = t.indexOf(q, i + 1)) if (SEP.includes(t[i - 1])) return 60;
  const ws = q.split(' ').filter(Boolean);
  if (ws.length > 1) {
    const words = t.split(/[\s\-–—(),.&/'"!?:]+/).filter(Boolean);
    if (ws.every((w) => words.some((x) => x.startsWith(w)))) return 55;
  }
  if (t.includes(q)) return 40;
  if (ws.length > 1 && ws.every((w) => t.includes(w))) return 30;
  return 0;
}
// Сортируем по релевантности; при равенстве сохраняется порядок сервиса (он учитывает популярность)
function ranked<X>(list: X[], sc: (x: X) => number): X[] {
  return list.map((x, i) => ({ x, i, s: sc(x) })).sort((a, b) => b.s - a.s || a.i - b.i).map((o) => o.x);
}

// ================= Умный поиск (как в Spotify) =================
// Запрос и каждое поле (название, исполнители, альбом) приводятся к «скелету»: строчные латинские буквы и цифры,
// кириллица — транслитом (маяк = mayak, династия = dinastiia), y→i, двойные буквы схлопнуты (villian = vilian),
// знаки и «feat.» не мешают. Потом каждое СЛОВО запроса ищется среди слов трека:
//   совпало целиком — 1, начало слова (последнее слово ещё дописывается) — 0,9, одна опечатка — 0,7.
// Важно, ГДЕ нашлось слово: в названии — вес 1, у исполнителя — 0,9, в альбоме — 0,5.
// Поэтому «sky playboi carti», «carti sky», «династия villian» находят именно этот трек: в нём есть ВСЕ слова.
// Трек, где нет хотя бы одного слова запроса, не показывается (для 3+ слов прощается одно — с понижением).
// Бонусы: название набрано полностью или точно; исполнитель назван полностью; порядок «название исполнитель».
// Минус: караоке, минусовки, каверы, sped up / slowed — если вы их не искали. При равенстве — порядок сервиса
// (он учитывает популярность), и чуть выше — треки из вашей музыки. Повторы (сингл/альбом, clean/explicit) — один раз.
// Всё считается локально и быстро: «скелеты» полей запоминаются для каждого трека один раз.
const TRL: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'iu', я: 'ia' };
const deacc = (x: string) => { try { return x.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch { return x; } };
function fold(x: string): string {
  let o = ''; for (const c of deacc(String(x || '').toLowerCase())) o += TRL[c] ?? c;
  return o.replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/y/g, 'i').replace(/([a-z])\1+/g, '$1').trim();
}
const toks = (x: string) => fold(x).split(' ').filter(Boolean);
const JUNK = ['karaoke', 'instrumental', 'tribute', 'cover', 'minus', 'minusovka', 'sped', 'slowed', 'nightcore', 'lulabi'];
// не больше одной правки (замена, лишняя или пропущенная буква) — для опечаток
function edit1(a: string, b: string): boolean {
  if (a === b) return true; const la = a.length, lb = b.length; if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < la && j < lb) { if (a[i] === b[j]) { i++; j++; continue; } if (++d > 1) return false; if (la > lb) i++; else if (lb > la) j++; else { i++; j++; } }
  return d + (la - i) + (lb - j) <= 1;
}
function tokMatch(q: string, w: string, last: boolean): number {
  if (w === q) return 1;
  if (w.startsWith(q)) return last ? 0.9 : q.length >= 3 ? 0.75 : 0.5;
  if (q.length >= 4 && w.length >= 4) {
    if (edit1(q, w)) return 0.7;
    if (last && w.length > q.length && (edit1(q, w.slice(0, q.length)) || edit1(q, w.slice(0, q.length + 1)))) return 0.65;
  }
  return 0;
}
type Fx = { t: string[]; a: string[]; al: string[]; ta: string; aa: string; junk: boolean; key: string };
const fxCache = new WeakMap<object, Fx>();
function fxTrack(t: Track): Fx {
  let f = fxCache.get(t); if (f) return f;
  const feat = /\((?:feat\.?|ft\.?|with)\s+([^)]+)\)/i.exec(t.title || '');
  const title = (t.title || '').replace(/\s*[([].*?[)\]]/g, ' ').replace(/\s+-\s+(single|ep)$/i, '');
  const tt = toks(title), aa = toks(`${t.artist || ''} ${feat ? feat[1] : ''}`), al = toks(t.album || '');
  const main = toks(api.baseArtist(t.artist || '')).join(' ');
  const raw = `${t.title} ${t.album || ''}`; const rt = toks(raw);
  f = { t: tt, a: aa, al, ta: tt.join(' '), aa: main, junk: rt.some((w) => JUNK.includes(w) || w.startsWith('karaok')) || /караоке|минус/i.test(raw), key: tt.join(' ') + '|' + main };
  fxCache.set(t, f); return f;
}
// q — слова запроса (уже «скелеты»); idx/n — место в ответе сервиса (популярность); own — трек из вашей музыки
function trackRel(t: Track, q: string[], idx = 0, n = 1, own = false): number {
  if (!q.length) return 0;
  const f = fxTrack(t); let sum = 0, miss = 0; const usedT = new Set<string>(), usedA = new Set<string>();
  q.forEach((w, i) => {
    const last = i === q.length - 1; let best = 0, where = '', hit = '';
    for (const x of f.t) { const m = tokMatch(w, x, last); if (m > best) { best = m; where = 't'; hit = x; } }
    for (const x of f.a) { const m = tokMatch(w, x, last) * 0.9; if (m > best) { best = m; where = 'a'; hit = x; } }
    for (const x of f.al) { const m = tokMatch(w, x, last) * 0.5; if (m > best) { best = m; where = 'l'; hit = x; } }
    if (!best) miss++; else { sum += best; if (where === 't') usedT.add(hit); else if (where === 'a') usedA.add(hit); }
  });
  if (miss && (q.length < 3 || miss > 1)) return 0;
  let sc = ((100 * sum) / q.length) * (miss ? 0.5 : 1);
  const qs = q.join(' ');
  if (f.t.length && f.t.every((x) => usedT.has(x))) sc += 12;                                   // название набрано целиком
  if (f.ta && (qs === f.ta || qs.startsWith(f.ta + ' ') || qs.endsWith(' ' + f.ta))) sc += 10;   // …и стоит отдельно
  if (usedA.size && f.aa && f.aa.split(' ').every((x) => usedA.has(x))) sc += 8;              // исполнитель назван целиком
  if (usedT.size && usedA.size && f.ta && qs.startsWith(f.ta)) sc += 4;                         // порядок «название исполнитель»
  if (f.junk && !q.some((w) => JUNK.includes(w))) sc -= 28;
  sc += 6 * (1 - idx / Math.max(1, n)); if (own) sc += 4;
  return Math.max(1, sc);
}
function artistRel(name: string, q: string[], idx = 0, n = 1): number {
  const nt = toks(name); if (!nt.length || !q.length) return 0;
  let sum = 0, miss = 0; const used = new Set<string>();
  q.forEach((w, i) => { let b = 0, h = ''; for (const x of nt) { const m = tokMatch(w, x, i === q.length - 1); if (m > b) { b = m; h = x; } } if (!b) miss++; else { sum += b; used.add(h); } });
  // «playboi carti sky»: имя артиста целиком есть в запросе, но в запросе есть и лишнее (название трека)
  if (miss) return nt.every((x) => q.includes(x)) ? 45 + 3 * (1 - idx / Math.max(1, n)) : 0;
  let sc = (100 * sum) / q.length;
  if (nt.every((x) => used.has(x))) sc += nt.length === q.length ? 16 : 8;
  return sc + 4 * (1 - idx / Math.max(1, n));
}
// треки: оценка, без повторов, только подходящие; если в свежем ответе не подошёл ни один — показываем как прислал сервис
function rankTracks(list: Track[], q: string[], ownIds: Set<string>, fresh: boolean): { t: Track; s: number }[] {
  const n = list.length; const sc = list.map((t, i) => ({ t, s: trackRel(t, q, i, n, ownIds.has(t.id)), i }));
  const ok = sc.filter((x) => x.s > 0);
  const use = ok.length || !fresh ? ok : sc.map((x) => ({ ...x, s: 1 + (n - x.i) / n }));
  use.sort((a, b) => b.s - a.s || a.i - b.i);
  const seen = new Set<string>(); const out: { t: Track; s: number }[] = [];
  for (const x of use) { const k = fxTrack(x.t).key; if (seen.has(k)) continue; seen.add(k); out.push({ t: x.t, s: x.s }); }
  return out;
}

// Поиск в стиле Spotify: результаты обновляются прямо во время ввода (без «Найти»), сверху — подходящие прошлые запросы,
// треки из вашей музыки и ваши плейлисты появляются мгновенно, ответ сервиса — через долю секунды.
// История, фильтры-чипы и «Лучший результат» — прежние.
// «Артист · 13 из 21 прослушано» — как у колец «Недавних» на главной
function BestSub({ id }: { id: number }) {
  const ty = useTy(); const n = useHeard(id); const [all, setAll] = useState(0);
  useEffect(() => { if (!n) return; let ok = true; api.artist(id).then((v: any) => ok && setAll((v?.info?.counts?.tracks) || 0)).catch(() => {}); return () => { ok = false; }; }, [id, n > 0]);
  return <Text numberOfLines={1} style={[ty.subhead, { marginTop: 4 }]}>{n > 0 && all > 0 ? `Артист · ${n} из ${all} прослушано` : 'Артист'}</Text>;
}
function Search({ open, auto }: any) {
  const ty = useTy(); const T = useT(); const P = usePlayer();
  // открыли кнопкой с главной — клавиатура появляется, когда экран уже въехал
  const inp = useRef<TextInput>(null);
  useEffect(() => { if (!auto) return; const t = setTimeout(() => inp.current?.focus(), 430); return () => clearTimeout(t); }, []);
  const [q, setQ] = useState(''); const [f, setF] = useState<Filt>('all'); const [hist, setHist] = useState<string[]>([]);
  useEffect(() => { AsyncStorage.getItem('pulse_search').then((v) => { if (v) try { setHist(JSON.parse(v)); } catch {} }); }, []);
  const s = q.trim(); const nq = norm(s.replace(/\s+/g, ' ')); const qt = useMemo(() => toks(s), [s]);

  // ---- запросы в сеть ----
  // • пауза 250 мс после последней буквы (быстрый ввод не превращается в десятки запросов);
  // • уже искали такое — ответ из памяти сразу;
  // • одновременно идёт только один запрос; если пока он шёл, текст изменился — сразу ищем последний вариант,
  //   а ответ на устаревший текст не показываем;
  // • пока грузится новый ответ, на экране остаются прежние результаты (без мигания и пустого экрана).
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState(false); const [busy, setBusy] = useState(false);
  const want = useRef(''); const running = useRef(false); const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // Быстрее: запрос на новый текст уходит сразу, не дожидаясь ответа на прежний (ответ на устаревший текст
  // просто не показывается); треки и артисты появляются, как только пришли, альбомы — следом.
  const run = useCallback(async () => {
    const qq = want.current; if (!qq) return;
    const show = (v: any) => { if (alive.current && want.current === qq) { setRes({ q: norm(qq.replace(/\s+/g, ' ')), v }); setErr(false); setBusy(false); } };
    let v: any = null;
    try { v = await api.searchCached(qq, show); } catch { v = null; }
    if (!alive.current || want.current !== qq) return;
    if (v) show(v); else { setErr(true); setBusy(false); }
  }, []);
  useEffect(() => {
    want.current = s;
    if (!s) { setRes(null); setErr(false); setBusy(false); return; }
    const hit = api.peekSearch(s); if (hit) { setRes({ q: norm(s.replace(/\s+/g, ' ')), v: hit }); setErr(false); setBusy(false); return; }
    setBusy(true); setErr(false);
    // пауза после последней буквы: короткая (140 мс), а для 1–2 букв чуть длиннее — их почти всегда дописывают
    const t = setTimeout(run, s.length <= 2 ? 260 : 140); return () => clearTimeout(t);
  }, [s]);

  const remember = (x: string) => { x = x.trim(); if (!x) return; const h = [x, ...hist.filter((y) => norm(y) !== norm(x))].slice(0, 8); setHist(h); AsyncStorage.setItem('pulse_search', JSON.stringify(h)).catch(() => {}); };
  const go = (st: any) => { remember(q); open(st); };
  const clear = () => { setHist([]); AsyncStorage.removeItem('pulse_search').catch(() => {}); };
  const chips: [Filt, string][] = [['all', 'Всё'], ['tracks', 'Треки'], ['artists', 'Артисты'], ['albums', 'Альбомы']];

  // ---- подсказки и результаты (пересчитываются только при изменении текста или данных) ----
  // прошлые запросы, похожие на вводимый текст
  // своя музыка: «Любимое», история прослушивания и треки плейлистов — находится мгновенно, без сети
  const local = useMemo(() => {
    if (!nq) return [] as Track[];
    const seen = new Set<string>(); const all: Track[] = [];
    for (const t of [...(P.favs as Track[]), ...(P.recent as Track[]), ...(P.lists as Playlist[]).flatMap((l) => l.tracks)]) { if (!seen.has(t.id)) { seen.add(t.id); all.push(t); } }
    return rankTracks(all, qt, new Set(), false).filter((x) => x.s >= 55).slice(0, 6).map((x) => x.t);
  }, [qt, P.favs, P.recent, P.lists]);
  // свои плейлисты (и «Любимое») по названию
  const myLists = useMemo(() => {
    if (!nq) return [] as { pl?: Playlist; fav?: boolean; recent?: boolean; name: string; n: number }[];
    const all = [{ fav: true, name: 'Любимое', n: (P.favs as Track[]).length }, { recent: true, name: 'Недавние', n: (P.recent as Track[]).length }, ...(P.lists as Playlist[]).map((pl) => ({ pl, name: pl.name, n: pl.tracks.length }))];
    return ranked(all.filter((x) => matchScore(x.name, nq) >= 40), (x) => matchScore(x.name, nq)).slice(0, 3);
  }, [nq, P.favs, P.recent, P.lists]);
  const R = useMemo(() => {
    // прежний ответ показываем, только пока он относится к тому же запросу (дописали или стёрли буквы);
    // ответ на совсем другой текст не показываем — ждём новый
    // (из прежнего ответа остаётся только то, в чём есть ВСЕ слова нового запроса — без «абы чего»)
    if (!res || !(nq.startsWith(res.q) || res.q.startsWith(nq))) return null;
    const v = res.v; const fresh = res.q === nq;
    // своя музыка и ответ сервиса — в одном рейтинге (своё чуть выше при равенстве)
    const ownIds = new Set(local.map((t) => t.id)); const seen = new Set<string>(); const pool: Track[] = [];
    for (const t of [...(v.tracks as Track[]), ...local]) if (!seen.has(t.id)) { seen.add(t.id); pool.push(t); }
    const tr = rankTracks(pool, qt, ownIds, fresh);
    // артисты: из ответа сервиса + те, что нашлись через треки (запрос «трек + исполнитель»)
    const arts: any[] = [...(v.artists as any[])]; const aid = new Set(arts.map((a) => a.artistId));
    for (const x of tr.slice(0, 10)) { const t = x.t; if (t.artistId && !aid.has(t.artistId)) { aid.add(t.artistId); arts.push({ artistId: t.artistId, artistName: api.baseArtist(t.artist), primaryGenreName: t.genre }); } }
    const qsort = qt.slice().sort().join(' ');
    const ar = arts.map((a, i) => ({ a, s: artistRel(a.artistName, qt, i, arts.length) + (toks(api.baseArtist(a.artistName || '')).sort().join(' ') === qsort ? 30 : 0) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const al: any[] = v.albums as any[];
    const albs = al.map((a, i) => ({ a, s: Math.max(artistRel(a.collectionName, qt, i, al.length), artistRel(`${a.collectionName} ${a.artistName}`, qt, i, al.length) * 0.95) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    return { tracks: tr.map((x) => x.t), tScore: tr[0]?.s || 0, artists: ar.map((x) => x.a), aScore: ar[0]?.s || 0, albums: albs.map((x) => x.a) };
  }, [res, local, nq, qt]);

  // ---- текстовые подсказки: поиск «думает наперёд», как в Spotify ----
  // Без лишних запросов в сеть: прошлые запросы (с часиками) + имена артистов, названия треков и альбомов
  // из уже пришедшего ответа и из своей музыки. Подходит только то, что начинается с набранного
  // (или где с набранного начинается одно из слов). Пока новый ответ в пути, подсказки строятся
  // из прежнего — если он о том же (дописали буквы), поэтому список не мигает.
  const sugg = useMemo(() => {
    if (!nq) return [] as { t: string; h?: boolean }[];
    const seen = new Set<string>([nq]); const hs: { t: string; h: boolean }[] = []; const pred: { t: string; sc: number; pr: number }[] = [];
    const clean = (x?: string) => (x || '').replace(/\s*[([].*?[)\]]/g, '').replace(/\s+/g, ' ').trim();
    const add = (raw: string | undefined, pr: number) => {
      const t = clean(raw).toLowerCase(); const k = norm(t);
      if (!k || k.length > 44 || seen.has(k)) return;
      const sc = matchScore(t, nq); if (sc < 60) return;
      seen.add(k); pred.push({ t, sc, pr });
    };
    for (const h of hist) { const k = norm(h); if (hs.length < 2 && !seen.has(k) && matchScore(h, nq) >= 60) { seen.add(k); hs.push({ t: h, h: true }); } }
    const v = res && (nq.startsWith(res.q) || res.q.startsWith(nq)) ? res.v : null;
    if (v) {
      (v.artists as any[]).slice(0, 8).forEach((a) => add(a.artistName, 0));
      (v.tracks as Track[]).slice(0, 16).forEach((t) => { add(t.title, 1); add(api.baseArtist(t.artist), 0); });
      (v.albums as any[]).slice(0, 8).forEach((a) => add(a.collectionName, 2));
    }
    for (const t of local) { add(t.title, 1); add(api.baseArtist(t.artist), 0); }
    pred.sort((a, b) => b.sc - a.sc || a.pr - b.pr || a.t.length - b.t.length);
    return [...hs, ...pred].slice(0, 5);
  }, [nq, hist, res, local]);
  const pick = (x: string) => { setQ(x); remember(x); Keyboard.dismiss(); };
  const fill = (x: string) => { setQ(x); inp.current?.focus(); };
  const suggRow = (x: { t: string; h?: boolean }) => {
    const i = norm(x.t).indexOf(nq); const a = i >= 0 ? i : 0, b = i >= 0 ? i + nq.length : 0;
    return (
      <Press key={'s' + x.t} onPress={() => pick(x.t)} to={0.98} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 18, paddingRight: 6, height: 52 }}>
        <PcIcon n={x.h ? 'clock' : 'search'} s={21} c={T.muted} />
        {/* набранная часть — приглушённая, продолжение — яркое */}
        <Text numberOfLines={1} style={[ty.body, { flex: 1, color: T.ink }]}>{x.t.slice(0, a)}<Text style={{ color: T.muted }}>{x.t.slice(a, b)}</Text>{x.t.slice(b)}</Text>
        {/* стрелка — подставить текст в поле и дописать дальше */}
        <Pressable hitSlop={6} onPress={() => fill(x.t)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ transform: [{ rotate: '45deg' }] }}><PcIcon n="arrowL" s={20} c={T.muted} /></View>
        </Pressable>
      </Press>
    );
  };

  // ---- лучший результат ----
  // Путаница была в двух местах:
  //  1) пока ответ на ПОЛНОЕ имя ещё в пути, показывался ответ на начало имени («bearwo»), где артиста ещё нет,
  //     зато есть его треки, — и «лучшим» на секунду становился трек, а потом всё перескакивало на артиста;
  //  2) при полном совпадении имени трек этого артиста мог обойти самого артиста по очкам.
  // Теперь: имя артиста набрано целиком (слова совпадают, порядок не важен) — лучший результат всегда артист;
  // пока ответ устарел — держим прежний лучший результат, если он всё ещё подходит, а не прыгаем на трек.
  const fresh = !!res && res.q === nq;
  const lastBest = useRef<{ q: string; b: any } | null>(null);
  let best: any = null;
  if (R) {
    const qs = qt.join(' '); const sameName = (n: string) => !!qs && toks(api.baseArtist(n)).slice().sort().join(' ') === qt.slice().sort().join(' ');
    const exact = R.artists.find((a: any) => sameName(a.artistName));
    const a0 = R.artists[0];
    if (exact) best = { kind: 'artist', a: exact };
    else if (a0 && R.aScore >= 60 && R.aScore >= R.tScore - 4) best = { kind: 'artist', a: a0 };
    else if (R.tracks[0]) best = { kind: 'track', t: R.tracks[0] };
    else if (a0) best = { kind: 'artist', a: a0 };
    if (!fresh && lastBest.current && best && (nq.startsWith(lastBest.current.q) || lastBest.current.q.startsWith(nq))) {
      const lb = lastBest.current.b;
      const still = lb.kind === 'artist' ? artistRel(lb.a.artistName, qt) > 0 : trackRel(lb.t, qt) > 0;
      if (still && !(best.kind === 'artist' && exact)) best = lb;   // ответ устарел — не меняем лучший результат на догадку
    }
    if (fresh && best) lastBest.current = { q: nq, b: best };
  }
  const showTracks = f === 'all' || f === 'tracks'; const showArtists = f === 'all' || f === 'artists'; const showAlbums = f === 'all' || f === 'albums';
  const tracks: Track[] = R ? (f === 'all' ? R.tracks.slice(0, 5) : R.tracks) : local;
  // «ничего не нашлось» — только по полному ответу (пока альбомы в пути, могут найтись они)
  const nothing = !!R && !res?.v?.part && !R.tracks.length && !R.artists.length && !R.albums.length && !myLists.length;
  const histRow = (h: string, onPress: () => void) => (
    <Press key={h} onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, height: 48 }}>
      <PcIcon n="clock" s={20} c={T.muted} /><Text numberOfLines={1} style={[ty.body, { flex: 1 }]}>{h}</Text></Press>
  );
  return (
    <ScrollView screen keyboardShouldPersistTaps="handled">
      {/* поле поиска — капсула (радиус = половина высоты), как все поля и кнопки */}
      <Glass radius={26} style={{ margin: 16, height: 52, flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 4 }}>
        <PcIcon n="search" s={20} c={T.muted} />
        <TextInput keyboardAppearance={T.dark ? 'dark' : 'light'} ref={inp} value={q} onChangeText={setQ} onSubmitEditing={() => remember(q)} placeholder="Трек, исполнитель, альбом" placeholderTextColor={T.muted} style={[ty.body, { flex: 1, height: 52, paddingHorizontal: 10, paddingVertical: 0 }]} returnKeyType="search" autoCorrect={false} />
        {!!q && <Pressable hitSlop={8} onPress={() => setQ('')} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><PcIcon n="close" s={18} c={T.muted} /></Pressable>}
      </Glass>
      {!s ? (
        hist.length ? (
          <View>
            <Sec right={<Pressable hitSlop={10} onPress={clear}><Text style={[ty.subhead, { color: T.accentText, fontWeight: '600' }]}>Очистить</Text></Pressable>}>Недавние запросы</Sec>
            {hist.map((h) => histRow(h, () => setQ(h)))}
          </View>
        ) : <Hint center>Начните вводить запрос</Hint>
      ) : (
        <View>
          {/* сначала — текстовые подсказки (прошлые запросы и продолжения), потом артисты, треки и всё остальное */}
          {sugg.length > 0 && <View style={{ marginBottom: 6 }}>{sugg.map(suggRow)}</View>}
          {!R && !local.length && !myLists.length ? (
            err ? <Hint center>Не удалось получить результаты. Проверьте интернет.</Hint> : busy ? <ActivityIndicator style={{ marginTop: 30 }} /> : null
          ) : nothing ? <Hint center>{`Ничего не нашлось по запросу «${s}»`}</Hint> : (
            <View>
              {!!R && (
                <RNScroll horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingBottom: 4 }}>
                  {chips.map(([k, lb]) => <Press key={k} hap="select" onPress={() => setF(k)} style={{ height: 36, paddingHorizontal: 16, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: f === k ? T.primary : T.glass, borderWidth: 1, borderColor: f === k ? 'transparent' : T.stroke }}>
                    <Text style={[ty.miniTitle, { color: f === k ? T.onPrimary : T.ink }]}>{lb}</Text></Press>)}
                </RNScroll>
              )}

              {f === 'all' && best && (
                <View>
                  <Sec>Лучший результат</Sec>
                  <Press onPress={() => (best.kind === 'artist' ? go({ k: 'artist', id: best.a.artistId, name: best.a.artistName }) : (remember(q), P.go([best.t], 0)))} style={{ marginHorizontal: 16 }}>
                    <Glass radius={22} style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                      {best.kind === 'artist' ? <ArtistDot name={best.a.artistName} id={best.a.artistId} fallback={R!.tracks.find((x: Track) => x.artistId === best.a.artistId)?.cover} size={88} /> : <Cover u={best.t.cover} size={88} r={8} />}
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={2} style={[ty.title2, { fontWeight: '700' }]}>{best.kind === 'artist' ? best.a.artistName : best.t.title}</Text>
                        {best.kind === 'artist' ? <BestSub id={best.a.artistId} /> : <Text numberOfLines={1} style={[ty.subhead, { marginTop: 4 }]}>{`Трек · ${best.t.artist}`}</Text>}
                      </View>
                      <Press hap="tap" onPress={() => { remember(q); if (best.kind === 'track') P.go([best.t], 0); else { const l = R!.tracks.filter((x: Track) => x.artistId === best.a.artistId); if (l.length) P.go(l, 0); else go({ k: 'artist', id: best.a.artistId, name: best.a.artistName }); } }} style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center' }}>
                        <PcIcon n="play" s={22} c={T.onPrimary} />
                      </Press>
                    </Glass>
                  </Press>
                </View>
              )}
              {showTracks && (tracks.length ? <><Sec>Треки</Sec><Rows list={tracks} open={go} /></> : R ? <><Sec>Треки</Sec><Hint>Треков с доступным превью не найдено</Hint></> : null)}
              {f === 'all' && myLists.length > 0 && <Sec>Плейлисты</Sec>}
              {f === 'all' && myLists.map((x) => (
                <Press key={x.fav ? 'favs' : x.recent ? 'recent' : x.pl!.id} onPress={() => go(x.fav ? { k: 'favs' } : x.recent ? { k: 'recent' } : { k: 'playlist', id: x.pl!.id })} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 16 }}>
                  <PlCover pl={x.pl} fav={x.fav} recent={x.recent} size={48} r={12} />
                  <View style={{ flex: 1 }}><Text numberOfLines={1} style={ty.headline}>{x.name}</Text><Text numberOfLines={1} style={[ty.subhead, { marginTop: 2 }]}>{`Плейлист · ${plural(x.n, ['трек', 'трека', 'треков'])}`}</Text></View>
                </Press>
              ))}
              {showArtists && !!R && R.artists.length > 0 && <Sec>Артисты</Sec>}
              {showArtists && !!R && R.artists.slice(0, f === 'all' ? 3 : 15).map((a: any) => <Press key={a.artistId} onPress={() => go({ k: 'artist', id: a.artistId, name: a.artistName })} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 16 }}>
                <ArtistDot name={a.artistName} id={a.artistId} size={48} />
                <View style={{ flex: 1 }}><Text numberOfLines={1} style={ty.headline}>{a.artistName}</Text><Text style={[ty.subhead, { marginTop: 2 }]}>{api.genreRu(a.primaryGenreName) || 'Исполнитель'}</Text></View></Press>)}
              {showAlbums && !!R && R.albums.length > 0 && <AlbumStrip title="Альбомы" albums={R.albums} open={go} />}
            </View>
          )}
        </View>
      )}
    </ScrollView>
  );
}

// ---------- Плейлисты ----------
// Всё редактирование — по нажатию на обложку плейлиста (без отдельных кнопок): название, своя обложка, автообложка, удаление.
// Обложка: своя картинка → иначе коллаж 2×2 из обложек треков → иначе одна обложка → иначе градиент со звездой «Пульса».
// «Любимое»: сердце мягко светится и бьётся «тук-тук» раз в ~2,6 с — едва заметно (масштаб +6 %).
// «Недавние»: часы, у которых медленно идёт минутная стрелка (оборот за 12 с).
// Обе анимации — только масштаб, прозрачность и поворот в потоке анимаций; когда обложку не видно — стоят.
function FavArt({ size }: { size: number }) {
  const v0 = useVisible(); const aw0 = useAwake(); const vis = v0 && aw0; const b = useSharedValue(0);
  useEffect(() => {
    if (!vis) { cancelAnimation(b); b.value = withTiming(0, { duration: 400 }); return; }
    b.value = withRepeat(withSequence(
      withTiming(1, { duration: 200, easing: Easing.out(Easing.quad) }),
      withTiming(0.3, { duration: 230, easing: Easing.inOut(Easing.quad) }),
      withTiming(0.75, { duration: 190, easing: Easing.out(Easing.quad) }),
      withTiming(0, { duration: 720, easing: Easing.inOut(Easing.sin) }),
      withDelay(1300, withTiming(0, { duration: 0 })),
    ), -1, false);
    return () => cancelAnimation(b);
  }, [vis]);
  const heart = useAnimatedStyle(() => ({ transform: [{ scale: 1 + 0.06 * b.value }] }));
  const glow = useAnimatedStyle(() => ({ opacity: 0.32 + 0.38 * b.value, transform: [{ scale: 0.92 + 0.14 * b.value }] }));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute' }, glow]}><Glow size={size * 0.95} color="#ffffff" /></Animated.View>
      <Animated.View style={heart}><Ionicons name="heart" size={size * 0.38} color="#fff" /></Animated.View>
    </View>
  );
}
function RecentArt({ size }: { size: number }) {
  const v0 = useVisible(); const aw0 = useAwake(); const vis = v0 && aw0; const r = useSharedValue(0);
  useEffect(() => {
    if (!vis) { cancelAnimation(r); return; }
    r.value = withRepeat(withTiming(r.value + 360, { duration: 12000, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(r);
  }, [vis]);
  const D = size * 0.42, w = Math.max(2, size * 0.034);
  const minute = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }] }));
  const hand = (len: number) => ({ position: 'absolute' as const, left: D / 2 - w / 2, top: D / 2 - len, width: w, height: len + w / 2, borderRadius: w / 2, backgroundColor: '#fff' });
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Glow size={size * 0.9} color="#ffffff" style={{ position: 'absolute', opacity: 0.28 }} />
      <View style={{ width: D, height: D, borderRadius: D / 2, borderWidth: w, borderColor: '#fff' }}>
        <View style={{ position: 'absolute', left: -w, top: -w, width: D, height: D, transform: [{ rotate: '120deg' }] }}><View style={hand(D * 0.2)} /></View>
        <Animated.View style={[{ position: 'absolute', left: -w, top: -w, width: D, height: D }, minute]}><View style={hand(D * 0.32)} /></Animated.View>
        <View style={{ position: 'absolute', left: D / 2 - w - w, top: D / 2 - w - w, width: w * 2, height: w * 2, borderRadius: w, backgroundColor: '#fff' }} />
      </View>
    </View>
  );
}

function PlCover({ pl, size, r = 22, fav, recent }: { pl?: Playlist; size: number; r?: number; fav?: boolean; recent?: boolean }) {
  const T: any = useT();
  const box = { width: size, height: size, borderRadius: r, overflow: 'hidden' as const, backgroundColor: T.ph };
  const grad = (child: React.ReactNode, rev?: boolean) => (T as any).grad
    ? <View style={[box, { alignItems: 'center', justifyContent: 'center' }]}><RadialFill colors={(T as any).grad} />{child}</View>
    : <LinearGradient colors={(T as any).duo ? (rev ? [(T as any).accent2, T.accent] : [T.accent, (T as any).accent2]) : rev ? [T.accent, T.accentSoft] : [T.accentSoft, T.accent]} start={rev ? { x: 0, y: 1 } : { x: 0, y: 0 }} end={rev ? { x: 1, y: 0 } : { x: 1, y: 1 }} style={[box, { alignItems: 'center', justifyContent: 'center' }]}>{child}</LinearGradient>;
  if (fav) return grad(<FavArt size={size} />);
  if (recent) return grad(<RecentArt size={size} />, true);
  if (pl?.cover) return <View style={box}><Pic uri={pl.cover} style={{ width: size, height: size }} /></View>;
  const cs = Array.from(new Set((pl?.tracks || []).map((t) => t.cover))).slice(0, 4);
  const art = (u: string, dp: number) => api.artPx(u, dp);
  if (cs.length >= 4) return <View style={[box, { flexDirection: 'row', flexWrap: 'wrap' }]}>{cs.map((c, i) => <Pic key={i} uri={art(c, size / 2)} style={{ width: size / 2, height: size / 2 }} />)}</View>;
  if (cs.length) return <View style={box}><Pic uri={art(cs[0], size)} style={{ width: size, height: size }} /></View>;
  return grad(<LStar w={size * 0.5} color="#ffffff" />);
}

const newListName = (n: number) => (n ? `Новый плейлист ${n + 1}` : 'Новый плейлист');

// «Моя музыка» — как на ПК: сверху две обложки «Любимые треки» и «Недавние» (переключают список ниже),
// «Мои плейлисты» сеткой (первой — «Новый плейлист»), под ними треки выбранной папки с «Перемешать» и «Слушать».
// Все обложки — CARD × CARD, как в лентах главной.
function Library({ open }: any) {
  const P = usePlayer(); const T: any = useT(); const ty = useTy(); const { width: W } = useWin();
  const cw = CARD; const gap = Math.max(12, W - 32 - 2 * cw);
  const [tab, setTab] = useState<'likes' | 'recent'>('likes'); const fol = useFollow();
  // двойное нажатие на «Новый плейлист» создавало два плейлиста
  const create = () => once(() => { hap('success'); const id = P.createList(newListName(P.lists.length)); open({ k: 'playlist', id, fresh: true }); });
  const lists: Playlist[] = useMemo(() => [...P.lists].sort((a, b) => b.at - a.at), [P.lists]);
  const list = (tab === 'likes' ? P.favs : P.recent) as Track[];
  const folder = (k: 'likes' | 'recent', i: number) => (
    <Animated.View key={k} entering={rise(i * 40)}>
      <Press onPress={() => { hap('select'); setTab(k); }} style={{ width: cw, opacity: tab === k ? 1 : 0.55 }}>
        <PlCover fav={k === 'likes'} recent={k === 'recent'} size={cw} />
        <Text numberOfLines={1} style={[ty.miniTitle, { marginTop: 8 }]}>{k === 'likes' ? 'Любимые треки' : 'Недавние'}</Text>
        <Text numberOfLines={1} style={ty.footnote}>{plural((k === 'likes' ? P.favs : P.recent).length, ['трек', 'трека', 'треков'])}</Text>
      </Press>
    </Animated.View>
  );
  return (
    <ScrollView screen automaticallyAdjustKeyboardInsets>
      <Title>Моя музыка</Title>
      <View style={{ flexDirection: 'row', columnGap: gap, paddingHorizontal: 16, marginTop: 8 }}>{folder('likes', 0)}{folder('recent', 1)}</View>
      {fol.length > 0 && <>
        <Sec>Мои артисты</Sec>
        <HScroll>{fol.map((a) => (
          <Press key={a.id} onPress={() => open({ k: 'artist', id: a.id, name: a.name })} style={{ width: 88, alignItems: 'center' }}>
            <ArtistDot name={a.name} id={a.id} size={88} />
            <Text numberOfLines={1} style={[ty.miniTitle, { marginTop: 8, textAlign: 'center' }]}>{a.name}</Text>
          </Press>
        ))}</HScroll>
      </>}
      <Sec right={<Text style={[ty.subhead, { fontWeight: '600' }]}>{lists.length || ''}</Text>}>Мои плейлисты</Sec>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: gap, rowGap: 18, paddingHorizontal: 16 }}>
        <Animated.View entering={rise(80)}>
          <Press onPress={create} style={{ width: cw }}>
            <View style={{ width: cw, height: cw, borderRadius: 22, borderWidth: 1.5, borderStyle: 'dashed', borderColor: T.dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.18)', backgroundColor: T.glass, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
              <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center' }}><PcIcon n="plus" s={26} c={T.onPrimary} /></View>
              <Text style={ty.miniTitle}>Новый плейлист</Text>
            </View>
            <Text style={[ty.miniTitle, { marginTop: 8 }]}> </Text><Text style={ty.footnote}> </Text>
          </Press>
        </Animated.View>
        {lists.map((pl, i) => <PlCard key={pl.id} pl={pl} i={i + 3} cw={cw} meta={plural(pl.tracks.length, ['трек', 'трека', 'треков'])} open={open} />)}
      </View>
      <Sec>{tab === 'likes' ? 'Любимые треки' : 'Недавние'}</Sec>
      {list.length ? <><PlayBtns list={list} from={tab} /><Rows key={tab} list={list} from={tab} open={open} /></>
        : <Hint>{tab === 'likes' ? 'Пока пусто. Нажмите ♥ у трека — он появится здесь.' : 'Здесь будут треки, которые вы слушали.'}</Hint>}
    </ScrollView>
  );
}

// Карточка плейлиста в «Моей музыке» — выглядит как прежде, но у неё две зоны:
//  • обычное нажатие на обложку или название — открыть плейлист (как раньше);
//  • долгое нажатие на НАЗВАНИЕ — переименовать прямо здесь: название превращается в поле ввода,
//    «Готово» на клавиатуре или нажатие мимо — сохранить (пустое название не сохраняется);
//  • долгое нажатие на ОБЛОЖКУ — удалить плейлист (после подтверждения). Удаляется только он сам:
//    треки в «Любимом», других плейлистах и истории остаются.
// Обе зоны сжимаются вместе, одной анимацией — как раньше вся карточка.
function PlCard({ pl, i, cw, meta, open }: { pl: Playlist; i: number; cw: number; meta: string; open: (s: any) => void }) {
  const P = usePlayer(); const T: any = useT(); const ty = useTy();
  const k = useSharedValue(1);
  const sc = useAnimatedStyle(() => ({ transform: [{ scale: k.value }] }));
  const down = () => { k.value = withTiming(0.97, { duration: 110, easing: Easing.out(Easing.quad) }); };
  const up = () => { k.value = withTiming(1, { duration: 240, easing: Easing.out(Easing.cubic) }); };
  const [edit, setEdit] = useState(false); const [val, setVal] = useState(pl.name);
  const asking = useRef(false);   // окно удаления уже открыто — повторное долгое нажатие ничего не делает
  const saved = useRef(false);    // «Готово» и потеря фокуса не сохраняют название дважды
  const go = () => { if (!edit && !asking.current) open({ k: 'playlist', id: pl.id }); };
  // поле ввода появляется вместо названия; карточку сразу возвращаем к обычному размеру
  // (нажатая область исчезает, и «отпускания» для неё уже не будет)
  const rename = () => { if (edit || asking.current) return; tick(); up(); saved.current = false; setVal(pl.name); setEdit(true); };
  const save = () => {
    if (saved.current) return; saved.current = true;
    const v = val.trim(); if (v && v !== pl.name) P.renameList(pl.id, v);
    setEdit(false);
  };
  const remove = () => {
    if (edit || asking.current) return; asking.current = true; tick();
    const done = () => { asking.current = false; };
    openDialog({ danger: true, icon: 'trash-outline', title: 'Удалить плейлист?', text: `«${pl.name}» исчезнет из «Моей музыки». Треки в «Любимом» и других плейлистах останутся.`, onClose: done, buttons: [
      { text: 'Отмена', kind: 'sec', onPress: done },
      { text: 'Удалить', kind: 'dng', onPress: () => { done(); P.deleteList(pl.id); } },
    ] });
  };
  return (
    <Animated.View entering={i < 14 ? rise(Math.min(i, 8) * 40) : undefined} exiting={FadeOut.duration(220).easing(EASE_IO)}>
      <Animated.View style={[{ width: cw }, sc]}>
        <Pressable onPress={go} onLongPress={remove} delayLongPress={450} onPressIn={down} onPressOut={up}>
          <View style={{ borderRadius: 22, backgroundColor: T.ph }}><PlCover pl={pl} size={cw} /></View>
        </Pressable>
        {edit ? (
          <View>
            {/* поле — капсула, как остальные поля и кнопки; по высоте занимает ровно место названия, карточки не сдвигаются */}
            <TextInput keyboardAppearance={T.dark ? 'dark' : 'light'} value={val} onChangeText={setVal} autoFocus selectTextOnFocus maxLength={40} returnKeyType="done" onSubmitEditing={save} onBlur={save} selectionColor={T.accent}
              style={[ty.miniTitle, { marginTop: 8, height: 20, padding: 0 }]} />
            <Text numberOfLines={1} style={ty.footnote}>{meta}</Text>
          </View>
        ) : (
          <Pressable onPress={go} onLongPress={rename} delayLongPress={450} onPressIn={down} onPressOut={up}>
            <Text numberOfLines={1} style={[ty.miniTitle, { marginTop: 8 }]}>{pl.name}</Text>
            <Text numberOfLines={1} style={ty.footnote}>{meta}</Text>
          </Pressable>
        )}
      </Animated.View>
    </Animated.View>
  );
}

function PlaylistScreen({ id, fav, recent, fresh, open, back }: any) {
  const P = usePlayer(); const T: any = useT(); const ty = useTy(); const settled = useSettled();
  const sys = fav || recent;   // «Любимое» и «Недавние» — папки приложения: их нельзя переименовать или удалить
  const pl: Playlist | undefined = sys ? undefined : P.lists.find((x: Playlist) => x.id === id);
  const tracks: Track[] = fav ? P.favs : recent ? P.recent : pl?.tracks || [];
  const name = fav ? 'Любимое' : recent ? 'Недавние' : pl?.name || '';
  const [edit, setEdit] = useState(!!fresh); const [val, setVal] = useState(name);
  const gone = useRef(false);
  useEffect(() => { if (!sys && !pl && !gone.current) { gone.current = true; back(); } }, [pl]);
  const save = () => { if (pl && edit) P.renameList(pl.id, val); setEdit(false); };
  const pickImg = async (camera: boolean) => {
    if (!pl) return;
    if (camera) { const perm = await ImagePicker.requestCameraPermissionsAsync(); if (!perm.granted) return; }
    const r = camera
      ? await ImagePicker.launchCameraAsync({ allowsEditing: true, aspect: [1, 1], quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
    if (!r.canceled) P.setListCover(pl.id, await keepImage(r.assets[0].uri));
  };
  const del = () => {
    if (!pl) return;
    openDialog({ danger: true, icon: 'trash-outline', title: 'Удалить плейлист?', text: `«${pl.name}» исчезнет из «Моей музыки». Треки в «Любимом» и других плейлистах останутся.`, buttons: [
      { text: 'Отмена', kind: 'sec' },
      { text: 'Удалить', kind: 'dng', onPress: () => { gone.current = true; back(); setTimeout(() => P.deleteList(pl.id), 420); } },
    ] });
  };
  // нажатие на обложку — всё управление плейлистом
  const menu = () => {
    if (sys || !pl) return;
    const items: [string, () => void][] = [
      ['Изменить название', () => { setVal(pl.name); setEdit(true); }],
      ['Выбрать обложку из галереи', () => pickImg(false)],
      ['Сделать фото', () => pickImg(true)],
      ...(pl.cover ? [['Собрать обложку из треков', () => P.setListCover(pl.id, undefined)] as [string, () => void]] : []),
      ['Удалить плейлист', del],
    ];
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ title: `Плейлист «${pl.name}»`, options: [...items.map((x) => x[0]), 'Отмена'], cancelButtonIndex: items.length, destructiveButtonIndex: items.length - 1 }, (i) => items[i]?.[1]());
    else { const ic = ['create-outline', 'images-outline', 'camera-outline', ...(pl.cover ? ['color-wand-outline'] : []), 'trash-outline']; openMenu(`Плейлист «${pl.name}»`, items.map(([text, onPress], i) => ({ text, onPress, icon: ic[i], danger: i === items.length - 1 }))); }
  };
  return (
    <ScrollView screen keyboardShouldPersistTaps="handled">
      {(T as any).grad ? <RadialFill colors={(T as any).grad} fade strength={T.dark ? 0.85 : 1} cy={0.48} style={{ left: '-30%', right: '-30%', top: -200, bottom: undefined, height: 660 }} />
        : <LinearGradient pointerEvents="none" colors={[T.bgGlow, 'transparent']} style={{ position: 'absolute', left: 0, right: 0, top: -200, height: 620 }} />}
      <Animated.View entering={FadeIn.duration(450).easing(EASE_OUT)} style={{ alignItems: 'center', marginTop: 8 }}>
        <Press onPress={menu} to={0.97}>
          <View style={{ borderRadius: 22, backgroundColor: T.ph, shadowColor: '#000', shadowOpacity: T.dark ? 0.5 : 0.25, shadowRadius: 30, shadowOffset: { width: 0, height: 24 } }}><PlCover pl={pl} fav={fav} recent={recent} size={220} /></View>
        </Press>
      </Animated.View>
      <View style={{ height: 74, marginTop: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
        {edit ? (
          <Animated.View key="e" entering={FadeIn.duration(220).easing(EASE_OUT)} style={{ alignItems: 'center' }}>
            <TextInput keyboardAppearance={T.dark ? 'dark' : 'light'} value={val} onChangeText={setVal} autoFocus selectTextOnFocus returnKeyType="done" onSubmitEditing={save} onBlur={save} maxLength={40}
              selectionColor={T.accent} style={[ty.title1, { fontWeight: '700', letterSpacing: -0.4, textAlign: 'center', minWidth: 200, paddingVertical: 0 }]} />
            <Text style={[ty.footnote, { marginTop: 8 }]}>Название сохранится, когда нажмёте «Готово»</Text>
          </Animated.View>
        ) : (
          <Animated.Text key="t" entering={FadeIn.duration(260).easing(EASE_OUT)} numberOfLines={2} suppressHighlighting
            onLongPress={sys || !pl ? undefined : () => { tick(); setVal(pl.name); setEdit(true); }}
            style={[ty.title1, { fontWeight: '700', letterSpacing: -0.4, textAlign: 'center' }]}>{name}</Animated.Text>
        )}
      </View>
      <Text style={[ty.footnote, { textAlign: 'center' }]}>{[sys ? null : P.profile.name, listMeta(tracks)].filter(Boolean).join(' · ')}</Text>
      <View style={{ opacity: tracks.length ? 1 : 0.45 }}><PlayBtns list={tracks} from={fav ? 'likes' : recent ? 'recent' : 'pl:' + id} mt={20} /></View>
      <View style={{ height: 10 }} />
      {tracks.length ? (settled ? <Rows list={tracks} open={open} /> : <View style={{ height: tracks.length * 64 }} />) : <Hint center>{fav ? 'Нажмите на сердечко у любого трека' : recent ? 'Здесь появятся треки, которые вы слушали' : 'Добавляйте треки долгим нажатием на любой трек'}</Hint>}
    </ScrollView>
  );
}

// Шторка «Добавить в плейлист» (долгое нажатие на трек или «…» в плеере). Отметки ставятся сразу.
// Скругления по правилу: шторка 40, внутренний отступ 16 → кнопка-капсула «Готово» (радиус 24) повторяет край шторки.
const AddCtx = React.createContext<(t: Track) => void>(() => {});
function AddSheet({ t, onClose }: { t: Track; onClose: () => void }) {
  const P = usePlayer(); const T: any = useT(); const ty = useTy(); const ins = useSafeAreaInsets();
  const y = useSharedValue(1);
  useEffect(() => { y.value = withTiming(0, { duration: 460, easing: SHEET }); }, []);
  const close = () => { y.value = withTiming(1, { duration: 340, easing: SHEET }, (f) => { if (f) runOnJS(onClose)(); }); };
  const sheet = useAnimatedStyle(() => ({ transform: [{ translateY: y.value * 640 }] }));
  const dim = useAnimatedStyle(() => ({ opacity: 1 - y.value }));
  const pan = Gesture.Pan().activeOffsetY(10).failOffsetX([-25, 25])
    .onUpdate((e) => { y.value = Math.max(0, e.translationY / 640); })
    .onEnd((e) => { if (e.translationY > 110 || e.velocityY > 800) runOnJS(close)(); else y.value = withTiming(0, { duration: 300, easing: SHEET }); });
  const abs = StyleSheet.absoluteFill;
  const lists: Playlist[] = [...P.lists].sort((a, b) => b.at - a.at);
  return (
    <View style={[abs, { zIndex: 85 }]}>
      <Animated.View style={[abs, dim]}><Pressable onPress={close} style={[abs, { backgroundColor: T.dark ? 'rgba(0,0,0,0.5)' : 'rgba(20,16,40,0.28)' }]} /></Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[{ position: 'absolute', left: 8, right: 8, bottom: ins.bottom + 8, borderRadius: 40, backgroundColor: T.sheet, borderWidth: 1, borderColor: T.stroke, padding: 16, paddingTop: 10, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 30, shadowOffset: { width: 0, height: 12 } }, sheet]}>
          <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: T.line, marginBottom: 14 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.line }}>
            <Cover u={api.smallArt(t.cover)} size={44} r={22} />
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}><Text numberOfLines={1} style={[ty.headline, { flexShrink: 1 }]}>{t.title}</Text>{!!t.explicit && <Explicit />}</View>
              <Text numberOfLines={1} style={ty.subhead}>{t.artist}</Text>
            </View>
          </View>
          <Text style={[ty.title2, { marginTop: 14, marginBottom: 4 }]}>Добавить в плейлист</Text>
          <RNScroll style={{ maxHeight: 330 }} showsVerticalScrollIndicator={false}>
            <Press onPress={() => once(() => { hap('double'); P.createList(newListName(P.lists.length), t); })} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
              <View style={{ width: 52, height: 52, borderRadius: 12, borderWidth: 1.5, borderStyle: 'dashed', borderColor: T.dark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)', alignItems: 'center', justifyContent: 'center' }}><Ionicons name="add" size={26} color={T.ink} /></View>
              <Text style={[ty.headline, { color: T.accentText }]}>Новый плейлист</Text>
            </Press>
            {lists.map((pl, i) => { const on = pl.tracks.some((x) => x.id === t.id || (x.title === t.title && x.artist === t.artist)); return (
              <Animated.View key={pl.id} entering={i < 14 ? rise(Math.min(i, 10) * 30, 8, 400) : undefined}>
                <Press onPress={() => P.toggleInList(pl.id, t)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 }}>
                  <PlCover pl={pl} size={52} r={12} />
                  <View style={{ flex: 1 }}><Text numberOfLines={1} style={ty.headline}>{pl.name}</Text><Text style={ty.subhead}>{plural(pl.tracks.length, ['трек', 'трека', 'треков'])}</Text></View>
                  <View style={{ width: 26, height: 26, borderRadius: 13, borderWidth: on ? 0 : 2, borderColor: T.line, backgroundColor: on ? T.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                    {on && <Animated.View entering={FadeIn.duration(220).easing(EASE_OUT)}><Ionicons name="checkmark" size={17} color="#fff" /></Animated.View>}
                  </View>
                </Press>
              </Animated.View>); })}
          </RNScroll>
          <Press onPress={close} style={{ marginTop: 14, height: 52, borderRadius: 26, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[ty.headline, { color: T.onPrimary }]}>Готово</Text>
          </Press>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function ListScreen({ title, tracks, open }: any) {
  return (<ScrollView screen><Title>{title}</Title><View style={{ height: 8 }} /><Rows list={tracks} open={open} /></ScrollView>);
}

// ---------- ИИ-диджей ----------
// Чат: пишете запрос — модель отвечает фразой и списком песен, приложение находит их в каталоге.
// Треки появляются по мере того, как находятся. «Слушать» — сразу играть, «Сохранить» — новый плейлист.
// Разговор помнит контекст: можно уточнять («ещё», «повеселее», «без рэпа»). Сохраняется между запусками.
let aiMem: M_ai.Msg[] | null = null;
const AI_CHAT = 'pulse_ai_chat';
function AiKeyCard({ onDone, err }: { onDone?: () => void; err?: boolean }) {
  const T: any = useT(); const ty = useTy(); const [v, setV] = useState(''); const [cur, setCur] = useState('');
  useEffect(() => { const l = () => M_ai.getKey().then(setCur); l(); return M_ai.onKey(l); }, []);
  const save = async () => { if (!v.trim()) return; await M_ai.setKey(v); setV(''); Keyboard.dismiss(); buzzS(); onDone?.(); };
  return (
    <Animated.View entering={rise(0, 6, 480)} style={{ marginHorizontal: 16, marginTop: 14 }}>
      <Glass radius={22} style={{ padding: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Ionicons name="key-outline" size={18} color={T.accentText} />
          <Text style={[ty.headline, { flex: 1 }]}>{cur ? 'Свой ключ подключён' : 'Свой ключ ИИ (необязательно)'}</Text>
        </View>
        <Text style={[ty.subhead, { marginTop: 8 }]}>{cur
          ? `${M_ai.providerOf(cur).name} · ${cur.slice(0, 4)}••••${cur.slice(-4)}`
          : 'ИИ-диджей работает бесплатно и без ключей. Есть ключ ChatGPT (OpenAI, sk-…), Groq или OpenRouter — вставьте, и ответы будут быстрее и точнее. Ключ хранится только на телефоне.'}</Text>
        {!cur && <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {([['ChatGPT', 'https://platform.openai.com/api-keys'], ['Groq', 'https://console.groq.com/keys'], ['OpenRouter', 'https://openrouter.ai/settings/keys']] as const).map(([lb, u]) => (
            <Press key={u} onPress={() => Linking.openURL(u)} to={0.96} style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: T.accentPill, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[ty.footnote, { fontWeight: '600', color: T.accentText }]}>{lb}</Text><Ionicons name="open-outline" size={13} color={T.accentText} />
            </Press>))}
        </View>}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <View style={{ flex: 1, height: 52, borderRadius: 26, paddingHorizontal: 16, backgroundColor: T.glass, borderWidth: 1, borderColor: T.stroke, justifyContent: 'center' }}>
            <TextInput value={v} onChangeText={setV} placeholder={cur ? 'Новый ключ' : 'gsk_…'} placeholderTextColor={T.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry
              onSubmitEditing={save} returnKeyType="done" style={{ fontFamily: SF, fontSize: 15, color: T.ink }} />
          </View>
          <Press onPress={save} to={0.95} style={{ height: 52, paddingHorizontal: 18, borderRadius: 26, backgroundColor: v.trim() ? T.primary : T.glass, justifyContent: 'center' }}>
            <Text style={[ty.footnote, { fontWeight: '700', color: v.trim() ? T.onPrimary : T.muted }]}>Сохранить</Text>
          </Press>
        </View>
        {!!cur && <Pressable hitSlop={8} onPress={() => M_ai.setKey('')} style={{ marginTop: 10, alignSelf: 'flex-start' }}><Text style={[ty.footnote, { color: T.muted }]}>Удалить ключ</Text></Pressable>}
      </Glass>
    </Animated.View>
  );
}
const buzzS = () => hap('select');
// «думает»: три точки мягко дышат по очереди
// «ИИ печатает…» — как в iMessage: облачко с хвостиком из двух кружков, три точки по очереди «загораются» волной.
// Цвета — из профиля: облачко — мягкий оттенок цвета оформления, точки — от бледного к яркому цвету оформления.
// Чёткость: точки не масштабируются и не полупрозрачны (меняется только цвет) — края всегда резкие;
// облачко «надувается» только при появлении и дальше стоит в натуральную величину.
function AiTyping() {
  const T: any = useT(); const k = useSharedValue(0); const pop = useSharedValue(0);
  useEffect(() => {
    pop.value = withTiming(1, { duration: 360, easing: Easing.bezier(0.34, 1.4, 0.64, 1) });
    k.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(k);
  }, []);
  // непрозрачные оттенки (смесь фона и цвета оформления): хвостик-кружки не дают тёмных пятен при наложении
  const hx = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#e23199');
  const base = T.dark ? '#000000' : '#ffffff'; const hi = hx(T.accent);
  const bg = blendHex(base, hi, T.dark ? 0.2 : 0.13); const lo = blendHex(base, hi, T.dark ? 0.45 : 0.35);
  const box = useAnimatedStyle(() => { const s = pop.value; return { opacity: Math.min(1, s * 1.6), transform: s >= 0.999 ? [] : [{ translateX: -36 * (1 - s) }, { translateY: 19 * (1 - s) }, { scale: s }] }; });
  const wave = (sh: number) => { 'worklet'; const p = (k.value + 1 - sh) % 1; return Math.max(0, Math.sin(p * Math.PI * 2 - 0.2)); };
  const d0 = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(wave(0), [0, 1], [lo, hi]), transform: [{ translateY: -Math.round(2 * wave(0)) }] }));
  const d1 = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(wave(0.18), [0, 1], [lo, hi]), transform: [{ translateY: -Math.round(2 * wave(0.18)) }] }));
  const d2 = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(wave(0.36), [0, 1], [lo, hi]), transform: [{ translateY: -Math.round(2 * wave(0.36)) }] }));
  return (
    <Animated.View style={[{ marginLeft: 26, marginTop: 16, alignSelf: 'flex-start' }, box]}>
      <View style={{ position: 'absolute', left: -10, bottom: -9, width: 7, height: 7, borderRadius: 3.5, backgroundColor: bg }} />
      <View style={{ position: 'absolute', left: -3, bottom: -3, width: 14, height: 14, borderRadius: 7, backgroundColor: bg }} />
      <View style={{ height: 38, paddingHorizontal: 15, borderRadius: 19, backgroundColor: bg, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {[d0, d1, d2].map((st, i) => <Animated.View key={i} style={[{ width: 9, height: 9, borderRadius: 4.5 }, st]} />)}
      </View>
    </Animated.View>
  );
}
function AiAnswer({ m, open, busy }: { m: M_ai.Msg; open: (s: any) => void; busy?: boolean }) {
  const T: any = useT(); const ty = useTy(); const P = usePlayer(); const [saved, setSaved] = useState<string | null>(null);
  const tr = m.tracks || [];
  const save = () => once(() => { if (!tr.length) return; const id = P.createList(m.title || 'От ИИ-диджея', tr); setSaved(id); hap('success'); });
  return (
    <View style={{ marginTop: 14 }}>
      <View style={{ flexDirection: 'row', gap: 10, marginHorizontal: 16, alignItems: 'flex-start' }}>
        <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginTop: -2 }}><AiIcon size={28} /></View>
        <Text style={[ty.body, { flex: 1, color: m.err ? T.muted : T.ink, lineHeight: 22 }]}>{m.text}</Text>
      </View>
      {/* кто ответил: бесплатный ИИ-сервис, свой ключ или встроенный диджей */}
      {!!m.src && !busy && <Text style={[ty.caption, { marginLeft: 54, marginTop: 4, color: T.muted }]}>{m.src}</Text>}
      {(tr.length > 0 || busy) && !m.err && (
        <Animated.View entering={rise(60, 6, 520)} style={{ marginTop: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, gap: 8, marginBottom: 6 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={ty.headline}>{m.title || 'Подборка'}</Text>
              <Text style={[ty.footnote, { marginTop: 2 }]}>{busy ? `Ищу в каталоге… ${tr.length ? plural(tr.length, ['трек', 'трека', 'треков']) : ''}` : plural(tr.length, ['трек', 'трека', 'треков']) + (m.miss ? ` · ${m.miss} не нашлось` : '')}</Text>
            </View>
            {tr.length > 0 && <Press onPress={() => P.go(tr, 0)} to={0.95} style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: T.primary, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="play" size={14} color={T.onPrimary} /><Text style={[ty.footnote, { fontWeight: '700', color: T.onPrimary }]}>Слушать</Text>
            </Press>}
            {tr.length > 1 && !busy && <Press onPress={() => (saved ? open({ k: 'playlist', id: saved }) : save())} to={0.95} style={{ height: 36, paddingHorizontal: 12, borderRadius: 18, backgroundColor: T.glass, borderWidth: 1, borderColor: T.stroke, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name={saved ? 'checkmark' : 'add'} size={15} color={T.ink} /><Text style={[ty.footnote, { fontWeight: '600', color: T.ink }]}>{saved ? 'Открыть' : 'Сохранить'}</Text>
            </Press>}
          </View>
          <Rows list={tr} open={open} />
        </Animated.View>
      )}
    </View>
  );
}
function AiScreen({ open, back, q0 }: { open: (s: any) => void; back: () => void; q0?: string }) {
  const T: any = useT(); const ty = useTy(); const P = usePlayer(); const ins = useSafeAreaInsets(); const top = useTopPad() + 56;
  const [msgs, setMsgs] = useState<M_ai.Msg[]>(aiMem || []); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false); const [part, setPart] = useState<M_ai.Msg | null>(null);
  const [key, setKeyS] = useState<string | null>(null); const [needKey, setNeedKey] = useState(false); const [setup, setSetup] = useState(false);
  const sc = useRef<RNScroll>(null); const inp = useRef<TextInput>(null); const edgeAi = useContext(EdgeCtx);
  // клавиатура: капсула ввода поднимается ровно над ней (на UI-потоке, в такт клавиатуре)
  const kb = useAnimatedKeyboard();
  const kbSt = useAnimatedStyle(() => ({ transform: [{ translateY: -Math.max(0, kb.height.value - DOCK_B + 8) }] }));
  const [kbh, setKbh] = useState(0);
  useEffect(() => {
    const a = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', (e) => { setKbh(e.endCoordinates.height); setTimeout(() => sc.current?.scrollToEnd({ animated: true }), 80); });
    const b = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKbh(0));
    return () => { a.remove(); b.remove(); };
  }, []);
  useEffect(() => { const l = () => M_ai.getKey().then((k) => { setKeyS(k); if (k) setNeedKey(false); }); l(); return M_ai.onKey(l); }, []);
  useEffect(() => { if (!aiMem) AsyncStorage.getItem(AI_CHAT).then((v) => { if (v) try { const m = JSON.parse(v); aiMem = m; setMsgs(m); } catch {} }).catch(() => {}); }, []);
  const keep = (m: M_ai.Msg[]) => { aiMem = m; AsyncStorage.setItem(AI_CHAT, JSON.stringify(m.slice(-16))).catch(() => {}); };
  const toEnd = () => setTimeout(() => sc.current?.scrollToEnd({ animated: true }), 60);
  const send = async (text?: string) => {
    const s = (text ?? q).trim(); if (!s || busy) return;
    Keyboard.dismiss(); setQ(''); buzzS();
    const hist = msgs; const mine: M_ai.Msg[] = [...hist, { role: 'user', text: s }]; setMsgs(mine); setBusy(true); setPart(null); toEnd();
    try {
      const tz = { artists: [...new Set([...(await M_pulse.topTaste(10)), ...P.favs.slice(0, 30).map((t) => api.baseArtist(t.artist))])].slice(0, 14), liked: P.favs.slice(0, 10).map((t) => `${t.title} — ${t.artist}`) };
      const r = await M_ai.ask(hist, s, tz, (m) => setPart(m));
      const next = [...mine, r]; setMsgs(next); keep(next); hap(r.tracks?.length ? 'success' : 'light');
    } catch (e: any) {
      const nk = e?.message === 'NOKEY'; hap('warning');
      const next = [...mine, { role: 'assistant' as const, text: nk ? 'Не получилось связаться с музыкальными сервисами — проверьте интернет.' : String(e?.message || 'Не получилось — проверьте интернет'), err: true }];
      setMsgs(next); keep(next);
    } finally { setBusy(false); setPart(null); toEnd(); }
  };
  // пришли из поиска с запросом — сразу спрашиваем, когда экран въехал
  useEffect(() => { if (!q0) return; const t = setTimeout(() => send(q0), 480); return () => clearTimeout(t); }, []);
  const clear = () => { setMsgs([]); keep([]); };
  const empty = !msgs.length && !busy;
  const prov = key !== null ? M_ai.providerOf(key).name : '';
  return (
    <View style={{ flex: 1 }}>
      {/* список прокручивается ПОД полем ввода и мини-плеером — внизу нет непрозрачной полосы */}
      <RNScroll ref={sc} scrollEventThrottle={16} onScroll={(e) => { if (edgeAi) edgeAi.value = e.nativeEvent.contentOffset.y; }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingTop: top, paddingBottom: DOCK_B + 60 + 20 + (kbh ? kbh - DOCK_B : P.cur ? MINI_H + 8 : 0) }}>
        {empty ? (
          <Animated.View entering={rise(0, 8, 560)} style={{ alignItems: 'center', paddingTop: 36 }}>
            <AiIcon size={96} />
            <Text style={[ty.title1, { marginTop: 10 }]}>ИИ-диджей</Text>
            <Text style={[ty.subhead, { textAlign: 'center', marginHorizontal: 40, marginTop: 6 }]}>Опишите настроение, занятие или похожих артистов — подберу трек или соберу плейлист</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 22, marginHorizontal: 20 }}>
              {M_ai.SUGGEST.map((x, i) => (
                <Animated.View key={x} entering={rise(120 + i * 40, 5, 480)}>
                  <Press onPress={() => send(x)} to={0.95} style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: T.glass, borderWidth: 1, borderColor: T.stroke, justifyContent: 'center' }}>
                    <Text style={[ty.footnote, { fontWeight: '600', color: T.ink }]}>{x}</Text>
                  </Press>
                </Animated.View>
              ))}
            </View>
          </Animated.View>
        ) : (
          <View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginHorizontal: 16 }}>
              <Pressable hitSlop={10} onPress={() => setSetup((x) => !x)}><Text style={[ty.footnote, { color: T.muted }]}>{key ? 'Ключ ИИ ✓' : M_ai.builtIn() ? 'ChatGPT' : 'Ключ ChatGPT'}</Text></Pressable>
              <Pressable hitSlop={10} onPress={clear} disabled={busy}><Text style={[ty.footnote, { color: T.muted }]}>Новый разговор</Text></Pressable>
            </View>
            {msgs.map((m, i) => m.role === 'user'
              ? <Animated.View key={i} entering={i >= msgs.length - 2 ? rise(0, 6, 420) : undefined} style={{ alignSelf: 'flex-end', maxWidth: '82%', marginHorizontal: 16, marginTop: 14, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, borderBottomRightRadius: 6, backgroundColor: T.primary }}>
                  <Text style={[ty.body, { color: T.onPrimary }]}>{m.text}</Text>
                </Animated.View>
              : <Animated.View key={i} entering={i >= msgs.length - 1 ? FadeIn.duration(380).easing(EASE_OUT) : undefined}><AiAnswer m={m} open={open} /></Animated.View>)}
            {busy && (part ? <Animated.View entering={FadeIn.duration(320).easing(EASE_OUT)}><AiAnswer m={part} open={open} busy /></Animated.View>
              : <AiTyping />)}
          </View>
        )}
        {(needKey || setup) && <AiKeyCard err={needKey} onDone={() => { setSetup(false); setNeedKey(false); }} />}
        {key !== null && empty && !setup && <Pressable onPress={() => setSetup(true)} hitSlop={8} style={{ alignSelf: 'center', marginTop: 22 }}><Text style={[ty.footnote, { color: T.accentText, fontWeight: '600' }]}>{key ? prov + ' · настроить' : M_ai.builtIn() ? 'Работает на ChatGPT' : 'Подключить ChatGPT — вставить свой ключ'}</Text></Pressable>}
      </RNScroll>
      {/* поле ввода — стеклянная капсула 60 на уровне нижнего меню, парит над списком (без подложки снизу);
          с клавиатурой плавно поднимается вместе с ней. Мини-плеер — над капсулой, как на других экранах */}
      <Animated.View style={[{ position: 'absolute', left: 16, right: 16, bottom: DOCK_B }, kbSt]}>
        <Matte radius={30} strong style={{ minHeight: 60, flexDirection: 'row', alignItems: 'flex-end', paddingLeft: 20, paddingRight: 8, paddingVertical: 8 }}>
          <TextInput ref={inp} value={q} onChangeText={setQ} placeholder="Что включить?" placeholderTextColor={T.muted} multiline maxLength={300}
            style={{ flex: 1, fontFamily: SF, fontSize: 16, color: T.ink, paddingTop: Platform.OS === 'ios' ? 12 : 9, paddingBottom: 12, maxHeight: 120 }} />
          <Press onPress={() => send()} to={0.9} disabled={busy || !q.trim()} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: q.trim() && !busy ? T.primary : T.glass, alignItems: 'center', justifyContent: 'center' }}>
            {busy ? <ActivityIndicator size="small" color={T.muted} /> : <Ionicons name="arrow-up" size={20} color={q.trim() ? T.onPrimary : T.muted} />}
          </Press>
        </Matte>
      </Animated.View>
    </View>
  );
}

// ---------- Яндекс Музыка: вход своим токеном ----------
// Без входа Яндекс отдаёт только 30-секундные фрагменты. Чтобы слушать целиком, пользователь вставляет СВОЙ
// токен (нужна своя подписка Плюс). Токен хранится только на телефоне и уходит лишь на сервер приложения
// (server/main.py) в заголовке запроса звука — там он не сохраняется.
function YmScreen() {
  const T: any = useT(); const ty = useTy(); const [v, setV] = useState(''); const [has, setHas] = useState(false); const [srv, setSrv] = useState('проверяем…');
  // проверка: сервер на связи и Яндекс отвечает (с токеном, если он есть)
  const check = async () => {
    setSrv('проверяем…'); const tok = await api.ymToken(); setHas(!!tok);
    try {
      const d = await api.ymHealth();
      setSrv(!d.yandex ? `сервер на связи, но Яндекс не отвечает: ${d.error || 'пустой ответ'}` : d.tokenError ? `Яндекс отвечает, но ТОКЕН НЕ ПОДОШЁЛ (${d.tokenError}) — получите новый` : `всё работает${d.auth ? ' (вы вошли)' : ' (без входа — 30-секундные фрагменты)'}`);
      if (d.tokenError) setHas(false);
    } catch { setSrv(api.YLOCAL ? 'нет связи с Яндекс Музыкой — проверьте интернет' : `сервер не отвечает (${api.YB}) — запущен ли ym-server.sh и в одной ли Wi-Fi телефон и Mac?`); }
  };
  useEffect(() => { check(); }, []);
  const save = async () => { const t = v.trim(); if (!t) return; await api.setYmToken(t); setV(''); Keyboard.dismiss(); hap('success'); check(); };
  const out = async () => { await api.setYmToken(''); hap('warning'); check(); };
  return (
    <ScrollView screen keyboardShouldPersistTaps="handled">
      <Title>Яндекс Музыка</Title>
      <Text style={[ty.subhead, { marginHorizontal: 16, marginTop: 6 }]}>{`Поиск, чарты, артисты и обложки — из Яндекс Музыки. Состояние: ${srv}`}</Text>
      <Glass radius={22} style={{ margin: 16, padding: 16 }}>
        <Text style={ty.headline}>{has ? 'Вы вошли — треки играют целиком' : 'Сейчас играют 30-секундные фрагменты'}</Text>
        <Text style={[ty.subhead, { marginTop: 8 }]}>{has
          ? 'Если трек всё равно обрывается на 30 секундах — у аккаунта нет подписки Плюс или токен устарел.'
          : 'Чтобы слушать целиком, вставьте токен своего аккаунта Яндекса с подпиской Плюс. Нажмите «Получить токен», войдите в Яндекс — в адресной строке после входа будет access_token=…: скопируйте значение до знака «&» и вставьте сюда. Токен хранится только на телефоне.'}</Text>
        {!has && <Press onPress={() => Linking.openURL('https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d')} to={0.96} style={{ alignSelf: 'flex-start', marginTop: 12, height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: T.accentPill, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={[ty.footnote, { fontWeight: '600', color: T.accentText }]}>Получить токен</Text><Ionicons name="open-outline" size={13} color={T.accentText} />
        </Press>}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <View style={{ flex: 1, height: 52, borderRadius: 26, paddingHorizontal: 16, backgroundColor: T.glass, borderWidth: 1, borderColor: T.stroke, justifyContent: 'center' }}>
            <TextInput value={v} onChangeText={setV} placeholder={has ? 'Новый токен' : 'Токен'} placeholderTextColor={T.muted} autoCapitalize="none" autoCorrect={false} secureTextEntry onSubmitEditing={save} style={{ fontFamily: SF, fontSize: 15, color: T.ink }} />
          </View>
          <Press onPress={save} to={0.95} style={{ height: 52, paddingHorizontal: 18, borderRadius: 26, backgroundColor: v.trim() ? T.primary : T.glass, justifyContent: 'center' }}>
            <Text style={[ty.footnote, { fontWeight: '700', color: v.trim() ? T.onPrimary : T.muted }]}>Войти</Text>
          </Press>
        </View>
        {has && <Pressable hitSlop={8} onPress={out} style={{ marginTop: 12, alignSelf: 'flex-start' }}><Text style={[ty.footnote, { color: T.muted }]}>Выйти</Text></Pressable>}
      </Glass>
    </ScrollView>
  );
}

// ---------- Скрытые в «Моём пульсе» (дизлайкнутые) ----------
// Дизлайк в «Моём пульсе» — бан: трек больше не попадается. Здесь их можно вернуть по одному.
function useBannedCount() {
  const [n, setN] = useState(0);
  useEffect(() => { const load = () => M_pulse.banned().then((l) => setN(l.length)).catch(() => {}); load(); return M_pulse.onBanned(load); }, []);
  return n;
}
function BannedScreen() {
  const T: any = useT(); const ty = useTy(); const [list, setList] = useState<Track[] | null>(null);
  useEffect(() => { const load = () => M_pulse.banned().then(setList).catch(() => setList([])); load(); return M_pulse.onBanned(load); }, []);
  return (
    <ScrollView screen>
      <Title>Скрытые треки</Title>
      <Text style={[ty.subhead, { marginHorizontal: 16, marginTop: 4, marginBottom: 12 }]}>Вы дизлайкнули их в «Моём пульсе» — там они больше не попадаются. Верните, если передумали.</Text>
      {list && !list.length && <Hint center>Пока ничего не скрыто</Hint>}
      {(list || []).map((t, i) => (
        <Animated.View key={M_pulse.key(t)} entering={i < 14 ? rise(Math.min(i, 10) * 35, 5, 520) : undefined} exiting={FadeOut.duration(220).easing(EASE_IO)} layout={LinearTransition.duration(280)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 16 }}>
          <Cover u={api.smallArt(t.cover)} size={48} r={12} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={ty.headline}>{t.title}</Text>
            <Text numberOfLines={1} style={[ty.subhead, { marginTop: 2 }]}>{t.artist}</Text>
          </View>
          <Press onPress={() => M_pulse.unban(t)} hap="medium" to={0.95} style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: T.accentPill, justifyContent: 'center' }}>
            <Text style={[ty.footnote, { fontWeight: '600', color: T.accentText }]}>Вернуть</Text>
          </Press>
        </Animated.View>
      ))}
    </ScrollView>
  );
}

function AlbumsScreen({ title, albums, open }: any) {
  return (
    <ScrollView screen>
      <Title>{title}</Title><View style={{ height: 8 }} />
      {albums.map((x: any, i: number) => <AlbumRow key={x.collectionId} x={x} i={i} onPress={() => open({ k: 'album', id: x.collectionId })} />)}
    </ScrollView>
  );
}

const plural = (n: number, f: [string, string, string]) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? f[0] : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? f[1] : f[2]}`;
const shuffled = <T,>(a: T[]) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

// ---------- Экраны артиста и альбома: цветной верх из фото + адаптивный цвет текста ----------
// Общее состояние экрана: прокрутка (для шапки) и «тёмный ли верх» (тогда текст, логотип и статус-бар — белые)
const HeroCtx = React.createContext<any>(null);
function HeroLayer({ children, onBack }: any) {
  const sy = useSharedValue(0); const od = useSharedValue(0); const [onDark, setOD] = useState(false);
  const [fly, setFly] = useState<any>(null); const flyD = useSharedValue(0);
  const edgeP = useDerivedValue(() => interpolate(sy.value, [8, 110], [0, 1], 'clamp'));
  const [back, setBack] = useState<any>(null); const heroEnd = useSharedValue(0);
  useEffect(() => { heroEnd.value = back ? back.end : 0; }, [back?.end]);
  const setOnDark = useCallback((v: boolean) => { setOD((p) => (p === v ? p : v)); od.value = withTiming(v ? 1 : 0, { duration: 350 }); }, []);
  // место аватара считаем относительно самого слоя (а не окна): на Android окно начинается под строкой
  // состояния, и аватар раньше рисовался выше своего места на её высоту
  const rootRef = useRef<any>(null);
  const at = useCallback((ref: any, cb: (yc: number) => void) => setTimeout(() => {
    const a = ref.current, b = rootRef.current; if (!a || !b) return;
    a.measure((_x: number, _y: number, _w: number, h: number, _px: number, py: number) => { if (!h) return;
      b.measure((_x2: number, _y2: number, _w2: number, _h2: number, _px2: number, py2: number) => cb(py - py2 + h / 2 + sy.value)); });
  }, 60), []);
  const ctx = useMemo(() => ({ sy, od, onDark, setOnDark, setFly, flyD, setBack, heroEnd, at }), [onDark]);
  // «Прогрев»: анимации шапки, аватара и фона считаются на отдельном потоке, и в первый раз каждая из них
  // выполняется медленно (на старых телефонах — заметный рывок в начале прокрутки, потом всё плавно).
  // Когда страница открылась и успокоилась, незаметно сдвигаем прокрутку на 1 точку и обратно — всё
  // просчитывается заранее, и первая настоящая прокрутка уже плавная.
  useEffect(() => { const tm = setTimeout(() => { if (sy.value !== 0) return; sy.value = 1; setTimeout(() => { if (sy.value === 1) sy.value = 0; }, 60); }, 700); return () => clearTimeout(tm); }, []);
  return (
    <HeroCtx.Provider value={ctx}>
      <View ref={rootRef} collapsable={false} style={{ flex: 1 }}><Bg plain />{back && <HeroLayerBg b={back} sy={sy} />}<FadeTop animP={edgeP}>{children}</FadeTop><HeroTop onBack={onBack} />{fly && <ArtistFly f={fly} />}</View>
    </HeroCtx.Provider>
  );
}
// Цветной верх страницы (размытое фото) — слой позади прокрутки. Двигается вместе со страницей,
// а при оттягивании вниз мягко растягивается. Содержимое над ним у верха тает (FadeTop), а сам он — нет:
// область под логотипом полностью прозрачная, видно настоящий цвет фото, переход нигде не обрывается.
function HeroLayerBg({ b, sy }: { b: { u: string; end: number; onDark: boolean; tint?: string }; sy: any }) {
  const top = useTopPad() + 56;
  const st = useAnimatedStyle(() => ({ transform: [{ translateY: -Math.max(0, sy.value) }, { scale: 1 + Math.max(0, -sy.value) / 600 }] }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', top, left: 0, right: 0 }, st]}>
      {b.tint ? <CoverBleed u={b.u} tint={b.tint} end={top + b.end} top={top} /> : <Hero u={b.u} end={b.end} onDark={b.onDark} reg={false} />}
    </Animated.View>
  );
}
// Альбом (вариант Б, как на ПК): обложка во всю ширину сверху, не растянута; снизу по S-кривой перетекает в цвет,
// взятый из самой обложки. На этом цвете — название и кнопки, ниже цвет так же плавно уходит в фон темы.
function CoverBleed({ u, tint, end, top }: { u: string; tint: string; end: number; top: number }) {
  const { width: W } = useWin();
  const solidH = Math.max(0, end - W); const FADE = 360;
  const over = smooth(tint, 0, 1, 0, 1, 12); const out = smooth(tint, 1, 0, 0, 1, 12); const dim = smooth('0,0,0', 0.38, 0, 0, 1, 8);
  return (
    <View style={{ position: 'absolute', top: -top, left: 0, right: 0 }}>
      <View style={{ width: W, height: W, backgroundColor: `rgb(${tint})` }}>
        <Animated.View entering={FadeIn.duration(500).easing(EASE_OUT)} style={StyleSheet.absoluteFill}><Pic uri={api.hiArt(u)} style={{ width: W, height: W }} /></Animated.View>
        {/* верх чуть темнее — белый логотип и кнопка «назад» читаются на любой обложке */}
        <LinearGradient colors={dim.colors as any} locations={dim.locations as any} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: top + 40 }} />
        <LinearGradient colors={over.colors as any} locations={over.locations as any} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: W * 0.62 }} />
      </View>
      {/* под кнопками — тот же цвет, ниже он плавно уходит в фон. Одним градиентом: отдельная заливка цветом
          на части телефонов рисовалась чёрной полосой */}
      <LinearGradient colors={[`rgba(${tint},1)`, ...out.colors] as any} locations={[0, ...out.locations.map((x) => (solidH + x * FADE) / (solidH + FADE))] as any} style={{ height: solidH + FADE }} />
    </View>
  );
}

// Аватар артиста поверх шапки: прокручивается вместе со страницей и у верха растворяется в «острове».
// (Сам аватар в странице — пустое место того же размера, а рисуется он здесь, чтобы проходить над шапкой.)
type FlyInfo = { name?: string; src?: string; letter?: string; ring?: string; ring2?: string; ring3?: string; badge?: boolean; fallback?: string; size: number; yc: number };
function ArtistFly({ f }: { f: FlyInfo }) {
  const T = useT(); const H = useContext(HeroCtx); const { width: W } = useWin(); const padT = useTopPad();
  const [u, setU] = useState('');
  useEffect(() => { setU(''); if (f.src || !f.name) return; let ok = true; api.artistPhoto(f.name).then((x) => ok && setU(x)); return () => { ok = false; }; }, [f.name, f.src]);
  const src = f.src || u || f.fallback;
  const inset = f.ring ? 6 : 0, ci = f.size - inset * 2;
  const D = Math.max(40, f.yc - island(padT).y);
  useEffect(() => { H.flyD.value = D; return () => { H.flyD.value = 0; }; }, [D]);
  const p = useDerivedValue(() => H.sy.value / D);
  const move = useDerivedValue(() => -Math.min(H.sy.value, D));
  const st = useIslandStyle(p, f.size, move);
  const r = f.size / 2;
  return (
    <Animated.View pointerEvents="none" entering={FadeIn.duration(450).easing(EASE_OUT)} style={{ position: 'absolute', zIndex: 6, left: W / 2 - r, top: f.yc - r, width: f.size, height: f.size }}>
    <Animated.View renderToHardwareTextureAndroid style={[{ width: f.size, height: f.size }, st.body]}>
      <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: r, backgroundColor: f.ring ? 'transparent' : T.ph, shadowColor: f.ring || '#000', shadowOpacity: f.ring ? 0.35 : T.dark || H.onDark ? 0.5 : 0.28, shadowRadius: f.ring ? 24 : 30, shadowOffset: { width: 0, height: f.ring ? 12 : 22 } }, st.lift]} />
      {!!f.ring && <Ring size={f.size} w={3} c1={f.ring} c2={f.ring2} c3={f.ring3} />}
      <View style={{ position: 'absolute', left: inset, top: inset, width: ci, height: ci, borderRadius: ci / 2, overflow: 'hidden', backgroundColor: src ? T.ph : T.glass, alignItems: 'center', justifyContent: 'center' }}>
        {src ? <Image source={{ uri: src }} style={StyleSheet.absoluteFill} /> : <Text style={{ fontFamily: SF, fontSize: ci * 0.4, fontWeight: '600', color: T.ink3 }}>{f.letter || '?'}</Text>}
        {!!src && !ANDROID_FLY && <Animated.Image source={{ uri: src }} blurRadius={24} style={[StyleSheet.absoluteFill, st.blur]} />}
        {!ANDROID_FLY && <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, st.dark]} />}
      </View>
      {!!f.badge && (
        <Animated.View style={[{ position: 'absolute', right: 8, bottom: 8, width: 38, height: 38, borderRadius: 19, backgroundColor: f.ring || T.accent, borderWidth: 3, borderColor: T.bgBase, alignItems: 'center', justifyContent: 'center' }, st.lift]}>
          <Ionicons name="camera" size={17} color="#fff" />
        </Animated.View>
      )}
    </Animated.View>
    </Animated.View>
  );
}

// Прозрачная шапка: сверху цвет фона уходит прямо под логотип. При прокрутке плавно появляется размытая панель.
function HeroTop({ onBack }: any) {
  const T = useT(); const padT = useTopPad(); const H = useContext(HeroCtx); const [solid, setSolid] = useState(false);
  useAnimatedReaction(() => H.sy.value > (H.heroEnd.value || 260) - 150, (v, p) => { if (v !== p) runOnJS(setSolid)(v); }, []);
  // Шапка полностью прозрачная: никаких полос, заливок и размытия. Содержимое под ней само плавно тает (FadeTop),
  // а цветной верх лежит отдельным слоем позади и не тает — поэтому всё перетекает в фон без «белого света» и без швов.
  // Логотип — без подложки: белый поверх тёмного фото и обычный, когда фото уехало.
  const edge = useAnimatedStyle(() => ({ opacity: interpolate(H.sy.value, [10, 90], [0, 1], 'clamp') }));
  const logoSt = useAnimatedStyle(() => { const d = H.flyD.value; if (!d) return { opacity: 1 }; return { opacity: interpolate(H.sy.value / d, [0.4, 0.6, 1.05, 1.3], [1, 0, 0, 1], 'clamp') }; });
  // пока под логотипом тёмная часть фото — он белый; когда она уехала вверх — обычный
  const passed = useDerivedValue(() => { const e = H.heroEnd.value || 260; return interpolate(H.sy.value, [e - 170, e - 70], [0, 1], 'clamp'); });
  const whiteSt = useAnimatedStyle(() => ({ opacity: H.od.value * (1 - passed.value) }));
  const inkSt = useAnimatedStyle(() => ({ opacity: 1 - H.od.value * (1 - passed.value) }));
  const abs = StyleSheet.absoluteFill;
  const fade = smooth(T.dark ? '0,0,0' : '255,255,255', 0.9, 0, 0, 1, 12);
  return (
    <>
      <StatusBar barStyle={T.dark || (H.onDark && !solid) ? 'light-content' : 'dark-content'} />
      {/* без masked-view — запасной вариант: мягкое растворение в цвет фона */}
      {!MaskedView && <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, height: padT + 56 + 40, zIndex: 2 }, edge]}><LinearGradient colors={fade.colors as any} locations={fade.locations as any} style={abs} /></Animated.View>}
      <View pointerEvents="box-none" style={{ position: 'absolute', top: padT, left: 0, right: 0, zIndex: 4, height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 }}>
        <IconBtn icon="chevron-left" size={44} onPress={onBack} />
        <Animated.View style={logoSt}>
          <Animated.View style={inkSt}><Logo /></Animated.View>
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, whiteSt]}><Logo color="#ffffff" /></Animated.View>
        </Animated.View>
        <View style={{ width: 44 }} />
      </View>
    </>
  );
}

// Средняя яркость фото → тёмный верх или светлый. Правило:
//  светлая тема: фото темнее ~45% → насыщенный тёмный верх и белый текст; иначе светлый верх и тёмный текст;
//  тёмная тема: верх всегда тёмный, текст белый.
function useHeroTone(photo?: string) {
  const T = useT(); const H = useContext(HeroCtx);
  const [tone, setTone] = useState<number | null | undefined>(undefined);   // undefined — ещё считаем
  useEffect(() => {
    let ok = true; setTone(undefined); if (!photo || T.dark) return;
    const d = setTimeout(() => api.imageTone(photo).then((v) => ok && setTone(v)), 460);
    const t = setTimeout(() => ok && setTone((x) => (x === undefined ? null : x)), 1700);
    return () => { ok = false; clearTimeout(d); clearTimeout(t); };
  }, [photo, T.dark]);
  const onDark = T.dark ? true : tone != null && tone < 0.45;
  useEffect(() => { H?.setOnDark(onDark); }, [onDark]);
  return { ready: tone !== undefined || T.dark, onDark };
}

// Цветной верх: крошечная копия фото, сильно размытая (остаются только цвета). Прокручивается вместе со страницей,
// уходит под прозрачную шапку и плавно (S-кривая) растворяется в фон прямо под кнопками — фон экрана однотонный, поэтому швов нет.
const tinyImg = (u: string) => u.replace(/\d+x\d+(bb)?(-\d+)?(?=\.\w+$)/, '100x100bb').replace(/\/\d+x\d+-/, '/120x120-');
function Hero({ u, end, onDark, reg = true }: { u?: string; end: number; onDark: boolean; reg?: boolean }) {
  const T = useT(); const top = useTopPad() + 56; const H = useContext(HeroCtx);
  // на странице Hero лишь сообщает, какой у неё цветной верх; рисуется он слоем позади прокрутки (HeroLayerBg)
  useEffect(() => { if (reg && H?.setBack) H.setBack(u && end ? { u, end, onDark } : null); }, [u, end, onDark]);
  useEffect(() => () => { if (reg && H?.setBack) H.setBack(null); }, []);
  if (!u || !end) return null;
  if (reg && H?.setBack) return null;
  const bg = T.dark ? '0,0,0' : '255,255,255';
  const ext = top + 420;                      // запас вверх: под шапку и на «оттяжку» при прокрутке вниз
  const Ht = ext + end;
  const g = smooth(bg, 0, 1, (Ht - 130) / Ht, 1, 14);
  const op = T.dark ? 0.6 : onDark ? 0.88 : 0.55;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: -ext, left: 0, right: 0, height: Ht, overflow: 'hidden' }}>
      {/* прозрачность задаём на картинке, а анимацию появления — на обёртке (иначе анимация сбрасывала прозрачность до 100%) */}
      <Animated.View entering={FadeIn.duration(600).easing(EASE_OUT)} style={StyleSheet.absoluteFill}>
        <Image source={{ uri: tinyImg(u) }} blurRadius={16} resizeMode="cover" style={[StyleSheet.absoluteFill, { opacity: op, transform: [{ scale: 1.6 }] }]} />
        {onDark && <View style={[StyleSheet.absoluteFill, { backgroundColor: T.dark ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.2)' }]} />}
      </Animated.View>
      <LinearGradient colors={g.colors as any} locations={g.locations as any} style={StyleSheet.absoluteFill} />
    </View>
  );
}

function useHeroScroll() {
  const H = useContext(HeroCtx); const own = useSharedValue(0); const sy = H?.sy || own;
  return useAnimatedScrollHandler((e) => { sy.value = e.contentOffset.y; });
}

function Album({ id, open }: any) {
  const T = useT(); const ty = useTy(); const P = usePlayer(); const r = useAsync(() => api.album(id), [id]); const settled = useSettled();
  const onScroll = useHeroScroll(); const [end, setEnd] = useState(0); const H = useContext(HeroCtx);
  const { width: W } = useWin(); const top = useTopPad() + 56;
  const cover = r.v?.info?.artworkUrl100 as string | undefined;
  // цвет из обложки обычно готов за доли секунды; не пришёл за 1,2 с — нейтральный тёмный (белый текст не окажется на белом)
  const [tint0, setTint0] = useState(''); useEffect(() => { if (!cover) return; let ok = true; api.coverTintVivid(cover).then((x) => ok && x && setTint0(x)); return () => { ok = false; }; }, [cover]);
  const [fb, setFb] = useState(false);
  useEffect(() => { const tm = setTimeout(() => setFb(true), 1200); return () => clearTimeout(tm); }, []);
  const tint = tint0 || (fb || (r.v && !cover) ? '40,40,48' : '');
  // цвет из обложки тёмный (×0,42), поэтому текст и логотип на нём — белые в обеих темах
  useEffect(() => { H?.setOnDark(true); }, []);
  useEffect(() => { if (!H?.setBack) return; H.setBack(cover && tint && end ? { u: cover, end, onDark: true, tint } : null); }, [cover, tint, end]);
  useEffect(() => () => H?.setBack?.(null), []);
  if (r.err) return <ScrollView screen><Hint center>Не удалось загрузить альбом</Hint></ScrollView>;
  if (!r.v || !tint) return <Spin />;
  const a = r.v.info; const list: Track[] = r.v.tracks;
  const shuffle = () => list.length && P.go(shuffled(list), 0, 'album:' + id);
  const meta = [a.kind ? api.KIND_LABEL[a.kind as api.Kind] : '', api.genreRu(a.primaryGenreName), (a.releaseDate || '').slice(0, 4), listMeta(list)].filter(Boolean).join(' · ');
  return (
    <ScrollView screen anim onScroll={onScroll}>
      <Animated.View entering={FadeIn.duration(420).easing(EASE_OUT)}>
        {/* место под обложку: название ложится на её нижнюю часть, где она уже перетекла в цвет */}
        <View style={{ height: Math.max(120, W - top - 112) }} />
        <View style={{ paddingHorizontal: 20 }}>
          <Text numberOfLines={2} style={[ty.title1, { color: '#fff', fontWeight: '800', letterSpacing: -0.5 }]}>{a.collectionName}</Text>
          <Text onPress={() => open({ k: 'artist', id: a.artistId, name: a.artistName })} numberOfLines={1} style={[ty.headline, { color: 'rgba(255,255,255,0.86)', marginTop: 4 }]}>{a.artistName}</Text>
          <Text numberOfLines={1} style={[ty.footnote, { color: 'rgba(255,255,255,0.62)', marginTop: 4 }]}>{meta}</Text>
        </View>
        {/* кнопки как на ПК: «Перемешать» кругом 52, «Слушать» — белая капсула */}
        <View onLayout={(e) => setEnd(e.nativeEvent.layout.y + e.nativeEvent.layout.height + 26)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginTop: 18 }}>
          <Press hap="light" onPress={shuffle} style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}><PcIcon n="shuffle" s={20} c="#fff" /></Press>
          <Press hap="medium" onPress={() => list.length && P.go(list, 0, 'album:' + id)} style={{ flex: 1, height: 52, borderRadius: 26, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <PcIcon n="play" s={18} c="#111114" /><Text style={[ty.headline, { color: '#111114' }]}>Слушать</Text>
          </Press>
        </View>
        <View style={{ height: 26 }} />
      </Animated.View>
      {/* в альбоме обложка у всех треков одна — показываем номер, название и артиста */}
      {settled ? <Rows list={list} open={open} noCover num from={'album:' + id} /> : <View style={{ height: list.length * 44 }} />}
      {settled && <StoryCard kind="album" artist={a.artistName} name={a.collectionName} />}
    </ScrollView>
  );
}

// ---------- «Об исполнителе» — внизу карточки артиста (вариант C) ----------
// Фото артиста на всю карточку; там, где начинается текст, фото плавно (по S-кривой) перетекает в цвет фона темы:
// в светлой — в белый с тёмным текстом, в тёмной — в чёрный с белым. Сверху на фото — звезда логотипа и «Об исполнителе».
// Фото — Deezer (официальное фото артиста; если его нет — обложка из каталога), текст, слушатели и жанры — Last.fm.
function AboutArtist({ name, photo, fallback, genre, first, fans }: { name: string; photo?: string; fallback?: string; genre?: string; first?: string; fans: number }) {
  const T: any = useT(); const ty = useTy(); const { width: W } = useWin();
  const [ab, setAb] = useState<api.About | null>(null); const [more, setMore] = useState(false);
  useEffect(() => { let ok = true; setAb(null); api.artistAbout(name).then((x) => ok && setAb(x)); return () => { ok = false; }; }, [name]);
  const src = photo || (fallback ? api.hiArt(fallback) : '');
  if (!src && !ab?.bio) return null;
  const cw = W - 32;
  const ph = Math.round(cw * 1.09);          // высота фото
  const textTop = Math.round(cw * 0.82);      // откуда начинается текст — к этому месту фото уже полностью ушло в фон
  const rgb = T.dark ? '0,0,0' : '255,255,255';
  const fade = smooth(rgb, 0, 1, 0, 1, 12);
  const ink = T.ink, ink3 = T.dark ? 'rgba(245,245,247,0.72)' : T.ink3;
  const line = ab && (ab.listeners || ab.plays)
    ? [ab.listeners ? `${fmtNum(ab.listeners)} слушателей` : '', ab.plays ? `${fmtNum(ab.plays)} прослушиваний` : ''].filter(Boolean).join(' · ')
    : [fans ? `${fmtNum(fans)} поклонников` : '', first ? `первый релиз — ${first.slice(0, 4)}` : ''].filter(Boolean).join(' · ');
  const tags = ab?.tags?.length ? ab.tags : genre ? [api.genreRu(genre).toLowerCase()] : [];
  const long = !!ab?.bio && (ab.bio.length > 170 || ab.bio.includes('\n'));
  const credit = [ab ? (ab.tr ? 'Текст и слушатели — Last.fm, перевод автоматический' : 'Текст и слушатели — Last.fm') : '', photo ? 'Фото — Deezer' : 'Фото — Apple Music'].filter(Boolean).join(' · ');
  const starW = 38;   // звезда логотипа высотой ~24 pt
  return (
    <Animated.View entering={FadeIn.duration(500).easing(EASE_OUT)} layout={LinearTransition.duration(280)}
      style={{ marginHorizontal: 16, marginTop: 28, borderRadius: 22, backgroundColor: T.bgBase, shadowColor: '#000', shadowOpacity: T.dark ? 0.4 : 0.14, shadowRadius: 24, shadowOffset: { width: 0, height: 12 } }}>
      <View style={{ borderRadius: 22, overflow: 'hidden', backgroundColor: T.bgBase, borderWidth: T.dark ? 1 : 0, borderColor: 'rgba(255,255,255,0.08)' }}>
        {/* фото и переход в фон */}
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: ph }}>
          <Pic uri={src} style={StyleSheet.absoluteFill} />
          <LinearGradient colors={['rgba(0,0,0,0.38)', 'rgba(0,0,0,0)']} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: Math.round(ph * 0.22) }} />
          <LinearGradient colors={fade.colors as any} locations={fade.locations as any} style={{ position: 'absolute', left: 0, right: 0, top: textTop - Math.round(cw * 0.42), height: Math.round(cw * 0.42) }} />
          <View style={{ position: 'absolute', left: 0, right: 0, top: textTop, bottom: 0, backgroundColor: T.bgBase }} />
        </View>
        {/* звезда логотипа + «Об исполнителе» */}
        <View pointerEvents="none" style={{ position: 'absolute', left: 14, top: 12, flexDirection: 'row', alignItems: 'center' }}>
          <LStar w={starW} color="#ffffff" style={{ margin: -starW * LSTAR_PAD }} />
          <Text style={{ fontFamily: SF, fontSize: 16, fontWeight: '700', letterSpacing: -0.2, color: '#fff', marginLeft: 5 }}>Об исполнителе</Text>
        </View>
        {/* текст */}
        <View style={{ marginTop: textTop, paddingHorizontal: 16, paddingBottom: 16 }}>
          <Text numberOfLines={2} style={{ fontFamily: SF, fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.5, color: ink }}>{name}</Text>
          {!!line && <Text numberOfLines={1} style={{ fontFamily: SF, fontSize: 13, lineHeight: 18, fontWeight: '600', color: ink3, marginTop: 2 }}>{line}</Text>}
          {!!ab?.bio && (
            <Pressable onPress={() => long && setMore((x) => !x)} disabled={!long}>
              <Text numberOfLines={more ? undefined : 3} style={{ fontFamily: SF, fontSize: 15, lineHeight: 21, color: ink3, marginTop: 10 }}>{ab.bio}</Text>
              {long && <Text style={{ fontFamily: SF, fontSize: 15, lineHeight: 21, fontWeight: '600', color: T.accentText, marginTop: 2 }}>{more ? 'свернуть' : 'ещё'}</Text>}
            </Pressable>
          )}
          {tags.length > 0 && (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {tags.map((t) => <View key={t} style={{ height: 28, paddingHorizontal: 12, borderRadius: 14, justifyContent: 'center', backgroundColor: T.glass, borderWidth: 1, borderColor: T.stroke }}><Text style={{ fontFamily: SF, fontSize: 13, fontWeight: '600', color: ink }}>{t}</Text></View>)}
            </View>
          )}
          <Text onPress={ab?.url ? () => Linking.openURL(ab.url).catch(() => {}) : undefined} style={{ fontFamily: SF, fontSize: 11, lineHeight: 14, fontWeight: '500', color: ink3, marginTop: 12 }}>{credit}</Text>
        </View>
      </View>
    </Animated.View>
  );
}

// ---------- История альбома / трека ----------
// Текст из Last.fm (как записывали, что вдохновило, как приняли). Есть не у всех — тогда блока просто нет.
function useStory(kind: 'album' | 'track', artist?: string, name?: string) {
  const [st, setSt] = useState<api.Story | null | undefined>(undefined);
  // история никогда не «висит»: ошибка сети — «истории нет»; ответа нет 12 с — тоже (а не вечная крутилка)
  useEffect(() => {
    let ok = true; setSt(undefined);
    const lim = setTimeout(() => ok && setSt((x) => (x === undefined ? null : x)), 12000);
    (kind === 'album' ? api.albumStory : api.trackStory)(artist, name).then((x) => ok && setSt(x || null)).catch(() => ok && setSt(null)).finally(() => clearTimeout(lim));
    return () => { ok = false; clearTimeout(lim); };
  }, [kind, artist, name]);
  return st;
}
function StoryText({ st, lines = 6, dark }: { st: api.Story; lines?: number; dark?: boolean }) {
  const T: any = useT(); const [more, setMore] = useState(false);
  const long = st.text.length > 320 || st.text.includes('\n');
  const ink2 = dark ? 'rgba(255,255,255,0.86)' : T.ink2, ink3 = dark ? 'rgba(255,255,255,0.6)' : T.ink3;
  return (
    <Animated.View layout={LinearTransition.duration(280)}>
      <Pressable onPress={() => long && setMore((x) => !x)} disabled={!long}>
        <Text numberOfLines={more ? undefined : lines} style={{ fontFamily: SF, fontSize: 15, lineHeight: 22, color: ink2 }}>{st.text}</Text>
        {long && <Text style={{ fontFamily: SF, fontSize: 15, lineHeight: 22, fontWeight: '600', color: dark ? T.accentMedia : T.accentText, marginTop: 2 }}>{more ? 'свернуть' : 'ещё'}</Text>}
      </Pressable>
      <Text onPress={st.url ? () => Linking.openURL(st.url).catch(() => {}) : undefined} style={{ fontFamily: SF, fontSize: 11, lineHeight: 14, fontWeight: '500', color: ink3, marginTop: 12 }}>{st.tr ? 'Текст — Last.fm, перевод автоматический' : 'Текст — Last.fm'}</Text>
    </Animated.View>
  );
}
function StoryCard({ kind, artist, name }: { kind: 'album' | 'track'; artist?: string; name?: string }) {
  const st = useStory(kind, artist, name);
  if (!st?.text) return null;
  return (
    <Animated.View entering={rise(0)}>
      <Sec>{kind === 'album' ? 'История альбома' : 'История трека'}</Sec>
      <Glass radius={22} style={{ marginHorizontal: 16, padding: 16 }}><StoryText st={st} /></Glass>
    </Animated.View>
  );
}
// Шторка «История трека» в большом плеере. Нет истории у трека — показываем историю его альбома (с пометкой).
function StorySheet({ t, onClose }: { t: Track; onClose: () => void }) {
  const T: any = useT(); const ty = useTy(); const ins = useSafeAreaInsets(); const { height: H } = useWin();
  const tr = useStory('track', t.artist, t.title); const al = useStory('album', t.artist, tr && !tr.text ? t.album : undefined);
  const st = tr?.text ? tr : al?.text ? al : null; const loading = tr === undefined || (!tr?.text && !!t.album && al === undefined);
  const y = useSharedValue(1);
  useEffect(() => { y.value = withTiming(0, { duration: 460, easing: SHEET }); }, []);
  const close = () => { y.value = withTiming(1, { duration: 340, easing: SHEET }, (f) => { if (f) runOnJS(onClose)(); }); };
  const sheet = useAnimatedStyle(() => ({ transform: [{ translateY: y.value * (H * 0.8) }] }));
  const dim = useAnimatedStyle(() => ({ opacity: 1 - y.value }));
  const pan = Gesture.Pan().activeOffsetY(10).failOffsetX([-25, 25])
    .onUpdate((e) => { y.value = Math.max(0, e.translationY / (H * 0.8)); })
    .onEnd((e) => { if (e.translationY > 110 || e.velocityY > 800) runOnJS(close)(); else y.value = withTiming(0, { duration: 300, easing: SHEET }); });
  const abs = StyleSheet.absoluteFill;
  return (
    <View style={[abs, { zIndex: 90 }]}>
      <Animated.View style={[abs, dim]}><Pressable onPress={close} style={[abs, { backgroundColor: 'rgba(0,0,0,0.5)' }]} /></Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[{ position: 'absolute', left: 8, right: 8, bottom: ins.bottom + 8, maxHeight: H * 0.72, borderRadius: 40, backgroundColor: T.sheet, borderWidth: 1, borderColor: T.stroke, padding: 16, paddingTop: 10, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 30, shadowOffset: { width: 0, height: 12 } }, sheet]}>
          <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: T.line, marginBottom: 14 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: T.line }}>
            <Cover u={api.smallArt(t.cover)} size={44} r={12} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={ty.headline}>{t.title}</Text>
              <Text numberOfLines={1} style={ty.subhead}>{t.artist}</Text>
            </View>
          </View>
          <Text style={[ty.title2, { marginTop: 14, marginBottom: 8 }]}>{st === al && al?.text ? `Из истории альбома «${t.album}»` : 'История трека'}</Text>
          <RNScroll style={{ flexGrow: 0 }} showsVerticalScrollIndicator={false}>
            {loading ? <ActivityIndicator style={{ marginVertical: 24 }} /> : st ? <StoryText st={st} lines={12} /> : <Text style={[ty.subhead, { marginVertical: 8 }]}>Об этом треке пока нет истории — Last.fm пишет её не для всех треков и альбомов.</Text>}
          </RNScroll>
          <Press onPress={close} style={{ marginTop: 14, height: 52, borderRadius: 26, backgroundColor: T.primary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={[ty.headline, { color: T.onPrimary }]}>Готово</Text>
          </Press>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

// ---------- Статистика (вариант «Плитки») ----------
// Неделя / месяц / всё время. Всё считается из записей по дням (player.tsx: s.days) — один раз при открытии
// и при смене периода, без постоянных пересчётов. Анимации: плитки всплывают по очереди, линия рисуется,
// столбики часов вырастают, кольцо жанра заполняется — всё в потоке анимаций.
type Per = 'w' | 'm' | 'a';
const PER_N: Record<Per, number> = { w: 7, m: 30, a: 30 };
const PER_WORD: Record<Per, [string, string]> = { w: ['недели', 'прошлой недели'], m: ['месяца', 'прошлого месяца'], a: ['за всё время', ''] };
function computeStats(s: any, per: Per) {
  const days: Record<string, DayStat> = s.days || {};
  const n = PER_N[per]; const today = Date.now();
  const keys = (from: number, cnt: number) => Array.from({ length: cnt }, (_, i) => dayKey(new Date(today - (from + cnt - 1 - i) * 864e5)));
  const cur = keys(0, n), prev = keys(n, n);
  const sum = (ks: string[]) => ks.reduce((t, k) => t + (days[k]?.s || 0), 0);
  const pool = per === 'a' ? Object.values(days) : cur.map((k) => days[k]).filter(Boolean) as DayStat[];
  const merge = (f: 'a' | 'g' | 't') => { const o: Record<string, number> = {}; for (const d of pool) for (const [k, v] of Object.entries(d[f] || {})) o[k] = (o[k] || 0) + v; return o; };
  const sec = per === 'a' ? (s.sec || 0) : sum(cur);
  const prevSec = per === 'a' ? 0 : sum(prev);
  const series = cur.map((k) => days[k]?.s || 0);
  const tracks = per === 'a' ? Object.keys(s.tracks || {}).length : Object.keys(merge('t')).length;
  const artists = per === 'a' ? Object.fromEntries(Object.entries<any>(s.artists || {}).map(([k, v]) => [k, v.s || 0])) : merge('a');
  const top = Object.entries(artists).sort((a, b) => b[1] - a[1])[0];
  const hours = new Array(24).fill(0); for (const d of pool) d.h?.forEach((v, i) => { hours[i] += v; });
  let genres = merge('g');
  if (per === 'a' && !Object.keys(genres).length) for (const e of Object.values<any>(s.tracks || {})) if (e.t?.genre) genres[e.t.genre] = (genres[e.t.genre] || 0) + (e.s || 0);
  const gTot = Object.values(genres).reduce((a, b) => a + b, 0);
  const g = Object.entries(genres).sort((a, b) => b[1] - a[1])[0];
  const peak = hours.indexOf(Math.max(...hours));
  return { sec, prevSec, series, tracks, top: top ? { name: top[0], sec: top[1], meta: (s.artists || {})[top[0]] } : null, hours, peak: Math.max(...hours) ? peak : -1, genre: g ? { name: api.genreRu(g[0]), share: gTot ? g[1] / gTot : 0 } : null };
}
const dayPart = (h: number) => (h < 0 ? '—' : h < 6 ? 'Ночью' : h < 12 ? 'Утром' : h < 18 ? 'Днём' : 'Вечером');
const SVP: any = SVGLIB; const AnimPath: any = SVP ? Animated.createAnimatedComponent(SVP.Path) : null; const AnimCircle: any = SVP ? Animated.createAnimatedComponent(SVP.Circle) : null;
// Линия времени по дням: за неделю — с «ударами пульса» на каждой точке, за месяц — плавная
function StatLine({ series, w, h, color }: { series: number[]; w: number; h: number; color: string }) {
  const p = useSharedValue(0);
  useEffect(() => { p.value = 0; p.value = withTiming(1, { duration: 1100, easing: EASE_OUT }); }, [series.join(',')]);
  const max = Math.max(60, ...series); const n = series.length;
  const pts = series.map((v, i) => [8 + (i * (w - 16)) / Math.max(1, n - 1), h - 8 - (v / max) * (h - 26)]);
  let d = `M0,${pts[0][1].toFixed(1)}`; let len = 0; let px = 0, py = pts[0][1];
  const L = (x: number, y: number) => { d += ` L${x.toFixed(1)},${y.toFixed(1)}`; len += Math.hypot(x - px, y - py); px = x; py = y; };
  pts.forEach(([x, y], i) => {
    if (n <= 7) { L(x - 9, y); L(x - 4, y - 10); L(x, y + 7); L(x + 4, y - 3); L(x + 9, y); } else L(x, y);
    if (i === n - 1) L(w, y);
  });
  const line = useAnimatedProps(() => ({ strokeDashoffset: len * (1 - p.value) }));
  const fill = useAnimatedProps(() => ({ opacity: p.value }));
  if (!SVP) return null;
  const S = SVP.default;
  return (
    <S width={w} height={h}>
      <SVP.Defs><SVP.LinearGradient id="stf" x1="0" y1="0" x2="0" y2="1"><SVP.Stop offset="0" stopColor={color} stopOpacity={0.28} /><SVP.Stop offset="1" stopColor={color} stopOpacity={0} /></SVP.LinearGradient></SVP.Defs>
      <AnimPath animatedProps={fill} d={`${d} L${w},${h} L0,${h} Z`} fill="url(#stf)" />
      <AnimPath animatedProps={line} d={d} stroke={color} strokeWidth={2.6} fill="none" strokeLinejoin="round" strokeLinecap="round" strokeDasharray={[len, len]} />
    </S>
  );
}
// столбик часа: вырастает снизу
const growUp = (delay: number) => () => { 'worklet'; return { initialValues: { opacity: 0, transform: [{ scaleY: 0.05 }] }, animations: { opacity: withDelay(delay, withTiming(1, { duration: 300 })), transform: [{ scaleY: withDelay(delay, withTiming(1, { duration: 520, easing: EASE_OUT })) }] } }; };
function Donut({ share, color, track }: { share: number; color: string; track: string }) {
  const r = 26, c = 2 * Math.PI * r; const p = useSharedValue(0);
  useEffect(() => { p.value = 0; p.value = withDelay(250, withTiming(share, { duration: 900, easing: EASE_OUT })); }, [share]);
  const ap = useAnimatedProps(() => ({ strokeDashoffset: c * (1 - p.value) }));
  if (!SVP) return null; const S = SVP.default;
  return (
    <S width={64} height={64}>
      <SVP.Circle cx={32} cy={32} r={r} stroke={track} strokeWidth={8} fill="none" />
      <AnimCircle animatedProps={ap} cx={32} cy={32} r={r} stroke={color} strokeWidth={8} fill="none" strokeLinecap="round" strokeDasharray={[c, c]} transform="rotate(-90 32 32)" />
    </S>
  );
}
function StatsScreen({ open }: any) {
  const P = usePlayer(); const T: any = useT(); const ty = useTy(); const { width: W } = useWin();
  const [per, setPer] = useState<Per>('w');
  const st = useMemo(() => computeStats(P.stats || {}, per), [per]);
  const [photo, setPhoto] = useState('');
  useEffect(() => { let ok = true; setPhoto(''); if (st.top) api.artistPhoto(st.top.name, true).then((u) => ok && setPhoto(u)); return () => { ok = false; }; }, [st.top?.name]);
  const gw = W - 32; const half = (gw - 12) / 2;
  const tile = { borderRadius: 22, backgroundColor: T.glass, borderWidth: 1, borderColor: T.stroke, overflow: 'hidden' as const };
  const lbl = [ty.footnote];
  const change = st.prevSec ? Math.round(((st.sec - st.prevSec) / st.prevSec) * 100) : null;
  const favs: Track[] = P.favs; const hmax = Math.max(1, ...st.hours);
  const top = st.top; const topImg = photo || (top?.meta?.cover ? api.smallArt(top.meta.cover) : '');
  const chips: [Per, string][] = [['w', 'Неделя'], ['m', 'Месяц'], ['a', 'Всё время']];
  return (
    <ScrollView screen>
      <Title>Статистика</Title>
      <View style={{ flexDirection: 'row', gap: 8, marginHorizontal: 16, marginTop: 14 }}>
        {chips.map(([k, lb]) => <Press key={k} onPress={() => setPer(k)} to={0.94} style={{ height: 36, paddingHorizontal: 16, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: per === k ? T.primary : T.glass, borderWidth: 1, borderColor: per === k ? 'transparent' : T.stroke }}>
          <Text style={[ty.miniTitle, { color: per === k ? T.onPrimary : T.ink }]}>{lb}</Text></Press>)}
      </View>
      <View key={per} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginHorizontal: 16, marginTop: 18 }}>
        {/* время + линия по дням */}
        <Animated.View entering={rise(0)} style={[tile, { width: gw, height: 170, padding: 16 }]}>
          <Text style={lbl}>Время в «Пульсе» · {PER_WORD[per][0]}</Text>
          <Text style={{ fontFamily: SF, fontSize: 40, lineHeight: 46, fontWeight: '700', letterSpacing: -1, color: T.ink, marginTop: 4 }}>{st.sec ? fmtTime(st.sec) : '0 мин'}</Text>
          {change != null && <Text style={[ty.footnote, { color: change >= 0 ? T.accentText : T.ink3, fontWeight: '600' }]}>{change >= 0 ? `▲ на ${change}% больше ${PER_WORD[per][1]}` : `▼ на ${-change}% меньше ${PER_WORD[per][1]}`}</Text>}
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}><StatLine series={st.series} w={gw} h={64} color={T.accent} /></View>
        </Animated.View>
        {/* треки и любимое */}
        <Animated.View entering={rise(60)} style={[tile, { width: half, height: 124, padding: 16 }]}>
          <Text style={lbl}>Треков</Text>
          <Text style={{ fontFamily: SF, fontSize: 34, lineHeight: 40, fontWeight: '700', color: T.ink, marginTop: 4 }}>{st.tracks}</Text>
          <Text style={[ty.footnote, { position: 'absolute', left: 16, bottom: 14 }]}>{per === 'a' ? 'всего разных' : 'разных за ' + (per === 'w' ? 'неделю' : 'месяц')}</Text>
        </Animated.View>
        <Animated.View entering={rise(100)} style={[tile, { width: half, height: 124, padding: 16 }]}>
          <Pressable onPress={() => open({ k: 'favs' })} style={{ flex: 1 }}>
            <Text style={lbl}>В любимом</Text>
            <Text style={{ fontFamily: SF, fontSize: 34, lineHeight: 40, fontWeight: '700', color: T.ink, marginTop: 4 }}>{favs.length}</Text>
            {!!favs[0] && <Text numberOfLines={1} style={[ty.footnote, { position: 'absolute', left: 0, right: 0, bottom: -2 }]}>последний — «{favs[0].title}»</Text>}
          </Pressable>
        </Animated.View>
        {/* артист периода: фото внутри плитки — отступ 8, скругление 22 − 8 = 14 */}
        {top && (
          <Animated.View entering={rise(140)} style={[tile, { width: gw, height: 112 }]}>
            <Pressable onPress={() => top.meta?.artistId && open({ k: 'artist', id: top.meta.artistId, name: top.name })} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', padding: 8, gap: 14 }}>
              <View style={{ width: 96, height: 96, borderRadius: 14, overflow: 'hidden', backgroundColor: T.ph }}>{!!topImg && <Image source={{ uri: topImg }} style={{ width: 96, height: 96 }} />}</View>
              <View style={{ flex: 1 }}>
                <Text style={lbl}>{per === 'w' ? 'Артист недели' : per === 'm' ? 'Артист месяца' : 'Главный артист'}</Text>
                <Text numberOfLines={1} style={[ty.headline, { marginTop: 4 }]}>{top.name}</Text>
                <Text style={[ty.footnote, { marginTop: 2 }]}>{fmtTime(top.sec)}</Text>
              </View>
              <Ionicons name="chevron-forward" size={17} color={T.muted} style={{ marginRight: 8 }} />
            </Pressable>
          </Animated.View>
        )}
        {/* когда слушаете */}
        <Animated.View entering={rise(180)} style={[tile, { width: half, height: 150, padding: 16 }]}>
          <Text style={lbl}>Когда слушаете</Text>
          <Text style={[ty.headline, { marginTop: 4 }]}>{dayPart(st.peak)}</Text>
          <View style={{ position: 'absolute', left: 16, right: 16, bottom: 14, height: 48, flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}>
            {st.hours.map((v, i) => (
              <Animated.View key={i} entering={growUp(220 + i * 18)} style={{ flex: 1, height: Math.max(3, (v / hmax) * 48), borderRadius: 2, backgroundColor: i === st.peak || (st.peak >= 0 && Math.abs(i - st.peak) <= 2 && v > hmax * 0.4) ? T.accent : T.dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)' }} />
            ))}
          </View>
        </Animated.View>
        {/* жанр */}
        <Animated.View entering={rise(220)} style={[tile, { width: half, height: 150, padding: 16 }]}>
          <Text style={lbl}>{per === 'a' ? 'Любимый жанр' : per === 'w' ? 'Жанр недели' : 'Жанр месяца'}</Text>
          <Text numberOfLines={1} style={[ty.headline, { marginTop: 4 }]}>{st.genre ? `${st.genre.name[0].toUpperCase()}${st.genre.name.slice(1)} · ${Math.round(st.genre.share * 100)}%` : '—'}</Text>
          {!!st.genre && <View style={{ position: 'absolute', right: 16, bottom: 14 }}><Donut share={st.genre.share} color={T.accent} track={T.dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'} /></View>}
        </Animated.View>
      </View>
      {!st.sec && <Text style={[ty.footnote, { marginHorizontal: 16, marginTop: 16, textAlign: 'center' }]}>Статистика по дням копится с этой версии — включите музыку, и графики начнут заполняться.</Text>}
    </ScrollView>
  );
}

const fmtNum = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',')} млн` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace('.', ',')} тыс` : String(n);

// жанры и страны Яндекса — по-русски, как на ПК
const YGENRES: Record<string, string> = { rap: 'Хип-хоп', hiphop: 'Хип-хоп', rusrap: 'Русский рэп', foreignrap: 'Хип-хоп', pop: 'Поп', ruspop: 'Русская поп-музыка', rock: 'Рок', rusrock: 'Русский рок', electronics: 'Электроника', dance: 'Танцевальная', house: 'Хаус', techno: 'Техно', indie: 'Инди', alternative: 'Альтернатива', metal: 'Метал', jazz: 'Джаз', classical: 'Классика', soundtrack: 'Саундтреки', rnb: 'R&B', soul: 'Соул', folk: 'Фолк', estrada: 'Эстрада', relax: 'Релакс', punk: 'Панк', reggae: 'Регги', phonk: 'Фонк', local_indie: 'Инди', posthardcore: 'Пост-хардкор', lounge: 'Лаунж' };
const YCOUNTRIES: Record<string, string> = { US: 'США', RU: 'Россия', GB: 'Великобритания', UA: 'Украина', BY: 'Беларусь', KZ: 'Казахстан', CA: 'Канада', DE: 'Германия', FR: 'Франция', SE: 'Швеция', AU: 'Австралия', KR: 'Южная Корея', JP: 'Япония', IT: 'Италия', ES: 'Испания', NL: 'Нидерланды', NO: 'Норвегия', BR: 'Бразилия', PR: 'Пуэрто-Рико', CO: 'Колумбия', JM: 'Ямайка', NZ: 'Новая Зеландия', IE: 'Ирландия', BE: 'Бельгия', PL: 'Польша' };
// плитка статистики: подпись, число, под ним — рост за месяц
function StatTile({ k, v, note, up, dk, i }: { k: string; v: string; note?: string; up?: boolean; dk: boolean; i: number }) {
  const T: any = useT(); const ty = useTy();
  return (
    <Animated.View entering={FadeIn.duration(520).delay(i * 70).easing(EASE_OUT)}>
      <GlassCard radius={22} tone={dk ? 'dark' : undefined} style={{ minWidth: 132, paddingVertical: 14, paddingHorizontal: 16 }}>
        <Text numberOfLines={1} style={[ty.footnote, { color: dk ? 'rgba(255,255,255,0.7)' : T.ink3 }]}>{k}</Text>
        <Text numberOfLines={1} style={[ty.title2, { fontSize: 22, marginTop: 2, color: dk ? '#fff' : T.ink }]}>{v}</Text>
        {!!note && <Text numberOfLines={1} style={[ty.caption, { marginTop: 2, fontWeight: '600', color: up ? '#34c77b' : dk ? 'rgba(255,255,255,0.6)' : T.ink3 }]}>{note}</Text>}
      </GlassCard>
    </Animated.View>
  );
}
function Artist({ id, name, open }: any) {
  const T = useT(); const ty = useTy(); const P = usePlayer(); const r = useAsync(() => api.artist(id), [id]); const settled = useSettled();
  const [all, setAll] = useState(false); const fol = useFollow(); const [dz, setDz] = useState<api.DZ | null>(null); const [end, setEnd] = useState(0);
  const onScroll = useHeroScroll(); const HC = useContext(HeroCtx); const avRef = useRef<View>(null);
  useEffect(() => () => HC?.setFly(null), []);
  // Deezer (фото, поклонники): запрос стартует сразу (а при нажатии на артиста — ещё раньше, см. open),
  // но результат применяется не раньше, чем доехал переход, — без перерисовки посреди анимации.
  // Статистика ждёт ответа (до 2,5 с) и показывается один раз уже полной — без «прыжка» карточек.
  const [fans, setFans] = useState<number | null>(null); const doneRef = useRef(false);
  useEffect(() => {
    let ok = true; const t0 = Date.now(); doneRef.current = false; setFans(null);
    const finish = (n: number) => { if (!ok || doneRef.current) return; doneRef.current = true; setFans(n); };
    api.artistDeezer(name).catch(() => null).then((d) => setTimeout(() => { if (!ok) return; setDz(d); finish(d?.fans || 0); }, Math.max(0, 460 - (Date.now() - t0))));
    const lim = setTimeout(() => finish(0), 2500);
    return () => { ok = false; clearTimeout(lim); };
  }, [name]);
  // фон шапки — из обложки топ-трека: она есть сразу (данные артиста в кэше) и не меняется потом на фото,
  // поэтому цвет не «перескакивает» и не пропадает, пока догружается фото
  const photo = r.v?.tracks?.[0]?.cover || dz?.photo;
  const tone = useHeroTone(photo); const dk = tone.onDark;
  // Мягкая загрузка: шапка (имя, жанр, статистика, кнопки) проявляется ОДНИМ движением вместе с цветом фона,
  // когда уже известно, светлый фон или тёмный, — текст не перекрашивается на глазах и ничего не «прыгает».
  const hv = useSharedValue(tone.ready ? 1 : 0);
  useEffect(() => { if (tone.ready) hv.value = withTiming(1, { duration: 520, easing: EASE_OUT }); }, [tone.ready]);
  const headSt = useAnimatedStyle(() => ({ opacity: hv.value }));
  const late = useRef(false); if (!r.v) late.current = true;   // данных не было сразу — страница проявится плавно
  if (r.err) return <ScrollView screen><Hint center>Не удалось загрузить артиста</Hint></ScrollView>;
  if (!r.v) return <Spin />;
  const nm = r.v.info?.artistName || name; const list: Track[] = r.v.tracks; const ts = all ? list : list.slice(0, 5);
  const al: any[] = r.v.albums;
  const A = al.filter((x) => x.kind === 'album'), E = al.filter((x) => x.kind === 'ep'), S = al.filter((x) => x.kind === 'single');
  const first = al.reduce((m: string, x: any) => (x.releaseDate && (!m || x.releaseDate < m) ? x.releaseDate : m), '');
  // только реальные цифры: поклонники — Deezer, релизы и год — каталог iTunes
  const stats: [string, string][] = [];
  if (fans) stats.push([fmtNum(fans), 'поклонников']);
  stats.push([String(A.length), A.length % 10 === 1 && A.length % 100 !== 11 ? 'альбом' : [2, 3, 4].includes(A.length % 10) && ![12, 13, 14].includes(A.length % 100) ? 'альбома' : 'альбомов']);
  stats.push([String(E.length + S.length), 'синглов и EP']);
  if (first) stats.push([first.slice(0, 4), 'первый релиз']);
  const shown = stats.slice(0, 3);
  const ES = [...E, ...S].sort((x: any, y: any) => String(y.releaseDate || '').localeCompare(String(x.releaseDate || '')));
  const sim: any[] = (r.v as any).similar || [];
  const inf: any = r.v.info || {}; const followed = fol.some((x) => x.id === id);
  const genre = ((inf.genres || []) as string[]).map((g) => YGENRES[g]).filter(Boolean)[0] || api.genreRu(inf.primaryGenreName);
  const country = ((inf.countries || []) as string[]).map((c) => YCOUNTRIES[c] || c)[0];
  const subline = [genre, country].filter(Boolean).join(' • ');
  // плитки — настоящие цифры Яндекс Музыки (как на ПК); без Яндекса — прежние (Deezer и каталог iTunes)
  const nTr = (inf.counts && inf.counts.tracks) || 0; const nAl = (inf.counts && inf.counts.directAlbums) || 0;
  const dl = inf.listenersDelta ? `${inf.listenersDelta > 0 ? '+' : '−'}${fmtNum(Math.abs(inf.listenersDelta))} за месяц` : '';
  const yt: { k: string; v: string; note?: string; up?: boolean }[] = [];
  if (inf.listeners > 0) yt.push({ k: 'Слушатели в месяц', v: fmtNum(inf.listeners), note: dl, up: inf.listenersDelta > 0 });
  if (inf.likes > 0) yt.push({ k: 'Лайки', v: fmtNum(inf.likes) });
  if (yt.length) { if (nTr > 0) yt.push({ k: 'Треки', v: nTr.toLocaleString('ru-RU') }); if (nAl > 0) yt.push({ k: 'Альбомы', v: String(nAl) }); if (inf.firstYear > 0) yt.push({ k: 'Первый релиз', v: String(inf.firstYear) }); }
  return (
    <ScrollView screen anim onScroll={onScroll}>
      <Animated.View entering={late.current ? FadeIn.duration(460).easing(EASE_OUT) : undefined}>
        <Hero u={tone.ready ? photo : undefined} end={end} onDark={dk} />
        <View style={{ alignItems: 'center', marginTop: 8, paddingHorizontal: 16 }}>
          {/* сам аватар рисуется поверх шапки (ArtistFly) — при прокрутке он уходит в «остров» */}
          <View ref={avRef} collapsable={false} style={{ width: 176, height: 176 }}
            onLayout={() => HC?.at(avRef, (yc: number) => HC?.setFly({ name: nm, fallback: list[0]?.cover, size: 176, yc }))} />
          <Animated.View style={[{ alignItems: 'center' }, headSt]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 16 }}>
            <Text numberOfLines={2} style={[ty.largeTitle, { textAlign: 'center', flexShrink: 1, color: dk ? '#fff' : T.ink }]}>{nm}</Text>
            <Verified s={26} c={T.accent} />
          </View>
          {!!subline && <Text style={[ty.footnote, { marginTop: 4, color: dk ? 'rgba(255,255,255,0.7)' : T.ink3 }]}>{subline}</Text>}
          </Animated.View>
        </View>
        {/* конец цветной шапки — низ этого блока (кнопок): меряем его, а не кнопки, — они теперь внутри обёртки */}
        <Animated.View style={headSt} onLayout={(e) => setEnd(e.nativeEvent.layout.y + e.nativeEvent.layout.height + 26)}>
        {yt.length > 0 ? (
          <RNScroll horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 18 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
            {yt.map((x, i) => <StatTile key={x.k} {...x} dk={dk} i={i} />)}
          </RNScroll>
        ) : <View style={{ flexDirection: 'row', gap: 10, marginHorizontal: 16, marginTop: 18 }}>
          {fans == null ? [0, 1, 2].map((i) => (
            // заглушки того же размера тихо «дышат», пока ждём цифры; потом плавно растворяются,
            // а настоящие карточки так же плавно проявляются на их месте (перекрёстно, без сдвигов)
            <Animated.View key={'sk' + i} exiting={FadeOut.duration(320).easing(EASE_IO)} style={{ flex: 1 }}><Breathe delay={i * 140}>
              <GlassCard radius={22} tone={dk ? 'dark' : undefined} style={{ paddingVertical: 14, paddingHorizontal: 12 }}>
                <View style={{ height: 28, justifyContent: 'center' }}><View style={{ width: '55%', height: 16, borderRadius: 8, backgroundColor: dk ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)' }} /></View>
                <View style={{ height: 18, marginTop: 2, justifyContent: 'center' }}><View style={{ width: '80%', height: 10, borderRadius: 5, backgroundColor: dk ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)' }} /></View>
              </GlassCard>
            </Breathe></Animated.View>
          )) : shown.map(([v, l], i) => (
            <Animated.View key={l} entering={FadeIn.duration(520).delay(i * 70).easing(EASE_OUT)} style={{ flex: 1 }}>
              <GlassCard radius={22} tone={dk ? 'dark' : undefined} style={{ paddingVertical: 14, paddingHorizontal: 12 }}>
                <Text numberOfLines={1} adjustsFontSizeToFit={Platform.OS === 'ios'} style={[ty.title2, { fontSize: 21, color: dk ? '#fff' : T.ink }]}>{v}</Text>
                <Text numberOfLines={1} style={[ty.footnote, { marginTop: 2, color: dk ? 'rgba(255,255,255,0.7)' : T.ink3 }]}>{l}</Text>
              </GlassCard>
            </Animated.View>
          ))}
        </View>}
        {/* три кнопки, как на ПК: «Слушать», «В избранное», перемешать кругом 52 */}
        <View style={{ flexDirection: 'row', gap: 10, marginHorizontal: 16, marginTop: 16 }}>
          <Btn label="Слушать" icon="play" onPress={() => list.length && P.go(list, 0, 'artist:' + id)} />
          <Btn label={followed ? 'В избранном' : 'В избранное'} icon={followed ? 'heart' : 'heartO'} kind="secondary" inv={dk && !T.dark} onPress={() => { hap('select'); toggleFollow({ id, name: nm, photo: dz?.photo || r.v.info?.photoS || r.v.info?.photo }); }} />
          <Press hap="light" onPress={() => list.length && P.go(shuffled(list), 0, 'artist:' + id)} style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: dk && !T.dark ? 'rgba(255,255,255,0.92)' : T.glass, borderWidth: 1, borderColor: dk && !T.dark ? 'transparent' : T.stroke, alignItems: 'center', justifyContent: 'center' }}>
            <PcIcon n="shuffle" s={20} c={dk && !T.dark ? '#1d1d22' : T.ink} />
          </Press>
        </View>
        </Animated.View>
        <View style={{ height: 8 }} />
      </Animated.View>
      <Sec right={list.length > 5 ? <Pressable hitSlop={10} onPress={() => setAll(!all)}><Text style={[ty.subhead, { color: T.accentText, fontWeight: '600' }]}>{all ? 'Свернуть' : 'Показать все'}</Text></Pressable> : undefined}>Популярные треки</Sec>
      {settled ? <Rows list={ts} queue={list} from={'artist:' + id} open={open} noFav selfId={id} num /> : <Animated.View exiting={FadeOut.duration(300).easing(EASE_IO)}><RowSkel n={ts.length} /></Animated.View>}
      {settled && A.length > 0 && <AlbumStrip title="Альбомы" albums={A} open={open} sub="year" />}
      {settled && ES.length > 0 && <AlbumStrip title="Синглы и EP" albums={ES} open={open} sub="year" />}
      {settled && <AboutArtist name={nm} photo={dz?.photo} fallback={list[0]?.cover} genre={r.v.info?.primaryGenreName} first={first} fans={dz?.fans || 0} />}
      {settled && canQuiz(r.v) && <QuizCard id={id} name={nm} onStart={() => open({ k: 'quiz', id, name: nm })} />}
      {settled && sim.length > 0 && <>
        <Sec>Похожие исполнители</Sec>
        <HScroll>{sim.map((x: any) => (
          <Press key={x.artistId} onPress={() => open({ k: 'artist', id: x.artistId, name: x.artistName })} style={{ width: 104, alignItems: 'center' }}>
            <ArtistDot name={x.artistName} id={x.artistId} size={104} />
            <Text numberOfLines={1} style={[ty.miniTitle, { marginTop: 8, textAlign: 'center' }]}>{x.artistName}</Text>
          </Press>
        ))}</HScroll>
      </>}
    </ScrollView>
  );
}

const fmtTime = (sec: number) => {
  if (sec < 60) return `${sec} сек`;
  const m = Math.floor(sec / 60); if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${m % 60} мин`;
};

// Заглушка «дышит»: прозрачность медленно ходит 1 → 0,55 → 1 (одна анимация на группу)
function Breathe({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const o = useSharedValue(1);
  useEffect(() => { o.value = withDelay(delay, withRepeat(withTiming(0.55, { duration: 900, easing: Easing.inOut(Easing.sin) }), -1, true)); return () => cancelAnimation(o); }, []);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={st}>{children}</Animated.View>;
}
// Заглушки строк треков, пока экран доезжает (вместо пустоты): обложка и две полоски того же размера, что строка
function RowSkel({ n }: { n: number }) {
  const T: any = useT(); const c = T.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  return <Breathe>{Array.from({ length: n }, (_, i) => (
    <View key={i} style={{ height: 64, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 }}>
      <View style={{ width: 48, height: 48, borderRadius: 12, backgroundColor: c }} />
      <View style={{ flex: 1, gap: 8 }}><View style={{ width: '58%', height: 12, borderRadius: 6, backgroundColor: c }} /><View style={{ width: '34%', height: 10, borderRadius: 5, backgroundColor: c }} /></View>
    </View>
  ))}</Breathe>;
}

// ---------- Профиль пользователя — в том же стиле, что карточка исполнителя ----------
// Сверху: цветной фон из фото, большой аватар в кольце цвета оформления, имя, статистика в стеклянных карточках, две кнопки.
// Ниже — настройки сгруппированными блоками (как в настройках iOS).
// Скругления по правилу «вложенности»: блок 22, внутренний отступ 14 → квадратик иконки 30 со скруглением 8 (22 − 14).
const SUB = { active: true, developer: true, expires: null as string | null };
const PERKS = ['Звук в высоком качестве', 'Без ограничений на прослушивание', 'Ранний доступ к новым функциям', 'Свой цвет оформления'];

function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  const ty = useTy();
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={{ marginTop: 24 }}>
      {!!title && <Text style={[ty.footnote, { marginLeft: 32, marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.6 }]}>{title}</Text>}
      <Glass radius={22} style={{ marginHorizontal: 16 }}>
        {items.map((c: any, i) => React.isValidElement(c) ? React.cloneElement(c as any, { first: i === 0 }) : c)}
      </Glass>
    </View>
  );
}
function SetRow({ icon, title, value, onPress, right, first, img, round, sub }: any) {
  const T: any = useT(); const ty = useTy();
  const body = (
    <View style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10, gap: 14 }}>
      {/* иконок у строк нет — только картинка (трек или артист), всегда одной формы: скругление 8 */}
      {!!img && <Cover u={img} size={30} r={8} />}
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[ty.body]}>{title}</Text>
        {!!sub && <Text numberOfLines={1} style={[ty.footnote, { marginTop: 1 }]}>{sub}</Text>}
      </View>
      {!!value && <Text numberOfLines={1} style={[ty.subhead, { maxWidth: 140 }]}>{value}</Text>}
      {right}
      {onPress && !right && <Chev c={T.muted} />}
      {!first && <View style={{ position: 'absolute', left: img ? 58 : 14, right: 0, top: 0, height: StyleSheet.hairlineWidth, backgroundColor: T.line }} />}
    </View>
  );
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => [{ backgroundColor: pressed ? T.glass : 'transparent' }]}>{body}</Pressable> : body;
}

// «Приложение»: версия, проверка и установка обновления (Android — прямо из приложения)
function UpdateGroup() {
  const T: any = useT();
  const [st, setSt] = useState<{ k: 'idle' | 'check' | 'none' | 'avail' | 'dl' | 'err'; u?: upd.Upd; p?: number; e?: string }>({ k: 'idle' });
  const check = async () => { setSt({ k: 'check' }); const u = await upd.checkUpdate(); setSt(u ? { k: 'avail', u } : { k: 'none' }); };
  useEffect(() => { check(); }, []);
  const go = async () => { if (!st.u) return; const u = st.u; setSt({ k: 'dl', u, p: 0 }); try { await upd.installUpdate(u, (p) => setSt({ k: 'dl', u, p })); setSt({ k: 'avail', u }); } catch (e: any) { setSt({ k: 'err', u, e: String(e?.message || e) }); } };
  const sub = st.k === 'check' ? 'Проверяю…' : st.k === 'none' ? 'У вас последняя версия' : st.k === 'avail' ? `Вышла версия ${st.u!.version}` : st.k === 'dl' ? `Скачиваю… ${Math.round((st.p || 0) * 100)}%` : st.k === 'err' ? st.e : '';
  const tap = st.k === 'avail' || st.k === 'err' ? (upd.canSelfUpdate && st.u ? go : check) : st.k === 'dl' || st.k === 'check' ? undefined : check;
  return (
    <Group title="Приложение">
      <SetRow title={`Пульс ${upd.current.version}`} sub={sub || ota.otaLabel()} onPress={tap}
        right={st.k === 'avail' && upd.canSelfUpdate ? <Text style={{ color: '#fff', backgroundColor: T.accent, overflow: 'hidden', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 8, fontWeight: '700' }}>Обновить</Text> : st.k === 'check' || st.k === 'dl' ? <ActivityIndicator color={T.accent} /> : undefined} />
      {st.k === 'avail' && !!st.u && st.u.notes.length > 0 && <SetRow title="Что нового" sub={st.u.notes.join(' · ')} />}
    </Group>
  );
}
// через 15 с после запуска и раз в час — тихая проверка; если вышла новая версия, один раз спрашиваем
function useUpdateNag() {
  // обновление «по воздуху»: при запуске и при каждом возвращении в приложение (не чаще раза в 10 минут)
  useEffect(() => {
    if (!ota.otaOn) return;
    let last = 0, shown = false;
    const run = async () => {
      if (shown || Date.now() - last < 600e3) return; last = Date.now();
      const o = await ota.otaFetch(); if (!o) return; shown = true;
      openDialog({ icon: 'sparkles', title: 'Обновление готово', sub: 'Включится за секунду', list: o.notes, buttons: [
        { text: 'Позже', kind: 'sec' },
        { text: 'Перезапустить', kind: 'pri', onPress: () => { ota.otaRestart(); } },
      ] });
    };
    const t0 = setTimeout(run, 3000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') run(); });
    return () => { clearTimeout(t0); sub.remove(); };
  }, []);
  useEffect(() => {
    if (!upd.canSelfUpdate) return;
    let asked = '';
    const run = async () => {
      const u = await upd.checkUpdate(); if (!u || asked === u.version) return; asked = u.version;
      openDialog({ icon: 'download-outline', title: 'Вышла версия ' + u.version, sub: 'Скачается и откроется установка', list: u.notes, buttons: [
        { text: 'Позже', kind: 'sec' },
        { text: 'Обновить', kind: 'pri', onPress: () => { upd.installUpdate(u, () => {}).catch((e) => openDialog({ danger: true, icon: 'alert-circle-outline', title: 'Не получилось', text: String(e?.message || e), buttons: [{ text: 'Понятно', kind: 'sec' }] })); } },
      ] });
    };
    const t = setTimeout(run, 15000); const h = setInterval(run, 3600e3);
    return () => { clearTimeout(t); clearInterval(h); };
  }, []);
}
const PSECS: ['over' | 'look' | 'ym' | 'app', string][] = [['over', 'Обзор'], ['look', 'Оформление'], ['ym', 'Яндекс'], ['app', 'Программа']];
function ProfileScreen({ open, onTheme, onPulse }: any) {
  const P = usePlayer(); const T: any = useT(); const ty = useTy();
  const bannedN = useBannedCount();
  const onScroll = useHeroScroll(); const [end, setEnd] = useState(0);
  const photo: string | undefined = P.profile.photo || undefined;
  const HC = useContext(HeroCtx); const avRef = useRef<View>(null);
  const letter = ((P.profile.name || '?')[0] || '?').toUpperCase();
  const reg = () => HC?.at(avRef, (yc: number) => HC?.setFly({ src: photo, letter, ring: T.accent, ring2: (T as any).duo ? (T as any).accent2 : undefined, ring3: (T as any).tri ? (T as any).accent3 : undefined, badge: true, size: 176, yc }));
  useEffect(() => { reg(); }, [photo, letter, T.accent, T.bgBase]);
  useEffect(() => () => HC?.setFly(null), []);
  const tone = useHeroTone(photo); const dk = tone.onDark;
  const [edit, setEdit] = useState(false); const [name, setName] = useState(P.profile.name);
  const [colorOpen, setColorOpen] = useState(false); const [perks, setPerks] = useState(false);
  const saveName = () => { P.setProfile({ ...P.profile, name: name.trim() || 'Гость' }); setEdit(false); };
  // прежнее фото удаляется с телефона, когда его заменили или убрали (иначе файлы копятся)
  const setPhoto = async (uri: string) => { const old = P.profile.photo; P.setProfile({ ...P.profile, photo: await keepImage(uri) }); dropImage(old); };
  const fromLibrary = async () => { const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 }); if (!r.canceled) setPhoto(r.assets[0].uri); };
  const fromCamera = async () => { const perm = await ImagePicker.requestCameraPermissionsAsync(); if (!perm.granted) return; const r = await ImagePicker.launchCameraAsync({ allowsEditing: true, aspect: [1, 1], quality: 0.8 }); if (!r.canceled) setPhoto(r.assets[0].uri); };
  const removePhoto = () => { dropImage(P.profile.photo); P.setProfile({ ...P.profile, photo: '' }); };
  const pick = () => {
    const has = !!P.profile.photo;
    const opts = ['Выбрать из галереи', 'Сделать фото', ...(has ? ['Удалить фото'] : []), 'Отмена'];
    const acts = [fromLibrary, fromCamera, ...(has ? [removePhoto] : [])];
    if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ title: 'Фото профиля', options: opts, cancelButtonIndex: opts.length - 1, destructiveButtonIndex: has ? 2 : undefined }, (i) => { acts[i]?.(); });
    else { const ic = ['images-outline', 'camera-outline', 'trash-outline']; openMenu('Фото профиля', opts.slice(0, -1).map((o, i) => ({ text: o, onPress: acts[i], icon: ic[i], danger: has && i === 2 }))); }
  };
  const st = P.stats || { sec: 0, tracks: {}, artists: {} };
  const topT: any = (Object.values(st.tracks) as any[]).sort((a, b) => b.s - a.s)[0];
  const topA: any = (Object.entries(st.artists) as any[]).sort((a, b) => b[1].s - a[1].s)[0];
  const nTracks = Object.keys(st.tracks || {}).length;
  const accName = P.black ? 'чёрная тема' : (ACCENTS.find((a) => a.key === P.accent) || ACCENTS[0]).name;
  const swRef = useRef<View>(null); const [swVal, setSwVal] = useState<boolean | null>(null);
  useEffect(() => { setSwVal(null); }, [T.dark]);
  const flipTheme = (v: boolean) => { setSwVal(v); swRef.current?.measure((_a, _b, w, h, x, y) => onTheme?.(x + w / 2, y + h / 2)); };
  const bkRef = useRef<View>(null); const [bkVal, setBkVal] = useState<boolean | null>(null);
  useEffect(() => { setBkVal(null); }, [P.black]);
  useEffect(() => { setSwVal(null); }, [P.dark]);
  const flipBlack = (v: boolean) => { setBkVal(v); bkRef.current?.measure((_a, _b, w, h, x, y) => onTheme?.(x + w / 2, y + h / 2, 'black', v)); };
  const stats: [string, string][] = [[st.sec ? fmtTime(st.sec) : '0 мин', 'в «Пульсе»'], [String(nTracks), plural(nTracks, ['трек', 'трека', 'треков']).replace(/^\d+ /, '')], [String(P.favs.length), 'в любимом']];
  const ink = dk ? '#fff' : T.ink, ink3 = dk ? 'rgba(255,255,255,0.7)' : T.ink3;
  const [sec, setSec] = useState<'over' | 'look' | 'ym' | 'app'>('over'); const sleep = useSleep(); const { width: W } = useWin();
  const wk = useMemo(() => computeStats(st, 'w'), [st]); const tileW = (W - 32 - 10) / 2;
  const grow = wk.prevSec ? Math.round(((wk.sec - wk.prevSec) / wk.prevSec) * 100) : 0;
  const tiles: { k: string; v: string; note?: string; up?: boolean }[] = [
    { k: 'За неделю', v: wk.sec ? fmtTime(wk.sec) : '0 мин', note: grow ? `${grow > 0 ? '+' : '−'}${Math.abs(grow)}% к прошлой` : '', up: grow > 0 },
    { k: 'Треков', v: String(wk.tracks), note: `${P.favs.length} в любимом` },
    { k: 'Любимый артист', v: wk.top?.name || '—' },
    { k: 'Чаще слушаю', v: wk.peak < 0 ? '—' : wk.peak < 6 ? 'ночью' : wk.peak < 12 ? 'утром' : wk.peak < 18 ? 'днём' : 'вечером', note: wk.peak < 0 ? '' : `около ${wk.peak}:00` },
  ];
  return (
    <>
      <ScrollView screen anim onScroll={onScroll} keyboardShouldPersistTaps="handled">
        <View>
          {photo ? <Hero u={tone.ready ? photo : undefined} end={end} onDark={dk} />
            : (T as any).grad ? <RadialFill colors={(T as any).grad} fade strength={T.dark ? 0.85 : 1} cy={0.5} style={{ left: '-30%', right: '-30%', top: -300, bottom: undefined, height: 800 }} />
            : <LinearGradient pointerEvents="none" colors={[T.bgGlow, 'transparent']} style={{ position: 'absolute', left: 0, right: 0, top: -300, height: 760 }} />}
          <View style={{ alignItems: 'center', marginTop: 8, paddingHorizontal: 16 }}>
            {/* аватар рисуется поверх шапки (как у артиста) и при прокрутке растворяется в «острове»; здесь — место под него и нажатие */}
            <Pressable onPress={pick}>
              <View ref={avRef} collapsable={false} style={{ width: 176, height: 176 }} onLayout={reg} />
            </Pressable>
            <View style={{ height: 50, marginTop: 14, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' }}>
              {edit ? (
                <TextInput keyboardAppearance={T.dark ? 'dark' : 'light'} value={name} onChangeText={setName} autoFocus selectTextOnFocus maxLength={30} returnKeyType="done" onSubmitEditing={saveName} onBlur={saveName}
                  selectionColor={T.accent} style={[ty.largeTitle, { textAlign: 'center', minWidth: 180, paddingHorizontal: 14, paddingVertical: 2, color: ink }]} />
              ) : (
                <Text onPress={() => { setName(P.profile.name); setEdit(true); }} numberOfLines={1} style={[ty.largeTitle, { textAlign: 'center', color: ink }]}>{P.profile.name}</Text>
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <Text style={[ty.footnote, { color: ink3 }]}>{SUB.developer ? 'профиль разработчика' : ''}</Text>
            </View>
          </View>
          <View onLayout={(e) => setEnd(e.nativeEvent.layout.y + e.nativeEvent.layout.height + 26)} style={{ flexDirection: 'row', gap: 12, marginHorizontal: 16, marginTop: 16 }}>
            <Btn label="Мой пульс" icon="pulse" onPress={onPulse} />
            <Btn label="Любимое" icon="heart" kind="secondary" inv={dk && !T.dark} onPress={() => open({ k: 'favs' })} />
          </View>
        </View>

        {/* разделы-пилюли, как на ПК: вместо одного длинного списка */}
        <RNScroll horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 22, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
          {PSECS.map(([k, lb]) => (
            <Press key={k} hap="select" onPress={() => setSec(k)} style={{ height: 36, paddingHorizontal: 16, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: sec === k ? T.primary : T.glass, borderWidth: 1, borderColor: sec === k ? 'transparent' : T.stroke }}>
              <Text style={[ty.miniTitle, { color: sec === k ? T.onPrimary : T.ink }]}>{lb}</Text>
            </Press>
          ))}
        </RNScroll>

        {sec === 'over' && <Animated.View key="over" entering={FadeIn.duration(260).easing(EASE_OUT)}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginHorizontal: 16, marginTop: 18 }}>
            {tiles.map((x, i) => (
              <Animated.View key={x.k} entering={rise(i * 40)} style={{ width: tileW }}>
                <Press onPress={() => open({ k: 'stats' })} to={0.98}>
                  <GlassCard radius={22} style={{ paddingVertical: 14, paddingHorizontal: 16, minHeight: 96 }}>
                    <Text numberOfLines={1} style={ty.footnote}>{x.k}</Text>
                    <Text numberOfLines={1} style={[ty.title2, { fontSize: 21, marginTop: 4 }]}>{x.v}</Text>
                    {!!x.note && <Text numberOfLines={1} style={[ty.caption, { marginTop: 2, fontWeight: '600', color: x.up ? '#34c77b' : T.ink3 }]}>{x.note}</Text>}
                  </GlassCard>
                </Press>
              </Animated.View>
            ))}
          </View>
          <View style={{ marginHorizontal: 16, marginTop: 12, flexDirection: 'row' }}><Btn kind="secondary" label="Подробная статистика" onPress={() => open({ k: 'stats' })} /></View>
        {(topT || topA) && (
          <Group title="Слушаю больше всего">
            {topT && <SetRow img={api.smallArt(topT.t.cover)} title={topT.t.title} sub={`${topT.t.artist} · трек`} onPress={() => P.go([topT.t], 0)} />}
            {topA && <SetRow img={topA[1].cover ? api.smallArt(topA[1].cover) : undefined} round icon="person" title={topA[0]} sub="исполнитель" onPress={topA[1].artistId ? () => open({ k: 'artist', id: topA[1].artistId, name: topA[0] }) : undefined} />}
          </Group>
        )}
        <Group title="Воспроизведение">
          <SetRow icon="infinite" title="Автопродолжение" sub="Похожие треки после альбома или плейлиста"
            right={<Switch value={P.auto} onValueChange={P.setAuto} trackColor={{ true: T.accent, false: T.line }} thumbColor="#fff" />} />
          <SetRow icon="moon-outline" title="Таймер сна" value={sleep ? sleepLabel(sleep) : 'выключен'} onPress={() => openSleepMenu(P.cur?.id)} />
          <SetRow icon="eye-off-outline" title="Скрытые в «Моём пульсе»" value={bannedN ? String(bannedN) : 'нет'} onPress={() => open({ k: 'banned' })} />
        </Group>
        </Animated.View>}

        {sec === 'look' && <Animated.View key="look" entering={FadeIn.duration(260).easing(EASE_OUT)}>
          <Group title="Цвет">
            <SetRow icon="color-palette" title="Цвет оформления" value={accName} onPress={() => setColorOpen(true)}
              right={<View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: T.accent }} /><Chev c={T.muted} /></View>} />
          </Group>
        <Group title="Оформление">
          {!P.black && <SetRow icon={T.dark ? 'moon' : 'sunny'} title="Тёмная тема"
            right={<View ref={swRef} collapsable={false}><Switch value={swVal ?? T.dark} onValueChange={flipTheme} trackColor={{ true: T.accent, false: T.line }} thumbColor="#fff" /></View>} />}
          <SetRow icon="contrast" title="Чёрная тема" sub={P.black ? 'Только чёрный фон, без света и цветов' : 'Только чёрный фон — без света и цветов'}
            right={<View ref={bkRef} collapsable={false}><Switch value={bkVal ?? !!P.black} onValueChange={flipBlack} trackColor={{ true: T.accent, false: T.line }} thumbColor="#fff" /></View>} />
        </Group>
        </Animated.View>}

        {sec === 'ym' && <Animated.View key="ym" entering={FadeIn.duration(260).easing(EASE_OUT)}>
          <Group title="Яндекс Музыка">
            {api.YB ? <SetRow icon="musical-note-outline" title="Аккаунт Яндекса" sub="Вход для полных треков (своя подписка Плюс)" onPress={() => open({ k: 'ym' })} />
              : <SetRow icon="musical-note-outline" title="Недоступно в этой сборке" />}
          </Group>
        </Animated.View>}

        {sec === 'app' && <Animated.View key="app" entering={FadeIn.duration(260).easing(EASE_OUT)}>
        <Group title="Подписка">
          <View style={{ paddingHorizontal: 14, paddingVertical: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Logo variant="impulse" height={22} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Ionicons name="checkmark-circle" size={16} color={SUB.active ? T.accent : T.muted} />
                <Text style={[ty.footnote, { color: SUB.active ? T.accentText : T.ink3, fontWeight: '600' }]}>{SUB.active ? 'Активна' : 'Неактивна'}</Text>
              </View>
            </View>
            <Text style={[ty.headline, { marginTop: 10 }]}>{SUB.expires ? `До ${new Date(SUB.expires).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}` : 'Бессрочно'}</Text>
            <Text style={[ty.subhead, { marginTop: 2 }]}>{SUB.developer ? 'Профиль разработчика' : 'Продлевается автоматически'}</Text>
          </View>
          <SetRow icon="sparkles" title="Преимущества" onPress={() => setPerks((x) => !x)} right={<Ionicons name={perks ? 'chevron-up' : 'chevron-down'} size={17} color={T.muted} />} />
          {perks && PERKS.map((p) => <SetRow key={p} icon="checkmark" title={p} />)}
        </Group>
          <UpdateGroup />
        <Group title="Профиль">
          <SetRow icon="person" title="Имя" value={P.profile.name} onPress={() => { setName(P.profile.name); setEdit(true); }} />
          <SetRow icon="image" title="Фото профиля" value={photo ? 'Изменить' : 'Добавить'} onPress={pick} />
        </Group>
        </Animated.View>}
        <Text style={[ty.caption, { textAlign: 'center', marginTop: 24 }]}>пульс · альфа {APP_VERSION}{ota.otaLabel() ? ' · ' + ota.otaLabel() : ''}</Text>
      </ScrollView>
      {colorOpen && <ColorSheet onClose={() => setColorOpen(false)} />}
    </>
  );
}

// ---------- Выбор цвета оформления (подписка «Импульс») ----------
// Панель снизу: живое превью (обводка аватара, вкладка, звезда «Импульса») и сетка цветов. Цвет применяется сразу ко всему приложению.
function ColorSheet({ onClose }: { onClose: () => void }) {
  const P = usePlayer(); const T = useT(); const ty = useTy(); const ins = useSafeAreaInsets();
  const y = useSharedValue(1);
  useEffect(() => { y.value = withTiming(0, { duration: 460, easing: SHEET }); }, []);
  const close = () => { y.value = withTiming(1, { duration: 340, easing: SHEET }, (f) => { if (f) runOnJS(onClose)(); }); };
  const sheet = useAnimatedStyle(() => ({ transform: [{ translateY: y.value * 900 }] }));
  const dim = useAnimatedStyle(() => ({ opacity: 1 - y.value }));
  const pan = Gesture.Pan().activeOffsetY(10).failOffsetX([-25, 25])
    .onUpdate((e) => { y.value = Math.max(0, e.translationY / 900); })
    .onEnd((e) => { if (e.translationY > 110 || e.velocityY > 800) runOnJS(close)(); else y.value = withTiming(0, { duration: 300, easing: SHEET }); });
  const abs = StyleSheet.absoluteFill;
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={close}>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Animated.View style={[abs, dim]}><Pressable onPress={close} style={[abs, { backgroundColor: T.dark ? 'rgba(0,0,0,0.5)' : 'rgba(20,16,40,0.28)' }]} /></Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={[{ position: 'absolute', left: 8, right: 8, bottom: ins.bottom + 8, borderRadius: 40, backgroundColor: T.sheet, borderWidth: 1, borderColor: T.stroke, padding: 16, paddingTop: 10, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 30, shadowOffset: { width: 0, height: 12 } }, sheet]}>
          <View style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: T.line, marginBottom: 14 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={ty.title2}>Цвет оформления</Text>
            <Logo variant="impulse" height={18} />
          </View>
          <Text style={[ty.subhead, { marginTop: 4 }]}>Обводка аватара, акценты интерфейса и звезда «Импульса»</Text>
          {/* живое превью */}
          <Glass radius={22} style={{ marginTop: 16, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, borderWidth: 2.5, borderColor: T.accent, alignItems: 'center', justifyContent: 'center' }}><Avatar size={51} bare /></View>
            <View style={{ flex: 1, gap: 10 }}>
              <Logo variant="impulse" height={20} />
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <View style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, overflow: 'hidden', backgroundColor: (T as any).accentPill, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  {(T as any).duo && <LinearGradient colors={(T as any).tri ? [(T as any).accentPillA, (T as any).accentPillB, (T as any).accentPillC] : [(T as any).accentPillA, (T as any).accentPillB]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />}
                  <Ionicons name="home" size={14} color={T.accentText} /><Text style={[ty.caption, { color: T.accentText, fontSize: 11 }]}>Главная</Text>
                </View>
                <Ionicons name="heart" size={20} color={(T as any).duo ? (T as any).accent2 : T.accent} />
                <View style={{ width: 38, height: 22, borderRadius: 11, overflow: 'hidden', backgroundColor: T.accent, padding: 2, alignItems: 'flex-end' }}>{(T as any).duo && <LinearGradient colors={(T as any).tri ? [T.accent, (T as any).accent2, (T as any).accent3] : [T.accent, (T as any).accent2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />}<View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff' }} /></View>
              </View>
            </View>
          </Glass>
          {/* сетка цветов: одноцветные и двухцветные (кружок разделён по диагонали, как в настройках iOS) */}
          {([['Один цвет', SOLO], ['Градиент', GRADIENTS]] as const).map(([title, list], gi) => (
            <View key={title} style={{ marginTop: gi ? 20 : 18 }}>
              <Text style={[ty.footnote, { fontWeight: '600', marginBottom: 10 }]}>{title}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 14 }}>
                {list.map((a) => {
                  const on = a.key === P.accent; const c = T.dark ? a.dark.a : a.light.a; const c2 = second(a.key, T.dark);
                  return (
                    <Press key={a.key} hap="select" onPress={() => { P.setAccent(a.key); if (P.black) P.setBlack(false); }} to={0.92} style={{ width: '25%', alignItems: 'center' }}>
                      <View style={{ width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center' }}>
                        {on && <Ring size={54} w={2.5} c1={(a as any).grad ? gradOf(a.key, T.dark)![0] : c} c2={(a as any).grad ? gradOf(a.key, T.dark)![1] : undefined} />}
                        <View style={{ width: 42, height: 42, borderRadius: 21, overflow: 'hidden', backgroundColor: c, alignItems: 'center', justifyContent: 'center' }}>
                          {!!(a as any).grad && <RadialFill colors={gradOf(a.key, T.dark)!} />}
                          {on && <Animated.View entering={FadeIn.duration(220).easing(EASE_OUT)}><Ionicons name="checkmark" size={22} color={a.key === 'mono' && T.dark ? '#111' : '#fff'} /></Animated.View>}
                        </View>
                      </View>
                      <Text style={[ty.caption, { marginTop: 5, fontSize: 12, color: on ? T.ink : T.ink3 }]}>{a.name}</Text>
                    </Press>
                  );
                })}
              </View>
            </View>
          ))}
          <View style={{ flexDirection: 'row', marginTop: 20 }}><Btn label="Готово" onPress={close} /></View>
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
    </Modal>
  );
}

// ---------- Смена темы: от переключателя расходится круг новой темы с розовой кромкой (как в промо), затем мягко растворяется ----------
function ThemeWipe({ w, onCovered, onDone }: { w: { x: number; y: number; color: string; k: number }; onCovered: () => void; onDone: () => void }) {
  const { width: W, height: H } = useWin(); const T: any = useT();
  const r = useSharedValue(0); const o = useSharedValue(1);
  const Rr = Math.hypot(Math.max(w.x, W - w.x), Math.max(w.y, H - w.y)) + 30;
  // Круг закрыл экран → меняем тему. Растворять круг начинаем только ПОСЛЕ того, как приложение реально
  // перерисовалось в новой теме (эффект ниже срабатывает после применения изменений) — раньше растворение
  // стартовало через два кадра, когда приложение ещё перестраивалось, и анимация «застревала» и дёргалась.
  const pending = useRef(false); const done = useRef(false);
  const reveal = () => {
    if (done.current) return; done.current = true;
    o.value = withTiming(0, { duration: 520, easing: EASE_OUT }, (g) => { if (g) runOnJS(onDone)(); });
  };
  const covered = () => { pending.current = true; onCovered(); setTimeout(() => requestAnimationFrame(reveal), 1500); };   // страховка
  useEffect(() => { if (pending.current) requestAnimationFrame(() => requestAnimationFrame(reveal)); }, [T.dark, T.black]);
  useEffect(() => {
    r.value = 0; o.value = 1;
    r.value = withTiming(1, { duration: 560, easing: Easing.bezier(0.65, 0, 0.35, 1) }, (f) => { if (f) runOnJS(covered)(); });
  }, [w.k]);
  const disk = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ scale: Math.max(0.001, r.value) }] }));
  const ring = useAnimatedStyle(() => ({ opacity: r.value < 1 ? Math.min(1, r.value * 6) * (1 - r.value) * 0.9 : 0, transform: [{ scale: Math.max(0.001, r.value) }] }));
  const box = { position: 'absolute' as const, left: w.x - Rr, top: w.y - Rr, width: 2 * Rr, height: 2 * Rr, borderRadius: Rr };
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { zIndex: 100 }]}>
      <Animated.View renderToHardwareTextureAndroid shouldRasterizeIOS={false} style={[box, { backgroundColor: w.color }, disk]} />
      <Animated.View style={[box, { borderWidth: 6, borderColor: T.accentMedia }, ring]} />
    </View>
  );
}

const WH = '#ffffff'; const WM = 'rgba(255,255,255,.62)';

// Ползунки плеера. Раньше каждое движение пальца перерисовывало компонент (и для громкости — всё приложение),
// а заполнение анимировалось шириной (пересчёт раскладки каждый кадр). Теперь палец двигает значение напрямую
// в потоке анимаций, заполнение — сдвигом (transform), без пересчёта раскладки. Вид тот же.
function useSlider(value: number, w: number, onMove?: (f: number) => void, onDone?: (f: number) => void, onDrag?: (on: boolean) => void) {
  const sv = useSharedValue(value); const dragging = useRef(false);
  // в покое ползунок не анимируется между обновлениями, а просто встаёт на место (шаг меньше точки на экране)
  useEffect(() => { if (!dragging.current) sv.value = isAwake() ? withTiming(value, { duration: 450, easing: Easing.linear }) : value; }, [value]);
  const at = (x: number) => Math.max(0, Math.min(1, x / w));
  const handlers = {
    onStartShouldSetResponder: () => true, onMoveShouldSetResponder: () => true, onResponderTerminationRequest: () => false,
    onResponderGrant: (e: any) => { dragging.current = true; onDrag?.(true); const f = at(e.nativeEvent.locationX); sv.value = withTiming(f, { duration: 90 }); onMove?.(f); },
    onResponderMove: (e: any) => { const f = at(e.nativeEvent.locationX); sv.value = f; onMove?.(f); },
    onResponderRelease: (e: any) => { const f = at(e.nativeEvent.locationX); sv.value = f; dragging.current = false; onDrag?.(false); onDone?.(f); },
    onResponderTerminate: () => { dragging.current = false; onDrag?.(false); },
  };
  return { sv, handlers };
}
function Bar({ value, onChange, onDone, knob, h0 = 5 }: any) {
  const [w, setW] = useState(1);
  const hv = useSharedValue(h0); const kv = useSharedValue(1);
  const drag = (on: boolean) => { hv.value = withTiming(on ? h0 + 4 : h0, { duration: 180, easing: EASE_OUT }); kv.value = withTiming(on ? 1.35 : 1, { duration: 180, easing: EASE_OUT }); };
  const { sv, handlers } = useSlider(value, w, onChange, onDone, drag);
  const fill = useAnimatedStyle(() => ({ transform: [{ translateX: (sv.value - 1) * w }] }), [w]);
  const track = useAnimatedStyle(() => ({ height: hv.value, borderRadius: hv.value / 2 }));
  const kn = useAnimatedStyle(() => ({ transform: [{ translateX: sv.value * w - 8 }, { scale: kv.value }] }), [w]);
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: 30, justifyContent: 'center' }} {...handlers}>
      <Animated.View pointerEvents="none" style={[{ backgroundColor: 'rgba(255,255,255,.28)', overflow: 'hidden' }, track]}>
        <Animated.View style={[{ height: '100%', width: w, borderRadius: 10, backgroundColor: knob ? '#ffffff' : 'rgba(255,255,255,.88)' }, fill]} />
      </Animated.View>
      {knob && <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 7, width: 16, height: 16, borderRadius: 8, backgroundColor: '#fff', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } }, kn]} />}
    </View>
  );
}

// ---------- Ползунок «комета + звезда» ----------
// Цвет звезды и шлейфа — основной цвет обложки, подогнанный под тёмный плеер; внутри звезды — белое ядро.
// Обложка без цвета или очень тёмная → «инверсия»: белая звезда и белый шлейф, ядро чёрное (иначе сливалось бы с тёмным фоном).
const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${Math.round(h * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`;
const hexA = (h: string, a: number) => { if (!/^#[0-9a-f]{6}$/i.test(h || '')) return h; const n = parseInt(h.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
function useCometColors(cover?: string) {
  const T: any = useT();
  const [c, setC] = useState<api.HSL | null | undefined>(undefined);
  useEffect(() => { let ok = true; api.coverColor(cover).then((v) => ok && setC(v)); return () => { ok = false; }; }, [cover]);
  // градиентное оформление — комета в цветах темы (как на ПК): хвост из первого цвета, звезда — последний
  if (T.grad && T.accent3) return { key: 'g' + T.accentKey, star: T.accent3, tail: hexA(T.accent, 0.85), tail0: hexA(T.accent, 0), glow: hexA(T.accent2, 0.4), core: '#ffffff' };
  if (!c) return { key: 'inv', star: '#ffffff', tail: 'rgba(255,255,255,0.75)', tail0: 'rgba(255,255,255,0)', glow: 'rgba(255,255,255,0.35)', core: '#111114' };
  const s = Math.max(c.s, 0.65);
  return { key: `${Math.round(c.h * 360)}`, star: hsl(c.h, s, 0.64), tail: hsl(c.h, s, 0.72, 0.85), tail0: hsl(c.h, s, 0.72, 0), glow: hsl(c.h, s, 0.6, 0.4), core: '#ffffff' };
}
function Comet({ value, onDone, cover }: { value: number; onDone: (f: number) => void; cover?: string }) {
  const col = useCometColors(cover);
  const [w, setW] = useState(1); const kv = useSharedValue(1);
  const { sv, handlers } = useSlider(value, w, undefined, onDone, (on) => { kv.value = withTiming(on ? 1.25 : 1, { duration: 180, easing: EASE_OUT }); });
  // шлейф растягивается масштабом (как раньше по ширине: градиент тянется вместе с ним), без пересчёта раскладки
  const fill = useAnimatedStyle(() => { const k = Math.max(0.0001, sv.value); return { width: w, transform: [{ translateX: -(1 - k) * w / 2 }, { scaleX: k }] }; }, [w]);
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: sv.value * w - 15 }, { scale: kv.value }] }), [w]);
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={{ height: 30, justifyContent: 'center' }} {...handlers}>
      {/* дорожка */}
      <View pointerEvents="none" style={{ height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.24)' }} />
      {/* шлейф: мягкое свечение + сама линия; новый цвет проявляется при смене трека */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 9, height: 12 }, fill]}>
        <Animated.View key={col.key} entering={FadeIn.duration(600).easing(EASE_OUT)} style={StyleSheet.absoluteFill}>
          <LinearGradient colors={[col.tail0, col.glow]} start={{ x: 0.2, y: 0 }} end={{ x: 1, y: 0 }} style={{ position: 'absolute', left: 0, right: 0, top: 2, height: 8, borderRadius: 4, opacity: 0.55 }} />
          <LinearGradient colors={[col.tail0, col.tail, col.star]} locations={[0, 0.55, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ position: 'absolute', left: 0, right: 0, top: 4.5, height: 3, borderRadius: 2 }} />
        </Animated.View>
      </Animated.View>
      {/* звезда-бегунок: ореол, звезда, ядро */}
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }, knob]}>
        <Animated.View key={col.key} entering={FadeIn.duration(600).easing(EASE_OUT)} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ position: 'absolute', opacity: 0.22 }}><StarShape size={34} color={col.star} /></View>
          <View style={{ position: 'absolute', opacity: 0.4 }}><StarShape size={27} color={col.star} /></View>
          <StarShape size={21} color={col.star} />
          <View style={{ position: 'absolute' }}><StarShape size={9} color={col.core} /></View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

// Слои для плавной смены картинки: новая проявляется поверх прежней, прежняя убирается после перехода
function useLayers(u: string) {
  const [layers, setLayers] = useState([{ k: 0, u }]); const n = useRef(0);
  useEffect(() => {
    setLayers((l) => (l[l.length - 1].u === u ? l : [...l.slice(-1), { k: ++n.current, u }]));
    const t = setTimeout(() => setLayers((l) => l.slice(-1)), 2200);
    return () => clearTimeout(t);
  }, [u]);
  return layers;
}

function BgLayer({ u, first }: { u: string; first: boolean }) {
  // медленный дрейф — от общих фоновых часов (30 кадров/с): огромные размытые слои не перерисовываются 120 раз в секунду
  const o = useSharedValue(first ? 1 : 0); useAmbient(true);
  const a = useDerivedValue(() => 0.5 - 0.5 * Math.cos((Math.PI * 2 * AMB.value) / 44));
  const fade = () => { if (!first) o.value = withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.sin) }); };
  const wrap = useAnimatedStyle(() => ({ opacity: o.value }));
  // только медленный дрейф и мягкое «дыхание», без вращения — края картинки всегда за пределами экрана
  const s1 = useAnimatedStyle(() => ({ transform: [{ translateX: -50 + a.value * 100 }, { translateY: -30 + a.value * 60 }, { scale: 2.4 + a.value * 0.25 }] }));
  const s2 = useAnimatedStyle(() => ({ transform: [{ translateX: 60 - a.value * 120 }, { translateY: 50 - a.value * 100 }, { scale: 2.8 - a.value * 0.25 }] }));
  return (
    <Animated.View style={[StyleSheet.absoluteFill, wrap]}>
      <Animated.Image source={{ uri: u }} blurRadius={22} onLoad={fade} style={[StyleSheet.absoluteFill, s1]} />
      {Platform.OS !== 'android' && <Animated.Image source={{ uri: u }} blurRadius={22} style={[StyleSheet.absoluteFill, s2, { opacity: 0.55 }]} />}
    </Animated.View>
  );
}

// Живой фон плеера: сильно размытая обложка (маленькая картинка даёт гладкий градиент без квадратов), цвет меняется плавным перекрёстным переходом
function LiveBg({ u }: { u: string }) {
  const small = (u || '').replace(/\d+x\d+(bb)?(-\d+)?(?=\.\w+$)/, '100x100bb');
  const layers = useLayers(small);
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#16161a', overflow: 'hidden' }]}>
      {layers.map((l) => <BgLayer key={l.k} u={l.u} first={l.k === 0} />)}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,.34)' }]} />
    </View>
  );
}

// Большая обложка: при смене трека новая обложка плавно проявляется поверх старой
function CoverFadeLayer({ u, first }: { u: string; first: boolean }) {
  const o = useSharedValue(first ? 1 : 0);
  const st = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ scale: 1.05 - 0.05 * o.value }] }));
  // картинка — через общий кэш (expo-image): туда же заранее скачивается обложка следующего трека
  return (
    <Animated.View style={[{ position: 'absolute', width: '100%', height: '100%' }, st]}>
      <Pic uri={u} style={{ width: '100%', height: '100%' }} onLoad={() => { if (!first) o.value = withTiming(1, { duration: 750, easing: Easing.inOut(Easing.cubic) }); }} />
    </Animated.View>
  );
}
function CoverStack({ u }: { u: string }) {
  const layers = useLayers(u);
  return <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,.08)' }}>{layers.map((l) => <CoverFadeLayer key={l.k} u={l.u} first={l.k === 0} />)}</View>;
}

function Like({ t }: any) {
  const P = usePlayer(); const k = useSharedValue(1); const on = P.isFav(t);
  const st = useAnimatedStyle(() => ({ transform: [{ scale: k.value }] }));
  return (
    <Pressable hitSlop={12} style={{ padding: 4 }} onPress={() => { hap(P.isFav(t) ? 'light' : 'heartbeat'); P.toggleFav(t); k.value = withTiming(1.15, { duration: 110 }, () => { k.value = withTiming(1, { duration: 160 }); }); }}>
      <Animated.View style={st}><Ic n={on ? 'heart' : 'heart-outline'} c={on ? '#ff6b86' : WH} /></Animated.View>
    </Pressable>
  );
}

// Лайк в плеере: сердце «подпрыгивает», при добавлении расходится розовое кольцо
function BigLike({ t }: { t: Track }) {
  const P = usePlayer(); const on = P.isFav(t); const k = useSharedValue(1); const b = useSharedValue(1);
  // сердце нарисовано в 1,3 раза крупнее и в покое уменьшено: «подпрыгивая» до 1,3, оно не растягивается и не пикселит
  const st = useAnimatedStyle(() => ({ transform: [{ scale: k.value / 1.3 }] }));
  const ring = useAnimatedStyle(() => ({ opacity: b.value < 1 ? (1 - b.value) * 0.9 : 0, transform: [{ scale: 0.6 + 1.5 * b.value }] }));
  const tap = () => {
    const was = P.isFav(t); P.toggleFav(t); hap(was ? 'light' : 'heartbeat');
    k.value = withSequence(withTiming(1.3, { duration: 120 }), withTiming(1, { duration: 220, easing: EASE }));
    if (!was) { b.value = 0; b.value = withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) }); }
  };
  return (
    <Pressable hitSlop={10} onPress={tap} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: 40, height: 40, borderRadius: 20, borderWidth: 2, borderColor: (P.T as any).accentGlow }, ring]} />
      <Animated.View style={[{ margin: -4.5 }, st]}><Ionicons name={on ? 'heart' : 'heart-outline'} size={39} color={on ? (P.T as any).accentMedia : WH} /></Animated.View>
    </Pressable>
  );
}
const RoundBtn = ({ icon, onPress, s = 22 }: any) => (
  <Press onPress={onPress} to={0.9} hitSlop={8} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,.16)', alignItems: 'center', justifyContent: 'center' }}><LIcon n={icon} s={s} c={WH} /></Press>
);

// Размер шрифта по длине текста: одна строка до 26pt; если не помещается — уменьшаем (не меньше 19pt);
// если и так не влезает — две строки от 22 до 15pt. Ширина символа ≈ 0.56 от размера шрифта.
// По дизайн-системе: название — np-title 22/28 Semibold, исполнитель — np-artist 22/28 Regular (SF Pro).
// Длинное название: сначала уменьшаем в одну строку (до 17pt), потом две строки 20→15pt. Ширина символа SF ≈ 0.53 размера.
const titleFont = (s: string, w: number) => {
  const cw = 0.53;
  if (s.length * 22 * cw <= w) return { size: 22, lines: 1 };
  const one = Math.floor(w / (s.length * cw));
  if (one >= 17) return { size: one, lines: 1 };
  return { size: Math.max(15, Math.min(20, Math.floor((2 * w) / (s.length * cw)))), lines: 2 };
};
const artistFont = (s: string, w: number) => Math.max(15, Math.min(22, Math.floor(w / (Math.max(1, s.length) * 0.5))));

function Full({ onClose, onClosing, open, bgP, reg }: any) {
  const P = usePlayer(); const playing = usePlaying(); const ins = useSafeAreaInsets(); const { width: W, height: H } = useWin(); const t = P.cur; const addTo = useContext(AddCtx);
  const [showQ, setShowQ0] = useState(false); const [story, setStory] = useState(false);
  // живой текст: обложка уменьшается (как в режиме очереди), а текст занимает середину плеера
  const [showL, setShowL0] = useState(false); const [goP, setGoP] = useState(0); const [goN, setGoN] = useState(0);
  const setShowQ = (v: any) => { setShowL0(false); setShowQ0(v); }; const setShowL = (v: any) => { setShowQ0(false); setShowL0(v); };
  // pr: 1 — плеер раскрыт, 0 — он превратился в капсулу мини-плеера. qm: 1 — режим очереди (обложка уменьшается)
  const pr = useSharedValue(0); const qm = useSharedValue(0); const sc = useSharedValue(playing ? 1 : 0.94);
  const sx = useSharedValue(0);   // сдвиг обложки при свайпе
  const ty = useSharedValue(0);   // карточка целиком едет вниз за пальцем
  // приложение под плеером чуть отодвигается вглубь (уменьшается и темнеет) — как карточка в iOS
  useAnimatedReaction(() => pr.value * (1 - Math.min(1, ty.value / (H * 0.9))), (v) => { if (bgP) bgP.value = v; }, []);
  useEffect(() => { pr.value = withTiming(1, { duration: 560, easing: EASE }); }, []);
  useEffect(() => { qm.value = withTiming(showQ || showL ? 1 : 0, { duration: 480, easing: EASE_IO }); }, [showQ, showL]);
  // Обложка чуть уменьшается только при настоящей паузе. При переключении трека плеер на долю секунды
  // «встаёт на паузу», пока грузит новый — это игнорируем (раньше из-за этого обложка подпрыгивала).
  useEffect(() => {
    if (playing) { sc.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) }); return; }
    const tm = setTimeout(() => { sc.value = withTiming(0.94, { duration: 500, easing: Easing.out(Easing.cubic) }); }, 600);
    return () => clearTimeout(tm);
  }, [playing]);

  const padT = Math.max(ins.top, Platform.OS === 'ios' ? 47 : 0);
  const miniTop = H - DOCK_B - TAB_H - 8 - MINI_H;
  // откуда раскрывается плеер: из мини-плеера (по умолчанию) или из карточки «Моего пульса» —
  // тогда карточка плавно «вырастает» в плеер, а обложка перелетает из неё (и при закрытии возвращается в карточку).
  // Это одни и те же слои, что и раньше, — без снимков экрана и лишней памяти.
  const org = useRef(takeFullOrigin()).current;
  const oX = org ? org.x : 16, oY = org ? org.y : miniTop, oW = org ? org.w : W - 32, oH = org ? org.h : MINI_H, oR = org ? 22 : 30;
  const SIDE = 24, BAR_H = 52;
  const cTop = padT + BAR_H + 16;
  const cs = Math.max(200, Math.min(W - SIDE * 2, H - cTop - ins.bottom - 318));

  const shell = useAnimatedStyle(() => {
    const p = pr.value;
    // мини-капсула (радиус 30) ↔ карточка во весь экран (радиус 44, как у углов экрана); при перетаскивании карточка
    // целиком едет за пальцем, а при отпускании продолжает путь вниз и одновременно собирается в мини-плеер
    return { left: oX * (1 - p), top: oY * (1 - p), width: oW + (W - oW) * p, height: oH + (H - oH) * p, borderRadius: oR + (44 - oR) * p, opacity: interpolate(p, [0, 0.22, 1], [0, 1, 1], 'clamp'), transform: [{ translateY: ty.value }] };
  });
  const fixed = useAnimatedStyle(() => { const p = pr.value; return { left: -oX * (1 - p), top: -oY * (1 - p) }; });
  // содержимое проявляется уже раскрытой карточкой: чуть снизу и из лёгкого «приближения»
  const body = useAnimatedStyle(() => ({ opacity: interpolate(pr.value, [0, 0.5, 1], [0, 0, 1], 'clamp'), transform: [{ translateY: (1 - pr.value) * 40 }, { scale: 0.96 + 0.04 * pr.value }] }));
  const grab = useAnimatedStyle(() => ({ opacity: interpolate(pr.value, [0.7, 1], [0, 1], 'clamp') }));
  // Обложка перелетает между мини-плеером и большой обложкой. Сама картинка ВСЕГДА размером cs×cs и только
  // масштабируется — поэтому iOS декодирует её в полном разрешении и после сворачивания качество не падает.
  const fly = useAnimatedStyle(() => {
    const p = pr.value, q = qm.value;
    const fx = ((W - cs) / 2) * (1 - q) + SIDE * q, fy = cTop + 9 * q, fs = cs * (1 - q) + 64 * q, fr = 30 * (1 - q) + 14 * q;
    const mx = org ? oX : 24, my = org ? oY + (oH - oW) / 2 : miniTop + 8, ms = org ? oW : 44, mr = 22;   // в мини-плеере обложка — круг: 30 (радиус капсулы) − 8 (отступ) = 22
    const x = mx + (fx - mx) * p, y = my + (fy - my) * p, s = ms + (fs - ms) * p, r = mr + (fr - mr) * p;
    const k = s / cs;
    return { left: x - oX * (1 - p) - (cs - s) / 2, top: y - oY * (1 - p) - (cs - s) / 2, borderRadius: r / k,
      opacity: 1 - Math.min(0.6, Math.abs(sx.value) / W),
      transform: [{ translateX: sx.value }, { rotate: `${(sx.value / W) * 7}deg` }, { scale: k * interpolate(p, [0.85, 1], [1, sc.value], 'clamp') }] };
  });

  // Свайп по обложке: влево — следующий трек, вправо — предыдущий. Обложка едет за пальцем с лёгким наклоном,
  // при достаточном сдвиге улетает, а новая въезжает с другой стороны; иначе мягко возвращается.
  const stepTo = (d: number) => P.step(d);
  const swipe = Gesture.Pan().activeOffsetX([-14, 14]).failOffsetY([-18, 18])
    .onUpdate((e) => { sx.value = e.translationX; })
    .onEnd((e) => {
      const go = Math.abs(e.translationX) > 90 || Math.abs(e.velocityX) > 700;
      if (!go) { sx.value = withTiming(0, { duration: 260, easing: EASE }); return; }
      const d = e.translationX < 0 ? 1 : -1;
      sx.value = withTiming(-d * W, { duration: 170, easing: Easing.in(Easing.cubic) }, (f) => {
        if (!f) return;
        runOnJS(stepTo)(d);
        sx.value = d * W * 0.45;
        sx.value = withTiming(0, { duration: 340, easing: EASE });
      });
    });
  // Закрытие: карточка уезжает вниз и по пути собирается в мини-плеер (обложка садится в его кружок)
  const CLOSE = { duration: 480, easing: Easing.bezier(0.32, 0.72, 0, 1) };
  const dismiss = () => { onClosing?.(); ty.value = withTiming(0, CLOSE); pr.value = withTiming(0, CLOSE, (f) => { if (f) runOnJS(onClose)(); }); };
  // системная кнопка «Назад» (Android): сначала закрывает текст/очередь, потом сворачивает плеер
  if (reg) reg.current = () => { if (showL) setShowL(false); else if (showQ) setShowQ(false); else dismiss(); };
  const mkClose = (enabled: boolean) => Gesture.Pan().enabled(enabled).activeOffsetY(10).failOffsetX([-28, 28])
    .onUpdate((e) => { ty.value = Math.max(0, e.translationY); })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 900) {
        runOnJS(onClosing)();
        ty.value = withTiming(0, CLOSE);
        pr.value = withTiming(0, CLOSE, (f) => { if (f) runOnJS(onClose)(); });
      } else ty.value = withTiming(0, { duration: 320, easing: EASE });
    });

  const sleep = useSleep();
  if (!t) return null;
  const menu = () => { if (Platform.OS === 'ios') ActionSheetIOS.showActionSheetWithOptions({ options: ['Добавить в плейлист', 'Перейти к артисту', 'Перейти к альбому', 'История трека', 'Отмена'], cancelButtonIndex: 4, title: t.title }, (i) => {
    if (i === 0) addTo(t);
    if (i === 3) setStory(true);
    if (i === 1 && t.artistId) { dismiss(); open({ k: 'artist', id: t.artistId, name: t.artist }); }
    if (i === 2 && t.albumId) { dismiss(); open({ k: 'album', id: t.albumId }); } });
    else openMenu(t.title, [
      { text: 'Добавить в плейлист', icon: 'add-circle-outline', onPress: () => addTo(t) },
      ...(t.artistId ? [{ text: 'Перейти к артисту', icon: 'person-outline', onPress: () => { dismiss(); open({ k: 'artist', id: t.artistId, name: t.artist }); } }] : []),
      ...(t.albumId ? [{ text: 'Перейти к альбому', icon: 'disc-outline', onPress: () => { dismiss(); open({ k: 'album', id: t.albumId }); } }] : []),
      { text: 'История трека', icon: 'book-outline', onPress: () => setStory(true) },
      { text: sleep ? `Таймер сна · ${sleepLabel(sleep)}` : 'Таймер сна', icon: 'moon-outline', onPress: () => setTimeout(() => openSleepMenu(t.id), 260) },
      { text: 'Не нравится', icon: 'heart-dislike-outline', danger: true, onPress: () => { hap('error'); M_pulse.dislike(t).catch(() => {}); P.step(1); } },
    ]); };
  const goArtist = () => { if (t.artistId) { dismiss(); open({ k: 'artist', id: t.artistId, name: t.artist }); } };
  const source = t.album && t.album !== t.title ? t.album : t.artist;

  const TopBar = (
    <View style={{ position: 'absolute', top: padT + 4, left: 0, right: 0, height: BAR_H - 8, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22 }}>
      <RoundBtn icon="chevron-down" s={24} onPress={dismiss} />
      <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 10 }}>
        <Text style={{ fontFamily: SF, fontSize: 11, lineHeight: 13, fontWeight: '600', letterSpacing: 1.6, color: 'rgba(255,255,255,0.64)' }}>СЕЙЧАС ИГРАЕТ</Text>
        <Text numberOfLines={1} style={{ fontFamily: SF, fontSize: 13, lineHeight: 18, fontWeight: '500', color: WH, marginTop: 2 }}>{source}</Text>
      </View>
      <RoundBtn icon="more-horizontal" onPress={menu} />
    </View>
  );
  // Блок названия фиксированной высоты: при смене трека ничего не сдвигается. Размер шрифта считаем заранее
  // по длине текста (без «дёрганья» после отрисовки), старое и новое название плавно сменяют друг друга на одном месте.
  // исполнитель — того же размера, что название (если имя длинное, уменьшается ещё, чтобы влезть целиком)
  const tf = titleFont(t.title, W - SIDE * 2 - 52), af = Math.min(tf.size, artistFont(t.artist, W - SIDE * 2 - 52));
  const compact = showQ || showL;
  const Titles = (
    <View style={{ flex: 1, paddingRight: 8 }}>
      {/* длинное название / имя не уменьшаются, а плавно едут бегущей строкой с мягкими краями */}
      <View style={{ height: compact ? 28 : 50 }}>
        <Animated.View key={t.id + 't'} entering={FadeIn.duration(420).easing(Easing.out(Easing.cubic))} exiting={FadeOut.duration(260).easing(EASE_IO)} style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
          <Marquee text={t.title} height={compact ? 28 : 30} style={{ fontFamily: SF, fontSize: compact ? 20 : 22, lineHeight: compact ? 26 : 28, fontWeight: '600', color: WH, letterSpacing: -0.3 }} />
        </Animated.View>
      </View>
      <View style={{ height: compact ? 24 : 28 }}>
        <Animated.View key={t.id + 'a'} entering={FadeIn.duration(420).easing(Easing.out(Easing.cubic))} exiting={FadeOut.duration(260).easing(EASE_IO)} style={{ position: 'absolute', left: 0, right: 0, top: 0 }}>
          <Marquee text={t.artist} height={compact ? 24 : 28} onPress={goArtist} style={{ fontFamily: SF, fontSize: compact ? 17 : 22, lineHeight: compact ? 22 : 28, fontWeight: '400', color: 'rgba(255,255,255,0.64)', letterSpacing: -0.3 }} />
        </Animated.View>
      </View>
      {/* честно: Яндекс отдал только 30-секундный фрагмент (без входа или без подписки Плюс) */}
      {(P as any).preview && !compact && <Text numberOfLines={1} style={{ fontFamily: SF, fontSize: 12, lineHeight: 16, marginTop: 2, color: 'rgba(255,255,255,0.5)' }}>Фрагмент 30 с · целиком — после входа в Яндекс Музыку</Text>}
      {!!(P as any).playErr && !compact && <Text numberOfLines={2} style={{ fontFamily: SF, fontSize: 12, lineHeight: 16, marginTop: 2, color: '#ffb4b4' }}>{(P as any).playErr}</Text>}
    </View>
  );
  const Prog = <ProgBlock cover={t.cover} seek={P.seek} />;
  const Controls = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
      <Press onPress={P.toggleShuffle} hap="select" to={0.88} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><AShuffle on={!!P.shuffle} s={22} c={P.shuffle ? (P.T as any).accentGlow : 'rgba(255,255,255,.75)'} /></Press>
      <Press onPress={() => { setGoP((x) => x + 1); P.step(-1); }} hap="light" to={0.86} style={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center' }}><ASkip dir={-1} go={goP} s={38} c={WH} /></Press>
      {/* без круга — только значок, как остальные кнопки: чисто и минималистично */}
      <Press onPress={P.toggle} hap="medium" to={0.88} style={{ width: 78, height: 78, alignItems: 'center', justifyContent: 'center' }}>
        <PlayPause playing={playing} size={52} color={WH} />
      </Press>
      <Press onPress={() => { setGoN((x) => x + 1); P.step(1); }} hap="light" to={0.86} style={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center' }}><ASkip dir={1} go={goN} s={38} c={WH} /></Press>
      <Press onPress={P.cycleRep} hap="select" to={0.88} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        {HAS_SVG ? <ARepeat mode={P.rep || 0} s={22} c={P.rep ? (P.T as any).accentGlow : 'rgba(255,255,255,.75)'} /> : <View><LIcon n="repeat" s={22} c={P.rep ? (P.T as any).accentGlow : 'rgba(255,255,255,.75)'} />{P.rep === 2 && <Text style={{ position: 'absolute', top: -4, right: -6, fontSize: 10, fontWeight: '800', color: (P.T as any).accentGlow }}>1</Text>}</View>}
      </Press>
    </View>
  );
  const Bottom = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <LIcon n="volume-1" s={20} c="rgba(255,255,255,.7)" />
      <View style={{ flex: 1 }}><Bar value={P.volume} h0={4} onChange={P.previewVolume} onDone={P.setVolume} /></View>
      <Press onPress={() => setShowL(!showL)} to={0.88} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: showL ? 'rgba(255,255,255,.2)' : 'transparent' }}><ALyrics on={showL} s={21} c={showL ? WH : 'rgba(255,255,255,.75)'} /></Press>
      <Press onPress={() => setShowQ(!showQ)} to={0.88} style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: showQ ? 'rgba(255,255,255,.2)' : 'transparent' }}><AQueue on={showQ} s={21} c={showQ ? WH : 'rgba(255,255,255,.7)'} /></Press>
    </View>
  );
  const Content = (
    <View style={{ flex: 1, paddingTop: cTop, paddingHorizontal: SIDE, paddingBottom: ins.bottom + 14 }}>
      {showL ? (
        <Animated.View key="l" entering={FadeIn.duration(360).easing(EASE_OUT)} exiting={FadeOut.duration(180).easing(EASE_IO)} style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 82 }}><View style={{ width: 64 }} />{Titles}<BigLike t={t} /></View>
          <View style={{ flex: 1, marginTop: 6 }}><LiveLyrics t={t} /></View>
          {Prog}{Controls}<View style={{ height: 14 }} />{Bottom}
        </Animated.View>
      ) : showQ ? (
        <Animated.View key="q" entering={FadeIn.duration(360).easing(EASE_OUT)} exiting={FadeOut.duration(180).easing(EASE_IO)} style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 82 }}><View style={{ width: 64 }} />{Titles}<BigLike t={t} /></View>
          <Text style={{ fontFamily: SF, fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3, marginTop: 16, marginBottom: 6, color: WH }}>Далее</Text>
          <RNScroll style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
            {P.queue.map((x: Track, i: number) => <React.Fragment key={x.id + i}>
              {/* с этого места — подобранные похожие треки (автопродолжение) */}
              {i === P.autoFrom && <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, marginBottom: 4 }}><Ionicons name="infinite" size={16} color="rgba(255,255,255,0.6)" /><Text style={{ fontFamily: SF, fontSize: 13, lineHeight: 18, fontWeight: '600', color: 'rgba(255,255,255,0.6)' }}>{String(P.src || '').startsWith('artist:') && P.queue[P.autoFrom]?.artistId === Number(String(P.src).slice(7)) ? `Дальше — ещё ${api.baseArtist(P.queue[P.autoFrom].artist)}` : 'Дальше — похожие треки'}</Text></View>}
              <Press onPress={() => P.go(P.queue, i)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 7 }}>
              <Cover u={api.smallArt(x.cover)} size={46} r={12} /><View style={{ flex: 1 }}><Text numberOfLines={1} style={{ fontFamily: SF, fontSize: 17, lineHeight: 22, fontWeight: '600', color: i === P.idx ? (P.T as any).accentGlow : WH }}>{x.title}</Text><Text numberOfLines={1} style={{ fontFamily: SF, fontSize: 15, lineHeight: 20, fontWeight: '400', color: 'rgba(255,255,255,0.64)' }}>{x.artist}</Text></View></Press></React.Fragment>)}
          </RNScroll>
          {Prog}{Controls}<View style={{ height: 14 }} />{Bottom}
        </Animated.View>
      ) : (
        <Animated.View key="c" entering={FadeIn.duration(360).easing(EASE_OUT)} exiting={FadeOut.duration(180).easing(EASE_IO)} style={{ flex: 1 }}>
          <GestureDetector gesture={swipe}><View collapsable={false} style={{ height: cs }} /></GestureDetector>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 24 }}>{Titles}<BigLike t={t} /></View>
          {Prog}
          {Controls}
          <View style={{ flex: 1 }} />
          {Bottom}
        </Animated.View>
      )}
    </View>
  );
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar barStyle="light-content" />
      <GestureDetector gesture={mkClose(!showQ && !showL)}>
        <Animated.View collapsable={false} style={[{ position: 'absolute', backgroundColor: '#16161a', overflow: 'hidden' }, shell]}>
          <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: W, height: H }, fixed]}>
            <LiveBg u={t.cover} />
            <LinearGradient colors={['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.30)', 'rgba(0,0,0,0.55)']} locations={[0, 0.6, 1]} style={StyleSheet.absoluteFill} />
          </Animated.View>
          <Animated.View style={[{ position: 'absolute', width: W, height: H }, fixed, body]}>
            {Content}
            {/* «ручка» карточки — подсказка, что плеер можно смахнуть вниз */}
            <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: padT - 12, left: W / 2 - 18, width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.35)' }, grab]} />
            {/* верхняя панель — за неё же можно тянуть вниз в режиме очереди */}
            <GestureDetector gesture={mkClose(showQ || showL)}>
              <View collapsable={false} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: showQ || showL ? cTop + 64 : padT + BAR_H }}>{TopBar}</View>
            </GestureDetector>
          </Animated.View>
          <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: cs, height: cs, overflow: 'hidden' }, fly]}>
            <CoverStack u={api.hiArt(t.cover)} />
          </Animated.View>
        </Animated.View>
      </GestureDetector>
      {story && <StorySheet t={t} onClose={() => setStory(false)} />}
    </GestureHandlerRootView>
  );
}

// Ползунок и время трека. Позиция меняется несколько раз в секунду, поэтому её слушает только этот блок,
// а не весь большой плеер (раньше от каждого обновления позиции перерисовывался весь плеер со списком «Далее»).
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function ProgBlock({ cover, seek }: { cover?: string; seek: (s: number) => void }) {
  const PR = useProgress();
  const frac = PR.dur ? Math.min(1, PR.pos / PR.dur) : 0;
  const durRef = useRef(PR.dur); durRef.current = PR.dur;
  const onDone = useCallback((f: number) => seek(f * durRef.current), [seek]);
  return (
    <View style={{ marginTop: 14 }}>
      {NEW_SLIDER ? <Comet value={frac} cover={cover} onDone={onDone} /> : <Bar value={frac} knob onDone={onDone} />}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 }}>
        <Text style={{ fontFamily: SF, fontSize: 12, lineHeight: 16, fontWeight: '600', color: 'rgba(255,255,255,0.64)', fontVariant: ['tabular-nums'] }}>{fmtClock(PR.pos)}</Text>
        <Text style={{ fontFamily: SF, fontSize: 12, lineHeight: 16, fontWeight: '600', color: 'rgba(255,255,255,0.64)', fontVariant: ['tabular-nums'] }}>-{fmtClock(Math.max(0, PR.dur - PR.pos))}</Text>
      </View>
    </View>
  );
}

// Кнопки мини-плеера: мягко и быстро, без пружин.
// Иконка play/pause: прежняя уменьшается и гаснет, новая проявляется с лёгким увеличением.
const iconIn = () => { 'worklet'; return { initialValues: { opacity: 0, transform: [{ scale: 0.55 }] }, animations: { opacity: withTiming(1, { duration: 170 }), transform: [{ scale: withTiming(1, { duration: 230, easing: Easing.out(Easing.cubic) }) }] } }; };
const iconOut = () => { 'worklet'; return { initialValues: { opacity: 1, transform: [{ scale: 1 }] }, animations: { opacity: withTiming(0, { duration: 120 }), transform: [{ scale: withTiming(0.55, { duration: 140, easing: Easing.in(Easing.quad) }) }] } }; };
// эквалайзер и кнопка мини-плеера — только они следят за «играет/пауза»
function MiniPlayCtl({ onPress }: { onPress: () => void }) {
  const playing = usePlaying();
  return <>{playing && <Eq playing />}<MiniPlay playing={playing} onPress={onPress} /></>;
}
function MiniPlay({ playing, onPress }: { playing: boolean; onPress: () => void }) {
  const T = useT(); const k = useSharedValue(1);
  const st = useAnimatedStyle(() => ({ transform: [{ scale: k.value }] }));
  return (
    <Pressable onPress={() => { hap('medium'); onPress(); }} hitSlop={6}
      onPressIn={() => { k.value = withTiming(0.84, { duration: 90, easing: Easing.out(Easing.quad) }); }}
      onPressOut={() => { k.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) }); }}
      style={{ width: 40, height: 44, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ width: 26, height: 26 }, st]}>
        <PlayPause playing={playing} size={26} color={T.ink} />
      </Animated.View>
    </Pressable>
  );
}
// «Далее»: иконка быстро улетает вправо за край капсулы и возвращается слева на место
function MiniNext({ onPress }: { onPress: () => void }) {
  const T = useT(); const x = useSharedValue(0); const o = useSharedValue(1);
  const st = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateX: x.value }] }));
  const go = () => {
    hap('light'); onPress();
    x.value = withSequence(withTiming(36, { duration: 150, easing: Easing.in(Easing.cubic) }), withTiming(-20, { duration: 0 }), withTiming(0, { duration: 210, easing: Easing.out(Easing.cubic) }));
    o.value = withSequence(withTiming(0, { duration: 150, easing: Easing.in(Easing.quad) }), withTiming(0, { duration: 0 }), withTiming(1, { duration: 190 }));
  };
  return (
    <Pressable onPress={go} hitSlop={6} style={{ width: 40, height: 44, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={st}><PIcon n="next" s={24} c={T.ink2} /></Animated.View>
    </Pressable>
  );
}

// Обложка мини-плеера: новая плавно проявляется поверх прежней
function MiniArt({ u }: { u: string }) {
  const T = useT(); const layers = useLayers(u);
  return <View style={{ width: 44, height: 44, borderRadius: 22, overflow: 'hidden', backgroundColor: T.ph }}>{layers.map((l) => <CoverFadeLayer key={l.k} u={l.u} first={l.k === 0} />)}</View>;
}

// «Сколько треков артиста прослушано» (кольца на главной): первый запуск — любимые и недавние считаем
// прослушанными; дальше трек засчитывается, если играл 30 секунд
// Таймер сна: по времени — проверка раз в 5 с; «после трека» — пауза, как только трек сменился
function SleepWatch() {
  const P = usePlayer(); const cur = useCurId(); const s = useSleep(); const pr = useRef(P); pr.current = P;
  useEffect(() => { if (!s || s.track) return; const iv = setInterval(() => { const v = sleepGet(); if (v && !v.track && Date.now() >= v.at) { sleepSet(null); if (pr.current.playing) pr.current.toggle(); } }, 5000); return () => clearInterval(iv); }, [s]);
  useEffect(() => { const v = sleepGet(); if (v && v.track && cur && cur !== v.track) { sleepSet(null); if (pr.current.playing) pr.current.toggle(); } }, [cur]);
  return null;
}
export function openSleepMenu(curId?: string) {
  const s = sleepGet(); const set = (m: number) => sleepSet({ at: Date.now() + m * 60000 });
  openMenu(s ? `Таймер сна · ${sleepLabel(s)}` : 'Таймер сна', [
    ...[15, 30, 45, 60].map((m) => ({ text: `${m} минут`, icon: 'time-outline', onPress: () => set(m) })),
    ...(curId ? [{ text: 'После этого трека', icon: 'musical-notes-outline', onPress: () => sleepSet({ at: 0, track: curId }) }] : []),
    ...(s ? [{ text: 'Выключить таймер', icon: 'moon-outline', danger: true, onPress: () => sleepSet(null) }] : []),
  ]);
}
function HeardTracker() {
  const P = usePlayer(); const cur = useCurId(); const pr = useRef(P); pr.current = P;
  const seeded = useRef(false);
  useEffect(() => { if (seeded.current || !(P.favs.length || P.recent.length)) return; seeded.current = true; heardSeed([...(P.favs as Track[]), ...(P.recent as Track[])]); }, [P.favs.length, P.recent.length]);
  useEffect(() => { if (!cur) return; const tm = setTimeout(() => { const c = pr.current.cur; if (c && c.id === cur) markHeard([c]); }, 30000); return () => clearTimeout(tm); }, [cur]);
  return null;
}

// Содержимое вкладки. Обёрнуто в memo: при переключении вкладок перерисовывается только та, что
// проявляется или прячется (меняется active), а не всё приложение — меньше работы, ровнее звук и анимация.
const PaneBody = React.memo(function PaneBody({ k, active, open, openFull, onPulse }: { k: 'home' | 'pulse' | 'lib'; active: boolean; open: (s: any) => void; openFull: () => void; onPulse?: () => void }) {
  return (
    <Layer edge={k !== 'pulse'} home={k === 'home'} right={k === 'home' ? <AvatarBtn onPress={() => open({ k: 'profile' })} /> : undefined} extra={k === 'home' ? <SearchBtn onPress={() => open({ k: 'search' })} /> : undefined}>
      {k === 'home' ? <Home open={open} onPulse={onPulse} /> : k === 'pulse' ? <PulseScreen openFull={openFull} active={active} /> : <Library open={open} />}
    </Layer>
  );
});

// Вкладка, которая не пересоздаётся: видимая — поверх и принимает касания, остальные прозрачны и «спят»
// Спрятанная вкладка после затухания уезжает далеко за край экрана: она точно не перекрывает другие экраны,
// не ловит касания и телефон её не рисует (меньше работы во время музыки). Прокрутка и состояние сохраняются.
// covered — вкладку целиком закрывают открытые поверх экраны: её тоже можно не рисовать.
// Параллакс как в iOS: экран под открывающимся чуть уезжает влево (на 28%) и слегка темнеет,
// при жесте «назад» — возвращается вместе с пальцем. Только transform и прозрачность — почти бесплатно.
const PAR = 0.28, PAR_DIM = 0.1;
function TabPane({ active, covered, under, shift, children }: { active: boolean; covered?: boolean; under?: boolean; shift?: any; children: React.ReactNode }) {
  const { width: SW } = useWin();
  const o = useSharedValue(active ? 1 : 0); const off = useSharedValue(active ? 0 : 1); const cov = useSharedValue(covered ? 1 : 0);
  useEffect(() => {
    // переход между вкладками: новая проявляется поверх прежней (240 мс), прежняя не гаснет одновременно с ней,
    // а просто убирается, когда новая уже проявилась. Так в каждый кадр анимируется ОДИН слой, а не два
    // полупрозрачных друг над другом — вдвое меньше работы, без подтормаживаний и быстрее
    if (active) { off.value = 0; o.value = withTiming(1, { duration: 240, easing: EASE_OUT }); }
    else o.value = withDelay(250, withTiming(0, { duration: 0 }, (f) => { if (f) off.value = 1; }));
  }, [active]);
  // закрыта экранами — убираем только когда экран поверх уже доехал (а не в первый кадр его анимации)
  const lateCov = !useLater(!covered);
  useEffect(() => { cov.value = lateCov ? 1 : 0; }, [lateCov]);
  const pv = useVisible(); const lv = useLater(active && !covered); const vis = pv && lv;
  const st = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateX: Math.max(off.value, cov.value) * 10000 - (under && shift ? PAR * SW * shift.value : 0) }] }), [under, SW]);
  const dim = useAnimatedStyle(() => ({ opacity: under && shift ? PAR_DIM * shift.value : 0 }), [under]);
  return (
    <VisCtx.Provider value={vis}>
      <Animated.View pointerEvents={active ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, { zIndex: active ? 2 : 1 }, st]}>
        {children}
        {under && <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000', zIndex: 50 }, dim]} />}
      </Animated.View>
    </VisCtx.Provider>
  );
}

// Экран поверх вкладок (профиль, поиск, плейлист, артист, альбом…). Въезжает справа и уезжает вправо
// своей собственной анимацией — без «layout animations», которые конфликтовали со сдвигом при жесте «назад».
// deep — экран лежит под двумя и более другими: его не видно даже при жесте «назад», поэтому он
// уезжает за край (не рисуется), а его состояние и прокрутка сохраняются.
const PUSH = Easing.bezier(0.32, 0.72, 0, 1);   // мягкий «доезд» как у системных экранов iOS
function StackScreen({ top, under, deep, far, drag, shift, leave, onGone, children }: { top: boolean; under?: boolean; deep?: boolean; far?: boolean; drag: any; shift: any; leave: null | 'anim' | 'instant'; onGone: () => void; children: React.ReactNode }) {
  const { width } = useWin();
  const tx = useSharedValue(width);
  useEffect(() => { tx.value = withTiming(0, { duration: 460, easing: PUSH }); }, []);
  // верхний экран сообщает, насколько он закрыл нижний (0…1) — по этому нижний делает параллакс
  useAnimatedReaction(() => (top ? Math.min(1, Math.max(0, 1 - (tx.value + drag.value) / width)) : -1), (v) => { if (v >= 0) shift.value = v; }, [top, width]);
  useEffect(() => {
    if (leave === 'anim') tx.value = withTiming(width, { duration: 340, easing: PUSH }, (f) => { if (f) runOnJS(onGone)(); });
    // после жеста экран уже за краем: фиксируем его там и сбрасываем жест — без мигания
    else if (leave === 'instant') { runOnUI(() => { 'worklet'; tx.value = width; drag.value = 0; })(); onGone(); }
  }, [leave]);
  const T0 = useT();
  const away = !useLater(!deep);   // глубоко под другими — убираем с экрана, когда переход закончился
  const pv = useVisible(); const lv = useLater(top); const vis = pv && lv;
  const st = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value + (top ? drag.value : 0) + (away ? 10000 : 0) - (under ? PAR * width * shift.value : 0) }] }), [top, under, away, width]);
  const dim = useAnimatedStyle(() => ({ opacity: under ? PAR_DIM * shift.value : 0 }), [under]);
  return (
    <VisCtx.Provider value={vis}>
      <Animated.View pointerEvents={leave ? 'none' : 'auto'} style={[StyleSheet.absoluteFill, { zIndex: 10, backgroundColor: T0.bgBase, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: -6, height: 0 } }, st]}>
        {far ? null : children}
        {under && <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000', zIndex: 50 }, dim]} />}
      </Animated.View>
    </VisCtx.Provider>
  );
}

// Содержимое экрана стека. memo: при перерисовке главного экрана (смена трека, открытие плеера и т.п.)
// открытые экраны не пересобираются заново — только если их что-то действительно касается.
const StackBody = React.memo(function StackBody({ s, open, back, onTheme, onPulse }: { s: any; open: (s: any) => void; back: () => void; onTheme: (x: number, y: number, kind?: 'dark' | 'black', on?: boolean) => void; onPulse: () => void }) {
  // квиз — свой полноэкранный экран (фон со звёздами, своя верхняя панель)
  if (s.k === 'quiz') return <QuizScreen id={s.id} name={s.name} back={back} />;
  const body = s.k === 'search' ? <Search open={open} auto />
    : s.k === 'stats' ? <StatsScreen open={open} />
    : s.k === 'profile' ? <ProfileScreen open={open} onTheme={onTheme} onPulse={onPulse} />
    : s.k === 'playlist' || s.k === 'favs' || s.k === 'recent' ? <PlaylistScreen key={s.id || s.k} id={s.id} fav={s.k === 'favs'} recent={s.k === 'recent'} fresh={s.fresh} open={open} back={back} />
    : s.k === 'banned' ? <BannedScreen />
    : s.k === 'ai' ? <AiScreen open={open} back={back} q0={s.q} />
    : s.k === 'ym' ? <YmScreen />
    : s.k === 'album' ? <Album key={s.id} id={s.id} open={open} /> : s.k === 'artist' ? <Artist key={s.id} id={s.id} name={s.name} open={open} /> : s.k === 'chart' ? <ChartScreen open={open} /> : s.k === 'coll' ? <CollScreen s={s} open={open} /> : s.k === 'list' ? <ListScreen title={s.title} tracks={s.tracks} open={open} /> : <AlbumsScreen title={s.title} albums={s.albums} open={open} />;
  return s.k === 'artist' || s.k === 'album' || s.k === 'profile'
    ? <HeroLayer onBack={back}>{body}</HeroLayer>
    : <Layer left={<IconBtn icon="chevron-left" size={44} onPress={back} />}>{body}</Layer>;
});

// Нижняя навигация как в промо: стеклянная капсула, активная вкладка — розовая «пилюля», которая плавно переезжает
function TabDock({ tab, onTab }: { tab: string; onTab: (k: any) => void }) {
  const T = useT(); const ty = useTy(); const { width } = useWin();
  // минималистичные иконки одного семейства: контур — неактивная, заливка — активная
  // контур — неактивная, заливка — активная. Домик — цельный силуэт (крыша и стены одной фигурой)
  // «Пульс» — фирменная звезда: контур, когда вкладка не выбрана, и залитая — когда выбрана
  const tabs: [string, string, string, string][] = [['home', 'home', 'home-outline', 'Главная'], ['pulse', '', '', 'Пульс'], ['lib', 'musical-notes', 'musical-notes-outline', 'Моя музыка']];
  const idx = Math.max(0, tabs.findIndex((x) => x[0] === tab)); const tw = (width - 32 - 12) / 3;
  const px = useSharedValue(idx);
  useEffect(() => { px.value = withTiming(idx, { duration: 260, easing: EASE }); }, [idx]);
  const pill = useAnimatedStyle(() => ({ transform: [{ translateX: px.value * tw }] }), [tw]);
  const abs = StyleSheet.absoluteFill;
  return (
    <View style={{ position: 'absolute', left: 16, right: 16, bottom: DOCK_B, height: TAB_H, zIndex: 30, borderRadius: TAB_H / 2, backgroundColor: (T as any).dark ? ((T as any).black ? '#141416' : '#1d1c23') : '#ffffff', elevation: (T as any).dark ? 0 : 3 }}>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 6, top: 6, width: tw, height: TAB_H - 12, borderRadius: (TAB_H - 12) / 2, overflow: 'hidden', backgroundColor: (T as any).accentPill }, pill]}>
        {/* двухцветный вариант — пилюля переливается из первого цвета во второй */}
        {(T as any).duo && <LinearGradient colors={(T as any).tri ? [(T as any).accentPillA, (T as any).accentPillB, (T as any).accentPillC] : [(T as any).accentPillA, (T as any).accentPillB]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />}
      </Animated.View>
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6 }}>
        {tabs.map(([k, ic, ico, lb]) => { const on = tab === k; return (
          <Press key={k} hap="select" onPress={() => onTab(k)} to={0.92} style={{ width: tw, height: TAB_H - 12, alignItems: 'center', justifyContent: 'center', gap: 3 }}>
            {HAS_TAB_ICONS ? <View style={{ width: 30, height: 26, alignItems: 'center', justifyContent: 'center' }}><TabIcon kind={k as any} on={on} color={T.accentText} color2={(T as any).duo ? (T as any).accent2 : undefined} color3={(T as any).tri ? (T as any).accent3 : undefined} idle={T.ink3} size={k === 'pulse' ? 28 : k === 'home' ? 26 : 25} /></View> :
            <Animated.View key={on ? 'on' : 'off'} entering={FadeIn.duration(220).easing(EASE_OUT)}>{k === 'home'
              ? <MaterialCommunityIcons name={(on ? 'home' : 'home-outline') as any} size={25} color={on ? T.accentText : T.ink3} style={{ marginVertical: -1.5 }} />
              : k === 'pulse'
                ? <View style={{ width: 30, height: 24, alignItems: 'center', justifyContent: 'center' }}><LStarIcon w={27} on={on} color={on ? T.accentText : T.ink3} /></View>
                : <Ionicons name={(on ? ic : ico) as any} size={22} color={on ? T.accentText : T.ink3} />}</Animated.View>}
            <Text style={[ty.caption, { fontSize: 10.5, fontWeight: '600', color: on ? T.accentText : T.ink3 }]}>{lb}</Text>
          </Press>); })}
      </View>
    </View>
  );
}

// Если часть файлов в папке src осталась от прошлой версии, приложение падало с непонятной ошибкой
// «undefined is not a function». Теперь вместо этого — понятная подсказка, какие файлы старые.
const MODS: [string, any][] = [['ui.tsx', M_ui], ['player.tsx', M_player], ['PulseTab.tsx', M_pulseTab], ['TabIcons.tsx', M_tabIcons], ['api.ts', api],
  ['audioCache.ts', M_audio], ['pulse.ts', M_pulse], ['spectrum.ts', M_spectrum], ['theme.ts', M_theme], ['logoData.ts', M_logo], ['Quiz.tsx', M_quiz], ['quizData.ts', M_quizData], ['ai.ts', M_ai], ['waterData.ts', M_water], ['yandex.ts', M_ym]];
const STALE = MODS.filter(([, m]) => (m as any)?.BUILD !== BUILD).map(([n]) => n);
export function Shell() {
  if (STALE.length) return <StaleFiles files={STALE} />;
  return <View style={{ flex: 1 }}><ShellMain /><BootSplash /></View>;
}
function StaleFiles({ files }: { files: string[] }) {
  return (
    <View style={{ flex: 1, backgroundColor: '#101014', justifyContent: 'center', padding: 28 }}>
      <Text style={{ color: '#fff', fontSize: 24, fontWeight: '700' }}>Файлы из разных версий</Text>
      <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 16, lineHeight: 22, marginTop: 12 }}>
        {`В папке src часть файлов осталась от прошлой версии (сборка ${BUILD}):\n\n${files.join('\n')}\n\nЗамените папку src целиком — из последнего pulse-expo.zip — и перезапустите: npx expo start -c`}
      </Text>
    </View>
  );
}
function ShellMain() {
  useUpdateNag();
  const P = usePlayer(); const T = useT(); const ty = useTy(); const ins = useSafeAreaInsets(); const { width } = useWin();
  // тёмная тема — снизу почти чёрный; светлая — цвет фона (на чёрном не читались бы тёмные подписи вкладок)
  // мини-плеер — сплошная карточка (не просвечивает): тёмная в тёмной теме, белая в светлой
  const dockMini = (T as any).dark ? ((T as any).black ? '#141416' : '#1d1c23') : '#ffffff';
  const padT = useTopPad(); const [addFor, setAddFor] = useState<Track | null>(null); const [dir, setDir] = useState(1);
  const bgP = useSharedValue(0);   // насколько раскрыт большой плеер (0…1) — приложение под ним уходит вглубь
  const deepV = useSharedValue(0);   // 1 — плеер раскрыт полностью: приложение под ним можно не рисовать (пока плеер не тянут вниз)
  const appSt = useAnimatedStyle(() => ({ opacity: deepV.value && bgP.value > 0.995 ? 0 : 1, borderRadius: 44 * Math.min(1, bgP.value * 4), transform: [{ scale: 1 - 0.07 * bgP.value }, { translateY: 10 * bgP.value }] }));
  const dimSt = useAnimatedStyle(() => ({ opacity: 0.45 * bgP.value }));
  const [tab, setTab] = useState<'home' | 'pulse' | 'lib'>('home'); const [stack, setStack] = useState<any[]>([]); const [full, setFull] = useState(false);
  const [closing, setClosing] = useState(false);
  const [leaving, setLeaving] = useState<{ i: number; m: 'anim' | 'instant' } | null>(null);   // какой экран сейчас закрывается
  // «видимый» стек: закрывающийся экран уже не считается. Так меню, мини-плеер и капсула «Моего пульса»
  // начинают появляться одновременно с уходом экрана (в такт анимации), а не рывком после неё
  const shown = leaving ? stack.slice(0, leaving.i) : stack;
  const topK = shown.length > 0 ? shown[shown.length - 1].k : '';
  const quizOn = topK === 'quiz';   // квиз — без меню и мини-плеера
  const aiOn = topK === 'ai';       // ИИ-чат — без меню (снизу поле ввода), но с мини-плеером
  const stackN = useRef(0); stackN.current = stack.length;
  const [wipe, setWipe] = useState<{ x: number; y: number; color: string; k: number; kind?: 'dark' | 'black'; on?: boolean } | null>(null);
  // постоянные (не пересоздаются) — чтобы вкладки не перерисовывались зря при каждом переключении
  const shift = useSharedValue(0);   // насколько верхний экран закрыл нижний (для параллакса)
  // новый экран начинает с края — нижний пока стоит на месте (без скачка в первый кадр)
  const lastOpen = useRef(0);
  const open = useCallback((s: any) => {
    // двойное нажатие (профиль, поиск, артист, альбом, плейлист…) больше не открывает экран дважды:
    // пока предыдущий экран въезжает (0,6 с) новые открытия игнорируются, а тот же экран поверх самого себя не открывается
    const now = Date.now(); if (now - lastOpen.current < 600) return; lastOpen.current = now;
    // данные экрана начинают грузиться в момент нажатия (из кэша — мгновенно), к концу перехода они обычно уже есть
    if (s.k === 'artist') { if (s.id) api.artist(s.id).catch(() => {}); if (s.name) api.artistDeezer(s.name).catch(() => {}); }
    else if (s.k === 'album' && s.id) api.album(s.id).catch(() => {});
    shift.value = 0;
    setStack((x) => { const t = x[x.length - 1]; if (t && t.k === s.k && t.id === s.id && t.name === s.name) return x; return [...x, s]; });
  }, []);
  const back = useCallback(() => { const n = stackN.current; if (n) setLeaving((l) => l || { i: n - 1, m: 'anim' }); }, []);
  // ИИ-диджей открывается из вкладки «Пульс», поиска и профиля
  useEffect(() => M_ai.onOpenAi((q) => open({ k: 'ai', q })), [open]);
  const gone = useCallback((i: number) => { setStack((s) => s.slice(0, i)); setLeaving(null); }, []);
  // системная кнопка «Назад» на Android: плеер → открытый экран → вкладка «Главная» → выход
  const fullBack = useRef<null | (() => void)>(null);
  const backSt = useRef({ full, closing, tab }); backSt.current = { full, closing, tab };
  useEffect(() => {
    const h = BackHandler.addEventListener('hardwareBackPress', () => {
      const b = backSt.current;
      if (b.full && !b.closing && fullBack.current) { fullBack.current(); return true; }
      if (stackN.current) { back(); return true; }
      if (b.tab !== 'home') { setTab('home'); return true; }
      return false;
    });
    return () => h.remove();
  }, [back]);
  const abs = StyleSheet.absoluteFill;
  const shadow = { shadowColor: '#000', shadowOpacity: T.shadow, shadowRadius: 16, shadowOffset: { width: 0, height: 12 } };

  // Жест «назад» от левого края экрана: верхний экран едет за пальцем и уходит вправо
  const x = useSharedValue(0);
  const finishBack = () => { const n = stackN.current; if (n) setLeaving({ i: n - 1, m: 'instant' }); else x.value = 0; };
  const edgeG = Gesture.Pan().enabled(stack.length > 0 && !leaving).activeOffsetX(8).failOffsetY([-30, 30])
    .onUpdate((e) => { x.value = Math.max(0, e.translationX); })
    .onEnd((e) => {
      // экран доезжает с той же скоростью, с какой его вёл палец (без рывка и без «залипания»)
      if (e.translationX > 80 || e.velocityX > 600) {
        const rest = Math.max(0, width - x.value), v = Math.max(700, e.velocityX);
        x.value = withTiming(width, { duration: Math.min(340, Math.max(160, (rest / v) * 1000 * 1.6)), easing: Easing.out(Easing.quad) }, (f) => { if (f) runOnJS(finishBack)(); });
      } else x.value = withTiming(0, { duration: 300, easing: EASE_OUT });
    });

  // Мини-плеер: свайп вверх — открыть, влево/вправо — следующий/предыдущий трек
  const pr = useRef(P); pr.current = P;
  const stepBy = (d: number) => pr.current.step(d);
  const openFull = useCallback(() => { setClosing(false); setFull(true); }, []);
  const miniG = Gesture.Pan().activeOffsetX([-14, 14]).activeOffsetY(-12)
    .onEnd((e) => {
      if (e.translationY < -30 && Math.abs(e.translationY) > Math.abs(e.translationX)) runOnJS(openFull)();
      else if (e.translationX < -50) runOnJS(stepBy)(1);
      else if (e.translationX > 50) runOnJS(stepBy)(-1);
    });

  const TABS = ['home', 'pulse', 'lib'] as const;
  const [seen, setSeen] = useState<Record<string, boolean>>({ home: true });
  useEffect(() => { setSeen((x) => (x[tab] ? x : { ...x, [tab]: true })); }, [tab]);
  const goTab = useCallback((k: any) => { Keyboard.dismiss(); setStack([]); setLeaving(null); x.value = 0; shift.value = 0; setTab(k); }, []);
  const goPulse = useCallback(() => goTab('pulse'), [goTab]);
  const darkRef = useRef(T.dark); darkRef.current = T.dark;
  // kind: 'dark' — светлая ⇄ тёмная; 'black' — включить/выключить чёрную тему (круг — цвета новой темы)
  const themeAt = useCallback((x: number, y: number, kind: 'dark' | 'black' = 'dark', on?: boolean) => setWipe((w) => w || { x, y, kind, on,
    color: kind === 'black' ? (on ? '#000000' : (P.dark ? DARK.bgBase : LIGHT.bgBase)) : darkRef.current ? LIGHT.bgBase : DARK.bgBase, k: Date.now() }), [P.dark]);
  const onPulse = useCallback(() => goTab('pulse'), [goTab]);
  const n = stack.length;
  const pulseOn = useLater(tab === 'pulse' && n === 0);   // живая линия засыпает, когда поверх доехал другой экран
  // когда полный плеер раскрылся, приложение под ним не рисуется вовсе (его всё равно не видно) — телефон не тратит
  // силы на размытие меню и мини-плеера под плеером; при закрытии оно появляется сразу, до начала сжатия
  const [deep, setDeep] = useState(false);
  useEffect(() => { if (full && !closing) { const t = setTimeout(() => setDeep(true), 700); return () => clearTimeout(t); } setDeep(false); }, [full, closing]);
  useEffect(() => { deepV.value = deep ? 1 : 0; }, [deep]);
  const appVis = useLater(!full, 700);                    // под раскрытым плеером украшающие анимации на паузе

  return (
    <AddCtx.Provider value={setAddFor}>
    <View style={{ flex: 1, backgroundColor: '#000' }} onTouchStart={poke} onStartShouldSetResponderCapture={wakeCapture}>
      <StatusBar barStyle={T.dark ? 'light-content' : 'dark-content'} />
      <Animated.View style={[abs, { overflow: 'hidden', backgroundColor: T.bgBase }, appSt]}>
      <VisCtx.Provider value={appVis}>

      {/* Вкладки создаются один раз и дальше живут: при переключении ничего не загружается заново,
          поэтому переход мгновенный и не тормозит даже во время музыки. Видимую плавно проявляем. */}
      {TABS.map((k) => seen[k] && (
        <TabPane key={k} active={tab === k} covered={n >= 2} under={tab === k && n === 1} shift={shift}>
          <PaneBody k={k} active={k === 'pulse' && pulseOn} open={open} openFull={openFull} onPulse={goPulse} />
        </TabPane>
      ))}

      {stack.map((s, i) => (
        <StackScreen key={'s' + i} top={i === n - 1} under={i === n - 2} deep={i < n - 2} far={i < n - 4} drag={x} shift={shift} leave={leaving && leaving.i === i ? leaving.m : null} onGone={() => gone(i)}>
          <StackBody s={s} open={open} back={back} onTheme={themeAt} onPulse={onPulse} />
        </StackScreen>
      ))}
      {stack.length > 0 && (
        <GestureDetector gesture={edgeG}>
          <View collapsable={false} style={{ position: 'absolute', left: 0, top: padT + 56, bottom: 110, width: 30, zIndex: 20 }} />
        </GestureDetector>
      )}

      {/* во время квиза меню и мини-плеер прячутся — квиз во весь экран */}
      {!quizOn && !aiOn && <Animated.View entering={rise(40, 16, 440)} exiting={FadeOut.duration(200).easing(EASE_IO)} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, zIndex: 30 }} pointerEvents="box-none"><TabDock tab={tab} onTab={goTab} /></Animated.View>}

      <AmbientDriver />
      <HeardTracker /><SleepWatch />
      <PulseFeeder />
      <PulseLearner />
      {/* на вкладке «Пульс» плеер — сам экран, поэтому мини-плеер там прячется (если играет «Мой пульс») */}
      {/* «Мой пульс»: на месте мини-плеера — капсула управления того же вида (дизлайк · пуск · дальше · лайк) */}
      {P.cur && !quizOn && tab === 'pulse' && P.src === 'pulse' && shown.length === 0 && (
        <Animated.View key="pbar" entering={FadeIn.duration(360).easing(EASE_OUT)} exiting={FadeOut.duration(260).easing(EASE_IO)} style={{ position: 'absolute', left: 16, right: 16, bottom: DOCK_B + TAB_H + 8, height: MINI_H, zIndex: 31, elevation: 5, borderRadius: 30 }}>
          <PulseBar />
        </Animated.View>
      )}
      {P.cur && !quizOn && !(tab === 'pulse' && P.src === 'pulse' && shown.length === 0) && (
        <GestureDetector gesture={miniG}>
          <Animated.View entering={rise(0, 14, 460)} exiting={FadeOut.duration(260).easing(EASE_IO)} style={{ position: 'absolute', left: 16, right: 16, bottom: DOCK_B + TAB_H + 8, height: MINI_H, zIndex: 31, elevation: 5, borderRadius: 30 }}>
            <View style={[abs, { borderRadius: 30, backgroundColor: dockMini, elevation: (T as any).dark ? 0 : 3 }]} />
            <Pressable onPress={openFull} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 8, paddingRight: 6, borderRadius: 30, overflow: 'hidden' }}>
              <MiniArt u={api.smallArt(P.cur.cover)} />
              <View style={{ flex: 1, height: 40 }}>
                <Animated.View key={P.cur.id} entering={FadeIn.duration(380).easing(EASE_OUT)} exiting={FadeOut.duration(220).easing(EASE_IO)} style={{ position: 'absolute', left: 0, right: 0, top: 0 }}>
                  <Text numberOfLines={1} style={ty.miniTitle}>{P.cur.title}</Text><Text numberOfLines={1} style={ty.footnote}>{P.cur.artist}</Text>
                </Animated.View>
              </View>
              <MiniPlayCtl onPress={P.toggle} />
              <MiniNext onPress={() => P.step(1)} />
            </Pressable>
          </Animated.View>
        </GestureDetector>
      )}
      </VisCtx.Provider>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[abs, { backgroundColor: '#000', zIndex: 35 }, dimSt]} />
      {addFor && <AddSheet t={addFor} onClose={() => setAddFor(null)} />}
      <MenuHost />
      {wipe && <ThemeWipe w={wipe} onCovered={() => { hap('medium'); if (wipe.kind === 'black') P.setBlack(!!wipe.on); else P.toggleDark(); }} onDone={() => setWipe(null)} />}
      {/* Полный плеер — обычный слой поверх экрана (без системного Modal), поэтому после закрытия нет задержки; пока он сжимается, касания уже проходят на главный экран */}
      {full && (
        <View pointerEvents={closing ? 'none' : 'auto'} style={[abs, { zIndex: 40 }]}>
          <Full reg={fullBack} bgP={bgP} onClosing={() => setClosing(true)} onClose={() => { setFull(false); setClosing(false); bgP.value = 0; }} open={open} />
        </View>
      )}
    </View>
    </AddCtx.Provider>
  );
}

