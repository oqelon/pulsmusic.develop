#![allow(dead_code)]
// ПУЛЬС AETHER SOUND — фирменная обработка звука «Пульса».
//
// Где стоит: на общей шине движка, сразу после смешения голосов (значит, и во время плавного перехода между
// треками), до эквалайзера пользователя. Источник один: «ДО» и «ПОСЛЕ» — два выхода одной и той же обработки
// одного и того же звука, поэтому переключение не перезагружает трек и не сдвигает позицию.
//
// Что делает «ПОСЛЕ» (всё в f64, без потери разрядности, без насыщения и «украшающих» гармоник):
//  1. Тембр (параметрический EQ, минимально-фазовые бикварды, отклонения не больше ±1,5 дБ):
//     • 16 Гц, ФВЧ 2-го порядка (Баттерворт) — убирает неслышимый инфрабас: он съедает запас и раскачивает динамики, а не звучит;
//     • 70 Гц, полка +1 дБ — глубина баса;
//     • 230 Гц, −1,5 дБ — гулкость и «грязь» нижней середины, из-за которых бас кажется рыхлым;
//     • 3 кГц, −1 дБ (узко) — назойливость вокала и гитар;
//     • 12 кГц, полка +0,75 дБ — воздух: верх не становится глухим.
//  2. Мягкая динамическая коррекция резкости (5–8 кГц): срабатывает, только когда в этой полосе энергии заметно больше
//     обычного (резкие «с», цифровая жёсткость тарелок), не больше −3 дБ, с плавными атакой и отпусканием; в
//     остальное время полоса не тронута — детали остаются.
//  3. Выравнивание громкости: громкость «ДО» и «ПОСЛЕ» непрерывно измеряется по ITU-R BS.1770 (K-взвешивание,
//     окно ~3 с), и «ПОСЛЕ» подстраивается к «ДО» (не громче, чем +1,5 дБ, и не тише, чем −6 дБ) — разница слышна
//     в тембре, а не в громкости.
//  4. Лимитер истинных пиков: потолок −1 дБTP, межсэмпловые пики оцениваются интерполяцией ×4, упреждение ~1,3 мс,
//     плавный спад усиления (без искажений «на атаке»), отпускание 80 мс. На громких мастерах пики выше 0 дБFS между
//     сэмплами иначе превращаются в жёсткий клиппинг — одну из причин «цифровой» резкости.
//
// «ДО» — исходный звук, задержанный на те же ~1,3 мс (чтобы переключение было без сдвига). Переключение — плавное
// смешение «ДО»/«ПОСЛЕ» за 40 мс: без щелчка и без скачка громкости.

use std::f64::consts::PI;

#[derive(Clone, Copy, Default, Debug)]
pub struct Bi { b0: f64, b1: f64, b2: f64, a1: f64, a2: f64 }
#[derive(Clone, Copy, Default)]
pub struct St { z1: f64, z2: f64 }

