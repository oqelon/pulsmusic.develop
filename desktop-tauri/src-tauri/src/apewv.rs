// APE (Monkey's Audio) и WavPack — свои декодеры, перенос codecs/ape.js и codecs/wv.js из Electron-версии.
//
// Арифметика повторяет JS-версию один в один (там она проверена побитно против ffmpeg): переполнения int32 —
// «с заворотом», деления — как Math.floor / Math.trunc. Сторонних библиотек нет — только std.
//
// APE: версии 3.95 и новее, 8/16/24 бит, моно и стерео, все уровни сжатия. Кадр APE большой (до ~300 тыс.
// отсчётов), поэтому разжимается кусками по 4608 отсчётов — движку не нужно ждать весь кадр.
// WavPack: 4.02–4.10 (и блоки WavPack 5 с PCM), без потерь и гибридный режим (без .wvc), моно/стерео/многоканальный,
// 8–32 бит, 32-бит float, «лишние» биты. WavPack DSD — нет. Многоканальный звук играется первыми двумя каналами.

use std::io::{Read, Seek, SeekFrom};

pub trait Src: Read + Seek + Send {}
impl<T: Read + Seek + Send> Src for T {}

#[derive(Debug, Clone)]
pub struct Info {
    pub codec: &'static str,
    pub rate: u32,
    pub channels: usize,
    pub bits: u32,
    pub float: bool,
    pub total: u64,
    pub lossy: bool,
    pub level: u32,
}
impl Info {
    pub fn duration(&self) -> f64 { self.total as f64 / self.rate.max(1) as f64 }
}

#[derive(Debug, Clone)]
struct Fr { off: u64, len: usize, start: u64, n: u64, skip: usize }

// ═════════════════════════════════════════ APE ═════════════════════════════════════════

const HISTORY: usize = 512;
const PRED: usize = 50;
const YDELAYA: usize = 50;
const YDELAYB: usize = 42;
const XDELAYA: usize = 34;
const XDELAYB: usize = 26;
const YADAPTA: usize = 18;
const XADAPTA: usize = 14;
const YADAPTB: usize = 10;
const XADAPTB: usize = 5;
const ORDERS: [&[usize]; 5] = [&[], &[16], &[64], &[32, 256], &[16, 256, 1280]];
const FRAC: [&[u32]; 5] = [&[], &[11], &[11], &[10, 13], &[11, 13, 15]];
const COUNTS_3970: [u32; 22] = [0, 14824, 28224, 39348, 47855, 53994, 58171, 60926, 62682, 63786, 64463, 64878, 65126, 65276, 65365, 65419, 65450, 65469, 65480, 65487, 65491, 65493];
const COUNTS_3980: [u32; 22] = [0, 19578, 36160, 48417, 56323, 60899, 63265, 64435, 64971, 65232, 65351, 65416, 65447, 65466, 65476, 65482, 65485, 65488, 65490, 65491, 65492, 65493];
const BOTTOM: u32 = 0x800000;
const LOOP: usize = 4608;

/// «обратный знак», как APESIGN
#[inline]
fn sign(x: i32) -> i32 { (x < 0) as i32 - (x > 0) as i32 }

struct Rc { d: Vec<u8>, p: usize, end: usize, err: bool, buffer: u32, low: u32, range: u32, help: u32 }
impl Rc {
    fn be32(&mut self) -> u32 {
        let p = self.p; self.p += 4;
        let g = |i: usize| *self.d.get(i).unwrap_or(&0) as u32;
        (g(p) << 24) | (g(p + 1) << 16) | (g(p + 2) << 8) | g(p + 3)
    }
    #[inline]
    fn byte(&mut self) -> u32 {
        if self.p < self.end { let b = self.d[self.p]; self.p += 1; b as u32 } else { self.err = true; self.p += 1; 0 }
    }
    fn start(&mut self) { self.buffer = self.byte(); self.low = self.buffer >> 1; self.range = 128; }
    #[inline]
    fn norm(&mut self) {
        while self.range <= BOTTOM {
            if self.range == 0 { self.err = true; self.range = 0x8000_0000; break; }
            self.buffer = (self.buffer << 8) | self.byte();
            self.low = self.low.wrapping_mul(256).wrapping_add((self.buffer >> 1) & 0xff);
            self.range = self.range.wrapping_mul(256);
        }
    }
    #[inline]
    fn culfreq(&mut self, tot: u32) -> u32 {
        self.norm();
        self.help = self.range / tot.max(1);
        if self.help == 0 { self.err = true; return 0; }
        self.low / self.help
    }
    #[inline]
    fn culshift(&mut self, sh: u32) -> u32 {
        self.norm();
        self.help = self.range >> sh;
        if self.help == 0 { self.err = true; return 0; }
        self.low / self.help
    }
    #[inline]
    fn update(&mut self, sy: u32, lt: u32) {
        self.low = self.low.wrapping_sub(self.help.wrapping_mul(lt));
        self.range = self.help.wrapping_mul(sy);
    }
    fn bits(&mut self, n: u32) -> u32 { let s = self.culshift(n); self.update(1, s); s }
    fn symbol(&mut self, counts: &[u32; 22]) -> u32 {
        let cf = self.culshift(16);
        if cf > 65492 {
            self.update(1, cf);
            if cf > 65535 { self.err = true; }
            return cf.wrapping_sub(65535).wrapping_add(63);
        }
        let mut s = 0;
        while counts[s + 1] <= cf { s += 1; }
        self.update(counts[s + 1] - counts[s], counts[s]);
        s as u32
    }
}

struct Rice { k: i64, ksum: i64 }
fn update_rice(r: &mut Rice, x: u32) {
    let lim: i64 = if r.k != 0 { 1i64 << (r.k + 4) } else { 0 };
    let sh = (((r.ksum + 16) as u64) & 0xffff_ffff) >> 5;
    r.ksum = r.ksum + ((x as i64 + 1) >> 1) - sh as i64;
    if r.ksum < lim { r.k -= 1; } else if r.ksum >= (1i64 << (r.k + 5)) && r.k < 24 { r.k += 1; }
}
#[inline]
fn to_signed(x: u32) -> i32 { if x & 1 != 0 { ((x >> 1) as i64 + 1) as i32 } else { (-((x >> 1) as i64)) as i32 } }

fn value3990(f: &mut Rc, r: &mut Rice) -> i32 {
    let mut pivot = ((r.ksum as u64) & 0xffff_ffff) >> 5;
    if pivot == 0 { pivot = 1; }
    let mut overflow = f.symbol(&COUNTS_3980) as u64;
    if overflow == 63 { overflow = f.bits(16) as u64 * 65536; overflow += f.bits(16) as u64; }
    let base: u64;
    if pivot < 0x10000 {
        let b = f.culfreq(pivot as u32); f.update(1, b); base = b as u64;
    } else {
        let mut hi = pivot; let mut bb = 0u32;
        while hi >= 0x10000 { hi /= 2; bb += 1; }
        let h = f.culfreq(hi as u32 + 1); f.update(1, h);
        let lo = f.culfreq(1u32 << bb); f.update(1, lo);
        base = ((h as u64) << bb) + lo as u64;
    }
    let x = base.wrapping_add(overflow.wrapping_mul(pivot)) as u32;
    update_rice(r, x);
    to_signed(x)
}

