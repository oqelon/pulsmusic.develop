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

/// Версия 1 (22.11.2026): тембр (см. шапку файла).
pub const VOICING: [(u8, f64, f64, f64); 5] = [
    // (вид: 0 ФВЧ, 1 низкая полка, 2 колокол, 3 высокая полка; частота; Q; дБ)
    (0, 16.0, 0.7071, 0.0),
    (1, 70.0, 0.0, 1.0),
    (2, 230.0, 0.9, -1.5),
    (2, 3000.0, 1.4, -1.0),
    (3, 12000.0, 0.0, 0.75),
];
/// Версия 2: чище и разборчивее (см. «Версия 2» ниже). Только вычитание в нижней середине и чуть глубины в басу;
/// провал 3 кГц и подъём 12 кГц убраны.
pub const VOICING2: [(u8, f64, f64, f64); 3] = [
    (0, 10.0, 0.5, 0.0),
    (1, 55.0, 0.0, 0.5),
    (2, 280.0, 0.8, -1.0),
];
const HARSH_F: f64 = 6500.0;
const HARSH_Q: f64 = 2.0;
const HARSH_T: f64 = -13.0;   // версия 1: порог полосы 5–8 кГц относительно всего звука выше 200 Гц, дБ
const HARSH_MAX: f64 = 3.0;
const MATCH_MAX_UP: f64 = 1.5;
const MATCH_MAX_DOWN: f64 = -6.0;
const XFADE_S: f64 = 0.040;

// Версия 2 — что изменено и почему (найденные причины «каши» в версии 1):
//  • провал −1 дБ на 3 кГц убирал как раз полосу разборчивости вокала и атаки инструментов → убран;
//  • полка +1 дБ на 70 Гц заметно задевает 100–200 Гц и добавляет нижней массы, а выравнивание громкости
//    (K-взвешивание почти не учитывает бас) ещё и поднимало всё вместе → полка +0,5 дБ на 55 Гц;
//  • смягчение 5–8 кГц срабатывало по постоянному порогу, т. е. почти всегда на ярких записях — съедало детали →
//    теперь только на всплесках относительно обычного уровня этой полосы в самом треке (сибилянты, «стекло»);
//  • лимитер с потолком −1 дБTP и отпусканием 80 мс на громких мастерах (пик 0 дБFS) работал на каждом ударе и
//    затягивал атаку ударных → потолок −0,5 дБTP, отпускание 30 мс: срабатывает реже и отпускает сразу после пика;
//  • ФВЧ 16 Гц (Баттерворт) поворачивал фазу в полосе бочки → 10 Гц, Q 0,5 (только инфразвук и постоянная составляющая);
//  • динамические полосы 3,2 и 6,5 кГц срабатывают с атакой 8–10 мс: первые миллисекунды удара (атака барабанов)
//    проходят нетронутыми, а сибилянты и резонансы (они длятся 50–200 мс) успевают ослабляться;
//  • «каша» в плотных местах — это нижняя середина (150–400 Гц), которая в такие моменты нарастает относительно
//    полосы разборчивости (1–4 кГц) и маскирует вокал → динамический эквалайзер 250 Гц: ослабляет до −2,5 дБ только
//    тогда, когда в этом треке нижняя середина вдруг выросла относительно своей обычной доли; плюс постоянные −1 дБ на
//    280 Гц; и динамический контроль резонансов 3,2 кГц (до −2 дБ, только на всплесках).
// Всё адаптивно к самому треку (сравнение с его собственным средним), поэтому не «одна настройка на всё».

#[derive(Clone, Copy)]
enum Det { Abs { thr: f64 }, Rel { margin: f64 } }
#[derive(Clone, Copy)]
struct DynSpec {
    f: f64, q: f64, max_db: f64, slope: f64, det: Det,
    band: (f64, f64),            // детектор: полоса (частота, Q)
    refr: Option<(f64, f64)>,    // с чем сравнивать: полоса (частота, Q) или None — весь звук выше 200 Гц
    env: (f64, f64), gain: (f64, f64), // атака/отпускание огибающих и усиления, с
}
const V1_DYN: [DynSpec; 1] = [DynSpec { f: HARSH_F, q: HARSH_Q, max_db: HARSH_MAX, slope: 0.5, det: Det::Abs { thr: HARSH_T }, band: (HARSH_F, HARSH_Q), refr: None, env: (0.002, 0.050), gain: (0.003, 0.080) }];
const V2_DYN: [DynSpec; 3] = [
    // нижняя середина в плотных местах относительно полосы разборчивости 2 кГц
    DynSpec { f: 250.0, q: 0.9, max_db: 2.5, slope: 0.6, det: Det::Rel { margin: 1.5 }, band: (250.0, 0.9), refr: Some((2000.0, 0.7)), env: (0.010, 0.150), gain: (0.020, 0.250) },
    // резонансы 3,2 кГц (крикливые гитары, «звон» вокала) — только всплески
    DynSpec { f: 3200.0, q: 2.0, max_db: 2.0, slope: 0.5, det: Det::Rel { margin: 3.0 }, band: (3200.0, 2.0), refr: None, env: (0.010, 0.060), gain: (0.010, 0.120) },
    // сибилянты и «стекло» 6,5 кГц — только всплески
    DynSpec { f: 6500.0, q: 2.5, max_db: 2.5, slope: 0.5, det: Det::Rel { margin: 3.0 }, band: (6500.0, 2.5), refr: None, env: (0.008, 0.050), gain: (0.008, 0.080) },
];

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