impl Bi {
    fn norm(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Bi { Bi { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 } }
    fn w(f: f64, sr: f64) -> (f64, f64) { let w = 2.0 * PI * (f / sr).min(0.49); (w.sin(), w.cos()) }
    // RBJ Audio EQ Cookbook
    pub fn peak(f: f64, q: f64, db: f64, sr: f64) -> Bi {
        let a = 10f64.powf(db / 40.0); let (sn, cs) = Self::w(f, sr); let al = sn / (2.0 * q);
        Self::norm(1.0 + al * a, -2.0 * cs, 1.0 - al * a, 1.0 + al / a, -2.0 * cs, 1.0 - al / a)
    }
    pub fn low_shelf(f: f64, db: f64, sr: f64) -> Bi {
        let a = 10f64.powf(db / 40.0); let (sn, cs) = Self::w(f, sr); let al = sn / 2.0 * 2f64.sqrt(); let s = 2.0 * a.sqrt() * al;
        Self::norm(a * ((a + 1.0) - (a - 1.0) * cs + s), 2.0 * a * ((a - 1.0) - (a + 1.0) * cs), a * ((a + 1.0) - (a - 1.0) * cs - s),
            (a + 1.0) + (a - 1.0) * cs + s, -2.0 * ((a - 1.0) + (a + 1.0) * cs), (a + 1.0) + (a - 1.0) * cs - s)
    }
    pub fn high_shelf(f: f64, db: f64, sr: f64) -> Bi {
        let a = 10f64.powf(db / 40.0); let (sn, cs) = Self::w(f, sr); let al = sn / 2.0 * 2f64.sqrt(); let s = 2.0 * a.sqrt() * al;
        Self::norm(a * ((a + 1.0) + (a - 1.0) * cs + s), -2.0 * a * ((a - 1.0) + (a + 1.0) * cs), a * ((a + 1.0) + (a - 1.0) * cs - s),
            (a + 1.0) - (a - 1.0) * cs + s, 2.0 * ((a - 1.0) - (a + 1.0) * cs), (a + 1.0) - (a - 1.0) * cs - s)
    }
    pub fn hp(f: f64, q: f64, sr: f64) -> Bi {
        let (sn, cs) = Self::w(f, sr); let al = sn / (2.0 * q);
        Self::norm((1.0 + cs) / 2.0, -(1.0 + cs), (1.0 + cs) / 2.0, 1.0 + al, -2.0 * cs, 1.0 - al)
    }
    /// полосовой с усилением 0 дБ на центральной частоте
    pub fn bp(f: f64, q: f64, sr: f64) -> Bi {
        let (sn, cs) = Self::w(f, sr); let al = sn / (2.0 * q);
        Self::norm(al, 0.0, -al, 1.0 + al, -2.0 * cs, 1.0 - al)
    }
    /// K-взвешивание ITU-R BS.1770 для любой частоты: ступень 1 (полка ~+4 дБ выше 1,7 кГц) и ступень 2 (ФВЧ ~38 Гц)
    pub fn k1(sr: f64) -> Bi {
        let (f0, g, q) = (1681.974450955533, 3.999843853973347, 0.7071752369554196);
        let k = (PI * f0 / sr).tan(); let vh = 10f64.powf(g / 20.0); let vb = vh.powf(0.4996667741545416);
        Self::norm(vh + vb * k / q + k * k, 2.0 * (k * k - vh), vh - vb * k / q + k * k, 1.0 + k / q + k * k, 2.0 * (k * k - 1.0), 1.0 - k / q + k * k)
    }
    pub fn k2(sr: f64) -> Bi {
        let (f0, q) = (38.13547087602444, 0.5003270373238773);
        let k = (PI * f0 / sr).tan();
        Self::norm(1.0, -2.0, 1.0, 1.0 + k / q + k * k, 2.0 * (k * k - 1.0), 1.0 - k / q + k * k)
    }
    #[inline]
    pub fn run(&self, s: &mut St, x: f64) -> f64 {
        let y = self.b0 * x + s.z1;
        s.z1 = self.b1 * x - self.a1 * y + s.z2;
        s.z2 = self.b2 * x - self.a2 * y;
        y
    }
    /// АЧХ в дБ на частоте f (для проверок)
    #[cfg(test)]
    pub fn mag_db(&self, f: f64, sr: f64) -> f64 {
        let w = 2.0 * PI * f / sr; let (c1, s1, c2, s2) = (w.cos(), w.sin(), (2.0 * w).cos(), (2.0 * w).sin());
        let (nr, ni) = (self.b0 + self.b1 * c1 + self.b2 * c2, -(self.b1 * s1 + self.b2 * s2));
        let (dr, di) = (1.0 + self.a1 * c1 + self.a2 * c2, -(self.a1 * s1 + self.a2 * s2));
        10.0 * ((nr * nr + ni * ni) / (dr * dr + di * di)).log10()
    }
}

/// Параметры фирменного тембра (см. шапку файла).
pub const VOICING: [(u8, f64, f64, f64); 5] = [
    // (вид: 0 ФВЧ, 1 низкая полка, 2 колокол, 3 высокая полка; частота; Q; дБ)
    (0, 16.0, 0.7071, 0.0),
    (1, 70.0, 0.0, 1.0),
    (2, 230.0, 0.9, -1.5),
    (2, 3000.0, 1.4, -1.0),
    (3, 12000.0, 0.0, 0.75),
];
const HARSH_F: f64 = 6500.0;
const HARSH_Q: f64 = 2.0;
const HARSH_T: f64 = -13.0;   // порог: полоса 5–8 кГц относительно всего звука выше 200 Гц, дБ
const HARSH_MAX: f64 = 3.0;   // не больше −3 дБ
const MATCH_MAX_UP: f64 = 1.5;
const MATCH_MAX_DOWN: f64 = -6.0;
const CEIL_DBTP: f64 = -1.0;
const XFADE_S: f64 = 0.040;

// интерполятор ×4 для оценки межсэмпловых пиков: 8 соседних сэмплов, окно Блэкмана
fn tp_coefs() -> [[f64; 8]; 3] {
    let mut c = [[0.0; 8]; 3];
    for p in 1..4 {
        let t = p as f64 / 4.0;
        let mut sum = 0.0;
        for i in 0..8 {
            let u = t - (i as f64 - 3.0);           // расстояние от точки до сэмпла x[n-7+i] (центр между i=3 и i=4)
            let s = if u.abs() < 1e-9 { 1.0 } else { (PI * u).sin() / (PI * u) };
            let x = (u + 4.0) / 8.0;                 // окно на [-4, 4]
            let w = 0.42 - 0.5 * (2.0 * PI * x).cos() + 0.08 * (4.0 * PI * x).cos();
            c[p - 1][i] = s * w; sum += s * w;
        }
        for i in 0..8 { c[p - 1][i] /= sum; }
    }
    c
}

pub struct Aether {
    sr: f64,
    eq: [Bi; 5],
    eq_st: [[St; 5]; 2],
    // резкость
    harsh: Bi, harsh_st: [St; 2], harsh_db: f64, harsh_set: f64, det_bp: Bi, det_hp: Bi, det_st: [St; 2], eb: f64, er: f64, e_att: f64, e_rel: f64, g_att: f64, g_rel: f64, tick: u32,
    // громкость
    kd: [Bi; 2], kd_st: [[St; 2]; 2], kw_st: [[St; 2]; 2], ms_d: f64, ms_w: f64, ms_a: f64, mg: f64, mg_a: f64,
    // лимитер истинных пиков
    l: usize, tpc: [[f64; 8]; 3], hist: [[f64; 8]; 2], req: Vec<f64>, req_i: usize, mins: Vec<f64>, box_sum: f64, box_i: usize,
    dl: [Vec<f64>; 2], dl_dry: [Vec<f64>; 2], dl_i: usize, lg: f64, lg_rel: f64, ceil: f64, lim_min: f64,
    // переключение
    pub w: f64, w_step: f64,
}

impl Aether {
    pub fn new(sr: u32) -> Aether {
        let sr = sr.max(8000) as f64;
        let eq = VOICING.map(|(k, f, q, db)| match k { 0 => Bi::hp(f, q, sr), 1 => Bi::low_shelf(f, db, sr), 3 => Bi::high_shelf(f, db, sr), _ => Bi::peak(f, q, db, sr) });
        let l = ((sr * 0.00133).round() as usize).max(16);
        let tc = |s: f64| 1.0 - (-1.0 / (s * sr)).exp();
        Aether {
            sr, eq, eq_st: [[St::default(); 5]; 2],
            harsh: Bi::peak(HARSH_F, HARSH_Q, 0.0, sr), harsh_st: [St::default(); 2], harsh_db: 0.0, harsh_set: 0.0,
            det_bp: Bi::bp(HARSH_F, HARSH_Q, sr), det_hp: Bi::hp(200.0, 0.707, sr), det_st: [St::default(); 2], eb: 0.0, er: 0.0,
            e_att: tc(0.002), e_rel: tc(0.050), g_att: tc(0.003), g_rel: tc(0.080), tick: 0,
            kd: [Bi::k1(sr), Bi::k2(sr)], kd_st: [[St::default(); 2]; 2], kw_st: [[St::default(); 2]; 2], ms_d: 0.0, ms_w: 0.0, ms_a: tc(3.0), mg: 1.0, mg_a: tc(1.0),
            l, tpc: tp_coefs(), hist: [[0.0; 8]; 2], req: vec![1.0; l + 2], req_i: 0, mins: vec![1.0; l], box_sum: l as f64, box_i: 0,
            dl: [vec![0.0; l + 4], vec![0.0; l + 4]], dl_dry: [vec![0.0; l + 4], vec![0.0; l + 4]], dl_i: 0, lg: 1.0, lg_rel: tc(0.080),
            ceil: 10f64.powf(CEIL_DBTP / 20.0), lim_min: 1.0,
            w: 0.0, w_step: 1.0 / (XFADE_S * sr),
        }
    }
    pub fn rate(&self) -> u32 { self.sr as u32 }
    /// задержка обработки в кадрах (одинакова для «ДО» и «ПОСЛЕ»)
    pub fn latency(&self) -> usize { self.l + 4 }
    pub fn match_db(&self) -> f64 { 20.0 * self.mg.log10() }
    pub fn harsh_db(&self) -> f64 { self.harsh_db }
    /// самое сильное ослабление лимитером с прошлого запроса (дБ) — и сброс
    pub fn take_lim_db(&mut self) -> f64 { let v = 20.0 * self.lim_min.log10(); self.lim_min = 1.0; v }