fn value3900(f: &mut Rc, r: &mut Rice, ver: u32) -> i32 {
    let mut overflow = f.symbol(&COUNTS_3970) as u64;
    let k: u32;
    if overflow == 63 { k = f.bits(5); overflow = 0; } else { k = if r.k < 1 { 0 } else { (r.k - 1) as u32 }; }
    let mut x: u64;
    if k <= 16 || ver < 3910 {
        if k > 23 { f.err = true; return 0; }
        x = f.bits(k) as u64;
    } else if k <= 31 {
        x = f.bits(16) as u64;
        if k > 16 { x += f.bits(k - 16) as u64 * 65536; }
    } else { f.err = true; return 0; }
    let x = x.wrapping_add(overflow << k) as u32;
    update_rice(r, x);
    to_signed(x)
}

/// адаптивный фильтр (NN-фильтр Monkey's Audio)
struct Filt { order: usize, coeffs: Vec<i16>, hist: Vec<i16>, delay: usize, adapt: usize, avg: u32 }
impl Filt {
    fn new(order: usize) -> Filt {
        Filt { order, coeffs: vec![0; order], hist: vec![0; HISTORY + order * 2], delay: order * 2, adapt: order, avg: 0 }
    }
    fn apply(&mut self, data: &mut [i32], frac: u32, ver: u32) {
        let order = self.order;
        let half = 1i64 << (frac - 1);
        for v in data.iter_mut() {
            let x = *v;
            let dv = self.delay - order;
            let av = self.adapt - order;
            let acc = dot(&self.coeffs, &self.hist[dv..dv + order]);
            if x > 0 { for (c, h) in self.coeffs.iter_mut().zip(&self.hist[av..av + order]) { *c = c.wrapping_sub(*h); } }
            else if x < 0 { for (c, h) in self.coeffs.iter_mut().zip(&self.hist[av..av + order]) { *c = c.wrapping_add(*h); } }
            let res = (((acc as i64 + half) >> frac) as i32).wrapping_add(x);
            *v = res;
            self.hist[self.delay] = res.clamp(-32768, 32767) as i16;
            self.delay += 1;
            let a = self.adapt;
            if ver < 3980 {
                self.hist[a] = if res == 0 { 0 } else { (((res >> 28) & 8) - 4) as i16 };
                self.hist[a - 4] >>= 1;
                self.hist[a - 8] >>= 1;
            } else {
                let abs = (res as i64).abs();
                let avg = self.avg as i64;
                self.hist[a] = if abs != 0 {
                    let n = (abs > avg * 3) as u32 + (abs > avg + avg / 3) as u32;
                    (sign(res) * (8 << n)) as i16
                } else { 0 };
                self.avg = (avg + (abs - avg) / 16) as u32;
                self.hist[a - 1] >>= 1;
                self.hist[a - 2] >>= 1;
                self.hist[a - 8] >>= 1;
            }
            self.adapt += 1;
            if self.delay == HISTORY + order * 2 {
                self.hist.copy_within(self.delay - order * 2..self.delay, 0);
                self.delay = order * 2;
                self.adapt = order;
            }
        }
    }
}
#[inline]
fn dot(a: &[i16], b: &[i16]) -> i32 {
    // i16 × i16 с суммой в i32 «с заворотом» — так же, как в эталоне (и векторизуется компилятором)
    a.iter().zip(b).fold(0i32, |s, (x, y)| s.wrapping_add(*x as i32 * *y as i32))
}

/// предсказатель (3.95+)
struct Pred { hist: [i32; HISTORY + PRED], b: usize, last_a: [i32; 2], filter_a: [i32; 2], filter_b: [i32; 2], ca: [[i32; 4]; 2], cb: [[i32; 5]; 2] }
impl Pred {
    fn new() -> Pred {
        Pred { hist: [0; HISTORY + PRED], b: 0, last_a: [0; 2], filter_a: [0; 2], filter_b: [0; 2], ca: [[360, 317, -109, 98]; 2], cb: [[0; 5]; 2] }
    }
    #[inline]
    fn advance(&mut self) {
        self.b += 1;
        if self.b == HISTORY { self.hist.copy_within(HISTORY..HISTORY + PRED, 0); self.b = 0; }
    }
    #[inline]
    fn update(&mut self, decoded: i32, f: usize, da: usize, db: usize, aa: usize, ab: usize) -> i32 {
        let b = self.b;
        let h = &mut self.hist;
        h[b + da] = self.last_a[f];
        h[b + aa] = sign(h[b + da]);
        h[b + da - 1] = h[b + da].wrapping_sub(h[b + da - 1]);
        h[b + aa - 1] = sign(h[b + da - 1]);
        let ca = &mut self.ca[f];
        let pra = h[b + da].wrapping_mul(ca[0])
            .wrapping_add(h[b + da - 1].wrapping_mul(ca[1]))
            .wrapping_add(h[b + da - 2].wrapping_mul(ca[2]))
            .wrapping_add(h[b + da - 3].wrapping_mul(ca[3]));
        h[b + db] = self.filter_a[f ^ 1].wrapping_sub(self.filter_b[f].wrapping_mul(31) >> 5);
        h[b + ab] = sign(h[b + db]);
        h[b + db - 1] = h[b + db].wrapping_sub(h[b + db - 1]);
        h[b + ab - 1] = sign(h[b + db - 1]);
        self.filter_b[f] = self.filter_a[f ^ 1];
        let cb = &mut self.cb[f];
        let prb = h[b + db].wrapping_mul(cb[0])
            .wrapping_add(h[b + db - 1].wrapping_mul(cb[1]))
            .wrapping_add(h[b + db - 2].wrapping_mul(cb[2]))
            .wrapping_add(h[b + db - 3].wrapping_mul(cb[3]))
            .wrapping_add(h[b + db - 4].wrapping_mul(cb[4]));
        self.last_a[f] = decoded.wrapping_add(pra.wrapping_add(prb >> 1) >> 10);
        self.filter_a[f] = self.last_a[f].wrapping_add(self.filter_a[f].wrapping_mul(31) >> 5);
        let s = sign(decoded);
        for i in 0..4 { ca[i] = ca[i].wrapping_add(h[b + aa - i].wrapping_mul(s)); }
        for i in 0..5 { cb[i] = cb[i].wrapping_add(h[b + ab - i].wrapping_mul(s)); }
        self.filter_a[f]
    }
    fn stereo(&mut self, d0: &mut [i32], d1: &mut [i32]) {
        for i in 0..d0.len() {
            d0[i] = self.update(d0[i], 0, YDELAYA, YDELAYB, YADAPTA, YADAPTB);
            d1[i] = self.update(d1[i], 1, XDELAYA, XDELAYB, XADAPTA, XADAPTB);
            self.advance();
        }
    }
    fn mono(&mut self, d0: &mut [i32]) {
        let mut cur = self.last_a[0];
        for v in d0.iter_mut() {
            let a = *v;
            let b = self.b;
            let h = &mut self.hist;
            h[b + YDELAYA] = cur;
            h[b + YDELAYA - 1] = h[b + YDELAYA].wrapping_sub(h[b + YDELAYA - 1]);
            let ca = &mut self.ca[0];
            let pr = h[b + YDELAYA].wrapping_mul(ca[0])
                .wrapping_add(h[b + YDELAYA - 1].wrapping_mul(ca[1]))
                .wrapping_add(h[b + YDELAYA - 2].wrapping_mul(ca[2]))
                .wrapping_add(h[b + YDELAYA - 3].wrapping_mul(ca[3]));
            cur = a.wrapping_add(pr >> 10);
            h[b + YADAPTA] = sign(h[b + YDELAYA]);
            h[b + YADAPTA - 1] = sign(h[b + YDELAYA - 1]);
            let s = sign(a);
            for i in 0..4 { ca[i] = ca[i].wrapping_add(h[b + YADAPTA - i].wrapping_mul(s)); }
            self.advance();
            self.filter_a[0] = cur.wrapping_add(self.filter_a[0].wrapping_mul(31) >> 5);
            *v = self.filter_a[0];
        }
        self.last_a[0] = cur;
    }
}

