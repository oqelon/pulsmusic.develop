// Таймер сна (как на ПК): через 15/30/45/60 минут или после текущего трека музыка встаёт на паузу.
import { useEffect, useState } from 'react';

export type Sleep = { at: number; track?: string } | null;   // at — когда остановить; track — «после этого трека»
let cur: Sleep = null;
const subs = new Set<() => void>();
export const sleepGet = () => cur;
export function sleepSet(v: Sleep) { cur = v; subs.forEach((f) => f()); }
export function useSleep(): Sleep {
  const [v, setV] = useState<Sleep>(cur);
  useEffect(() => { const f = () => setV(cur); subs.add(f); return () => { subs.delete(f); }; }, []);
  return v;
}
// подпись для меню: «ещё 23 мин» / «после трека»
export function sleepLabel(v: Sleep): string {
  if (!v) return '';
  if (v.track) return 'после трека';
  const m = Math.max(1, Math.ceil((v.at - Date.now()) / 60000));
  return `ещё ${m} мин`;
}