struct Dyn {
    sp: DynSpec, filt: Bi, st: [St; 2], cur: f64, set: f64, db: Bi, dr: Bi, ds: [St; 2], eb: f64, er: f64, long: f64, long_ok: bool,
    ea: f64, er_: f64, ga: f64, gr: f64, la: f64,
}
impl Dyn {
    fn new(sp: DynSpec, sr: f64) -> Dyn {
        let tc = |s: f64| 1.0 - (-1.0 / (s * sr)).exp();
        Dyn { sp, filt: Bi::peak(sp.f, sp.q, 0.0, sr), st: [St::default(); 2], cur: 0.0, set: 0.0,
            db: Bi::bp(sp.band.0, sp.band.1, sr), dr: match sp.refr { Some((f, q)) => Bi::bp(f, q, sr), None => Bi::hp(200.0, 0.707, sr) }, ds: [St::default(); 2],
            eb: 0.0, er: 0.0, long: 0.0, long_ok: false, ea: tc(sp.env.0), er_: tc(sp.env.1), ga: tc(sp.gain.0), gr: tc(sp.gain.1), la: tc(8.0) }
    }
    #[inline]
    fn detect(&mut self, mid: f64) {
        let b = self.db.run(&mut self.ds[0], mid); let r = self.dr.run(&mut self.ds[1], mid);
        let (b2, r2) = (b * b, r * r);
        self.eb += (b2 - self.eb) * if b2 > self.eb { self.ea } else { self.er_ };
        self.er += (r2 - self.er) * if r2 > self.er { self.ea } else { self.er_ };
        let want = if self.eb > 1e-7 && self.er > 1e-9 {
            let ratio = 10.0 * (self.eb / self.er).log10();
            match self.sp.det {
                Det::Abs { thr } => -((ratio - thr) * self.sp.slope).clamp(0.0, self.sp.max_db),
                Det::Rel { margin } => {
                    // сравнение с обычной долей этой полосы в самом треке (среднее за ~8 с)
                    if !self.long_ok { self.long = ratio; self.long_ok = true; } else { self.long += (ratio - self.long) * self.la; }
                    -((ratio - self.long - margin) * self.sp.slope).clamp(0.0, self.sp.max_db)
                }
            }
        } else { 0.0 };
        self.cur += (want - self.cur) * if want < self.cur { self.ga } else { self.gr };
    }
}

/// Одна версия обработки: тембр → динамика → выравнивание громкости → лимитер истинных пиков (+ задержка).
struct Chain {
    eq: Vec<Bi>, eq_st: Vec<[St; 2]>, dy: Vec<Dyn>, kw_st: [[St; 2]; 2], ms_w: f64, mg: f64,
    hist: [[f64; 8]; 2], req: Vec<f64>, req_i: usize, mins: Vec<f64>, box_sum: f64, box_i: usize,
    dl: [Vec<f64>; 2], lg: f64, lg_rel: f64, ceil: f64, lim_min: f64, lim_n: u64,
}
impl Chain {
    fn new(sr: f64, voicing: &[(u8, f64, f64, f64)], dy: &[DynSpec], ceil_db: f64, rel_s: f64, l: usize) -> Chain {
        let eq: Vec<Bi> = voicing.iter().map(|&(k, f, q, db)| match k { 0 => Bi::hp(f, q, sr), 1 => Bi::low_shelf(f, db, sr), 3 => Bi::high_shelf(f, db, sr), _ => Bi::peak(f, q, db, sr) }).collect();
        let n = eq.len();
        Chain { eq, eq_st: vec![[St::default(); 2]; n], dy: dy.iter().map(|d| Dyn::new(*d, sr)).collect(), kw_st: [[St::default(); 2]; 2], ms_w: 0.0, mg: 1.0,
            hist: [[0.0; 8]; 2], req: vec![1.0; l + 2], req_i: 0, mins: vec![1.0; l], box_sum: l as f64, box_i: 0,
            dl: [vec![0.0; l + 4], vec![0.0; l + 4]], lg: 1.0, lg_rel: 1.0 - (-1.0 / (rel_s * sr)).exp(), ceil: 10f64.powf(ceil_db / 20.0), lim_min: 1.0, lim_n: 0 }
    }
}

