// Главная как в версии для ПК: кольца «сколько треков артиста прослушано», обложки «Собрано для вас» (стена из
// обложек треков), афиши «Лучшее артистов». Все карточки-обложки одного размера — CARD (ui.tsx), скругление 22.
// Кнопка «слушать» в углу карточки: 30 × 30 с отступом 7 → её скругление 15 = 22 − 7 (концентрично с карточкой).
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import Animated from 'react-native-reanimated';
import * as api from './api';
import type { Track } from './api';
import { useT, useTy, Press, Pic, rise, ArtistDot, SVGLIB, hap, CARD } from './ui';
import { PcIcon } from './PcIcons';
import { useHeard } from './heard';

export const CARD_R = 22;
export { CARD };
const SV: any = SVGLIB;
const fmtLong = (sec: number) => { const m = Math.round(sec / 60); return m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин' : m + ' мин'; };
const plural3 = (n: number, a: string, b: string, c: string) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
export const tracksWord = (n: number) => n + ' ' + plural3(n, 'трек', 'трека', 'треков');

// ---------- кольцо прослушивания ----------
// фото 56 (как кнопка профиля), вокруг кольцо толщиной 3 с отступом 4 — снаружи 64
export function RingDot({ a, onPress, i = 0 }: { a: { name: string; id?: number; cover?: string }; onPress?: () => void; i?: number }) {
  const T: any = useT(); const ty = useTy();
  const heard = useHeard(a.id);
  const [total, setTotal] = useState(0);
  useEffect(() => { if (!a.id) return; let ok = true; api.artist(a.id).then((r: any) => { const n = r?.info?.counts?.tracks; if (ok && n) setTotal(n); }).catch(() => {}); return () => { ok = false; }; }, [a.id]);
  const p = Math.min(1, total ? heard / total : heard / 50);
  const S = 64, w = 3, r = (S - w) / 2;
  const c1 = T.accent, c2 = T.accent2 || T.accent, c3 = T.accent3 || c2;
  return (
    <Animated.View entering={rise(Math.min(i, 8) * 40)}>
      <Press onPress={onPress} style={{ width: 72, alignItems: 'center' }}>
        <View style={{ width: S, height: S, alignItems: 'center', justifyContent: 'center' }}>
          {SV && <SV.default width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ position: 'absolute', left: 0, top: 0 }}>
            <SV.Defs><SV.LinearGradient id={'rg' + (a.id || a.name)} x1="0" y1="0" x2="1" y2="1"><SV.Stop offset="0" stopColor={c1} /><SV.Stop offset="0.5" stopColor={c2} /><SV.Stop offset="1" stopColor={c3} /></SV.LinearGradient></SV.Defs>
            <SV.Circle cx={S / 2} cy={S / 2} r={r} fill="none" stroke={T.dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'} strokeWidth={w} />
            {p > 0 && <SV.Circle cx={S / 2} cy={S / 2} r={r} fill="none" stroke={`url(#rg${a.id || a.name})`} strokeWidth={w} strokeLinecap="round"
              strokeDasharray={p >= 0.999 ? undefined : `${(2 * Math.PI * r * p).toFixed(2)} ${(2 * Math.PI * r).toFixed(2)}`} transform={`rotate(-90 ${S / 2} ${S / 2})`} />}
          </SV.default>}
          <ArtistDot name={a.name} id={a.id} fallback={a.cover} size={56} />
        </View>
        <Text numberOfLines={1} style={[ty.footnote, { marginTop: 6, color: T.ink2, fontWeight: '600', fontSize: 12 }]}>{a.name}</Text>
        <Text numberOfLines={1} style={[ty.caption, { fontSize: 10.5, marginTop: 1 }]}>{heard ? (total ? Math.min(heard, total) + ' из ' + total : tracksWord(heard)) : 'не слушали'}</Text>
      </Press>
    </Animated.View>
  );
}

