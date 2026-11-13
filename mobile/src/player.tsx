import React, { createContext, useContext, useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Image, AppState, Platform, PermissionsAndroid } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSharedValue } from 'react-native-reanimated';
import { analyze, NB } from './spectrum';
import type { Track } from './api';
import { hiArt, smallArt, YB, streamUrl, streamErr, ymSignedIn, forgetStream } from './api';
import { playable, preload, forget, dropImage } from './audioCache';
import { LIGHT, DARK, withAccent, blackOf } from './theme';
import { similar, key as tkey } from './pulse';
import { useLikeSync } from './ysync';
// заранее — только на диск (expo-image), не в оперативную память: картинка появится мгновенно, но не держится в памяти зря
let XI: any = null; try { XI = require('expo-image').Image; } catch { XI = null; }
const prefetch = (u?: string) => { if (!u) return; try { if (XI && XI.prefetch) XI.prefetch(u, 'disk'); else Image.prefetch(u).catch(() => {}); } catch {} };

export type Playlist = { id: string; name: string; cover?: string; tracks: Track[]; at: number };
const Ctx = createContext<any>(null);
// один и тот же трек может прийти с разными id (сингл, альбом, чарт) — сравниваем ещё и по названию + артисту
const key = (t: Track) => (t.title || '').toLowerCase().replace(/ё/g, 'е').trim() + '|' + (t.artist || '').toLowerCase().trim();
const same = (a: Track, b: Track) => a.id === b.id || key(a) === key(b);
const uniq = (l: Track[]) => { const s = new Set<string>(); const ids = new Set<string>(); return l.filter((t) => { const k = key(t); if (s.has(k) || ids.has(t.id)) return false; s.add(k); ids.add(t.id); return true; }); };
export const usePlayer = () => useContext(Ctx);
// Позиция и длительность трека меняются несколько раз в секунду — они живут в ОТДЕЛЬНОМ контексте,
// который читает только блок прогресса в плеере.
const ProgCtx = createContext<{ pos: number; dur: number }>({ pos: 0, dur: 30 });
export const useProgress = () => useContext(ProgCtx);
// Тема (цвета) — отдельно: экраны, которым нужны только цвета, не перерисовываются при смене трека, паузе и т.п.
const ThemeCtx = createContext<any>(withAccent(LIGHT, 'pink'));
export const useTheme = () => useContext(ThemeCtx);
// «Играет / пауза» — отдельно: при нажатии на паузу перерисовываются только кнопки и эквалайзеры, а не всё приложение.
const PlayingCtx = createContext(false);
// id текущего трека — отдельно: строки списков следят только за ним и не перерисовываются от остальных изменений плеера
const CurCtx = createContext<string | undefined>(undefined);
export const useCurId = () => useContext(CurCtx);
export const usePlaying = () => useContext(PlayingCtx);

// Статистика прослушивания: храним не больше этого числа треков и артистов (самые слушаемые),
// иначе со временем файл статистики растёт, и его сохранение начинает подтормаживать приложение.
const MAX_STAT_TRACKS = 400, MAX_STAT_ARTISTS = 250;
function pruneStats(s: any) {
  const cut = (o: Record<string, any>, n: number) => {
    const e = Object.entries(o || {}); if (e.length <= n) return o || {};
    e.sort((a, b) => (b[1].s || 0) - (a[1].s || 0)); return Object.fromEntries(e.slice(0, n));
  };
  s.tracks = cut(s.tracks, MAX_STAT_TRACKS); s.artists = cut(s.artists, MAX_STAT_ARTISTS);
  // по дням храним последние 120 дней (для графиков «Неделя» и «Месяц»), старше — удаляем
  if (s.days) { const old = dayKey(new Date(Date.now() - 120 * 864e5)); for (const k of Object.keys(s.days)) if (k < old) delete s.days[k]; }
  return s;
}
// Ключ дня по местному времени: «2026-10-25»
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export type DayStat = { s: number; h: number[]; a: Record<string, number>; g: Record<string, number>; t: Record<string, number> };
// «Мой пульс» — бесконечная очередь. Уже прослушанные треки дальше этого числа назад убираются из очереди,
// чтобы она не росла часами (иначе со временем тормозят подбор новых треков и список «Далее»).
const KEEP_BEHIND = 30;

