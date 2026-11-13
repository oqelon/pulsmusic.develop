// Живой текст в большом плеере — как в версии для Windows: прямо на живом фоне, текущая строка заливается
// светом по словам (время слов — из расширенного LRC или из общей базы ИИ-разметки, иначе по слогам),
// пауза исполнителя — пауза в подсветке, эдлибы в скобках — отдельной строкой и в своё время,
// прошедшие строки тускнеют, следующие — чуть тише и тем сильнее, чем дальше. Листаете сами — всё чётко,
// через 3,5 с текст возвращается к песне. Нажатие на строку — перемотка. «−/+» — сдвиг текста для трека.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, Pressable, Platform, ActivityIndicator, NativeSyntheticEvent, NativeScrollEvent } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, SharedValue, FadeIn } from 'react-native-reanimated';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePlayer } from './player';
import { PcIcon } from './PcIcons';
import { getLyrics, wordTimes, adFlags } from './lyrics';
import type { Lyrics, Line } from './lyrics';

const SF = Platform.OS === 'ios' ? 'System' : undefined;
const FS = 27, LH = 34;
const OFF_KEY = 'pulse_lyr_off';

// одно слово текущей строки: тусклое, поверх — то же слово белым, открывается слева направо по времени
function Word({ text, a, b, time, size, ad }: { text: string; a: number; b: number; time: SharedValue<number>; size: number; ad?: boolean }) {
  const w = useSharedValue(0); const [ww, setWw] = useState(0);
  const st = useAnimatedStyle(() => {
    const d = Math.max(0.05, b - a); let p = (time.value - a) / d; p = p < 0 ? 0 : p > 1 ? 1 : p; p = p * p * (3 - 2 * p);
    return { width: w.value * p, opacity: p > 0.001 ? 1 : 0 };
  });
  const base = { fontFamily: SF, fontSize: size, lineHeight: size * 1.26, fontWeight: (ad ? '600' : '700') as any, letterSpacing: -0.3 };
  return (
    <View onLayout={(e) => { const x = e.nativeEvent.layout.width; w.value = x; setWw(x); }} style={{ marginRight: size * 0.26 }}>
      <Text style={[base, { color: 'rgba(255,255,255,0.36)' }]}>{text}</Text>
      {/* белая копия во всю ширину слова, а открывается обрезкой контейнера: Android больше не подставляет «…»
          в узкую строку (раньше при заливке вместо слова мелькали точки) */}
      {ww > 0 && <Animated.View style={[{ position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' }, st]}>
        <Text style={[base, { color: '#fff', width: ww + 1 }]}>{text}</Text>
      </Animated.View>}
    </View>
  );
}

// строка: основной текст и эдлибы (в скобках, без скобок — мельче, отдельно)
const LineView = React.memo(LineViewImpl, (a: any, b: any) => a.l === b.l && a.next === b.next && a.cur === b.cur && a.d === b.d && a.i === b.i);
function LineViewImpl({ l, next, cur, d, time, i, onTap, onPos }: { l: Line; next?: Line; cur: boolean; d: number; time: SharedValue<number>; i: number; onTap: (i: number) => void; onPos: (i: number, y: number, h: number) => void }) {
  const onPress = () => onTap(i); const onLayout = (y: number, h: number) => onPos(i, y, h);
  const words = useMemo(() => String(l.text || '').split(/\s+/).filter(Boolean), [l.text]);
  const ad = useMemo(() => adFlags(words), [words]);
  const wt = useMemo(() => (cur ? wordTimes(l, next) : null), [cur, l, next]);
  const clean = (s: string) => s.replace(/[()[\]]/g, '');
  const main = words.map((w, i) => ({ w: ad[i] ? '' : w, i })).filter((x) => x.w);
  const ads = words.map((w, i) => ({ w: ad[i] ? clean(w) : '', i })).filter((x) => x.w);
  // прошлые — тусклые, следующие — чуть ярче прошлых и тише текущей, дальние — ещё тише
  const op = cur ? 1 : d < 0 ? (d === -1 ? 0.42 : 0.26) : d === 1 ? 0.5 : d === 2 ? 0.36 : 0.24;
  const size = FS;
  if (!l.text) return <View onLayout={(e) => onLayout(e.nativeEvent.layout.y, e.nativeEvent.layout.height)} style={{ height: 24 }} />;
  return (
    <Pressable onPress={onPress} onLayout={(e) => onLayout(e.nativeEvent.layout.y, e.nativeEvent.layout.height)} style={{ marginBottom: 18 }}>
      {cur && wt ? (
        <Animated.View entering={FadeIn.duration(280)}>
          {main.length > 0 && <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{main.map((x) => <Word key={x.i} text={x.w} a={wt[x.i].a} b={wt[x.i].b} time={time} size={size} />)}</View>}
          {ads.length > 0 && <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: main.length ? 2 : 0 }}>{ads.map((x) => <Word key={x.i} text={x.w} a={wt[x.i].a} b={wt[x.i].b} time={time} size={main.length ? size * 0.6 : size * 0.72} ad />)}</View>}
        </Animated.View>
      ) : (
        <View style={{ opacity: op }}>
          {main.length > 0 && <Text style={{ fontFamily: SF, fontSize: size, lineHeight: size * 1.26, fontWeight: '700', letterSpacing: -0.3, color: d < 0 ? '#fff' : 'rgba(255,255,255,0.85)' }}>{main.map((x) => x.w).join(' ')}</Text>}
          {ads.length > 0 && <Text style={{ fontFamily: SF, fontSize: main.length ? size * 0.6 : size * 0.72, lineHeight: (main.length ? size * 0.6 : size * 0.72) * 1.3, fontWeight: '600', color: 'rgba(255,255,255,0.8)', marginTop: 2 }}>{ads.map((x) => x.w).join(' ')}</Text>}
        </View>
      )}
    </Pressable>
  );
}

// далёкие строки выглядят одинаково — сводим расстояние к нескольким ступеням (меньше перерисовок)
const dBucket = (d: number) => (d <= -2 ? -2 : d >= 3 ? 3 : d);
export function LiveLyrics({ t }: { t: { id: string; url?: string; title: string; artist: string; dur?: number } }) {
  const P: any = usePlayer();
  const [ly, setLy] = useState<Lyrics | null>(null); const [err, setErr] = useState(false);
  useEffect(() => { let ok = true; setLy(null); setErr(false); getLyrics(t).then((v) => ok && setLy(v)).catch(() => ok && setErr(true)); return () => { ok = false; }; }, [t.id]);
  // сдвиг текста (если спешит или опаздывает) — запоминается для трека
  const [shift, setShift0] = useState(0); const shiftRef = useRef(0); shiftRef.current = shift;
  useEffect(() => { AsyncStorage.getItem(OFF_KEY).then((v) => { const m = v ? JSON.parse(v) : {}; setShift0(+m[t.id] || 0); }).catch(() => setShift0(0)); }, [t.id]);
  const setShift = (v: number) => {
    v = Math.round(Math.max(-3, Math.min(3, v)) * 10) / 10; setShift0(v);
    AsyncStorage.getItem(OFF_KEY).then((x) => { const m = x ? JSON.parse(x) : {}; if (v) m[t.id] = v; else delete m[t.id]; const k = Object.keys(m); if (k.length > 300) delete m[k[0]]; AsyncStorage.setItem(OFF_KEY, JSON.stringify(m)); }).catch(() => {});
  };
  const synced = !!(ly && 'lines' in ly && ly.synced);
  const lines: Line[] = ly && 'lines' in ly ? ly.lines : [];
  // каждый кадр: время → общая переменная (её читает подсветка слов на «потоке интерфейса»), строка — только при смене
  const time = useSharedValue(0); const [cur, setCur] = useState(-1); const curRef = useRef(-1);
  useEffect(() => {
    if (!synced) return;
    let raf = 0, tmo: any = 0, last = -1, still = 0;
    const f = () => {
      const tm = P.now() - shiftRef.current; time.value = tm;
      if (tm === last) { if (++still > 40) { tmo = setTimeout(() => { raf = requestAnimationFrame(f); }, 200); return; } } else still = 0;
      last = tm;
      let c = -1; const look = tm + 0.12; for (let i = 0; i < lines.length; i++) { if (lines[i].t <= look) c = i; else break; }
      if (c !== curRef.current) { curRef.current = c; setCur(c); }
      raf = requestAnimationFrame(f);
    };
    raf = requestAnimationFrame(f);
    return () => { cancelAnimationFrame(raf); clearTimeout(tmo); };
  }, [synced, lines]);
  // прокрутка: текущая строка — на трети высоты; листаете сами — 3,5 с не мешаем
  const sv = useRef<ScrollView>(null); const ys = useRef<{ y: number; h: number }[]>([]); const [boxH, setBoxH] = useState(0);
  const userAt = useRef(0); const [browse, setBrowse] = useState(false); const brT = useRef<any>(0);
  useEffect(() => {
    if (!synced || cur < 0 || Date.now() - userAt.current < 3500) return;
    const p = ys.current[cur]; if (!p || !boxH) return;
    sv.current?.scrollTo({ y: Math.max(0, p.y + p.h / 2 - boxH * 0.34), animated: true });
  }, [cur, boxH, synced]);
  const onDrag = () => { userAt.current = Date.now(); setBrowse(true); clearTimeout(brT.current); brT.current = setTimeout(() => { userAt.current = 0; setBrowse(false); setCur((c) => c); const p = ys.current[curRef.current]; if (p && boxH) sv.current?.scrollTo({ y: Math.max(0, p.y + p.h / 2 - boxH * 0.34), animated: true }); }, 3500); };
  useEffect(() => () => clearTimeout(brT.current), []);

  // постоянные обработчики для строк — чтобы строки не перерисовывались зря
  const linesRef = useRef(lines); linesRef.current = lines;
  const tap = React.useCallback((i: number) => { const l = linesRef.current[i]; if (!l) return; userAt.current = 0; setBrowse(false); P.seek(Math.max(0, l.t + shiftRef.current)); }, []);
  const pos = React.useCallback((i: number, y: number, h: number) => { ys.current[i] = { y, h }; }, []);
  if (!ly && !err) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#fff" /></View>;
  if (err || !ly || 'none' in ly) return (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      <Text style={{ fontFamily: SF, fontSize: 24, fontWeight: '700', color: '#fff' }}>{ly && 'none' in ly && ly.instrumental ? 'Это инструментал — слов нет' : 'Текст для этого трека не нашёлся'}</Text>
      <Text style={{ fontFamily: SF, fontSize: 14, color: 'rgba(255,255,255,0.6)', marginTop: 8 }}>Войдите в Яндекс Музыку в профиле — там больше текстов.</Text>
    </View>
  );
  const near = (v: number) => (Math.abs(v) < 0.05 ? 'синхронно' : 'сдвиг ' + (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1).replace('.', ',') + ' с');
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setBoxH(e.nativeEvent.layout.height)}>
      <ScrollView ref={sv} showsVerticalScrollIndicator={false} onScrollBeginDrag={onDrag} onMomentumScrollEnd={() => {}} contentContainerStyle={{ paddingTop: boxH * 0.3, paddingBottom: boxH * 0.55 }}
        scrollEventThrottle={32} onScroll={(_e: NativeSyntheticEvent<NativeScrollEvent>) => {}}>
        {!synced && <Text style={{ fontFamily: SF, fontSize: 13, color: 'rgba(255,255,255,0.55)', marginBottom: 14 }}>Живого текста у трека нет — показываю обычный</Text>}
        {lines.map((l, i) => synced
          ? <LineView key={i} i={i} l={l} next={lines[i + 1]} cur={i === cur && !browse} d={dBucket(browse ? (i < cur ? -1 : i === cur ? 0 : 1) : cur < 0 ? i + 1 : i - cur)} time={time} onTap={tap} onPos={pos} />
          : <Text key={i} style={{ fontFamily: SF, fontSize: 22, lineHeight: 30, fontWeight: '600', color: 'rgba(255,255,255,0.88)', marginBottom: l.text ? 8 : 14 }}>{l.text}</Text>)}
        <Text style={{ fontFamily: SF, fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 10 }}>{(ly.writers ? 'Авторы: ' + ly.writers + ' · ' : '') + 'Текст: ' + ly.source + (synced ? (ly.ai ? ' · время по словам (ИИ)' : ly.words ? ' · время по словам' : ' · подсветка по слогам') : '')}</Text>
      </ScrollView>
      {/* пометка, как на ПК: время слов посчитал ИИ (общая база разметки) */}
      {synced && ly.ai && (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, bottom: 4, height: 36, borderRadius: 18, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.22)', paddingHorizontal: 12 }}>
          <PcIcon n="spark" s={14} c="rgba(255,255,255,0.85)" />
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '600' }}>Время слов — ИИ</Text>
        </View>
      )}
      {synced && (
        <View style={{ position: 'absolute', right: 0, bottom: 4, height: 36, borderRadius: 18, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.22)', paddingHorizontal: 4 }}>
          <Pressable onPress={() => setShift(shift - 0.2)} hitSlop={6} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 18 }}>−</Text></Pressable>
          <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, fontWeight: '600', minWidth: 88, textAlign: 'center' }}>{near(shift)}</Text>
          <Pressable onPress={() => setShift(shift + 0.2)} hitSlop={6} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 18 }}>+</Text></Pressable>
        </View>
      )}
    </View>
  );
}
export const BUILD_LYR = 1;