// ---------- подписи поверх обложки (как .bestc-low на ПК) ----------
function Low({ c, n, label, name, ft, big }: { c: string; n: number | string; label: string; name: string; ft: string; big?: boolean }) {
  const T: any = useT();
  const k = big ? 1.55 : 1;
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '62%', justifyContent: 'flex-end', paddingHorizontal: 12 * k, paddingBottom: 11 * k }}>
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
        {/* низ уходит в цвет обложки: 0 → 86 % → сплошной (как linear-gradient на ПК) */}
        {SV ? <SV.default width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 1 1">
          <SV.Defs><SV.LinearGradient id={'lw' + name + c} x1="0" y1="0" x2="0" y2="1"><SV.Stop offset="0" stopColor={`rgb(${c})`} stopOpacity={0} /><SV.Stop offset="0.3" stopColor={`rgb(${c})`} stopOpacity={0.86} /><SV.Stop offset="0.5" stopColor={`rgb(${c})`} stopOpacity={1} /></SV.LinearGradient></SV.Defs>
          <SV.Rect x="0" y="0" width="1" height="1" fill={`url(#lw${name}${c})`} />
        </SV.default> : <View style={{ flex: 1, backgroundColor: `rgba(${c},0.86)` }} />}
      </View>
      <Text numberOfLines={1} style={{ color: '#ffe3ef', fontSize: 40 * k, lineHeight: 36 * k, fontWeight: '900', letterSpacing: -2.2 * k, marginBottom: 4 * k }}>
        {n}<Text style={{ color: '#fff', fontSize: 10 * k, letterSpacing: 0, fontWeight: '700' }}>{'  ' + label}</Text>
      </Text>
      <Text numberOfLines={2} style={{ color: '#fff', fontSize: 14 * k, lineHeight: 17 * k, fontWeight: '800', paddingRight: big ? 0 : 34 }}>{name}</Text>
      <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.8)', fontSize: 10 * k, marginTop: 1 }}>{ft}</Text>
    </View>
  );
}

// «Собрано для вас»: оформление известных подборок Яндекса — как на ПК
const MIX_LOOK: [RegExp, string, string, string][] = [
  [/плейлист дня/i, '178,58,94', 'треков', 'обновлён сегодня'],
  [/дежавю/i, '28,112,104', 'треков', 'давно не слушали'],
  [/премьер/i, '86,52,150', 'новинок', 'новое от ваших артистов'],
  [/тайник/i, '44,66,152', 'находок', 'редкое для вас'],
  [/открыти/i, '150,82,40', 'треков', 'новые для вас артисты'],
  [/^чарт$/i, '120,26,72', 'треков', 'Россия · сейчас'],
];
const smallCov = (u: string) => String(u || '').replace(/\/\d+x\d+$/, '/100x100');
export function useCoverTint(u?: string) {
  const [c, setC] = useState('');
  useEffect(() => { if (!u) return; let ok = true; api.coverTint(u).then((x) => ok && x && setC(x)); return () => { ok = false; }; }, [u]);
  return c;
}
// стена из 12 обложек треков, повёрнутая на −14° (как .mixc-wall на ПК)
export function MixCover({ p, covers, n, dur, size = CARD, big }: { p: api.YPl | { title: string; cover?: string; count?: number }; covers?: string[]; n?: number; dur?: number; size?: number; big?: boolean }) {
  const look = MIX_LOOK.find(([re]) => re.test(p.title || ''));
  const tint = useCoverTint(look ? '' : p.cover);
  const c = look ? look[1] : tint || '62,30,72';
  const src = covers && covers.length ? covers : p.cover ? [p.cover] : [];
  const cell = (size * 1.5 - size * 1.5 * 0.03 * 3) / 4, gap = size * 1.5 * 0.03;
  return (
    <View style={{ width: size, height: size, borderRadius: CARD_R, overflow: 'hidden', backgroundColor: `rgb(${c})` }}>
      {src.length > 0 && <View style={{ position: 'absolute', left: -size * 0.2, top: -size * 0.23, width: size * 1.5, flexDirection: 'row', flexWrap: 'wrap', gap, transform: [{ rotate: '-14deg' }] }}>
        {Array.from({ length: 12 }, (_, i) => <Pic key={i} uri={smallCov(src[i % src.length])} style={{ width: cell, height: cell, borderRadius: 10 * (size / 210) }} />)}
      </View>}
      <Low c={c} big={big} n={n || (p as any).count || ''} label={look ? look[2] : 'треков'} name={p.title} ft={look ? look[3] : dur ? fmtLong(dur) : 'собрано для вас'} />
    </View>
  );
}
// маленькая круглая «слушать» в углу карточки
function CornerPlay({ onPress }: { onPress: () => void }) {
  return (
    <Pressable hitSlop={8} onPress={() => { hap('light'); onPress(); }} style={{ position: 'absolute', right: 7, bottom: 7, width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ marginLeft: 2 }}><PcIcon n="play" s={14} c="#111" /></View>
    </Pressable>
  );
}
export function MixCard({ p, i = 0, onOpen, onPlay }: { p: api.YPl; i?: number; onOpen: () => void; onPlay: (l: Track[]) => void }) {
  const [st, setSt] = useState<{ covers: string[]; n: number; dur: number } | null>(null);
  useEffect(() => {
    let ok = true;
    api.yplaylist(p.uid, p.kind).then((r) => {
      const l = r.tracks || []; const seen = new Set<string>(); const covers: string[] = [];
      for (const t of l) { if (t.cover && !seen.has(t.cover)) { seen.add(t.cover); covers.push(t.cover); if (covers.length >= 12) break; } }
      if (ok) setSt({ covers, n: l.length, dur: l.reduce((s, t) => s + (t.dur || 0), 0) });
    }).catch(() => {});
    return () => { ok = false; };
  }, [p.uid, p.kind]);
  return (
    <Animated.View entering={rise(Math.min(i, 8) * 45)}>
      <Press onPress={onOpen} style={{ width: CARD }}>
        <MixCover p={p} covers={st?.covers} n={st?.n} dur={st?.dur} />
        <CornerPlay onPress={() => api.yplaylist(p.uid, p.kind).then((r) => r.tracks.length && onPlay(r.tracks)).catch(() => {})} />
      </Press>
    </Animated.View>
  );
}