pub struct Aether {
    sr: f64, l: usize, tpc: [[f64; 8]; 3], tick: u32,
    kd: [Bi; 2], kd_st: [[St; 2]; 2], ms_d: f64, ms_a: f64, mg_a: f64,
    dl_dry: [Vec<f64>; 2], dl_i: usize,
    ch: [Chain; 2],
    /// доли в смеси: «ДО», версия 1, версия 2 (в сумме 1)
    pub mix: [f64; 3], step: f64,
    /// для совместимости проверок версии 1: доля «ПОСЛЕ» (версия 1)
    pub w: f64, w_step: f64,
    pub frames: u64,
}

impl Aether {
    pub fn new(sr: u32) -> Aether {
        let sr = sr.max(8000) as f64;
        let l = ((sr * 0.00133).round() as usize).max(16);
        let tc = |s: f64| 1.0 - (-1.0 / (s * sr)).exp();
        Aether {
            sr, l, tpc: tp_coefs(), tick: 0,
            kd: [Bi::k1(sr), Bi::k2(sr)], kd_st: [[St::default(); 2]; 2], ms_d: 0.0, ms_a: tc(3.0), mg_a: tc(1.0),
            dl_dry: [vec![0.0; l + 4], vec![0.0; l + 4]], dl_i: 0,
            ch: [Chain::new(sr, &VOICING, &V1_DYN, -1.0, 0.080, l), Chain::new(sr, &VOICING2, &V2_DYN, -0.5, 0.030, l)],
            mix: [1.0, 0.0, 0.0], step: 1.0 / (XFADE_S * sr), w: 0.0, w_step: 1.0 / (XFADE_S * sr), frames: 0,
        }
    }
    pub fn rate(&self) -> u32 { self.sr as u32 }
    /// задержка обработки в кадрах (одинакова для «ДО» и обеих версий)
    pub fn latency(&self) -> usize { self.l + 4 }
    /// выравнивание громкости версии v (1 или 2), дБ
    pub fn match_db_v(&self, v: usize) -> f64 { 20.0 * self.ch[v - 1].mg.log10() }
    pub fn match_db(&self) -> f64 { self.match_db_v(1) }
    /// текущее ослабление динамических полос версии v, дБ (версия 1 — одна полоса, версия 2 — три)
    pub fn dyn_db(&self, v: usize, k: usize) -> f64 { self.ch[v - 1].dy.get(k).map(|d| d.cur).unwrap_or(0.0) }
    pub fn harsh_db(&self) -> f64 { self.dyn_db(1, 0) }
    /// самое сильное ослабление лимитером версии v с прошлого запроса (дБ) — и сброс
    pub fn take_lim_db_v(&mut self, v: usize) -> f64 { let c = &mut self.ch[v - 1]; let x = 20.0 * c.lim_min.log10(); c.lim_min = 1.0; x }
    pub fn take_lim_db(&mut self) -> f64 { self.take_lim_db_v(1) }
    /// сколько кадров лимитер версии v ослаблял звук больше чем на 0,1 дБ (для проверок)
    pub fn lim_frames(&self, v: usize) -> u64 { self.ch[v - 1].lim_n }

    /// Совместимость: false — «ДО», true — версия 1.
    pub fn process(&mut self, buf: &mut [f32], after: bool) { self.process_mode(buf, if after { 1 } else { 0 }) }