    /// Обработать стерео-кадры на месте (L R L R). `after` — какой режим слышен: false — «ДО», true — «ПОСЛЕ».
    pub fn process(&mut self, buf: &mut [f32], after: bool) {
        let frames = buf.len() / 2;
        let target = if after { 1.0 } else { 0.0 };
        let dn = self.dl[0].len();
        for i in 0..frames {
            let (xl, xr) = (buf[i * 2] as f64, buf[i * 2 + 1] as f64);
            // громкость «ДО» (K-взвешенная)
            let mut msd = 0.0;
            for (c, x) in [xl, xr].into_iter().enumerate() { let k0 = self.kd[0].run(&mut self.kd_st[c][0], x); let y = self.kd[1].run(&mut self.kd_st[c][1], k0); msd += y * y; }
            // тембр
            let mut v = [xl, xr];
            for c in 0..2 { for k in 0..5 { v[c] = self.eq[k].run(&mut self.eq_st[c][k], v[c]); } }
            // резкость: детектор по середине (L+R)/2
            let mid = (v[0] + v[1]) * 0.5;
            let b = self.det_bp.run(&mut self.det_st[0], mid); let r = self.det_hp.run(&mut self.det_st[1], mid);
            let (b2, r2) = (b * b, r * r);
            self.eb += (b2 - self.eb) * if b2 > self.eb { self.e_att } else { self.e_rel };
            self.er += (r2 - self.er) * if r2 > self.er { self.e_att } else { self.e_rel };
            let want = if self.eb > 1e-7 && self.er > 1e-9 { let ex = 10.0 * (self.eb / self.er).log10() - HARSH_T; -(ex * 0.5).clamp(0.0, HARSH_MAX) } else { 0.0 };
            self.harsh_db += (want - self.harsh_db) * if want < self.harsh_db { self.g_att } else { self.g_rel };
            self.tick = self.tick.wrapping_add(1);
            if self.tick % 16 == 0 && (self.harsh_db - self.harsh_set).abs() > 0.02 { self.harsh = Bi::peak(HARSH_F, HARSH_Q, self.harsh_db, self.sr); self.harsh_set = self.harsh_db; }
            for c in 0..2 { v[c] = self.harsh.run(&mut self.harsh_st[c], v[c]); }
            // громкость «ПОСЛЕ» до выравнивания и лимитера → выравнивание к «ДО»
            let mut msw = 0.0;
            for c in 0..2 { let k0 = self.kd[0].run(&mut self.kw_st[c][0], v[c]); let y = self.kd[1].run(&mut self.kw_st[c][1], k0); msw += y * y; }
            self.ms_d += (msd - self.ms_d) * self.ms_a;
            self.ms_w += (msw - self.ms_w) * self.ms_a;
            if self.ms_d > 1e-7 && self.ms_w > 1e-9 {
                let t = (self.ms_d / self.ms_w).sqrt().clamp(10f64.powf(MATCH_MAX_DOWN / 20.0), 10f64.powf(MATCH_MAX_UP / 20.0));
                self.mg += (t - self.mg) * self.mg_a;
            }
            for c in 0..2 { v[c] *= self.mg; }
            // лимитер истинных пиков: оценка пика на отрезке [n−4, n−3) по интерполяции ×4
            let mut pk = 0.0f64;
            for c in 0..2 {
                let h = &mut self.hist[c]; h.copy_within(1..8, 0); h[7] = v[c];
                pk = pk.max(h[3].abs());
                for p in 0..3 { let mut s = 0.0; for k in 0..8 { s += self.tpc[p][k] * h[k]; } pk = pk.max(s.abs()); }
            }
            let rq = if pk > self.ceil { self.ceil / pk } else { 1.0 };
            self.req[self.req_i] = rq; self.req_i = (self.req_i + 1) % self.req.len();
            let m = self.req.iter().cloned().fold(1.0f64, f64::min);
            self.box_sum += m - self.mins[self.box_i]; self.mins[self.box_i] = m; self.box_i = (self.box_i + 1) % self.l;
            let g_box = (self.box_sum / self.l as f64).min(1.0);
            if g_box < self.lg { self.lg = g_box; } else { self.lg += (g_box - self.lg) * self.lg_rel; }
            if self.lg < self.lim_min { self.lim_min = self.lg; }
            // задержка: «ПОСЛЕ» ждёт решения лимитера, «ДО» задержан так же
            let j = self.dl_i;
            let (wl, wr) = (self.dl[0][j] * self.lg, self.dl[1][j] * self.lg);
            let (dl0, dr0) = (self.dl_dry[0][j], self.dl_dry[1][j]);
            self.dl[0][j] = v[0]; self.dl[1][j] = v[1]; self.dl_dry[0][j] = xl; self.dl_dry[1][j] = xr;
            self.dl_i = (j + 1) % dn;
            // плавное смешение «ДО»/«ПОСЛЕ»
            if self.w < target { self.w = (self.w + self.w_step).min(target); } else if self.w > target { self.w = (self.w - self.w_step).max(target); }
            let (a, bw) = (1.0 - self.w, self.w);
            let ol = dl0 * a + wl.clamp(-self.ceil, self.ceil) * bw;
            let or = dr0 * a + wr.clamp(-self.ceil, self.ceil) * bw;
            buf[i * 2] = ol as f32; buf[i * 2 + 1] = or as f32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48000;
    // воспроизводимый шум
    struct Rng(u64);
    impl Rng { fn f(&mut self) -> f64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; (self.0 >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0 } }
    // «музыкоподобный» сигнал: розовый шум с наклоном спектра + бас + удары, разные жанры — разной окраской
    fn music(kind: u8, secs: f64, seed: u64) -> Vec<f32> { music2(kind, secs, seed, true) }
    fn music2(kind: u8, secs: f64, seed: u64, beats: bool) -> Vec<f32> {
        let n = (secs * SR as f64) as usize; let mut r = Rng(seed); let mut out = Vec::with_capacity(n * 2);
        let (mut b0, mut b1, mut b2, mut b3, mut b4, mut b5) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        let tilt = match kind { 0 => Bi::high_shelf(3000.0, -6.0, SR as f64), 1 => Bi::high_shelf(3000.0, 3.0, SR as f64), 2 => Bi::low_shelf(120.0, 8.0, SR as f64), _ => Bi::peak(1000.0, 1.0, 0.0, SR as f64) };
        let mut ts = [St::default(); 2];
        // настоящая музыка почти не содержит звука ниже 20 Гц; у генератора розового шума он есть — убираем
        let sub = Bi::hp(25.0, 0.7071, SR as f64); let mut ss = [St::default(); 2];
        for i in 0..n {
            let w = r.f();
            b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
            b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
            let pink = (b0 + b1 + b2 + b3 + b4 + b5 + w * 0.5362) * 0.11;
            let t = i as f64 / SR as f64;
            let beat = if beats { (-(t % 0.5) * 30.0).exp() * (2.0 * PI * 55.0 * t).sin() * 0.5 } else { 0.0 };
            let x = pink + beat + (2.0 * PI * 220.0 * t).sin() * 0.1;
            let y = tilt.run(&mut ts[0], sub.run(&mut ss[0], x));
            let z = tilt.run(&mut ts[1], sub.run(&mut ss[1], x * 0.9 + r.f() * 0.02));
            out.push(y as f32); out.push(z as f32);
        }
        // нормировка: пик 0 дБFS, как у громких мастеров
        let pk = out.iter().fold(0f32, |m, x| m.max(x.abs()));
        out.iter_mut().for_each(|x| *x /= pk);
        out
    }
    fn lufs(x: &[f32]) -> f64 {
        let (k1, k2) = (Bi::k1(SR as f64), Bi::k2(SR as f64)); let mut s = [[St::default(); 2]; 2]; let mut e = 0.0;
        for f in x.chunks_exact(2) { for c in 0..2 { let k0 = k1.run(&mut s[c][0], f[c] as f64); let y = k2.run(&mut s[c][1], k0); e += y * y; } }
        -0.691 + 10.0 * (e / (x.len() / 2) as f64).log10()
    }
    // истинный пик (дБTP) — независимой интерполяцией ×8 по 64 соседям
    fn true_peak_db(x: &[f32]) -> f64 {
        let n = x.len() / 2; let mut pk = 0f64;
        for c in 0..2 { for i in 32..n - 32 { for p in 0..8 { let t = p as f64 / 8.0; let mut s = 0.0;
            for k in -31i64..=32 { let u = t - k as f64; let sc = if u.abs() < 1e-12 { 1.0 } else { (PI * u).sin() / (PI * u) }; let w = 0.5 + 0.5 * (PI * u / 33.0).cos(); s += x[(i as i64 + k) as usize * 2 + c] as f64 * sc * w; }
            pk = pk.max(s.abs()); } } }
        20.0 * pk.log10()
    }
    fn run(a: &mut Aether, x: &[f32], after: bool) -> Vec<f32> { let mut y = x.to_vec(); for ch in y.chunks_mut(1024) { a.process(ch, after); } y }

    #[test]
    fn before_is_untouched() {
        let x = music(3, 3.0, 7); let mut a = Aether::new(SR); let y = run(&mut a, &x, false); let d = a.latency();
        for i in 0..x.len() / 2 - d { for c in 0..2 { assert_eq!(y[(i + d) * 2 + c], x[i * 2 + c], "«ДО» должно быть исходным звуком"); } }
    }

    #[test]
    fn voicing_is_gentle() {
        let sr = SR as f64; let eq = VOICING.map(|(k, f, q, db)| match k { 0 => Bi::hp(f, q, sr), 1 => Bi::low_shelf(f, db, sr), 3 => Bi::high_shelf(f, db, sr), _ => Bi::peak(f, q, db, sr) });
        let resp = |f: f64| eq.iter().map(|b| b.mag_db(f, sr)).sum::<f64>();
        for f in [40.0, 60.0, 100.0, 230.0, 500.0, 1000.0, 2000.0, 3000.0, 5000.0, 8000.0, 12000.0, 16000.0] { let r = resp(f); assert!(r.abs() <= 1.6, "{f} Гц: {r:.2} дБ — слишком сильно"); }
        assert!(resp(10.0) < -6.0, "инфрабас не убран: {:.1}", resp(10.0));
        assert!(resp(1000.0).abs() < 0.3);
        assert!(resp(230.0) < -1.0 && resp(55.0) > 0.3 && resp(15000.0) > 0.4);
    }

    #[test]
    fn after_matches_loudness_and_never_exceeds_ceiling() {
        for (kind, name) in [(0u8, "тёмный (акустика)"), (1, "яркий (рок/электроника)"), (2, "басовый (хип-хоп)"), (3, "ровный (поп/вокал)")] {
            let x = music(kind, 14.0, 11 + kind as u64);
            let mut a = Aether::new(SR); let y = run(&mut a, &x, true);
            let tail = 8 * SR as usize * 2;
            let (ld, lw) = (lufs(&x[tail..]), lufs(&y[tail..]));
            eprintln!("AETHER, {name}: ДО {ld:.2} LUFS, ПОСЛЕ {lw:.2} LUFS, разница {:+.2} дБ", lw - ld);
            // «ПОСЛЕ» не громче (+0,25 дБ — погрешность измерения) и не заметно тише (лимитер на мастерах с пиком 0 дБFS)
            assert!(lw - ld < 0.25 && lw - ld > -0.8, "{name}: громкость ДО {ld:.2}, ПОСЛЕ {lw:.2} LUFS");
            let tp = true_peak_db(&y[tail..tail + SR as usize * 2]);
            assert!(tp <= -0.7, "{name}: истинный пик {tp:.2} дБTP");
            assert!(y.iter().all(|v| v.abs() <= 1.0), "{name}: клиппинг");
        }
    }

    #[test]
    fn intersample_overs_are_caught() {
        // синус fs/4 со сдвигом 45°: сэмплы ±1,0, а между ними +3 дБ — классический межсэмпловый перегруз
        let n = SR as usize * 2; let mut x = Vec::with_capacity(n * 2);
        for i in 0..n { let v = (2.0 * PI * 0.25 * i as f64 + PI / 4.0).sin() * 2f64.sqrt(); x.push(v as f32); x.push(v as f32); }
        assert!(true_peak_db(&x) > 2.5);
        let mut a = Aether::new(SR); let y = run(&mut a, &x, true);
        let tp = true_peak_db(&y[SR as usize..]);
        assert!(tp <= -0.7, "истинный пик после лимитера {tp:.2} дБTP");
    }

    #[test]
    fn switching_is_smooth() {
        // переключаем ДО/ПОСЛЕ каждые 70 мс прямо во время звучания
        for kind in [1u8, 3] {
            let x = music(kind, 6.0, 3 + kind as u64);
            let mut z = x.clone(); let mut b = Aether::new(SR); b.w = 1.0; for ch in z.chunks_mut(1024) { b.process(ch, true); }
            let mut a = Aether::new(SR); let d = a.latency(); let step = a.w_step;
            let mut y = x.clone(); let mut after = false; let mut prev_w = 0.0; let mut ws = Vec::with_capacity(x.len() / 2);
            for n in 0..x.len() / 2 {
                if n % (SR as usize * 70 / 1000) == 0 { after = !after; }
                a.process(&mut y[n * 2..n * 2 + 2], after);
                assert!((a.w - prev_w).abs() <= step + 1e-12, "смешение меняется скачком");
                prev_w = a.w; ws.push(a.w);
            }
            // 1) один источник: на выходе ровно смесь «ДО» (исходный звук, задержанный) и «ПОСЛЕ» — без перезапуска и сдвига
            for n in d..x.len() / 2 { for c in 0..2 {
                let want = (1.0 - ws[n]) * x[(n - d) * 2 + c] as f64 + ws[n] * z[n * 2 + c] as f64;
                assert!((y[n * 2 + c] as f64 - want).abs() < 1e-5, "кадр {n}: {} вместо {want}", y[n * 2 + c]);
            } }
            // 2) «ДО» и «ПОСЛЕ» в каждый момент одной громкости (окна 50 мс, K-взвешивание) — переход без скачка
            let win = SR as usize / 20; let mut worst = 0f64;
            for s0 in (SR as usize * 3..x.len() / 2 - win - d).step_by(win) {
                let dry = &x[(s0 - d) * 2..(s0 - d + win) * 2]; let wet = &z[s0 * 2..(s0 + win) * 2];
                worst = worst.max((lufs(dry) - lufs(wet)).abs());
            }
            eprintln!("AETHER, переключение (вид {kind}): наибольшая разница громкости ДО/ПОСЛЕ в окне 50 мс — {worst:.2} дБ");
            assert!(worst < 1.5, "разница громкости ДО/ПОСЛЕ в моменте {worst:.2} дБ");
        }
    }

    #[test]
    fn harshness_control_is_selective() {
        // тёмный звук — не трогает; очень яркий — смягчает, но не больше −3 дБ
        let mut a = Aether::new(SR); run(&mut a, &music(0, 4.0, 5), true); let dark = a.harsh_db();
        let n = SR as usize * 4; let mut r = Rng(9); let hp = Bi::hp(4000.0, 0.7, SR as f64); let mut s = St::default();
        let x: Vec<f32> = (0..n).flat_map(|_| { let v = hp.run(&mut s, r.f()) as f32 * 0.5; [v, v] }).collect();
        let mut b = Aether::new(SR); let mut min = 0f64; for ch in x.clone().chunks_mut(1024) { b.process(ch, true); min = min.min(b.harsh_db()); }
        assert!(dark > -0.3, "тёмный звук: {dark:.2} дБ");
        assert!(min < -1.5 && min >= -HARSH_MAX - 0.01, "яркий звук: {min:.2} дБ");
    }

    #[test]
    fn cpu_is_low() {
        let x = music(3, 20.0, 1); let mut a = Aether::new(SR); let t = std::time::Instant::now(); let _ = run(&mut a, &x, true);
        let part = t.elapsed().as_secs_f64() / 20.0;
        eprintln!("AETHER: {:.2} % одного ядра", part * 100.0);
        assert!(part < 0.05, "слишком тяжело: {:.1} % ядра", part * 100.0);
    }
}