// «Лучшее артистов»: фото артиста как афиша, низ — в цвет фото, крупно «30 лучших»
export function BestCover({ a, ph, stat, size = CARD, big }: { a: { name: string }; ph?: string; stat?: { n: number; dur: number } | null; size?: number; big?: boolean }) {
  const T: any = useT();
  const tint = useCoverTint(ph);
  const c = tint || '40,22,38';
  return (
    <View style={{ width: size, height: size, borderRadius: CARD_R, overflow: 'hidden', backgroundColor: `rgb(${c})` }}>
      {ph ? <Pic uri={ph} style={{ position: 'absolute', left: 0, top: 0, width: size, height: size }} />
        : <View style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: T.accent }}><Text style={{ fontSize: size * 0.34, fontWeight: '800', color: 'rgba(255,255,255,0.5)' }}>{(a.name || '?')[0]}</Text></View>}
      <Low c={c} big={big} n={stat ? stat.n : 30} label="лучших" name={a.name} ft={stat && stat.dur ? fmtLong(stat.dur) : 'треков артиста'} />
    </View>
  );
}
export function BestCard({ a, i = 0, onOpen, onPlay }: { a: { id: number; name: string }; i?: number; onOpen: (ph: string) => void; onPlay: (l: Track[]) => void }) {
  const [ph, setPh] = useState(''); const [stat, setStat] = useState<{ n: number; dur: number } | null>(null);
  useEffect(() => {
    let ok = true;
    api.artistPhotoBy(a.name, a.id, false).then((u) => ok && u && setPh(api.artPx(u, CARD))).catch(() => {});
    api.artist(a.id).then((r: any) => { const l = (r.tracks || []).slice(0, 30); if (ok && l.length) setStat({ n: l.length, dur: l.reduce((s: number, t: Track) => s + (t.dur || 0), 0) }); }).catch(() => {});
    return () => { ok = false; };
  }, [a.id]);
  return (
    <Animated.View entering={rise(Math.min(i, 8) * 45)}>
      <Press onPress={() => onOpen(ph)} style={{ width: CARD }}>
        <BestCover a={a} ph={ph} stat={stat} />
        <CornerPlay onPress={() => api.artist(a.id).then((r: any) => { const l = (r.tracks || []).slice(0, 30); if (l.length) onPlay(l); }).catch(() => {})} />
      </Press>
    </Animated.View>
  );
}

// «Подборки» редакции Яндекса: обложка CARD × CARD, название и описание (как PlCard на ПК)
export function YplCard({ p, i = 0, onOpen }: { p: api.YPl; i?: number; onOpen: () => void }) {
  const T: any = useT(); const ty = useTy();
  return (
    <Animated.View entering={rise(Math.min(i, 8) * 45)}>
      <Press onPress={onOpen} style={{ width: CARD }}>
        <View style={{ width: CARD, height: CARD, borderRadius: CARD_R, overflow: 'hidden', backgroundColor: T.ph, marginBottom: 8 }}><Pic uri={api.artPx(p.cover, CARD)} style={{ width: CARD, height: CARD }} /></View>
        <Text numberOfLines={1} style={ty.miniTitle}>{p.title}</Text>
        <Text numberOfLines={1} style={ty.footnote}>{p.count ? tracksWord(p.count) : 'Яндекс Музыка'}</Text>
      </Press>
    </Animated.View>
  );
}

// какие артисты в «Лучшем»: сначала те, кого слушаете и любите, потом — из чарта (как на ПК)
export function useBestArtists(likes: Track[], recent: Track[], chart: Track[] | null) {
  return useMemo(() => {
    const cnt = new Map<number, { a: { id: number; name: string }; n: number }>();
    for (const t of [...likes, ...recent]) if (t.artistId) { const o = cnt.get(t.artistId); cnt.set(t.artistId, { a: { id: t.artistId, name: api.baseArtist(t.artist) }, n: (o ? o.n : 0) + 1 }); }
    const own = [...cnt.values()].sort((x, y) => y.n - x.n).map((x) => x.a);
    const seen = new Set(own.map((a) => a.id));
    for (const t of chart || []) if (t.artistId && !seen.has(t.artistId)) { seen.add(t.artistId); own.push({ id: t.artistId, name: api.baseArtist(t.artist) }); }
    return own.slice(0, 10);
  }, [likes, recent, chart]);
}