#[derive(Debug, Clone)]
struct ApeHdr { ver: u32, level: u32, channels: usize }

/// Один кадр APE, разжимаемый кусками по LOOP отсчётов.
struct ApeFrame { rc: Rc, filt: [Vec<Filt>; 2], pred: Pred, ry: Rice, rx: Rice, flags: u32, stereo: bool, n: usize, at: usize, fset: usize, h: ApeHdr }
impl ApeFrame {
    fn new(raw: &[u8], skip: usize, n: usize, h: &ApeHdr) -> ApeFrame {
        let len = raw.len() & !3;
        let mut d = vec![0u8; raw.len() + 8];
        for i in (0..len).step_by(4) { d[i] = raw[i + 3]; d[i + 1] = raw[i + 2]; d[i + 2] = raw[i + 1]; d[i + 3] = raw[i]; }
        let mut rc = Rc { d, p: skip, end: raw.len(), err: false, buffer: 0, low: 0, range: 0, help: 0 };
        let crc = rc.be32();
        let mut flags = 0;
        if h.ver > 3820 && crc & 0x8000_0000 != 0 { flags = rc.be32(); }
        rc.p += 1;
        rc.start();
        let fset = (h.level / 1000 - 1) as usize;
        let mk = || ORDERS[fset].iter().map(|&o| Filt::new(o)).collect::<Vec<_>>();
        ApeFrame {
            rc, filt: [mk(), mk()], pred: Pred::new(), ry: Rice { k: 10, ksum: 16384 }, rx: Rice { k: 10, ksum: 16384 },
            flags, stereo: h.channels == 2 && flags & 4 == 0, n, at: 0, fset, h: h.clone(),
        }
    }
    fn done(&self) -> bool { self.at >= self.n }
    /// следующий кусок (до LOOP отсчётов) → каналы
    fn chunk(&mut self) -> Result<Vec<Vec<i32>>, String> {
        let cnt = LOOP.min(self.n - self.at);
        self.at += cnt;
        let mut d0 = vec![0i32; cnt];
        let mut d1 = vec![0i32; cnt];
        let ver = self.h.ver;
        let (orders, fracs) = (ORDERS[self.fset], FRAC[self.fset]);
        if !self.stereo {
            if self.flags & 3 == 0 {
                for v in d0.iter_mut() { *v = if ver >= 3990 { value3990(&mut self.rc, &mut self.ry) } else { value3900(&mut self.rc, &mut self.ry, ver) }; }
                for l in 0..orders.len() { self.filt[0][l].apply(&mut d0, fracs[l], ver); }
                self.pred.mono(&mut d0);
                if self.h.channels == 2 { d1.copy_from_slice(&d0); }
            }
        } else if self.flags & 3 != 3 {
            if ver >= 3990 {
                for i in 0..cnt { d0[i] = value3990(&mut self.rc, &mut self.ry); d1[i] = value3990(&mut self.rc, &mut self.rx); }
            } else {
                for i in 0..cnt { d0[i] = value3900(&mut self.rc, &mut self.ry, ver); d1[i] = value3900(&mut self.rc, &mut self.rx, ver); }
            }
            for l in 0..orders.len() {
                self.filt[0][l].apply(&mut d0, fracs[l], ver);
                self.filt[1][l].apply(&mut d1, fracs[l], ver);
            }
            self.pred.stereo(&mut d0, &mut d1);
            for i in 0..cnt {
                let left = d1[i].wrapping_sub(d0[i] / 2);
                let right = left.wrapping_add(d0[i]);
                d0[i] = left; d1[i] = right;
            }
        }
        if self.rc.err { return Err("APE: кадр повреждён".into()); }
        Ok(if self.h.channels == 2 { vec![d0, d1] } else { vec![d0] })
    }
}

fn le16(b: &[u8], o: usize) -> u32 { b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as u32).unwrap_or(0) }
fn le32(b: &[u8], o: usize) -> u32 { b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).unwrap_or(0) }
fn find(h: &[u8], what: &[u8], from: usize) -> Option<usize> {
    if h.len() < what.len() { return None; }
    (from..=h.len() - what.len()).find(|&i| &h[i..i + what.len()] == what)
}
fn read_at(s: &mut dyn Src, off: u64, n: usize) -> Result<Vec<u8>, String> {
    s.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
    let mut b = vec![0u8; n];
    let mut got = 0;
    while got < n {
        match s.read(&mut b[got..]) { Ok(0) => break, Ok(k) => got += k, Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}, Err(e) => return Err(e.to_string()) }
    }
    b.truncate(got);
    Ok(b)
}
fn syncsafe(h: &[u8]) -> u64 { ((h[6] as u64 & 127) << 21) | ((h[7] as u64 & 127) << 14) | ((h[8] as u64 & 127) << 7) | (h[9] as u64 & 127) }

fn ape_info(s: &mut dyn Src, size: u64) -> Result<(Info, ApeHdr, Vec<Fr>), String> {
    let hh = read_at(s, 0, size.min(1 << 16) as usize)?;
    let mut junk: u64 = 0;
    if hh.len() >= 10 && &hh[0..3] == b"ID3" { junk = 10 + syncsafe(&hh) + if hh[5] & 0x10 != 0 { 10 } else { 0 }; }
    let mut b = read_at(s, junk, 256)?;
    if b.len() < 4 || &b[0..4] != b"MAC " {
        let k = find(&hh, b"MAC ", 0).ok_or("Это не файл Monkey's Audio")?;
        junk = k as u64;
        b = read_at(s, junk, 256)?;
    }
    b.resize(256, 0);
    let ver = le16(&b, 4);
    if ver < 3950 { return Err(format!("Файл APE старой версии {:.2} — такие не поддерживаются", ver as f64 / 1000.0)); }
    let (desc_len, mut head_len, seek_len, wav_head, wav_tail, level, flags, bpf, final_blocks, nframes, bits, channels, rate);
    if ver >= 3980 {
        desc_len = le32(&b, 8) as u64; head_len = le32(&b, 12) as u64; seek_len = le32(&b, 16) as u64; wav_head = le32(&b, 20) as u64; wav_tail = le32(&b, 32) as u64;
        let o = desc_len as usize;
        level = le16(&b, o); flags = le16(&b, o + 2); bpf = le32(&b, o + 4) as u64; final_blocks = le32(&b, o + 8) as u64; nframes = le32(&b, o + 12) as u64;
        bits = le16(&b, o + 16); channels = le16(&b, o + 18) as usize; rate = le32(&b, o + 20);
    } else {
        desc_len = 0; head_len = 32;
        level = le16(&b, 6); flags = le16(&b, 8); channels = le16(&b, 10) as usize; rate = le32(&b, 12);
        wav_head = le32(&b, 16) as u64; wav_tail = le32(&b, 20) as u64; nframes = le32(&b, 24) as u64; final_blocks = le32(&b, 28) as u64;
        let mut o = 32;
        if flags & 4 != 0 { o += 4; head_len += 4; }
        if flags & 16 != 0 { seek_len = le32(&b, o) as u64 * 4; head_len += 4; } else { seek_len = nframes * 4; }
        bits = if flags & 1 != 0 { 8 } else if flags & 8 != 0 { 24 } else { 16 };
        bpf = 73728 * 4;
    }
    if !(1..=2).contains(&channels) { return Err("APE: поддерживаются моно и стерео".into()); }
    if ![8, 16, 24].contains(&bits) { return Err(format!("APE: {bits} бит не поддерживается")); }
    if level % 1000 != 0 || !(1000..=5000).contains(&level) { return Err(format!("APE: неизвестный уровень сжатия {level}")); }
    if nframes == 0 { return Err("APE: в файле нет звука".into()); }
    if seek_len < nframes * 4 { return Err("APE: таблица перемотки короче числа кадров".into()); }
    let first = junk + desc_len + head_len + seek_len + wav_head;
    let seek_at = junk + desc_len + head_len + if ver < 3980 && flags & 32 == 0 { wav_head } else { 0 };
    let st = read_at(s, seek_at, (nframes * 4) as usize)?;
    if (st.len() as u64) < nframes * 4 { return Err("APE: файл обрезан".into()); }
    let mut frames = Vec::with_capacity(nframes as usize);
    for i in 0..nframes as usize {
        let pos = if i == 0 { first } else { le32(&st, i * 4) as u64 + junk };
        frames.push(Fr { off: pos, len: 0, start: i as u64 * bpf, n: if i as u64 == nframes - 1 { final_blocks } else { bpf }, skip: 0 });
    }
    let f0 = frames[0].off;
    for i in 0..frames.len() {
        let pos = frames[i].off;
        let mut sz: i64 = if i < frames.len() - 1 { frames[i + 1].off as i64 - pos as i64 } else { size as i64 - pos as i64 - wav_tail as i64 };
        if i == frames.len() - 1 { sz -= sz & 3; if sz <= 0 { sz = final_blocks as i64 * 8; } }
        if sz < 0 { return Err("APE: таблица перемотки повреждена".into()); }
        let skip = ((pos as i64 - f0 as i64) & 3) as usize;
        frames[i].off = pos - skip as u64;
        frames[i].skip = skip;
        frames[i].len = ((sz as usize + skip + 3) & !3) as usize;
    }
    let total = (nframes - 1) * bpf + final_blocks;
    Ok((Info { codec: "APE", rate, channels, bits, float: false, total, lossy: false, level }, ApeHdr { ver, level, channels }, frames))
}

