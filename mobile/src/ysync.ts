// Общее «Любимое» для компьютера и телефона — без регистрации: лайки хранятся в «Мне нравится» Яндекс Музыки
// того же аккаунта (тот же токен). Тот же код — в версии для ПК (src/ysync.js).
//
// Слияние «на троих»: base — список лайков Яндекса после прошлой сверки.
//  • появилось в Яндексе, а не было в base — лайк поставили на другом устройстве → добавляем сюда;
//  • было в base, пропало из Яндекса — сняли на другом устройстве → убираем здесь;
//  • есть здесь, нет в base и в Яндексе — поставили здесь → отправляем в Яндекс;
//  • было в base, сняли здесь, а в Яндексе ещё стоит → снимаем в Яндексе.
// Первая сверка (base ещё нет) — просто объединение: ничего не удаляется ни здесь, ни в Яндексе.
export async function syncLikes(a: any): Promise<{ added: number; removed: number; sent: number }> {
  const remote = await a.fetchRemote();
  let st = a.load() || null;
  if (!st || st.uid !== remote.uid) st = { uid: remote.uid, base: null };
  const R = new Map<string, any>(remote.ids.map((x: any) => [x.id, x]));
  const local = a.getLocal();
  const L = new Map<string, any>(); for (const t of local) { const id = a.yid(t); if (id) L.set(id, t); }
  const B: Set<string> | null = st.base ? new Set<string>(st.base) : null;
  // защита: Яндекс вдруг прислал пустой список, а раньше лайки были — ничего не удаляем
  const glitch = B && R.size === 0 && B.size > 3;
  const addHere: any[] = [], dropHere = new Set<string>(), addThere: string[] = [], dropThere: string[] = [];
  for (const [id, x] of R) if (!L.has(id) && (!B || !B.has(id))) addHere.push(x);
  for (const [id, t] of L) {
    if (R.has(id)) continue;
    if (B && B.has(id)) { if (!glitch) dropHere.add(id); }
    else addThere.push(id + (a.yalb(t) ? ':' + a.yalb(t) : ''));
  }
  if (B) for (const id of B) if (!L.has(id) && R.has(id)) dropThere.push(id);
  if (addThere.length) await a.push(addThere, true);
  if (dropThere.length) await a.push(dropThere, false);
  // новые лайки с другого устройства: сначала свежие
  addHere.sort((x: any, y: any) => String(y.ts).localeCompare(String(x.ts)));
  let fresh: any[] = [];
  if (addHere.length) fresh = await a.fetchTracks(addHere.map((x: any) => x.id + (x.album ? ':' + x.album : '')));
  if (fresh.length || dropHere.size) {
    const order = new Map<string, number>(addHere.map((x: any, i: number) => [x.id, i]));
    fresh.sort((x: any, y: any) => (order.get(a.yid(x)) ?? 0) - (order.get(a.yid(y)) ?? 0));
    a.apply((cur: any[]) => {
      const have = new Set(cur.map((t: any) => a.yid(t)).filter(Boolean));
      const kept = cur.filter((t: any) => !dropHere.has(a.yid(t)));
      return [...fresh.filter((t: any) => !have.has(a.yid(t))), ...kept];
    });
  }
  const fin = new Set<string>(R.keys());
  for (const id of addThere) fin.add(id.split(':')[0]);
  for (const id of dropThere) fin.delete(id);
  if (glitch) for (const id of B) fin.add(id);
  a.save({ uid: remote.uid, base: [...fin] });
  return { added: fresh.length, removed: dropHere.size, sent: addThere.length + dropThere.length };
}

// ---------- телефон: когда сверять ----------
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import * as api from './api';
import type { Track } from './api';

const KEY = 'pulse.ysync';
let st: any = undefined;
// при запуске, когда приложение снова открыли (не чаще раза в минуту), раз в 2 мин на экране и через 2,5 с после лайка
export function useLikeSync(favs: Track[], setFavs: (f: (cur: Track[]) => Track[]) => void, ready: boolean, onNews?: (n: number) => void) {
  const fr = useRef(favs); fr.current = favs;
  const busy = useRef(false); const again = useRef(false); const last = useRef(0);
  const run = useCallback(async () => {
    if (!ready) return;
    if (busy.current) { again.current = true; return; }
    if (!(await api.ySyncOn())) return;
    busy.current = true; last.current = Date.now();
    try {
      if (st === undefined) { try { st = JSON.parse((await AsyncStorage.getItem(KEY)) || 'null'); } catch { st = null; } }
      const r = await syncLikes({
        fetchRemote: api.yLikes, fetchTracks: api.yTracks, push: api.yLikeSet,
        getLocal: () => fr.current,
        apply: (f: (cur: Track[]) => Track[]) => setFavs((cur) => { const n = f(cur); fr.current = n; return n; }),
        yid: (t: Track) => (t && /^y\d+$/.test(t.id) ? t.id.slice(1) : null), yalb: (t: Track) => (t.albumId ? String(t.albumId) : ''),
        load: () => st, save: (v: any) => { st = v; AsyncStorage.setItem(KEY, JSON.stringify(v)).catch(() => {}); },
      });
      if (r.added || r.removed) onNews?.(r.added + r.removed);
    } catch (e: any) { console.warn('[sync]', String(e?.message || e).slice(0, 160)); }
    finally { busy.current = false; if (again.current) { again.current = false; setTimeout(run, 400); } }
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    const t0 = setTimeout(run, 2500);   // после запуска — когда главная уже нарисована
    const iv = setInterval(() => { if (AppState.currentState === 'active') run(); }, 120000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active' && Date.now() - last.current > 60000) run(); });
    return () => { clearTimeout(t0); clearInterval(iv); sub.remove(); };
  }, [ready, run]);
  const sig = favs.length + ':' + (favs[0] && favs[0].id); const first = useRef<string | null>(null);
  useEffect(() => { if (!ready) return; if (first.current === null) { first.current = sig; return; } if (sig === first.current) return; first.current = sig; const tm = setTimeout(run, 2500); return () => clearTimeout(tm); }, [sig, ready]);
  return run;
}
