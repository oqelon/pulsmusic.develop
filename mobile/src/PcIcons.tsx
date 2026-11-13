// Иконки как в версии для ПК (тот же рисунок: линии 2 из 24, круглые концы и стыки). Нужна react-native-svg;
// без неё — пустое место того же размера (ничего не «прыгает»). Только для мест, где на ПК своя иконка.
import React from 'react';
import { View } from 'react-native';
import { SVGLIB } from './ui';

const SV: any = SVGLIB;
const L = (c: string, w: number) => ({ fill: 'none', stroke: c, strokeWidth: w, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const });
export const HEART_D = 'M256 448a32 32 0 01-18-5.57c-78.59-53.35-112.62-89.93-131.39-112.8-40-48.75-59.15-98.8-58.61-153C48.63 114.52 98.46 64 159.08 64c44.08 0 74.61 24.83 92.39 45.51a6 6 0 009.06 0C278.31 88.81 308.84 64 352.92 64c60.62 0 110.45 50.52 111.08 112.64.54 54.21-18.63 104.26-58.61 153-18.77 22.87-52.8 59.45-131.39 112.8a32 32 0 01-18 5.56z';
const ICONS: Record<string, (c: string, w: number) => React.ReactNode> = {
  search: (c: string, w: number) => <><SV.Circle cx="11" cy="11" r="7" {...L(c, w)} /><SV.Path d="M20 20l-3.5-3.5" {...L(c, w)} /></>,
  notes: (c: string, w: number) => <><SV.Path d="M9 18 V5.5 L20 3.5 V16 M6.5 15.5 A2.5 2.5 0 1 1 6.49 15.5 M17.5 13.5 A2.5 2.5 0 1 1 17.49 13.5" {...L(c, w)} /></>,
  shuffle: (c: string, w: number) => <><SV.Path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" {...L(c, w)} /></>,
  repeat: (c: string, w: number) => <><SV.Path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" {...L(c, w)} /></>,
  queue: (c: string, w: number) => <><SV.Path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" {...L(c, w)} /></>,
  down: (c: string, w: number) => <><SV.Path d="M6 9l6 6 6-6" {...L(c, w)} /></>,
  back: (c: string, w: number) => <><SV.Path d="M15 18l-6-6 6-6" {...L(c, w)} /></>,
  close: (c: string, w: number) => <><SV.Path d="M6 6l12 12M18 6L6 18" {...L(c, w)} /></>,
  check: (c: string, w: number) => <><SV.Path d="M5 12.5l4.5 4.5L19 7.5" {...L(c, w)} /></>,
  download: (c: string, w: number) => <><SV.Path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" {...L(c, w)} /></>,
  plus: (c: string, w: number) => <><SV.Path d="M12 5v14M5 12h14" {...L(c, w)} /></>,
  arrowL: (c: string, w: number) => <><SV.Path d="M19 12H5M11 18l-6-6 6-6" {...L(c, w)} /></>,
  camera: (c: string, w: number) => <><SV.Path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" {...L(c, w)} /><SV.Circle cx="12" cy="13.5" r="3.5" {...L(c, w)} /></>,
  pencil: (c: string, w: number) => <><SV.Path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" {...L(c, w)} /></>,
  user: (c: string, w: number) => <><SV.Circle cx="12" cy="8" r="4" {...L(c, w)} /><SV.Path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" {...L(c, w)} /></>,
  lyrics: (c: string, w: number) => <><SV.Path d="M7.5 4h9A4.5 4.5 0 0 1 21 8.5v5a4.5 4.5 0 0 1-4.5 4.5H12l-3.9 2.9a.7.7 0 0 1-1.1-.6V18A4.5 4.5 0 0 1 3 13.5v-5A4.5 4.5 0 0 1 7.5 4z" {...L(c, w)} /><SV.Path d="M8 9.5h8M8 13h5" {...L(c, w)} /></>,
  moon: (c: string, w: number) => <><SV.Path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" {...L(c, w)} /></>,
  clock: (c: string, w: number) => <><SV.Circle cx="12" cy="12" r="8" {...L(c, w)} /><SV.Path d="M12 8v4l3 2" {...L(c, w)} /></>,
  trash: (c: string, w: number) => <><SV.Path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" {...L(c, w)} /></>,
  listAdd: (c: string, w: number) => <><SV.Path d="M4 6h11M4 12h11M4 18h7M18 15v6M15 18h6" {...L(c, w)} /></>,
  lock: (c: string, w: number) => <><SV.Rect x="5" y="11" width="14" height="10" rx="3" {...L(c, w)} /><SV.Path d="M8 11V8a4 4 0 0 1 8 0v3" {...L(c, w)} /></>,
  gear: (c: string, w: number) => <><SV.Circle cx="12" cy="12" r="3" {...L(c, w)} /><SV.Path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" {...L(c, w)} /></>,
  home: (c: string, w: number) => <><SV.Path d="M4.5 19.2 V11.4 Q4.5 10.6 5.1 10.1 L10.9 5.1 Q12 4.2 13.1 5.1 L18.9 10.1 Q19.5 10.6 19.5 11.4 V19.2 Q19.5 20.6 18.1 20.6 H15.2 Q14.6 20.6 14.6 20 V16 Q14.6 14.8 13.4 14.8 H10.6 Q9.4 14.8 9.4 16 V20 Q9.4 20.6 8.8 20.6 H5.9 Q4.5 20.6 4.5 19.2 Z" {...L(c, w)} /></>,
};
export type PcName = keyof typeof ICONS | 'heart' | 'heartO' | 'play' | 'pause' | 'more' | 'spark';
export function PcIcon({ n, s = 20, c = '#fff', w = 2 }: { n: PcName; s?: number; c?: string; w?: number }) {
  if (!SV) return <View style={{ width: s, height: s }} />;
  if (n === 'heart' || n === 'heartO') return (
    <SV.default width={s} height={s} viewBox="0 0 512 512">
      {n === 'heart' ? <SV.Path d={HEART_D} fill={c} /> : <SV.Path d={HEART_D} fill="none" stroke={c} strokeWidth={47.4} strokeLinejoin="round" transform="translate(25.6 25.6) scale(.9)" />}
    </SV.default>
  );
  const soft = { fill: c, stroke: c, strokeWidth: 2.4, strokeLinejoin: 'round' as const };
  return (
    <SV.default width={s} height={s} viewBox="0 0 24 24">
      {n === 'play' ? <SV.Path d="M8.6 6.2L18.2 12L8.6 17.8Z" {...soft} />
        : n === 'pause' ? <><SV.Rect x={6.3} y={5.2} width={4.3} height={13.6} rx={1.9} fill={c} /><SV.Rect x={13.4} y={5.2} width={4.3} height={13.6} rx={1.9} fill={c} /></>
        : n === 'more' ? <><SV.Circle cx={5} cy={12} r={1.8} fill={c} /><SV.Circle cx={12} cy={12} r={1.8} fill={c} /><SV.Circle cx={19} cy={12} r={1.8} fill={c} /></>
        : n === 'spark' ? <SV.Path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z" fill={c} />
        : ICONS[n as string] ? ICONS[n as string](c, w) : null}
    </SV.default>
  );
}

// Галочка «подтверждённый исполнитель» — розетка с 10 лепестками, как на ПК (цвет — акцент темы)
const ROSETTE = (() => {
  const n = 10, base = 10.4, amp = 0.75, c = 12, steps = 200; let d = '';
  for (let i = 0; i < steps; i++) {
    const a = (2 * Math.PI * i) / steps - Math.PI / 2, k = Math.cos(n * (a + Math.PI / 2)), rr = base + amp * k;
    d += (i ? 'L' : 'M') + (c + rr * Math.cos(a)).toFixed(2) + ' ' + (c + rr * Math.sin(a)).toFixed(2);
  }
  return d + 'Z';
})();
export function Verified({ s = 24, c }: { s?: number; c: string }) {
  if (!SV) return null;
  return (
    <SV.default width={s} height={s} viewBox="0 0 24 24">
      <SV.Path d={ROSETTE} fill={c} />
      <SV.Path d="M7.6 12.3l2.9 2.9 5.9-6.2" fill="none" stroke="#fff" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" />
    </SV.default>
  );
}