// ═════════════════════════════════════════ WavPack ═════════════════════════════════════════

const RATES: [u32; 15] = [6000, 8000, 9600, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000, 192000];
const F_MONO: u32 = 0x4;
const F_HYBRID: u32 = 0x8;
const F_JOINT: u32 = 0x10;
const F_FLOAT: u32 = 0x80;
const F_HBITRATE: u32 = 0x200;
const F_INITIAL: u32 = 0x800;
const F_FALSE_STEREO: u32 = 0x4000_0000;
const F_DSD: u32 = 0x8000_0000;

struct Tabs { exp2: [u8; 256], log2: [u8; 256] }
fn tabs() -> &'static Tabs {
    static T: std::sync::OnceLock<Tabs> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let mut t = Tabs { exp2: [0; 256], log2: [0; 256] };
        for i in 0..256 {
            t.exp2[i] = (((2f64.powf(i as f64 / 256.0) * 256.0).round() as i64 - 256) & 255) as u8;
            t.log2[i] = (((1.0 + i as f64 / 256.0).log2() * 256.0).round() as i64 & 255) as u8;
        }
        t
    })
}
pub fn wp_exp2(v: i32) -> i32 {
    let mut v = ((v << 16) >> 16) as i32;
    let mut neg = false;
    if v < 0 { v = -v; neg = true; }
    let mut res = tabs().exp2[(v & 255) as usize] as i32 | 0x100;
    v >>= 8;
    if v > 31 { return i32::MIN; }
    res = if v > 9 { res.wrapping_shl((v - 9) as u32) } else { res >> (9 - v) };
    if neg { res.wrapping_neg() } else { res }
}
fn wp_log2(val: u32) -> i32 {
    if val == 0 { return 0; }
    let val = val.wrapping_add(val >> 9);
    if val == 0 { return 0; }
    let bits = 31 - val.leading_zeros() as i32;
    let t = &tabs().log2;
    if bits < 9 { (bits << 8) + t[((val << (9 - bits)) & 255) as usize] as i32 }
    else { (bits << 8) + t[((val >> (bits - 9)) & 255) as usize] as i32 }
}
#[inline]
fn level_decay(a: i32) -> i32 { a.wrapping_add(0x80) >> 8 }

/// чтение битов младшим разрядом вперёд
struct Bits { p: usize, end: usize, c: u32, n: u32, used: i64, total: i64 }
impl Bits {
    fn new(off: usize, len: usize) -> Bits { Bits { p: off, end: off + len, c: 0, n: 0, used: 0, total: len as i64 * 8 } }
    fn left(&self) -> i64 { self.total - self.used }
    #[inline]
    fn fill(&mut self, d: &[u8]) {
        while self.n <= 24 {
            let b = if self.p < self.end { *d.get(self.p).unwrap_or(&0) as u32 } else { 0 };
            self.c |= b << self.n; self.p += 1; self.n += 8;
        }
    }
    #[inline]
    fn bit(&mut self, d: &[u8]) -> u32 {
        if self.n == 0 { self.fill(d); }
        let b = self.c & 1; self.c >>= 1; self.n -= 1; self.used += 1; b
    }
    fn get(&mut self, d: &[u8], k: u32) -> u32 {
        if k == 0 { return 0; }
        if k > 24 { let lo = self.get(d, 16); return lo.wrapping_add(self.get(d, k - 16).wrapping_mul(65536)); }
        if self.n < k { self.fill(d); }
        let v = self.c & ((1u32 << k) - 1);
        self.c = if k >= 32 { 0 } else { self.c >> k };
        self.n -= k; self.used += k as i64;
        v
    }
    fn unary33(&mut self, d: &[u8]) -> i64 { let mut k = 0; while k < 33 && self.bit(d) != 0 { k += 1; } k }
}

#[derive(Clone, Default)]
struct Chan { median: [u32; 3], slow: i32, err_limit: u32, bitrate_acc: u32, bitrate_delta: i32 }
#[derive(Clone)]
struct Decorr { value: i32, delta: i32, wa: i32, wb: i32, sa: [i32; 8], sb: [i32; 8] }

struct St {
    decorr: Vec<Decorr>, ch: [Chan; 2], extra_bits: u32, and: i32, or: i32, shift: u32, gx: Option<Bits>,
    hybrid: bool, hbitrate: bool, joint: bool, float: bool, stereo: bool, post_shift: u32, maxclip: i64, minclip: i64,
    fflag: u32, fshift: u32, fmax_exp: u32, zero: i64, one: i64, zeroes: i64, last: bool,
}

fn get_tail(gb: &mut Bits, d: &[u8], k: i64) -> i64 {
    if k < 1 { return 0; }
    let p = 63 - (k as u64).leading_zeros() as i64;
    let e = (1i64 << (p + 1)) - k - 1;
    let mut res = gb.get(d, p as u32) as i64;
    if res >= e { res = res * 2 - e + gb.bit(d) as i64; }
    res
}

fn update_error_limit(s: &mut St) {
    let mut br = [0i32; 2];
    let mut sl = [0i32; 2];
    let st = if s.stereo { 1 } else { 0 };
    for i in 0..=st {
        let c = &mut s.ch[i];
        c.bitrate_acc = c.bitrate_acc.wrapping_add(c.bitrate_delta as u32);
        br[i] = (c.bitrate_acc >> 16) as i32;
        sl[i] = level_decay(c.slow);
    }
    if st == 1 && s.hbitrate {
        let balance = (sl[1] - sl[0] + br[1] + 1) >> 1;
        if balance > br[0] { br[1] = br[0] * 2; br[0] = 0; }
        else if -balance > br[0] { br[0] *= 2; br[1] = 0; }
        else { br[1] = br[0] + balance; br[0] -= balance; }
    }
    for i in 0..=st {
        s.ch[i].err_limit = if s.hbitrate {
            if sl[i] - br[i] > -0x100 { wp_exp2(sl[i] - br[i] + 0x100) as u32 } else { 0 }
        } else { wp_exp2(br[i]) as u32 };
    }
}