// название, исполнитель и обложка — в шторке и на заблокированном экране. Управление плеером в шторке включаем
// ОДИН раз: раньше оно пересоздавалось на каждом треке (Android при этом показывал «ничего не играет», а в фоне
// мог не дать перезапустить службу плеера). Дальше для нового трека меняются только название и обложка.
// Кнопки «назад» / «вперёд» в шторке — из доработанного плеера (patch-expo-audio.js), нажатия приходят в статус как remote.
let lockOn = false; let notifAsked = false;
function lockScreen(player: any, t: Track) {
  const meta = { title: t.title, artist: t.artist, albumTitle: (t as any).album || '', artworkUrl: hiArt((t as any).art || (t as any).cover) };
  try {
    if (!lockOn) { player.setActiveForLockScreen?.(true, meta, { showSeekForward: false, showSeekBackward: false }); lockOn = true; }
    else player.updateLockScreenMetadata?.(meta);
  } catch {}
  // Android 13+: без разрешения на уведомления шторка плеера может не появиться — спрашиваем один раз, при первом треке
  if (!notifAsked && Platform.OS === 'android' && (Platform.Version as number) >= 33) {
    notifAsked = true;
    PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any).catch(() => {});
  }
}

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const player = useAudioPlayer(null);
  const st = useAudioPlayerStatus(player);
  const [q, setQ] = useState<Track[]>([]);
  const [i, setI] = useState(-1);
  const [src, setSrc] = useState<string | undefined>(undefined);   // откуда играет очередь ('pulse' — «Мой пульс»)
  const [shuffle, setShuffle] = useState(false);
  const [rep, setRep] = useState(0); // 0 нет, 1 все, 2 один
  // Автопродолжение: когда альбом, плейлист или одиночный трек заканчивается — дальше играют похожие треки.
  // autoFrom — с какого места очереди начинаются подобранные треки (для подписи в «Далее»).
  const [auto, setAuto] = useState(true); const [autoFrom, setAutoFrom] = useState<number | null>(null);
  const [volume, setVol] = useState(1);
  const [favs, setFavs] = useState<Track[]>([]);
  // плейлисты: название, своя обложка (файл на телефоне) или автообложка из треков
  const [lists, setLists] = useState<Playlist[]>([]);
  const [recent, setRecent] = useState<Track[]>([]);
  const [profile, setProfile] = useState({ name: 'Гость', photo: '' });
  const [dark, setDark] = useState(false);
  const [accent, setAccent] = useState('pink');   // цвет оформления (подписка «Импульс»)
  const [black, setBlack] = useState(false);      // чёрная тема — отдельно от цветов
  const statsRef = useRef<any>({ sec: 0, tracks: {}, artists: {} });
  const [ready, setReady] = useState(false);
  // ---- звук «в моменте» для живой линии «Моего пульса» ----
  // bands — громкость 24 частотных полос (бас → высокие), fresh > 0 — данные свежие.
  // Перехват звука в плеере включается ОДИН раз (при первом открытии «Моего пульса») и не выключается —
  // иначе плеер перенастраивает звук и он «заикается». А вот слушатель данных подключается только пока
  // «Мой пульс» на экране: когда он скрыт, кусочки звука не передаются в JavaScript и не разбираются.
  const bands = useSharedValue<number[]>(new Array(NB).fill(0));
  const fresh = useSharedValue(0);
  const [armed, setArmed] = useState(false); const [listen, setListen] = useState(false);
  const setSampling = useCallback((v: boolean) => { setListen(v); if (v) setArmed(true); }, []);
  useEffect(() => {
    const pl: any = player; if (!armed || pl.isAudioSamplingSupported === false) return;
    try { pl.setAudioSamplingEnabled?.(true); } catch {}
  }, [armed, player]);
  useEffect(() => {
    const pl: any = player; if (!armed || !listen || pl.isAudioSamplingSupported === false) return;
    let sub: any = null; let last = 0;
    try {
      sub = pl.addListener?.('audioSampleUpdate', (smp: any) => {
        const now = Date.now(); if (now - last < 40) return; last = now;
        const r = analyze(smp); if (r) { bands.value = r; fresh.value = 1; }
      });
    } catch {}
    return () => { try { sub?.remove?.(); } catch {} };
  }, [armed, listen, player]);

  useEffect(() => {
    // музыка играет и в фоне, и на заблокированном экране (Android — через уведомление плеера)
    setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' } as any).catch(() => setAudioModeAsync({ playsInSilentMode: true }).catch(() => {}));
    AsyncStorage.getItem('pulse').then((v) => { if (v) { const d = JSON.parse(v); setFavs(d.favs || []); setLists(d.lists || []); setRecent(uniq(d.recent || [])); if (d.profile) setProfile(d.profile); if (d.dark) setDark(true); if (d.accent) setAccent(d.accent); if (d.black) setBlack(true); if (d.auto === false) setAuto(false); } }).catch(() => {}).finally(() => setReady(true));
    AsyncStorage.getItem('pulse_now').then((v) => {
      if (!v) return; const d = JSON.parse(v); if (!d || !Array.isArray(d.q) || !d.q[d.i]) return;
      if (S.current.q.length) return;   // уже что-то включили, пока читали
      setQ(d.q); setI(d.i); setSrc(d.src); resumeAt.current = d.pos > 3 && d.pos < (d.q[d.i].dur || 1e9) - 5 ? d.pos : 0;
    }).catch(() => {});
    AsyncStorage.getItem('pulse_stats').then((v) => { if (v) { const d = JSON.parse(v); if (d && d.tracks) statsRef.current = pruneStats(d); } }).catch(() => {});
  }, []);

  // ---- сохранение на телефон ----
  // Основные данные сохраняются не на каждое изменение, а через полсекунды после последнего (несколько лайков подряд —
  // одна запись). При уходе приложения в фон всё несохранённое записывается сразу.
  const saveData = useRef({ favs, lists, recent, profile, dark, accent, black, auto }); saveData.current = { favs, lists, recent, profile, dark, accent, black, auto };
  const saveT = useRef<any>(null); const dirty = useRef(false);
  const flushData = useCallback(() => {
    clearTimeout(saveT.current); if (!dirty.current) return; dirty.current = false;
    AsyncStorage.setItem('pulse', JSON.stringify(saveData.current)).catch(() => {});
  }, []);
  useEffect(() => { if (!ready) return; dirty.current = true; clearTimeout(saveT.current); saveT.current = setTimeout(flushData, 500); }, [favs, lists, recent, profile, dark, accent, black, auto, ready]);
  const statsDirty = useRef(false);
  const flushStats = useCallback(() => {
    if (!statsDirty.current) return; statsDirty.current = false;
    AsyncStorage.setItem('pulse_stats', JSON.stringify(pruneStats(statsRef.current))).catch(() => {});
  }, []);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s !== 'active') { flushData(); flushStats(); } });
    return () => { sub.remove(); clearTimeout(saveT.current); };
  }, []);

  // Страховка от «зависших» загрузок: если за 7 секунд трек так и не начал играть — пробуем ещё раз
  // напрямую из сети, а если и так не вышло — тихо переходим к следующему.
  const watch = useRef<{ t?: Track; at: number; tries: number; ok: boolean; timer?: any }>({ at: 0, tries: 0, ok: true });
  const userPaused = useRef(false);
  // preview — Яндекс отдал только 30-секундный фрагмент (без входа / без Плюса): плеер честно это показывает
  const [preview, setPreview] = useState(false); const [playErr, setPlayErr] = useState(''); const fails = useRef(0);
  const startN = useRef(0);
  // Последний трек после перезапуска (или обновления): очередь и место сохраняются; при запуске трек стоит
  // в мини-плеере на паузе, звук не грузится, пока не нажали «играть» — тогда продолжаем с того же места
  const hasSrc = useRef(false); const resumeAt = useRef(0);
  const start = useCallback((t: Track, direct?: boolean) => {
    hasSrc.current = true;
    if (YB) {
      // режим Яндекса: ссылку на звук берём прямо перед проигрыванием (они живут недолго). Пока она едет —
      // прежний трек замолкает; пришла ссылка на другой трек (успели переключить) — её не используем
      const n = ++startN.current; try { player.pause(); } catch {}
      streamUrl(t).then((s) => {
        if (n !== startN.current) return;
        // звук не получен: пробуем следующий трек, но не больше 2 раз подряд — иначе (сервер недоступен, нужен вход)
        // очередь «бесконечно пролистывалась». После этого останавливаемся и показываем причину
        if (!s) { setPreview(false); fails.current += 1; setPlayErr(streamErr || 'Не удалось получить звук'); if (fails.current < 3 && S.current.q.length > 1) stepRef.current(1); return; }
        fails.current = 0; setPlayErr(''); setPreview(s.preview); player.replace({ uri: s.url }); player.play(); lockScreen(player, t);
        // пришёл фрагмент, хотя вход в Яндекс есть: тихо спрашиваем полный звук ещё раз и, как только он есть,
        // подменяем на том же месте — без паузы и без перезапуска трека
        if (s.preview) ymSignedIn().then((ok) => { if (!ok) return; let k = 0;
          const up = () => { if (n !== startN.current || k++ >= 3) return; forgetStream(t);
            streamUrl(t).then((f) => {
              if (n !== startN.current) return;
              if (!f || f.preview) { setTimeout(up, 1500 * k); return; }
              let pos = 0; try { pos = player.currentTime || 0; } catch {}
              const wasOn = playingRef.current || !userPaused.current;
              player.replace({ uri: f.url }); if (pos > 0.5) { resumeAt.current = pos; } if (wasOn) player.play(); setPreview(false);
            }).catch(() => setTimeout(up, 1500 * k)); };
          setTimeout(up, 700); });
      }).catch(() => {});
      return;
    }
    player.replace({ uri: direct ? t.url : playable(t.url) }); player.play(); lockScreen(player, t);
  }, [player]);
  const S = useRef({ q, i, shuffle, rep, src, auto }); S.current = { q, i, shuffle, rep, src, auto };
  const autoReq = useRef<{ q: Track[]; p: Promise<Track[]>; done?: boolean } | null>(null); const autoPlay = useRef(false);
  const stepRef = useRef<(d: number) => void>(() => {});
  const arm = useCallback(() => {
    const w = watch.current; clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      const c = watch.current; if (c.ok || userPaused.current || !c.t) return;
      if (c.tries === 0) { c.tries = 1; c.at = Date.now(); forget(c.t.url); start(c.t, true); arm(); }
      else if (S.current.q.length > 1) stepRef.current(1);
    }, 7000);
  }, [start]);
  const go = useCallback((list: Track[], k: number, from?: string) => {
    const t = list[k]; if (!t) return;
    if (list !== S.current.q && !(autoReq.current && autoReq.current.q === list)) { setAutoFrom(null); autoReq.current = null; autoPlay.current = false; }
    setQ(list); setI(k); setSrc(from);
    userPaused.current = false;
    watch.current = { t, at: Date.now(), tries: 0, ok: false, timer: watch.current.timer };
    start(t); arm();
    setRecent((r) => [t, ...r.filter((x) => !same(x, t))].slice(0, 40));
  }, [start, arm]);
  // актуальные значения для стабильных функций (функции не пересоздаются → экраны не перерисовываются зря)
  const step = useCallback((d: number) => {
    const { q, i, shuffle, src } = S.current; if (!q.length) return;
    go(q, shuffle && d > 0 ? Math.floor(Math.random() * q.length) : (i + d + q.length) % q.length, src);
  }, [go]);
  stepRef.current = step;
  // очередь «Моего пульса» растёт по мере прослушивания; давно прослушанное сзади отрезаем
  const extend = useCallback((more: Track[]) => {
    const cut = S.current.src === 'pulse' ? Math.max(0, S.current.i - KEEP_BEHIND) : 0;
    setQ((l) => [...l.slice(cut), ...more]);
    if (cut) setI((x) => x - cut);
  }, []);
  const setUpcoming = useCallback((more: Track[]) => setQ((l) => [...l.slice(0, S.current.i + 1), ...more]), []);
  useEffect(() => {
    const w = watch.current; if (w.ok) return;
    const el = (Date.now() - w.at) / 1000;
    if ((st.currentTime || 0) > 0.15 && (st.currentTime || 0) < el + 1) { w.ok = true; clearTimeout(w.timer); }
  }, [st.currentTime]);
  useEffect(() => () => clearTimeout(watch.current.timer), []);
  // звук загрузился — перематываем на место, где остановились в прошлый раз
  useEffect(() => {
    if (!st.isLoaded || !resumeAt.current) return;
    const s = resumeAt.current; resumeAt.current = 0;
    try { player.seekTo(s); } catch {}
  }, [st.isLoaded]);

  // кнопки «назад» / «вперёд» в шторке и на экране блокировки
  const remoteAt = (st as any).remoteAt as number | undefined, remoteCmd = (st as any).remote as string | undefined;
  const lastRemote = useRef(0);
  useEffect(() => {
    if (!remoteAt || remoteAt === lastRemote.current) return; lastRemote.current = remoteAt;
    if (remoteCmd === 'next') stepRef.current(1);
    else if (remoteCmd === 'prev') { let tm = 0; try { tm = player.currentTime || 0; } catch {} if (tm > 4) player.seekTo(0); else stepRef.current(-1); }
  }, [remoteAt]);
  useEffect(() => {
    if (!st.didJustFinish) return;
    const { q, i, rep, shuffle, src } = S.current;
    if (rep === 2) go(q, i, src); else if (src === 'pulse') step(1); else if (i < q.length - 1 || rep === 1 || shuffle) step(1);
    // конец очереди: похожие ещё грузятся — включим первый, как только придут
    else if (S.current.auto && autoReq.current && !autoReq.current.done) autoPlay.current = true;
  }, [st.didJustFinish]);
  // Автопродолжение: как только заиграл предпоследний или последний трек очереди (не «Мой пульс», без повтора
  // и перемешивания) — заранее подбираем 10 похожих и добавляем в конец. Так «Далее» сразу их показывает,
  // а звук первого из них успевает скачаться — переход без паузы. Дошли до конца подобранного — подбираем ещё.
  useEffect(() => {
    if (!auto || src === 'pulse' || rep !== 0 || shuffle || !q.length || i < q.length - 2) return;
    if (autoReq.current && autoReq.current.q === q && !autoReq.current.done) return;   // уже подбираем для этой очереди
    // со страницы артиста (src 'artist:<id>') — продолжаем его же песнями (недавно слушанные не исключаем), иначе — похожие треки
    const aid = typeof src === 'string' && src.startsWith('artist:') ? Number(src.slice(7)) || undefined : undefined;
    const base = q; const used = new Set((aid ? q : [...q, ...recent]).map(tkey));
    const p = similar(q.slice(Math.max(0, i - 4), i + 1), used, aid ? 15 : 10, aid); autoReq.current = { q: base, p };
    p.then((more) => {
      if (S.current.q !== base || !more.length) { if (S.current.q === base) autoReq.current = null; return; }
      const nq = [...base, ...more]; setQ(nq); setAutoFrom((f) => (f == null ? base.length : f));
      autoReq.current = { q: nq, p, done: true };   // следующая порция — когда дойдём до конца подобранного
      if (autoPlay.current) { autoPlay.current = false; go(nq, base.length, S.current.src); }
    }).catch(() => { if (S.current.q === base) autoReq.current = null; });
  }, [i, q, auto, src, rep, shuffle]);

  // заранее подгружаем большую обложку следующего трека — в плеере она появится мгновенно
  // и заранее скачиваем звук двух следующих треков — переключение без ожидания
  const cur = q[i];
  const nx1 = q.length ? q[(i + 1) % q.length] : undefined, nx2 = q.length ? q[(i + 2) % q.length] : undefined;
  useEffect(() => {
    const nx = [nx1, nx2].filter((x) => x && x !== cur) as Track[];
    const tms = nx.map((n, k) => {
      if (n.cover) { prefetch(hiArt(n.cover)); prefetch(smallArt(n.cover)); }
      return setTimeout(() => (YB ? streamUrl(n).catch(() => null) : preload(n.url)), k ? 1500 : 0);   // следующий — сразу, через один — чуть позже   // Яндекс: заранее готовим ссылку
    });
    return () => tms.forEach(clearTimeout);
  }, [cur?.id, nx1?.id, nx2?.id]);

  // ссылка на звук живёт около минуты — поэтому за ~35 с до конца трека готовим её для следующего ещё раз:
  // переход мгновенный, в том числе при выключенном экране
  const nearRef = useRef('');
  useEffect(() => {
    const d = st.duration || 0, c = st.currentTime || 0;
    if (!YB || !d || d - c > 35 || !nx1 || !cur || nx1 === cur || nearRef.current === cur.id) return;
    nearRef.current = cur.id; streamUrl(nx1).catch(() => null);
  }, [Math.floor((st.currentTime || 0) / 5), cur?.id]);
  const curRef = useRef<Track | undefined>(undefined); curRef.current = cur;
  const saveNow = useCallback(() => {
    const { q, i, src } = S.current; if (!q[i]) return;
    // очередь «Моего пульса» бывает длинной — храним окно вокруг текущего трека
    const a = Math.max(0, i - 20), qq = q.slice(a, i + 80);
    let pos = 0; try { pos = hasSrc.current ? player.currentTime || 0 : resumeAt.current; } catch {}
    AsyncStorage.setItem('pulse_now', JSON.stringify({ q: qq, i: i - a, src, pos: Math.round(pos) })).catch(() => {});
  }, [player]);
  useEffect(() => { if (ready && cur) saveNow(); }, [cur?.id, ready]);
  useEffect(() => { if (!st.playing) { if (hasSrc.current) saveNow(); return; } const iv = setInterval(saveNow, 10000); return () => clearInterval(iv); }, [st.playing]);
  useEffect(() => { const sub = AppState.addEventListener('change', (s) => { if (s !== 'active') saveNow(); }); return () => sub.remove(); }, []);
  useEffect(() => {
    if (!st.playing) { flushStats(); return; }
    let n = 0;
    const id = setInterval(() => {
      const t = curRef.current; if (!t) return; const s = statsRef.current; s.sec += 1; statsDirty.current = true;
      const e = s.tracks[t.id] || (s.tracks[t.id] = { t, s: 0 }); e.s += 1;
      const a = s.artists[t.artist] || (s.artists[t.artist] = { s: 0, cover: t.cover, artistId: t.artistId }); a.s += 1;
      // по дням: сколько слушали, в какие часы, каких артистов, жанры и треки — для экрана «Статистика»
      const now = new Date(); const days = s.days || (s.days = {}); const k = dayKey(now);
      const d: DayStat = days[k] || (days[k] = { s: 0, h: new Array(24).fill(0), a: {}, g: {}, t: {} });
      d.s += 1; d.h[now.getHours()] += 1; d.a[t.artist] = (d.a[t.artist] || 0) + 1; d.t[t.id] = (d.t[t.id] || 0) + 1;
      if (t.genre) d.g[t.genre] = (d.g[t.genre] || 0) + 1;
      // статистика копится тихо (без перерисовки экранов), на телефон сохраняется раз в 20 секунд и при паузе
      if (++n % 20 === 0) flushStats();
    }, 1000);
    return () => clearInterval(id);
  }, [st.playing]);

  const playing = !!st.playing;
  const playingRef = useRef(playing); playingRef.current = playing;
  const T = useMemo(() => (black ? blackOf(withAccent(DARK, accent)) : withAccent(dark ? DARK : LIGHT, accent)), [dark, accent, black]);
  // Действия — одни и те же функции на всё время работы приложения
  const listsRef = useRef(lists); listsRef.current = lists;
  const act = useMemo(() => ({
    toggleDark: () => setDark((x) => !x), setAccent, setBlack,
    toggle: () => {
      if (playingRef.current) { userPaused.current = true; player.pause(); return; }
      userPaused.current = false;
      // трек восстановлен после перезапуска, звука ещё нет — загружаем и играем с сохранённого места
      if (!hasSrc.current) { const { q, i } = S.current; const t = q[i]; if (t) { watch.current = { t, at: Date.now(), tries: 0, ok: false, timer: watch.current.timer }; start(t); arm(); } return; }
      player.play();
    },
    seek: (s: number) => { if (!hasSrc.current) { resumeAt.current = s; return; } player.seekTo(s); },
    // точное время трека прямо сейчас (для живого текста — читается каждый кадр, без перерисовок)
    now: (): number => { try { return player.currentTime || 0; } catch { return 0; } },
    setVolume: (v: number) => { setVol(v); player.volume = v; },
    // во время перетаскивания ползунка громкости меняется только звук — без перерисовки приложения
    previewVolume: (v: number) => { player.volume = v; },
    toggleShuffle: () => setShuffle((x) => !x), cycleRep: () => setRep((x) => (x + 1) % 3),
    setProfile, setAuto,
    toggleFav: (t: Track) => setFavs((f) => (f.some((x) => x.id === t.id) ? f.filter((x) => x.id !== t.id) : [t, ...f])),
    // first — один трек или сразу весь список (плейлист от ИИ-диджея)
    createList: (name: string, first?: Track | Track[]) => { const id = 'pl' + Date.now().toString(36); setLists((l) => [{ id, name, tracks: Array.isArray(first) ? first.slice() : first ? [first] : [], at: Date.now() }, ...l]); return id; },
    renameList: (id: string, name: string) => setLists((l) => l.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p))),
    // своя обложка плейлиста хранится файлом — прежний файл удаляем, чтобы они не копились
    setListCover: (id: string, cover?: string) => {
      const old = listsRef.current.find((p) => p.id === id)?.cover; if (old && old !== cover) dropImage(old);
      setLists((l) => l.map((p) => (p.id === id ? { ...p, cover } : p)));
    },
    // удаляется только сам плейлист (и файл его обложки); треки в «Любимом», других плейлистах и истории не трогаются
    deleteList: (id: string) => {
      const old = listsRef.current.find((p) => p.id === id)?.cover; if (old) dropImage(old);
      setLists((l) => l.filter((p) => p.id !== id));
    },
    toggleInList: (id: string, t: Track) => setLists((l) => l.map((p) => (p.id !== id ? p : p.tracks.some((x) => same(x, t)) ? { ...p, tracks: p.tracks.filter((x) => !same(x, t)) } : { ...p, tracks: [...p.tracks, t] }))),
  }), [player, start, arm]);
  // проверка «в любимом» — через набор id (быстро даже при сотнях любимых треков)
  // общее «Любимое» с ПК — через «Мне нравится» Яндекс Музыки (ysync.ts)
  useLikeSync(favs, setFavs, ready);
  const favIds = useMemo(() => new Set(favs.map((x) => x.id)), [favs]);
  const value = useMemo(() => ({
    ...act,
    T, dark, black, get stats() { return statsRef.current; }, accent,
    cur: cur as Track | undefined, queue: q, idx: i, go, step, src, extend, setUpcoming, bands, fresh, setSampling,
    // для совместимости: актуальное значение, но без подписки (подписка — usePlaying())
    get playing() { return playingRef.current; },
    volume, shuffle, rep,
    favs, recent, profile, auto, autoFrom, preview, playErr, ready,
    isFav: (t: Track) => favIds.has(t.id),
    lists,
    inList: (id: string, t: Track) => !!lists.find((p) => p.id === id)?.tracks.some((x) => same(x, t)),
  }), [act, T, dark, black, accent, q, i, src, go, step, extend, setUpcoming, volume, shuffle, rep, favs, favIds, lists, recent, profile, auto, autoFrom, preview, playErr, ready]);
  const pos = st.currentTime || 0, dur = st.duration || 30;
  const prog = useMemo(() => ({ pos, dur }), [pos, dur]);
  return (
    <ThemeCtx.Provider value={T}>
      <Ctx.Provider value={value}>
        <CurCtx.Provider value={cur?.id}>
        <PlayingCtx.Provider value={playing}>
          <ProgCtx.Provider value={prog}>{children}</ProgCtx.Provider>
        </PlayingCtx.Provider>
        </CurCtx.Provider>
      </Ctx.Provider>
    </ThemeCtx.Provider>
  );
}

// Номер сборки файла. Все файлы папки src должны быть из одной сборки — иначе приложение покажет подсказку, а не ошибку.
export const BUILD = 64;
