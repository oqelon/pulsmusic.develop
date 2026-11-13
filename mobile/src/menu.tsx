// Небольшое своё меню вместо системного окна Android (фото профиля, плейлист, трек).
// Компактная карточка снизу экрана: заголовок, пункты со значками, «Отмена». Скругление 22, пункты 48 с отступом 6 →
// их скругление 16 (22 − 6). Появляется и уходит мягко (прозрачность + небольшой подъём), закрывается касанием
// мимо, кнопкой «Назад» или «Отменой». На iPhone остаётся системное меню (оно и так в стиле iOS).
import React, { useEffect, useState } from 'react';
import { Alert, Modal, Platform, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { useSharedValue, useAnimatedStyle, withTiming, Easing, runOnJS } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useT, hap } from './ui';
import { PcIcon } from './PcIcons';

// пункты меню и значки диалогов — теми же иконками, что на ПК; где своей на ПК нет — системная
const PC: Record<string, any> = { 'trash-outline': 'trash', 'create-outline': 'pencil', 'camera-outline': 'camera', sparkles: 'spark', 'person-outline': 'user', 'download-outline': 'download', 'add-circle-outline': 'plus', add: 'plus', 'heart-outline': 'heartO', heart: 'heart', 'time-outline': 'clock', 'moon-outline': 'moon', 'settings-outline': 'gear', 'list-outline': 'queue', 'lock-closed-outline': 'lock', 'musical-notes-outline': 'notes', 'search-outline': 'search' };
const Icon = ({ n, s, c }: { n: string; s: number; c: string }) => (PC[n] ? <PcIcon n={PC[n]} s={s} c={c} /> : <Ionicons name={n as any} size={s} color={c} />);

export type MItem = { text: string; icon?: string; onPress: () => void; danger?: boolean };
// окно-вопрос: значок, заголовок, текст, список (что нового), две кнопки-капсулы рядом
export type DBtn = { text: string; kind?: 'sec' | 'pri' | 'dng'; onPress?: () => void };
export type DDlg = { icon?: string; danger?: boolean; title: string; sub?: string; text?: string; list?: string[]; buttons: DBtn[]; onClose?: () => void };
type M = { title?: string; items: MItem[]; dlg?: undefined } | { dlg: DDlg; title?: undefined; items?: undefined };
let push: ((m: M) => void) | null = null;
export function openMenu(title: string | undefined, items: MItem[]) { if (push) push({ title, items }); }
// на Android — своё окно снизу; на iPhone — системное (оно и так в стиле iOS)
export function openDialog(d: DDlg) {
  if (Platform.OS === 'android' && push) { push({ dlg: d }); return; }
  Alert.alert(d.title, [d.sub, d.list && d.list.length ? d.list.map((x) => '• ' + x).join('\n') : '', d.text].filter(Boolean).join('\n\n') || undefined,
    d.buttons.map((b) => ({ text: b.text, onPress: b.onPress, style: (b.kind === 'dng' ? 'destructive' : b.kind === 'sec' ? 'cancel' : 'default') as any })), { cancelable: true, onDismiss: d.onClose });
}