/// значение из энтропийного кода (wv_get_value в libavcodec)
fn get_value(s: &mut St, gb: &mut Bits, d: &[u8], ch: usize) -> i32 {
    s.last = false;
    if s.ch[0].median[0] < 2 && s.ch[1].median[0] < 2 && s.zero == 0 && s.one == 0 {
        if s.zeroes != 0 {
            s.zeroes -= 1;
            if s.zeroes != 0 { let c = &mut s.ch[ch]; c.slow = c.slow.wrapping_sub(level_decay(c.slow)); return 0; }
        } else {
            let mut t = gb.unary33(d);
            if t >= 2 {
                if t >= 32 || gb.left() < t - 1 { s.last = true; return 0; }
                t = gb.get(d, (t - 1) as u32) as i64 + (1i64 << (t - 1));
            }
            s.zeroes = t;
            if s.zeroes != 0 {
                s.ch[0].median = [0; 3]; s.ch[1].median = [0; 3];
                let c = &mut s.ch[ch]; c.slow = c.slow.wrapping_sub(level_decay(c.slow));
                return 0;
            }
        }
    }
    let mut t: i64;
    if s.zero != 0 { t = 0; s.zero = 0; }
    else {
        t = gb.unary33(d);
        if gb.left() < 0 { s.last = true; return 0; }
        if t == 16 {
            let t2 = gb.unary33(d);
            if t2 < 2 { t += t2; }
            else {
                if t2 >= 32 || gb.left() < t2 - 1 { s.last = true; return 0; }
                t += gb.get(d, (t2 - 1) as u32) as i64 + (1i64 << (t2 - 1));
            }
        }
        let ti = t as i32; // как в JS: t & 1, t >> 1 — над int32
        if s.one != 0 { s.one = (ti & 1) as i64; t = (ti >> 1) as i64 + 1; } else { s.one = (ti & 1) as i64; t = (ti >> 1) as i64; }
        s.zero = if s.one != 0 { 0 } else { 1 };
    }
    if s.hybrid && ch == 0 { update_error_limit(s); }
    let c = &mut s.ch[ch];
    let m = &mut c.median;
    let g = |m: &[u32; 3], n: usize| (m[n] >> 4) as i64 + 1;
    let dec = |m: &mut [u32; 3], n: usize| { let q = 128i64 >> n; let v = m[n] as i64; m[n] = (v - (v + q - 2).div_euclid(q) * 2) as u32; };
    let inc = |m: &mut [u32; 3], n: usize| { let q = 128i64 >> n; let v = m[n] as i64; m[n] = (v + (v + q).div_euclid(q) * 5) as u32; };
    let (mut base, mut add): (i64, i64);
    if t == 0 { base = 0; add = g(m, 0) - 1; dec(m, 0); }
    else if t == 1 { base = g(m, 0); add = g(m, 1) - 1; inc(m, 0); dec(m, 1); }
    else if t == 2 { base = g(m, 0) + g(m, 1); add = g(m, 2) - 1; inc(m, 0); inc(m, 1); dec(m, 2); }
    else { base = g(m, 0) + g(m, 1) + g(m, 2).wrapping_mul(t - 2); add = g(m, 2) - 1; inc(m, 0); inc(m, 1); inc(m, 2); }
    base = (base as u64 & 0xffff_ffff) as i64;
    let ret: i64;
    if c.err_limit == 0 {
        if add >= 0x200_0000 { s.last = true; return 0; }
        ret = base + get_tail(gb, d, add);
        if gb.left() <= 0 { s.last = true; return 0; }
    } else {
        let lim = c.err_limit as i64;
        let mut mid = (base * 2 + add + 1).div_euclid(2);
        while add > lim {
            if gb.left() <= 0 { s.last = true; return 0; }
            if gb.bit(d) != 0 { add -= mid - base; base = mid; } else { add = mid - base - 1; }
            mid = (base * 2 + add + 1).div_euclid(2);
        }
        ret = mid;
    }
    let ret = (ret as u64 & 0xffff_ffff) as u32;
    let sgn = gb.bit(d);
    if s.hbitrate { let c = &mut s.ch[ch]; c.slow = c.slow.wrapping_add(wp_log2(ret).wrapping_sub(level_decay(c.slow))); }
    if sgn != 0 { !(ret as i32) } else { ret as i32 }
}

fn to_int(s: &mut St, d: &[u8], mut v: i32) -> i32 {
    if s.extra_bits != 0 {
        v = v.wrapping_shl(s.extra_bits);
        let eb = s.extra_bits;
        if let Some(gx) = s.gx.as_mut() { if gx.left() >= eb as i64 { v |= gx.get(d, eb) as i32; } }
    }
    let bit = (v & s.and) | s.or;
    let mut bit = v.wrapping_add(bit).wrapping_shl(s.shift).wrapping_sub(bit);
    if s.hybrid { bit = (bit as i64).clamp(s.minclip, s.maxclip) as i32; }
    bit.wrapping_shl(s.post_shift)
}

fn to_float(s: &mut St, d: &[u8], v: i32) -> u32 {
    let mut exp = s.fmax_exp as i64;
    let mut sgn: u32 = 0;
    let mut m: i64;
    let fflag = s.fflag;
    if v != 0 {
        let big = s.fshift >= 32;
        m = if big { 0 } else { (v as i64) << s.fshift };
        if v < 0 { sgn = 1; m = -m; }
        if big || m >= 0x100_0000 {
            m = match s.gx.as_mut() { Some(gx) => if gx.bit(d) != 0 { gx.get(d, 23) as i64 } else { 0 }, None => 0 };
            exp = 255;
        } else if exp != 0 {
            let mut shift = 23 - (63 - (m as u64).leading_zeros() as i64);
            exp = s.fmax_exp as i64;
            if exp <= shift { exp -= 1; shift = exp; }
            exp -= shift;
            if shift != 0 {
                m <<= shift;
                let mut ones = fflag & 1 != 0;
                if !ones && fflag & 2 != 0 { if let Some(gx) = s.gx.as_mut() { ones = gx.bit(d) != 0; } }
                if ones { m += (1i64 << shift) - 1; }
                else if fflag & 4 != 0 { if let Some(gx) = s.gx.as_mut() { m += gx.get(d, shift as u32) as i64; } }
            }
        } else { exp = s.fmax_exp as i64; }
        m &= 0x7f_ffff;
    } else {
        exp = 0; m = 0;
        if fflag & 8 != 0 {
            let fmax = s.fmax_exp;
            if let Some(gx) = s.gx.as_mut() {
                if gx.bit(d) != 0 {
                    m = gx.get(d, 23) as i64;
                    if fmax >= 25 { exp = gx.get(d, 8) as i64; }
                    sgn = gx.bit(d);
                } else if fflag & 0x10 != 0 { sgn = gx.bit(d); }
            }
        }
    }
    (sgn << 31) | ((exp as u32) << 23) | (m as u32)
}

