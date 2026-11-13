// Избранные исполнители (кнопка «В избранное» на странице артиста, как на ПК). Хранятся на телефоне,
// показываются в «Моей музыке» кружками.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

export type Fol = { id: number; name: string; photo?: string };
const KEY = 'pulse.follow';
let mem: Fol[] | null = null; let loading: Promise<void> | null = null;
const subs = new Set<() => void>();
function load(): Promise<void> {
  if (mem) return Promise.resolve();
  if (!loading) loading = AsyncStorage.getItem(KEY).then((s) => { try { mem = s ? JSON.parse(s) : []; } catch { mem = []; } }).catch(() => { mem = []; });
  return loading;
}
export function toggleFollow(a: Fol): boolean {
  const list = mem || []; const on = list.some((x) => x.id === a.id);
  mem = on ? list.filter((x) => x.id !== a.id) : [a, ...list].slice(0, 300);
  AsyncStorage.setItem(KEY, JSON.stringify(mem)).catch(() => {});
  subs.forEach((f) => f());
  return !on;
}
export function useFollow(): Fol[] {
  const [v, setV] = useState<Fol[]>(mem || []);
  useEffect(() => { const f = () => setV(mem ? mem.slice() : []); subs.add(f); load().then(f); return () => { subs.delete(f); }; }, []);
  return v;
}