const EO = Easing.bezier(0.22, 1, 0.36, 1);
export function MenuHost() {
  const T: any = useT(); const ins = useSafeAreaInsets(); const { width } = useWindowDimensions();
  const [m, setM] = useState<M | null>(null);
  const p = useSharedValue(0);
  useEffect(() => { push = (x) => { setM(x); p.value = 0; p.value = withTiming(1, { duration: 240, easing: EO }); }; return () => { push = null; }; }, []);
  const close = (then?: () => void, dismissed?: boolean) => {
    if (dismissed && m && m.dlg && m.dlg.onClose) m.dlg.onClose();
    p.value = withTiming(0, { duration: 170, easing: Easing.out(Easing.quad) }, (f) => { if (f) runOnJS(setM)(null); });
    if (then) setTimeout(then, 120);   // действие — когда меню уже уходит (окна выбора фото не налезают на него)
  };
  const bg = useAnimatedStyle(() => ({ opacity: p.value }));
  const card = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ translateY: (1 - p.value) * 24 }, { scale: 0.97 + 0.03 * p.value }] }));
  if (!m) return null;
  const dk = !!T.dark; const ink = T.ink || (dk ? '#fff' : '#111');
  const cardBg = dk ? '#1d1c23' : '#ffffff'; const line = dk ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const W = Math.min(width - 32, 360);
  const Row = ({ it, cancel }: { it?: MItem; cancel?: boolean }) => (
    <Pressable onPress={() => { hap('light'); close(cancel ? undefined : it!.onPress); }}
      style={({ pressed }) => ({ height: 48, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, backgroundColor: pressed ? line : 'transparent', justifyContent: cancel ? 'center' : 'flex-start' })}>
      {!cancel && !!it!.icon && <Icon n={it!.icon!} s={20} c={it!.danger ? '#ff5a5f' : ink} />}
      <Text style={{ fontSize: 16, fontWeight: cancel ? '600' : '500', color: cancel ? (T.accentText || T.accent) : it!.danger ? '#ff5a5f' : ink }}>{cancel ? 'Отмена' : it!.text}</Text>
    </Pressable>
  );
  return (
    <Modal transparent visible animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={() => close(undefined, true)}>
      <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.38)' }, bg]}>
        <Pressable style={{ flex: 1 }} onPress={() => close(undefined, true)} />
      </Animated.View>
      {m.dlg ? <Animated.View style={[{ position: 'absolute', left: (width - W) / 2, width: W, bottom: ins.bottom + 16 }, card]}>
        <Dialog d={m.dlg} T={T} bg={cardBg} ink={ink} onPick={(b) => { hap(b.kind === 'dng' ? 'warning' : 'light'); close(b.onPress, b.kind === 'sec' && !b.onPress); }} />
      </Animated.View> : <>
      <Animated.View style={[{ position: 'absolute', left: (width - W) / 2, width: W, bottom: ins.bottom + 16 }, card]}>
        <View style={{ borderRadius: 22, backgroundColor: cardBg, padding: 6, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 24, elevation: 12 }}>
          {!!m.title && <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: '600', color: T.ink3 || T.muted, textAlign: 'center', paddingTop: 8, paddingBottom: 6, paddingHorizontal: 12 }}>{m.title}</Text>}
          {(m.items || []).map((it, i) => <Row key={i} it={it} />)}
        </View>
        <View style={{ height: 8 }} />
        <View style={{ borderRadius: 22, backgroundColor: cardBg, padding: 6, elevation: 12 }}><Row cancel /></View>
      </Animated.View></>}
    </Modal>
  );
}

// Окно-вопрос: карточка 30 со скруглением, внутри отступ 18 → кнопки-капсулы 52 (скругление 26).
function Dialog({ d, T, bg, ink, onPick }: { d: DDlg; T: any; bg: string; ink: string; onPick: (b: DBtn) => void }) {
  const dk = !!T.dark; const mut = T.ink3 || T.muted || (dk ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)');
  const g1 = T.accent || '#e23199', g2 = T.accent2 || T.accentSoft || g1;
  const red = '#ff5a5f';
  return (
    <View style={{ borderRadius: 30, backgroundColor: bg, padding: 18, paddingTop: 20, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 24, elevation: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        {d.danger
          ? <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,90,95,0.16)', alignItems: 'center', justifyContent: 'center' }}><Icon n={d.icon || 'trash-outline'} s={22} c={red} /></View>
          : <LinearGradient colors={[g1, g2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' }}><Icon n={d.icon || 'sparkles'} s={22} c="#fff" /></LinearGradient>}
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 19, fontWeight: '700', color: ink, letterSpacing: -0.2 }}>{d.title}</Text>
          {!!d.sub && <Text style={{ fontSize: 14, color: mut, marginTop: 2 }}>{d.sub}</Text>}
        </View>
      </View>
      {!!d.text && <Text style={{ fontSize: 15, lineHeight: 21, color: mut, marginTop: 14 }}>{d.text}</Text>}
      {!!d.list && d.list.length > 0 && <View style={{ marginTop: 14, gap: 8 }}>{d.list.map((x, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
          <LinearGradient colors={[g1, g2]} style={{ width: 7, height: 7, borderRadius: 4, marginTop: 7 }} />
          <Text style={{ flex: 1, fontSize: 15, lineHeight: 21, color: ink }}>{x}</Text>
        </View>))}</View>}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
        {d.buttons.map((b, i) => {
          const k = b.kind || 'pri';
          const body = <Text style={{ fontSize: 16, fontWeight: '700', color: k === 'sec' ? ink : '#fff' }}>{b.text}</Text>;
          const box = { flex: 1, height: 52, borderRadius: 26, alignItems: 'center' as const, justifyContent: 'center' as const, overflow: 'hidden' as const };
          return (
            <Pressable key={i} onPress={() => onPick(b)} style={({ pressed }) => [box, { opacity: pressed ? 0.85 : 1, backgroundColor: k === 'sec' ? (dk ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.06)') : k === 'dng' ? red : 'transparent' }]}>
              {k === 'pri' && <LinearGradient colors={[g1, g2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />}
              {body}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