#[inline]
fn w10(w: i32, a: i32) -> i64 { (w as i64 * a as i64 + 512) >> 10 }
#[inline]
fn addw(x: i32, w: i32, a: i32) -> i32 { (x as i64 + w10(w, a)) as i32 }
fn clip_w(mut w: i32, delta: i32, smp: i32, inp: i32) -> i32 {
    if smp != 0 && inp != 0 {
        if (smp ^ inp) < 0 { w -= delta; if w < -1024 { w = -1024; } } else { w += delta; if w > 1024 { w = 1024; } }
    }
    w
}
#[inline]
fn adj(a: i32, x: i32) -> i32 { (((x ^ a) >> 30) & 2) - 1 }

fn out_val(s: &mut St, d: &[u8], v: i32) -> i32 { if s.float { to_float(s, d, v) as i32 } else { to_int(s, d, v) } }

fn unpack_stereo(s: &mut St, gb: &mut Bits, d: &[u8], ol: &mut [i32], or: &mut [i32]) -> usize {
    let n = ol.len();
    let (mut pos, mut count) = (0usize, 0usize);
    s.one = 0; s.zero = 0; s.zeroes = 0;
    let mut dc = std::mem::take(&mut s.decorr);
    while count < n {
        let mut l = get_value(s, gb, d, 0); if s.last { break; }
        let mut r = get_value(s, gb, d, 1); if s.last { break; }
        for e in dc.iter_mut() {
            let t = e.value;
            if t > 0 {
                let (a, b, j);
                if t > 8 {
                    if t & 1 != 0 { a = e.sa[0].wrapping_mul(2).wrapping_sub(e.sa[1]); b = e.sb[0].wrapping_mul(2).wrapping_sub(e.sb[1]); }
                    else { a = e.sa[0].wrapping_mul(3).wrapping_sub(e.sa[1]) >> 1; b = e.sb[0].wrapping_mul(3).wrapping_sub(e.sb[1]) >> 1; }
                    e.sa[1] = e.sa[0]; e.sb[1] = e.sb[0]; j = 0;
                } else { a = e.sa[pos]; b = e.sb[pos]; j = (pos + t as usize) & 7; }
                let l2 = addw(l, e.wa, a);
                let r2 = addw(r, e.wb, b);
                if a != 0 && l != 0 { e.wa = e.wa.wrapping_sub(adj(a, l).wrapping_mul(e.delta)); }
                if b != 0 && r != 0 { e.wb = e.wb.wrapping_sub(adj(b, r).wrapping_mul(e.delta)); }
                l = l2; r = r2; e.sa[j] = l; e.sb[j] = r;
            } else if t == -1 {
                let l2 = addw(l, e.wa, e.sa[0]); e.wa = clip_w(e.wa, e.delta, e.sa[0], l); l = l2;
                let r2 = addw(r, e.wb, l2); e.wb = clip_w(e.wb, e.delta, l2, r); r = r2; e.sa[0] = r;
            } else {
                let mut r2 = addw(r, e.wb, e.sb[0]); e.wb = clip_w(e.wb, e.delta, e.sb[0], r); r = r2;
                if t == -3 { r2 = e.sa[0]; e.sa[0] = r; }
                let l2 = addw(l, e.wa, r2); e.wa = clip_w(e.wa, e.delta, r2, l); l = l2; e.sb[0] = l;
            }
        }
        pos = (pos + 1) & 7;
        if s.joint { r = r.wrapping_sub(l >> 1); l = l.wrapping_add(r); }
        ol[count] = out_val(s, d, l);
        or[count] = out_val(s, d, r);
        count += 1;
    }
    s.decorr = dc;
    count
}

fn unpack_mono(s: &mut St, gb: &mut Bits, d: &[u8], out: &mut [i32]) -> usize {
    let n = out.len();
    let (mut pos, mut count) = (0usize, 0usize);
    s.one = 0; s.zero = 0; s.zeroes = 0;
    let mut dc = std::mem::take(&mut s.decorr);
    while count < n {
        let mut t0 = get_value(s, gb, d, 0); if s.last { break; }
        let mut sv = t0;
        for e in dc.iter_mut() {
            let t = e.value;
            let (a, j);
            if t > 8 {
                a = if t & 1 != 0 { e.sa[0].wrapping_mul(2).wrapping_sub(e.sa[1]) } else { e.sa[0].wrapping_mul(3).wrapping_sub(e.sa[1]) >> 1 };
                e.sa[1] = e.sa[0]; j = 0;
            } else { a = e.sa[pos]; j = ((pos as i32 + t) & 7) as usize; }
            sv = addw(t0, e.wa, a);
            if a != 0 && t0 != 0 { e.wa = e.wa.wrapping_sub(adj(a, t0).wrapping_mul(e.delta)); }
            t0 = sv; e.sa[j] = sv;
        }
        pos = (pos + 1) & 7;
        out[count] = out_val(s, d, sv);
        count += 1;
    }
    s.decorr = dc;
    count
}

/// метаданные блока: (id, начало, длина)
fn sub_blocks(b: &[u8], mut off: usize, end: usize) -> Vec<(u8, usize, usize)> {
    let end = end.min(b.len());
    let mut v = Vec::new();
    while off + 2 <= end {
        let id = b[off];
        let mut size = b[off + 1] as usize * 2;
        let mut h = 2;
        if id & 0x80 != 0 {
            if off + 4 > end { break; }
            size = (b[off + 1] as usize | (b[off + 2] as usize) << 8 | (b[off + 3] as usize) << 16) * 2; h = 4;
        }
        let real = if id & 0x40 != 0 { size.saturating_sub(1) } else { size };
        if off + h + real > end { break; }
        v.push((id & 0x3f, off + h, real));
        off += h + size;
    }
    v
}
fn i16le(b: &[u8], q: usize) -> i32 { b.get(q..q + 2).map(|s| i16::from_le_bytes([s[0], s[1]]) as i32).unwrap_or(0) }

