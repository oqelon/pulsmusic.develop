// Сколько треков каждого артиста вы прослушали (как на ПК): трек считается прослушанным, если играл 30 секунд
// или он в «Любимом». Хранится на телефоне. По этому числу рисуются кольца у «Недавних» на главной.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

const KEY = 'pulse.heard';
let mem: Record<string, string[]> | null = null; let loading: Promise<void> | null = null; let dirty: any = null;
const subs = new Set<() => void>();
export function heardLoad(): Promise<void> {
  if (mem) return Promise.resolve();
  if (!loading) loading = AsyncStorage.getItem(KEY).then((s) => { try { mem = s ? JSON.parse(s) : null; } catch { mem = null; } }).catch(() => { mem = null; });
  return loading;
}
export const heardReady = () => mem !== null;
// первый запуск: любимые и недавние треки считаем прослушанными
export async function heardSeed(list: { id: string; artistId?: number }[]) { await heardLoad(); if (mem) return; mem = {}; markHeard(list, true); }
export function markHeard(list: { id: string; artistId?: number }[], force = false) {
  if (!mem) { if (!force) heardLoad().then(() => { if (!mem) mem = {}; markHeard(list); }); return; }
  let ch = false;
  for (const t of list) {
    if (!t || !t.artistId) continue; const k = String(t.artistId);
    const l = mem[k] || (mem[k] = []); if (!l.includes(String(t.id))) { l.push(String(t.id)); if (l.length > 3000) l.shift(); ch = true; }
  }
  if (!ch && !force) return;
  const ks = Object.keys(mem); for (let i = 0; i < ks.length - 500; i++) delete mem[ks[i]];
  clearTimeout(dirty); dirty = setTimeout(() => { AsyncStorage.setItem(KEY, JSON.stringify(mem)).catch(() => {}); }, 1500);
  subs.forEach((f) => f());
}
export function useHeard(artistId?: number): number {
  const get = () => (mem && artistId ? (mem[String(artistId)] || []).length : 0);
  const [n, setN] = useState(get);
  useEffect(() => { const f = () => setN(get()); subs.add(f); heardLoad().then(f); return () => { subs.delete(f); }; }, [artistId]);
  return n;
}
