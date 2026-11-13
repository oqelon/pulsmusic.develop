// Готова ли стартовая страница: заставка не уходит, пока главная не получила первые данные (чарт),
// но и не держит дольше нескольких секунд, если сети нет.
let done = false; const subs = new Set<() => void>();
export function bootReady() { if (done) return; done = true; subs.forEach((f) => f()); subs.clear(); }
export function onBoot(f: () => void) { if (done) { f(); return () => {}; } subs.add(f); return () => { subs.delete(f); }; }