/// один блок (1 или 2 канала) → каналы (для float — биты f32)
fn decode_block(b: &[u8], off: usize, out: &mut Vec<Vec<i32>>) -> Result<usize, String> {
    let flags = le32(b, off + 24);
    let n = le32(b, off + 20) as usize;
    let end = (off + 8 + le32(b, off + 4) as usize).min(b.len());
    if flags & F_DSD != 0 { return Err("WavPack DSD не поддерживается".into()); }
    if n > 1 << 24 { return Err("WavPack: слишком большой блок".into()); }
    let bytes = (flags & 3) + 1;
    let mono = flags & F_MONO != 0;
    let false_st = flags & F_FALSE_STEREO != 0;
    let mut s = St {
        decorr: Vec::new(), ch: [Chan::default(), Chan::default()], extra_bits: 0, and: 0, or: 0, shift: 0, gx: None,
        hybrid: flags & F_HYBRID != 0, hbitrate: flags & F_HBITRATE != 0, joint: flags & F_JOINT != 0, float: flags & F_FLOAT != 0,
        stereo: !mono, post_shift: (flags >> 13) & 0x1f, maxclip: (1i64 << (bytes * 8 - 1)) - 1, minclip: -(1i64 << (bytes * 8 - 1)),
        fflag: 0, fshift: 0, fmax_exp: 0, zero: 0, one: 0, zeroes: 0, last: false,
    };
    let nch = if mono { 1 } else { 2 };
    let mut gb: Option<Bits> = None;
    for (id, p, len) in sub_blocks(b, off + 32, end) {
        match id {
            2 => {
                s.decorr = (0..len).rev().map(|i| { let v = b[p + i] as i32; Decorr { value: (v & 0x1f) - 5, delta: v >> 5, wa: 0, wb: 0, sa: [0; 8], sb: [0; 8] } }).collect();
            }
            3 => {
                let cnt = (len / nch).min(s.decorr.len());
                let nd = s.decorr.len();
                let mut q = p;
                for i in 0..cnt {
                    let e = &mut s.decorr[nd - 1 - i];
                    let mut w = (b[q] as i8 as i32) * 8; q += 1;
                    if w > 0 { w += (w + 64) >> 7; }
                    e.wa = w;
                    if !mono { let mut w = (b[q] as i8 as i32) * 8; q += 1; if w > 0 { w += (w + 64) >> 7; } e.wb = w; }
                }
            }
            4 => {
                let mut q = p;
                let mut t = 0usize;
                let mut rd = || { let v = wp_exp2(i16le(b, q)); q += 2; v };
                for i in (0..s.decorr.len()).rev() {
                    if t >= len { break; }
                    let e = &mut s.decorr[i];
                    if e.value > 8 {
                        e.sa[0] = rd(); e.sa[1] = rd();
                        if !mono { e.sb[0] = rd(); e.sb[1] = rd(); t += 4; }
                        t += 4;
                    } else if e.value < 0 { e.sa[0] = rd(); e.sb[0] = rd(); t += 4; }
                    else {
                        for j in 0..e.value as usize { e.sa[j] = rd(); if !mono { e.sb[j] = rd(); } }
                        t += e.value as usize * 2 * nch;
                    }
                }
            }
            5 => {
                let mut q = p;
                for i in 0..nch { for j in 0..3 { s.ch[i].median[j] = wp_exp2(i16le(b, q)) as u32; q += 2; } }
            }
            6 => {
                let mut q = p;
                if s.hbitrate { for i in 0..nch { s.ch[i].slow = wp_exp2(i16le(b, q)); q += 2; } }
                for i in 0..nch { s.ch[i].bitrate_acc = le16(b, q) << 16; q += 2; }
                if q < p + len { for i in 0..nch { s.ch[i].bitrate_delta = wp_exp2(i16le(b, q)); q += 2; } }
                else { for i in 0..nch { s.ch[i].bitrate_delta = 0; } }
            }
            8 if len >= 3 => { s.fflag = b[p] as u32; s.fshift = b[p + 1] as u32; s.fmax_exp = b[p + 2] as u32; }
            9 if len >= 4 => {
                let v = [b[p] as u32, b[p + 1] as u32, b[p + 2] as u32, b[p + 3] as u32];
                if v[0] != 0 { s.extra_bits = v[0]; } else if v[1] != 0 { s.shift = v[1]; } else if v[2] != 0 { s.and = 1; s.or = 1; s.shift = v[2]; } else if v[3] != 0 { s.and = 1; s.shift = v[3]; }
                if s.hybrid && bytes == 4 && s.post_shift < 8 && s.shift > 8 { s.post_shift += 8; s.shift -= 8; s.maxclip = s.maxclip.div_euclid(256); s.minclip = s.minclip.div_euclid(256); }
            }
            10 => gb = Some(Bits::new(p, len)),
            12 if len > 4 => s.gx = Some(Bits::new(p + 4, len - 4)),
            _ => {}
        }
    }
    if s.extra_bits == 0 && !s.float { s.gx = None; }
    let mut gb = gb.ok_or("WavPack: в блоке нет звука")?;
    let mut a = vec![0i32; n];
    if mono {
        let got = unpack_mono(&mut s, &mut gb, b, &mut a);
        if false_st { out.push(a.clone()); }
        out.push(a);
        return Ok(got);
    }
    let mut bb = vec![0i32; n];
    let got = unpack_stereo(&mut s, &mut gb, b, &mut a, &mut bb);
    out.push(a); out.push(bb);
    Ok(got)
}

struct Head { size: u64, ver: u32, index: u64, n: u64, flags: u32 }
fn read_head(b: &[u8], o: usize) -> Option<Head> {
    if b.len() < o + 32 || &b[o..o + 4] != b"wvpk" { return None; }
    let size = le32(b, o + 4) as u64 + 8;
    let ver = le16(b, o + 8);
    let mut index = le32(b, o + 16) as u64;
    if ver >= 0x410 { index += (b[o + 10] as u64) << 32; }
    Some(Head { size, ver, index, n: le32(b, o + 20) as u64, flags: le32(b, o + 24) })
}

fn wv_info(s: &mut dyn Src, fsize: u64) -> Result<(Info, Vec<Fr>), String> {
    let mut frames: Vec<Fr> = Vec::new();
    let mut pos: u64 = 0;
    let mut misses = 0;
    let mut first: Option<(Head, usize, u32)> = None; // заголовок, каналы, частота
    let h10 = read_at(s, 0, 10)?;
    if h10.len() == 10 && &h10[0..3] == b"ID3" { pos = 10 + syncsafe(&h10); }
    while pos + 32 <= fsize {
        let hb = read_at(s, pos, 32)?;
        let h = read_head(&hb, 0);
        let bad = match &h { None => true, Some(h) => h.size < 32 || h.ver < 0x402 || h.ver > 0x410 };
        if bad {
            misses += 1;
            if misses > 1 && !frames.is_empty() { break; }
            let w = read_at(s, pos, (fsize - pos).min(1 << 20) as usize)?;
            match find(&w, b"wvpk", 1) { Some(k) => { pos += k as u64; continue; } None => break }
        }
        let h = h.unwrap();
        misses = 0;
        if h.n != 0 {
            if first.is_none() {
                let mut channels = 0usize;
                let mut rate = RATES.get(((h.flags >> 23) & 15) as usize).copied().unwrap_or(0);
                let b = read_at(s, pos, h.size.min(1 << 20) as usize)?;
                for (id, p, len) in sub_blocks(&b, 32, b.len()) {
                    if id == 0xd && len > 0 { channels = b[p] as usize; }
                    if id == 0x27 && len >= 3 { rate = if len >= 4 { le32(&b, p) } else { b[p] as u32 | (b[p + 1] as u32) << 8 | (b[p + 2] as u32) << 16 }; }
                }
                if channels == 0 { channels = if h.flags & F_MONO != 0 && h.flags & F_FALSE_STEREO == 0 { 1 } else { 2 }; }
                first = Some((Head { ..h }, channels, rate));
                let h = &first.as_ref().unwrap().0;
                frames.push(Fr { off: pos, len: 0, start: h.index, n: h.n, skip: 0 });
            } else if h.flags & F_INITIAL != 0 {
                frames.push(Fr { off: pos, len: 0, start: h.index, n: h.n, skip: 0 });
            }
            let cur = frames.last_mut().unwrap();
            cur.len = (pos + h.size - cur.off) as usize;
        }
        pos += h.size;
    }
    let (fh, channels, rate) = first.ok_or("Это не файл WavPack")?;
    if fh.flags & F_DSD != 0 { return Err("WavPack DSD не поддерживается".into()); }
    let base = frames[0].start;
    for f in frames.iter_mut() { f.start = f.start.saturating_sub(base); }
    let last = frames.last().unwrap();
    let total = last.start + last.n;
    let float = fh.flags & F_FLOAT != 0;
    let bits = if float { 32 } else { ((fh.flags & 3) + 1) * 8 };
    Ok((Info { codec: "WavPack", rate, channels, bits, float, total, lossy: fh.flags & F_HYBRID != 0, level: 0 }, frames))
}

fn wv_frame(buf: &[u8]) -> Result<(Vec<Vec<i32>>, usize), String> {
    let mut ch = Vec::new();
    let (mut o, mut n) = (0usize, 0usize);
    while o + 32 <= buf.len() {
        let Some(h) = read_head(buf, o) else { break };
        if h.n != 0 { n = h.n as usize; decode_block(buf, o, &mut ch)?; }
        o += h.size as usize;
    }
    Ok((ch, n))
}