    /// Обработать стерео-кадры на месте (L R L R). mode: 0 — «ДО», 1 — AETHER 1, 2 — AETHER 2.
    pub fn process_mode(&mut self, buf: &mut [f32], mode: u8) {
        let frames = buf.len() / 2;
        let target = [(mode == 0) as u8 as f64, (mode == 1) as u8 as f64, (mode == 2) as u8 as f64];
        let dn = self.dl_dry[0].len();
        let (sr, mg_a, ms_a) = (self.sr, self.mg_a, self.ms_a);
        for i in 0..frames {
            let (xl, xr) = (buf[i * 2] as f64, buf[i * 2 + 1] as f64);
            // громкость «ДО» (K-взвешенная) — общая для обеих версий
            let mut msd = 0.0;
            for (c, x) in [xl, xr].into_iter().enumerate() { let k0 = self.kd[0].run(&mut self.kd_st[c][0], x); let y = self.kd[1].run(&mut self.kd_st[c][1], k0); msd += y * y; }
            self.ms_d += (msd - self.ms_d) * ms_a;
            self.tick = self.tick.wrapping_add(1);
            let upd = self.tick % 16 == 0;
            let j = self.dl_i;
            let mut outs = [[0.0f64; 2]; 2];
            for (ci, ch) in self.ch.iter_mut().enumerate() {
                // тембр
                let mut v = [xl, xr];
                for c in 0..2 { for (k, b) in ch.eq.iter().enumerate() { v[c] = b.run(&mut ch.eq_st[k][c], v[c]); } }
                // динамические полосы: детектор по середине (L+R)/2 — одинаковое действие на оба канала, стереокартина не меняется
                for d in ch.dy.iter_mut() {
                    let mid = (v[0] + v[1]) * 0.5;
                    d.detect(mid);
                    if upd && (d.cur - d.set).abs() > 0.02 { d.filt = Bi::peak(d.sp.f, d.sp.q, d.cur, sr); d.set = d.cur; }
                    for c in 0..2 { v[c] = d.filt.run(&mut d.st[c], v[c]); }
                }
                // выравнивание громкости к «ДО»
                let mut msw = 0.0;
                for c in 0..2 { let k0 = self.kd[0].run(&mut ch.kw_st[c][0], v[c]); let y = self.kd[1].run(&mut ch.kw_st[c][1], k0); msw += y * y; }
                ch.ms_w += (msw - ch.ms_w) * ms_a;
                if self.ms_d > 1e-7 && ch.ms_w > 1e-9 {
                    let t = (self.ms_d / ch.ms_w).sqrt().clamp(10f64.powf(MATCH_MAX_DOWN / 20.0), 10f64.powf(MATCH_MAX_UP / 20.0));
                    ch.mg += (t - ch.mg) * mg_a;
                }
                for c in 0..2 { v[c] *= ch.mg; }
                // лимитер истинных пиков: оценка пика на отрезке [n−4, n−3) по интерполяции ×4
                let mut pk = 0.0f64;
                for c in 0..2 {
                    let h = &mut ch.hist[c]; h.copy_within(1..8, 0); h[7] = v[c];
                    pk = pk.max(h[3].abs());
                    for p in 0..3 { let mut s = 0.0; for k in 0..8 { s += self.tpc[p][k] * h[k]; } pk = pk.max(s.abs()); }
                }
                let rq = if pk > ch.ceil { ch.ceil / pk } else { 1.0 };
                ch.req[ch.req_i] = rq; ch.req_i = (ch.req_i + 1) % ch.req.len();
                let m = ch.req.iter().cloned().fold(1.0f64, f64::min);
                ch.box_sum += m - ch.mins[ch.box_i]; ch.mins[ch.box_i] = m; ch.box_i = (ch.box_i + 1) % self.l;
                let g_box = (ch.box_sum / self.l as f64).min(1.0);
                if g_box < ch.lg { ch.lg = g_box; } else { ch.lg += (g_box - ch.lg) * ch.lg_rel; }
                if ch.lg < ch.lim_min { ch.lim_min = ch.lg; }
                if ch.lg < 0.98855 { ch.lim_n += 1; }
                // задержка: версия ждёт решения лимитера
                outs[ci] = [(ch.dl[0][j] * ch.lg).clamp(-ch.ceil, ch.ceil), (ch.dl[1][j] * ch.lg).clamp(-ch.ceil, ch.ceil)];
                ch.dl[0][j] = v[0]; ch.dl[1][j] = v[1];
            }
            let (dl0, dr0) = (self.dl_dry[0][j], self.dl_dry[1][j]);
            self.dl_dry[0][j] = xl; self.dl_dry[1][j] = xr;
            self.dl_i = (j + 1) % dn;
            // плавное смешение: доли движутся к выбранному режиму по прямой (сумма всегда 1), за 40 мс
            let dist = (0..3).map(|k| (target[k] - self.mix[k]).abs()).fold(0.0, f64::max);
            if dist > 0.0 { let a = (self.step / dist).min(1.0); for k in 0..3 { self.mix[k] += (target[k] - self.mix[k]) * a; } }
            self.w = self.mix[1];
            let [a0, a1, a2] = self.mix;
            buf[i * 2] = (dl0 * a0 + outs[0][0] * a1 + outs[1][0] * a2) as f32;
            buf[i * 2 + 1] = (dr0 * a0 + outs[0][1] * a1 + outs[1][1] * a2) as f32;
            self.frames += 1;
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
            let mut z = x.clone(); let mut b = Aether::new(SR); b.mix = [0.0, 1.0, 0.0]; for ch in z.chunks_mut(1024) { b.process(ch, true); }
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

    // ——— «песни» для сравнения версий: барабаны, бас, вокал с формантами, пэды, гитары — по жанрам ———
    struct Osc { ph: f64 }
    impl Osc {
        // пила без наложения спектров (polyBLEP)
        fn saw(&mut self, f: f64) -> f64 {
            let dt = f / SR as f64; self.ph += dt; if self.ph >= 1.0 { self.ph -= 1.0; }
            let t = self.ph; let mut v = 2.0 * t - 1.0;
            if t < dt { let x = t / dt; v -= x + x - x * x - 1.0; } else if t > 1.0 - dt { let x = (t - 1.0) / dt; v -= x * x + x + x + 1.0; }
            v
        }
    }
    fn lp1(y: &mut f64, x: f64, f: f64) -> f64 { let a = 1.0 - (-2.0 * PI * f / SR as f64).exp(); *y += (x - *y) * a; *y }
    pub(super) fn song(genre: u8, secs: f64) -> Vec<f32> {
        let sr = SR as f64; let n = (secs * sr) as usize; let mut r = Rng(1234 + genre as u64);
        let mut out = vec![0f32; n * 2];
        let bpm = match genre { 0 => 90.0, 1 => 124.0, 3 => 140.0, _ => 100.0 }; let beat = 60.0 / bpm;
        let roots = [55.0, 43.65, 65.41, 49.0]; // A1 F1 C2 G1
        let (mut sn_bp, mut sn_st) = (Bi::bp(1800.0, 0.6, sr), St::default());
        let (hh_hp, mut hh_st) = (Bi::hp(7000.0, 0.7, sr), St::default());
        let (sib_hp, mut sib_st) = (Bi::hp(5000.0, 0.7, sr), St::default());
        let fm = [Bi::bp(700.0, 5.0, sr), Bi::bp(1200.0, 6.0, sr), Bi::bp(2800.0, 8.0, sr)]; let mut fs = [St::default(); 3];
        let (g_bp, mut g_st) = ([Bi::bp(900.0, 0.5, sr), Bi::bp(900.0, 0.5, sr)], [St::default(); 2]);
        let mut bass_o = Osc { ph: 0.0 }; let mut bass_lp = 0.0; let mut bass_lp2 = 0.0;
        let mut pads: Vec<Osc> = (0..6).map(|k| Osc { ph: k as f64 * 0.13 }).collect(); let mut pad_lp = [0.0f64; 4];
        let mut gtr: Vec<Osc> = (0..6).map(|k| Osc { ph: k as f64 * 0.21 }).collect();
        let mut vph = 0.0f64;
        // струны (Karplus–Strong) для акустики
        let mut ks: Vec<(Vec<f64>, usize, f64)> = Vec::new();
        let _ = &mut sn_bp;
        for i in 0..n {
            let t = i as f64 / sr; let bt = t / beat; let b_in = bt.fract() * beat; let bar = (bt / 4.0) as usize;
            let root = roots[bar % 4];
            let (mut l, mut rr) = (0.0f64, 0.0f64);
            // бочка: каждая доля (в акустике — нет)
            if genre != 4 { let tk = b_in; let ph = 2.0 * PI * (48.0 * tk + 70.0 / 30.0 * (1.0 - (-30.0 * tk).exp())); let k = ph.sin() * (-tk * if genre == 0 { 5.0 } else { 9.0 }).exp() * 0.9; l += k; rr += k; }
            // малый: 2 и 4
            let beat_i = bt as usize; let tsn = if beat_i % 2 == 1 { b_in } else { 9.0 };
            if genre != 4 && tsn < 0.4 { let nz = sn_bp.run(&mut sn_st, r.f()) * 2.2; let v = (nz * (-tsn * 18.0).exp() + (2.0 * PI * 185.0 * tsn).sin() * (-tsn * 28.0).exp() * 0.6) * 0.55; l += v; rr += v; }
            // хэты: восьмые, чуть вправо
            if genre != 4 { let th = (bt * 2.0).fract() * beat / 2.0; let v = hh_hp.run(&mut hh_st, r.f()) * (-th * 55.0).exp() * if genre == 1 { 0.22 } else { 0.14 }; l += v * 0.7; rr += v; }
            // бас
            let bf = if genre == 0 { root * (1.0 + 0.02 * (-b_in * 10.0).exp()) } else { root * if genre == 3 { 2.0 } else { 1.0 } };
            let bv = if genre == 0 { (2.0 * PI * bf * t).sin() * 0.75 + (2.0 * PI * bf * 2.0 * t).sin() * 0.12 }
                else { let s = bass_o.saw(bf); lp1(&mut bass_lp2, lp1(&mut bass_lp, s, if genre == 1 { 600.0 } else { 350.0 }), 900.0) * 0.55 };
            let benv = if genre == 4 { 0.35 } else { 1.0 };
            l += bv * benv; rr += bv * benv;
            // пэд / синтезаторы: аккорд из расстроенных пил, шире по стерео
            if genre != 3 && genre != 4 {
                let ch = [root * 4.0, root * 4.0 * 1.26, root * 4.0 * 1.5];
                let mut pl = 0.0; let mut pr = 0.0;
                for k in 0..3 { pl += pads[k].saw(ch[k] * 1.003); pr += pads[k + 3].saw(ch[k] * 0.997); }
                let cut = if genre == 1 { 2500.0 + 1500.0 * (t * 0.5).sin() } else { 1800.0 };
                let a0 = lp1(&mut pad_lp[0], pl, cut); let a = lp1(&mut pad_lp[1], a0, cut) * if genre == 1 { 0.20 } else { 0.12 };
                let b0 = lp1(&mut pad_lp[2], pr, cut); let b = lp1(&mut pad_lp[3], b0, cut) * if genre == 1 { 0.20 } else { 0.12 };
                l += a; rr += b;
                if genre == 1 { let arp = [1.0, 1.5, 2.0, 1.26][((bt * 4.0) as usize) % 4]; let te = (bt * 4.0).fract() * beat / 4.0; let v = (2.0 * PI * root * 8.0 * arp * t).sin().signum() * (-te * 20.0).exp() * 0.07; l += v * 0.5; rr += v; }
            }
            // гитары (рок): перегруженные пилы, дабл слева/справа
            if genre == 3 {
                let ch = [root * 2.0, root * 3.0, root * 4.0];
                let mut gl = 0.0; let mut gr = 0.0; for k in 0..3 { gl += gtr[k].saw(ch[k] * 1.002); gr += gtr[k + 3].saw(ch[k] * 0.998); }
                let gl = g_bp[0].run(&mut g_st[0], (gl * 2.5).tanh()) * 0.45; let gr = g_bp[1].run(&mut g_st[1], (gr * 2.5).tanh()) * 0.45;
                l += gl; rr += gr;
            }
            // акустика: щипки струн каждые полдоли
            if genre == 4 {
                if i % (sr as usize / 2) == 0 { let f = root * 4.0 * [1.0, 1.26, 1.5, 2.0][(i / (sr as usize / 2)) % 4]; let len = (sr / f) as usize; let buf: Vec<f64> = (0..len).map(|_| r.f() * 0.5).collect(); ks.push((buf, 0, 0.996)); if ks.len() > 6 { ks.remove(0); } }
                let mut a = 0.0; for (b, p, d) in ks.iter_mut() { let len = b.len(); let nx = (*p + 1) % len; let v = (b[*p] + b[nx]) * 0.5 * *d; b[*p] = v; *p = nx; a += v; }
                l += a * 0.9; rr += a * 0.7;
            }
            // вокал: гармоники с вибрато, форманты 700/1200/2800 Гц, слоги; редкие сибилянты
            let vlev = match genre { 2 => 0.55, 4 => 0.45, 1 => 0.25, _ => 0.35 };
            let f0 = [220.0, 247.0, 196.0, 262.0][(bt as usize / 2) % 4] * (1.0 + 0.012 * (2.0 * PI * 5.5 * t).sin());
            vph += f0 / sr; if vph > 1.0 { vph -= 1.0; }
            let mut src = 0.0; for k in 1..24 { src += (2.0 * PI * k as f64 * vph).sin() / k as f64; }
            let mut vv = 0.0; for k in 0..3 { vv += fm[k].run(&mut fs[k], src) * [1.0, 0.7, 0.45][k]; }
            let syl = (0.5 - 0.5 * (2.0 * PI * t / beat).cos()).powf(0.7) * if (bt as usize) % 8 == 7 { 0.0 } else { 1.0 };
            let sib = if (t % 1.7) < 0.07 { sib_hp.run(&mut sib_st, r.f()) * 0.25 } else { sib_hp.run(&mut sib_st, 0.0) * 0.0 };
            let v = (vv * 1.6 * syl + sib) * vlev; l += v; rr += v;
            out[i * 2] = l as f32; out[i * 2 + 1] = rr as f32;
        }
        // мастеринг: громкие жанры — пик в 0 дБFS (как у современных мастеров), акустика — с запасом −3 дБ
        let pk = out.iter().fold(0f32, |m, x| m.max(x.abs())) as f64;
        let target = if genre == 4 { 0.707 } else { 1.0 };
        out.iter_mut().for_each(|x| *x = (*x as f64 / pk * target) as f32);
        out
    }

    struct Metrics { lufs: f64, bands: [f64; 7], lim_pct: f64, crest: f64, corr: f64, side: f64, ldr: f64 }
    const BANDS: [(f64, &str); 7] = [(45.0, "30–60"), (100.0, "60–150"), (250.0, "150–400"), (650.0, "0,4–1к"), (2000.0, "1–4к"), (5600.0, "4–8к"), (11000.0, "8–16к")];
    fn metrics(y: &[f32], from: usize, hits: &[usize], lim: Option<u64>, total: u64) -> Metrics {
        let sr = SR as f64; let n = y.len() / 2;
        let mid: Vec<f64> = (0..n).map(|i| (y[i * 2] as f64 + y[i * 2 + 1] as f64) * 0.5).collect();
        let mut bands = [0.0; 7];
        for (k, (f, _)) in BANDS.iter().enumerate() { let b = Bi::bp(*f, 1.0, sr); let mut s = St::default(); let mut e = 0.0; for i in 0..n { let v = b.run(&mut s, mid[i]); if i >= from { e += v * v; } } bands[k] = 10.0 * (e / (n - from) as f64).log10(); }
        // атака ударных: щелчок удара живёт выше ~1 кГц — пик за 6 мс после удара относительно RMS следующих 100 мс
        let hp = Bi::hp(1000.0, 0.707, sr); let mut hs = St::default(); let hm: Vec<f64> = mid.iter().map(|x| hp.run(&mut hs, *x)).collect();
        let mut crest = 0.0f64; let mut cn = 0.0f64;
        for &h in hits { if h < from || h + (0.13 * sr) as usize >= n { continue; }
            let pk = hm[h..h + (0.006 * sr) as usize].iter().fold(0f64, |m, x| m.max(x.abs()));
            let rms = (hm[h..h + (0.10 * sr) as usize].iter().map(|x| x * x).sum::<f64>() / (0.10 * sr)).sqrt();
            crest += 20.0 * (pk / rms).log10(); cn += 1.0; }
        // стерео: корреляция L/R и доля «стороны»
        let (mut lr, mut ll, mut rr2, mut ss, mut mm) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for i in from..n { let (l, r) = (y[i * 2] as f64, y[i * 2 + 1] as f64); lr += l * r; ll += l * l; rr2 += r * r; ss += (l - r).powi(2); mm += (l + r).powi(2); }
        // микродинамика: разброс громкости окон 100 мс
        let w = (0.1 * sr) as usize; let mut lv = Vec::new(); let mut i = from; while i + w <= n { let e = mid[i..i + w].iter().map(|x| x * x).sum::<f64>() / w as f64; lv.push(10.0 * e.max(1e-12).log10()); i += w; }
        let mean = lv.iter().sum::<f64>() / lv.len() as f64; let ldr = (lv.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / lv.len() as f64).sqrt();
        Metrics { lufs: lufs(&y[from * 2..]), bands, lim_pct: lim.map(|l| l as f64 / total as f64 * 100.0).unwrap_or(0.0), crest: crest / cn.max(1.0), corr: lr / (ll * rr2).sqrt(), side: 10.0 * (ss / mm).log10(), ldr }
    }

    /// Сравнение: исходный звук, AETHER 1, AETHER 2 — по 5 жанрам, при выровненной громкости.
    #[test]
    fn compare_versions_by_genre() {
        let names = ["хип-хоп (плотный бас)", "электроника (синтезаторы)", "вокал", "рок (плотные гитары)", "акустика"];
        let secs = 14.0; let sr = SR as usize;
        let mut rows = Vec::new();
        for g in 0..5u8 {
            let x = song(g, secs);
            let bpm = match g { 0 => 90.0, 1 => 124.0, 3 => 140.0, _ => 100.0 }; let beat = 60.0 / bpm;
            let mut a1 = Aether::new(SR); a1.mix = [0.0, 1.0, 0.0]; let mut y1 = x.clone(); for c in y1.chunks_mut(1024) { a1.process_mode(c, 1); }
            let mut a2 = Aether::new(SR); a2.mix = [0.0, 0.0, 1.0]; let mut y2 = x.clone(); for c in y2.chunks_mut(1024) { a2.process_mode(c, 2); }
            let d = a1.latency(); let from = 6 * sr; let total = (x.len() / 2) as u64;
            // удары: малый барабан (2 и 4), в акустике — щипки струн
            let hits0: Vec<usize> = if g == 4 { (0..(secs * 2.0) as usize).map(|k| k * sr / 2).collect() } else { (0..(secs / beat) as usize).filter(|k| k % 2 == 1).map(|k| (k as f64 * beat * SR as f64) as usize).collect() };
            let hits1: Vec<usize> = hits0.iter().map(|h| h + d).collect();
            let m0 = metrics(&x, from - d, &hits0, None, total);
            let m1 = metrics(&y1, from, &hits1, Some(a1.lim_frames(1)), total);
            let m2 = metrics(&y2, from, &hits1, Some(a2.lim_frames(2)), total);
            rows.push((names[g as usize], m0, m1, m2));
        }
        eprintln!("\n=== ПУЛЬС AETHER SOUND: исходный (0) / версия 1 / версия 2 — громкость выровнена ===");
        for (name, m0, m1, m2) in &rows {
            eprintln!("\n{name}");
            eprintln!("  громкость, LUFS:         0: {:.2}   1: {:+.2}   2: {:+.2}  (разница с исходным)", m0.lufs, m1.lufs - m0.lufs, m2.lufs - m0.lufs);
            let bl: Vec<String> = BANDS.iter().enumerate().map(|(k, (_, b))| format!("{b}: {:+.1}/{:+.1}", m1.bands[k] - m0.bands[k], m2.bands[k] - m0.bands[k])).collect();
            eprintln!("  полосы, дБ к исходному (в1/в2): {}", bl.join("  "));
            let cl = |m: &Metrics| (m.bands[4] - m.bands[2]) - (m0.bands[4] - m0.bands[2]);
            eprintln!("  разборчивость (1–4к против 150–400), дБ к исходному: в1 {:+.2}   в2 {:+.2}", cl(m1), cl(m2));
            eprintln!("  атака ударных (пик/RMS), дБ к исходному: в1 {:+.2}   в2 {:+.2}", m1.crest - m0.crest, m2.crest - m0.crest);
            eprintln!("  микродинамика (разброс 100 мс), дБ: 0 {:.2}   в1 {:.2}   в2 {:.2}", m0.ldr, m1.ldr, m2.ldr);
            eprintln!("  лимитер работал, % времени: в1 {:.1}   в2 {:.1}", m1.lim_pct, m2.lim_pct);
            eprintln!("  стерео: корреляция 0 {:.3} в1 {:.3} в2 {:.3}; доля «стороны» 0 {:.2} в1 {:.2} в2 {:.2} дБ", m0.corr, m1.corr, m2.corr, m0.side, m1.side, m2.side);
        }
        for (name, m0, m1, m2) in &rows {
            let cl = |m: &Metrics| (m.bands[4] - m.bands[2]) - (m0.bands[4] - m0.bands[2]);
            assert!(m2.lufs - m0.lufs < 0.25 && m2.lufs - m0.lufs > -0.6, "{name}: громкость в2 {:+.2}", m2.lufs - m0.lufs);
            assert!(cl(m2) > cl(m1) && cl(m2) > 0.2, "{name}: разборчивость в2 {:+.2} (в1 {:+.2})", cl(m2), cl(m1));
            // не ярче: верх относительно середины (1–4 кГц) не поднимается
            assert!((m2.bands[6] - m2.bands[4]) - (m0.bands[6] - m0.bands[4]) < 0.3 && (m2.bands[5] - m2.bands[4]) - (m0.bands[5] - m0.bands[4]) < 0.3, "{name}: в2 ярче исходного");
            assert!(m2.lim_pct <= m1.lim_pct + 0.01 && m2.lim_pct < 5.0, "{name}: лимитер в2 {:.1} %", m2.lim_pct);
            assert!(m2.crest - m0.crest > -0.6, "{name}: атака в2 {:+.2}", m2.crest - m0.crest);

        }
    }

    // стереокартина: обе версии обрабатывают левый и правый каналы одинаково (общие решения по середине),
    // поэтому звук, панорамированный влево (R = 0,5·L), и после обработки остаётся ровно так же панорамирован
    #[test]
    fn stereo_image_is_kept() {
        let x0 = song(1, 4.0);
        let x: Vec<f32> = x0.chunks_exact(2).flat_map(|f| [f[0], f[0] * 0.5]).collect();
        for v in [1u8, 2] {
            let mut a = Aether::new(SR); a.mix = [0.0, 0.0, 0.0]; a.mix[v as usize] = 1.0;
            let mut y = x.clone(); for c in y.chunks_mut(1024) { a.process_mode(c, v); }
            for f in y.chunks_exact(2).skip(SR as usize) { assert!((f[1] as f64 - f[0] as f64 * 0.5).abs() < 1e-6, "версия {v}: L {} R {}", f[0], f[1]); }
        }
    }

    #[test]
    fn v2_peaks_and_three_way_switch() {
        let x = song(3, 6.0);
        let mut a = Aether::new(SR); let mut y = x.clone(); let step = a.step;
        let mut prev = a.mix; let mut k = 0u8;
        for n in 0..x.len() / 2 {
            if n % (SR as usize * 60 / 1000) == 0 { k = (k + 1) % 3; }
            a.process_mode(&mut y[n * 2..n * 2 + 2], [2u8, 0, 1][k as usize]);
            let s: f64 = a.mix.iter().sum(); assert!((s - 1.0).abs() < 1e-9, "доли смеси в сумме {s}");
            for j in 0..3 { assert!((a.mix[j] - prev[j]).abs() <= step + 1e-12, "скачок смеси"); }
            prev = a.mix;
        }
        let mut b = Aether::new(SR); b.mix = [0.0, 0.0, 1.0]; let mut z = x.clone(); for c in z.chunks_mut(1024) { b.process_mode(c, 2); }
        let tp = true_peak_db(&z[SR as usize * 4..SR as usize * 5]);
        assert!(tp <= -0.25, "версия 2: истинный пик {tp:.2} дБTP");
        assert!(y.iter().all(|v| v.abs() <= 1.0));
    }
}