// ═════════════════════════════════════════ файл ═════════════════════════════════════════

enum Cur { Ape(Box<ApeFrame>), Wv { ch: Vec<Vec<i32>>, at: usize, n: usize } }

pub struct Reader {
    src: Box<dyn Src>,
    pub info: Info,
    frames: Vec<Fr>,
    ape: Option<ApeHdr>,
    fi: usize,          // следующий кадр
    cur: Option<Cur>,
    drop: u64,          // после перемотки: сколько отсчётов выбросить в начале кадра
}

impl Reader {
    pub fn open(mut src: Box<dyn Src>) -> Result<Reader, String> {
        let size = src.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        let head = read_at(&mut *src, 0, 4096.min(size as usize))?;
        let id3 = if head.len() >= 10 && &head[0..3] == b"ID3" { 10 + syncsafe(&head) } else { 0 };
        let probe = read_at(&mut *src, id3, 4)?;
        let is_ape = probe.as_slice() == b"MAC " || (probe.as_slice() != b"wvpk" && find(&head, b"MAC ", 0).is_some());
        if is_ape {
            let (info, h, frames) = ape_info(&mut *src, size)?;
            Ok(Reader { src, info, frames, ape: Some(h), fi: 0, cur: None, drop: 0 })
        } else {
            let (info, frames) = wv_info(&mut *src, size)?;
            Ok(Reader { src, info, frames, ape: None, fi: 0, cur: None, drop: 0 })
        }
    }

    pub fn duration(&self) -> f64 { self.info.duration() }

    pub fn seek(&mut self, t: f64) -> Result<(), String> {
        let target = ((t.max(0.0)) * self.info.rate as f64).round() as u64;
        if target >= self.info.total {
            if t < 0.5 { self.fi = 0; self.cur = None; self.drop = 0; return Ok(()); }
            return Err("за концом файла".into());
        }
        let i = match self.frames.binary_search_by(|f| f.start.cmp(&target)) { Ok(i) => i, Err(i) => i.saturating_sub(1) };
        self.fi = i;
        self.cur = None;
        self.drop = target - self.frames[i].start;
        Ok(())
    }

    fn load(&mut self) -> Result<bool, String> {
        if self.fi >= self.frames.len() { return Ok(false); }
        let f = self.frames[self.fi].clone();
        self.fi += 1;
        let raw = read_at(&mut *self.src, f.off, f.len)?;
        if let Some(h) = &self.ape {
            self.cur = Some(Cur::Ape(Box::new(ApeFrame::new(&raw, f.skip, f.n as usize, h))));
        } else {
            let (ch, n) = wv_frame(&raw)?;
            if ch.is_empty() { return Err("WavPack: пустой кадр".into()); }
            self.cur = Some(Cur::Wv { ch, at: 0, n });
        }
        Ok(true)
    }

    /// следующий кусок: каналы целыми (для float — биты f32); None — конец
    pub fn next_raw(&mut self, max: usize) -> Result<Option<Vec<Vec<i32>>>, String> {
        loop {
            let done = match &self.cur { None => true, Some(Cur::Ape(a)) => a.done(), Some(Cur::Wv { at, n, .. }) => at >= n };
            if done { if !self.load()? { return Ok(None); } continue; }
            let mut out = match self.cur.as_mut().unwrap() {
                Cur::Ape(a) => a.chunk()?,
                Cur::Wv { ch, at, n } => {
                    let k = max.max(1).min(*n - *at);
                    let o = ch.iter().map(|c| c.get(*at..*at + k).map(|s| s.to_vec()).unwrap_or_else(|| vec![0; k])).collect();
                    *at += k;
                    o
                }
            };
            if self.drop > 0 {
                let len = out[0].len() as u64;
                if self.drop >= len { self.drop -= len; continue; }
                let d = self.drop as usize;
                for c in out.iter_mut() { c.drain(..d); }
                self.drop = 0;
            }
            return Ok(Some(out));
        }
    }

    /// следующий кусок для движка: стерео f32 (моно — в оба канала, многоканальный — первые два)
    pub fn next(&mut self, max: usize) -> Result<Option<(Vec<f32>, Vec<f32>)>, String> {
        let Some(ch) = self.next_raw(max)? else { return Ok(None) };
        let conv = |c: &[i32]| -> Vec<f32> {
            if self.info.float { c.iter().map(|&v| f32::from_bits(v as u32)).collect() }
            else { let k = 1.0 / (1u64 << (self.info.bits - 1)) as f32; c.iter().map(|&v| v as f32 * k).collect() }
        };
        let l = conv(&ch[0]);
        let r = if ch.len() > 1 { conv(&ch[1]) } else { l.clone() };
        Ok(Some((l, r)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// побитная сверка с эталонным PCM (как его отдаёт ffmpeg: s16le/s24le/s32le/u8/f32le, каналы чередуются)
    pub fn raw_of(path: &Path) -> (Info, Vec<u8>) {
        let f = std::fs::File::open(path).unwrap();
        let mut r = Reader::open(Box::new(f)).unwrap();
        let info = r.info.clone();
        let mut out = Vec::new();
        while let Some(ch) = r.next_raw(4096).unwrap() {
            for i in 0..ch[0].len() {
                for c in &ch {
                    let v = c[i];
                    if info.float { out.extend_from_slice(&(v as u32).to_le_bytes()); }
                    else { match info.bits { 8 => out.push((v + 128) as u8), 16 => out.extend_from_slice(&(v as i16).to_le_bytes()), 24 => out.extend_from_slice(&v.to_le_bytes()[..3]), _ => out.extend_from_slice(&v.to_le_bytes()) } }
                }
            }
        }
        (info, out)
    }

    fn fixture(name: &str) -> Option<std::path::PathBuf> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../lab-media").join(name);
        if p.exists() { Some(p) } else { None }
    }

    #[test]
    fn wavpack_fixtures_match_reference() {
        for n in ["wv-s16", "wv-f32"] {
            let (Some(w), Some(r)) = (fixture(&format!("{n}.wv")), fixture(&format!("{n}.ref.raw"))) else { panic!("нет {n}") };
            let (_, mine) = raw_of(&w);
            assert!(mine == std::fs::read(r).unwrap(), "{n}: расхождение с эталоном");
        }
    }

    #[test]
    fn ape_fixtures_match_reference() {
        for n in ["ape-s16-5000-3990", "ape-s24-3000-3980", "ape-m16-2000-3950", "ape-s8-4000-3970"] {
            let (Some(a), Some(r)) = (fixture(&format!("{n}.ape")), fixture(&format!("{n}.ref.raw"))) else { panic!("нет {n}") };
            let (_, mine) = raw_of(&a);
            assert!(mine == std::fs::read(r).unwrap(), "{n}: расхождение с эталоном");
        }
    }

    #[test]
    fn seek_lands_on_exact_sample() {
        let a = fixture("ape-s16-5000-3990.ape").expect("нет ape-s16");
        let (info, all) = raw_of(&a);
        let mut r = Reader::open(Box::new(std::fs::File::open(&a).unwrap())).unwrap();
        let t = 1.2345;
        r.seek(t).unwrap();
        let first = r.next_raw(4096).unwrap().unwrap();
        let at = (t * info.rate as f64).round() as usize;
        let want = i16::from_le_bytes([all[at * 4], all[at * 4 + 1]]) as i32;
        assert_eq!(first[0][0], want);
    }
}
