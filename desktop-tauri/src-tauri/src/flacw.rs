// Запись FLAC (без потерь) — для «Сохранить как FLAC» (DSD → PCM 24 бит). Свой небольшой кодер без сторонних
// библиотек: фиксированные предсказатели порядков 0–4 (выбирается лучший для каждого канала каждого блока), каналы
// независимо или «середина/сторона» (что короче), остаток — код Райса с разбиением на части. Проверено декодером
// ffmpeg: восстановленные отсчёты совпадают бит в бит (тест flac_roundtrip_with_ffmpeg).

use std::io::{Seek, SeekFrom, Write};

struct Bits { v: Vec<u8>, acc: u64, n: u32 }
impl Bits {
    fn new() -> Bits { Bits { v: Vec::with_capacity(1 << 16), acc: 0, n: 0 } }
    #[inline]
    fn put(&mut self, x: u64, bits: u32) {
        if bits == 0 { return; }
        if bits > 32 { self.put(x >> 32, bits - 32); self.put(x & 0xffff_ffff, 32); return; }
        self.acc = (self.acc << bits) | (x & ((1u64 << bits) - 1)); self.n += bits;
        while self.n >= 8 { self.n -= 8; self.v.push((self.acc >> self.n) as u8); }
    }
    fn put_s(&mut self, x: i64, bits: u32) { self.put((x as u64) & ((1u64 << bits) - 1), bits); }
    fn unary(&mut self, q: u64) { let mut q = q; while q >= 32 { self.put(0, 32); q -= 32; } self.put(1, q as u32 + 1); }
    fn align(&mut self) { if self.n > 0 { let pad = 8 - self.n; self.put(0, pad); } }
}

fn crc8(d: &[u8]) -> u8 { let mut c = 0u8; for &b in d { c ^= b; for _ in 0..8 { c = if c & 0x80 != 0 { (c << 1) ^ 0x07 } else { c << 1 }; } } c }
fn crc16(d: &[u8]) -> u16 { let mut c = 0u16; for &b in d { c ^= (b as u16) << 8; for _ in 0..8 { c = if c & 0x8000 != 0 { (c << 1) ^ 0x8005 } else { c << 1 }; } } c }

fn residual(x: &[i64], order: usize) -> Vec<i64> {
    (order..x.len()).map(|i| match order {
        0 => x[i],
        1 => x[i] - x[i - 1],
        2 => x[i] - 2 * x[i - 1] + x[i - 2],
        3 => x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3],
        _ => x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4],
    }).collect()
}
fn zz(r: i64) -> u64 { ((r << 1) ^ (r >> 63)) as u64 }

/// лучший параметр Райса для части и её длина в битах
fn rice_part(res: &[i64]) -> (u32, u64) {
    let mut best = (0u32, u64::MAX);
    let sum: u64 = res.iter().map(|&r| zz(r)).sum();
    let mean = if res.is_empty() { 0 } else { sum / res.len() as u64 };
    let k0 = if mean == 0 { 0 } else { 63 - mean.leading_zeros() };
    for k in k0.saturating_sub(1)..=(k0 + 1).min(30) {
        let bits: u64 = res.iter().map(|&r| (zz(r) >> k) + 1 + k as u64).sum();
        if bits < best.1 { best = (k, bits); }
    }
    best
}

/// подкадр: (лучший порядок, порядок разбиения, параметры, длина в битах)
fn plan(x: &[i64], bps: u32) -> (usize, u32, Vec<u32>, u64) {
    let n = x.len();
    let mut best = (0usize, 0u32, vec![], u64::MAX);
    for order in 0..=4usize.min(n.saturating_sub(1)) {
        let res = residual(x, order);
        for po in 0..=4u32 {
            let parts = 1usize << po;
            if n % parts != 0 || (n >> po) <= order { continue; }
            let mut ks = Vec::with_capacity(parts); let mut bits = 6 + 1 + order as u64 * bps as u64 + 2 + 4;
            let mut at = 0;
            for p in 0..parts {
                let len = (n >> po) - if p == 0 { order } else { 0 };
                let (k, b) = rice_part(&res[at..at + len]); at += len;
                ks.push(k); bits += 5 + b;
            }
            if bits < best.3 { best = (order, po, ks, bits); }
        }
    }
    best
}

fn subframe(b: &mut Bits, x: &[i64], bps: u32) {
    let verbatim = 6 + 1 + x.len() as u64 * bps as u64;
    let (order, po, ks, bits) = plan(x, bps);
    b.put(0, 1);
    if bits >= verbatim {
        b.put(1, 6); b.put(0, 1);
        for &v in x { b.put_s(v, bps); }
        return;
    }
    b.put(8 | order as u64, 6); b.put(0, 1);
    for &v in &x[..order] { b.put_s(v, bps); }
    let res = residual(x, order);
    b.put(1, 2); b.put(po as u64, 4); // Rice2: параметры по 5 бит
    let n = x.len(); let mut at = 0;
    for (p, &k) in ks.iter().enumerate() {
        let len = (n >> po) - if p == 0 { order } else { 0 };
        b.put(k as u64, 5);
        for &r in &res[at..at + len] { let u = zz(r); b.unary(u >> k); b.put(u & ((1u64 << k) - 1), k); }
        at += len;
    }
}

pub struct Encoder<'a, W: Write + Seek> { w: &'a mut W, rate: u32, ch: u32, bps: u32, frame_no: u64, samples: u64, minb: u32, maxb: u32, minf: u32, maxf: u32 }

impl<'a, W: Write + Seek> Encoder<'a, W> {
    pub fn new(w: &'a mut W, rate: u32, ch: u32, bps: u32) -> Result<Self, String> {
        if !(1..=2).contains(&ch) || !(8..=24).contains(&bps) { return Err("FLAC: только 1–2 канала, 8–24 бит".into()); }
        let mut e = Encoder { w, rate, ch, bps, frame_no: 0, samples: 0, minb: u32::MAX, maxb: 0, minf: u32::MAX, maxf: 0 };
        e.header()?;
        Ok(e)
    }
    fn header(&mut self) -> Result<(), String> {
        let mut b = Bits::new();
        b.v.extend_from_slice(b"fLaC");
        b.put(1, 1); b.put(0, 7); b.put(34, 24);
        let (minb, maxb) = if self.maxb == 0 { (4096, 4096) } else { (self.minb.min(self.maxb), self.maxb) };
        b.put(minb.min(65535) as u64, 16); b.put(maxb.min(65535) as u64, 16);
        b.put(if self.maxf == 0 { 0 } else { self.minf } as u64, 24); b.put(self.maxf as u64, 24);
        b.put(self.rate as u64, 20); b.put((self.ch - 1) as u64, 3); b.put((self.bps - 1) as u64, 5); b.put(self.samples, 36);
        for _ in 0..16 { b.put(0, 8); } // MD5 не считаем (по стандарту 0 — «неизвестно»)
        self.w.write_all(&b.v).map_err(|e| e.to_string())
    }
    /// один блок отсчётов (каналы одинаковой длины, до 65535)
    pub fn frame(&mut self, chans: &[&[i32]]) -> Result<(), String> {
        let n = chans[0].len(); if n == 0 { return Ok(()); }
        let mut b = Bits::new();
        b.put(0b11111111111110, 14); b.put(0, 1); b.put(0, 1);
        let bs_code = if n == 4096 { 12 } else if n <= 256 { 6 } else { 7 };
        b.put(bs_code, 4);
        let sr_code = match self.rate { 88200 => 1, 176400 => 2, 192000 => 3, 8000 => 4, 16000 => 5, 22050 => 6, 24000 => 7, 32000 => 8, 44100 => 9, 48000 => 10, 96000 => 11, _ => 0 };
        b.put(sr_code, 4);
        // каналы: независимо (1) или середина/сторона (10) — выбираем короче
        let x: Vec<Vec<i64>> = chans.iter().map(|c| c.iter().map(|&v| v as i64).collect()).collect();
        let mut assign = self.ch as u64 - 1;
        let mut subs: Vec<(Vec<i64>, u32)> = x.iter().map(|c| (c.clone(), self.bps)).collect();
        if self.ch == 2 {
            let mid: Vec<i64> = (0..n).map(|i| (x[0][i] + x[1][i]) >> 1).collect();
            let side: Vec<i64> = (0..n).map(|i| x[0][i] - x[1][i]).collect();
            let indep = plan(&x[0], self.bps).3 + plan(&x[1], self.bps).3;
            let ms = plan(&mid, self.bps).3 + plan(&side, self.bps + 1).3;
            if ms < indep { assign = 10; subs = vec![(mid, self.bps), (side, self.bps + 1)]; }
        }
        b.put(assign, 4);
        let ss = match self.bps { 8 => 1, 12 => 2, 16 => 4, 20 => 5, 24 => 6, _ => 0 };
        b.put(ss, 3); b.put(0, 1);
        // номер кадра — как UTF-8
        let f = self.frame_no;
        if f < 0x80 { b.put(f, 8); } else {
            let mut bytes = Vec::new(); let mut v = f; let mut lim = 0x3fu64;
            while v > lim { bytes.push(0x80 | (v & 0x3f) as u8); v >>= 6; lim >>= 1; }
            let nb = bytes.len() as u32 + 1; let lead = (0xffu64 << (8 - nb)) & 0xff;
            b.put(lead | v, 8); for x in bytes.iter().rev() { b.put(*x as u64, 8); }
        }
        if bs_code == 6 { b.put(n as u64 - 1, 8); } else if bs_code == 7 { b.put(n as u64 - 1, 16); }
        if sr_code == 0 { return Err(format!("FLAC: частота {} не поддержана", self.rate)); }
        let c = crc8(&b.v); b.put(c as u64, 8);
        for (s, bps) in &subs { subframe(&mut b, s, *bps); }
        b.align();
        let c = crc16(&b.v); b.put(c as u64, 16);
        self.w.write_all(&b.v).map_err(|e| e.to_string())?;
        self.frame_no += 1; self.samples += n as u64;
        self.minb = self.minb.min(n as u32); self.maxb = self.maxb.max(n as u32);
        self.minf = self.minf.min(b.v.len() as u32); self.maxf = self.maxf.max(b.v.len() as u32);
        Ok(())
    }
    /// дописать в заголовок число отсчётов и размеры
    pub fn finish(mut self) -> Result<(), String> {
        let end = self.w.stream_position().map_err(|e| e.to_string())?;
        self.w.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        // последний (короткий) блок не входит в «наименьший размер блока» по стандарту
        if self.minb < self.maxb { self.minb = self.maxb; }
        self.header()?;
        self.w.seek(SeekFrom::Start(end)).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // проверка декодером ffmpeg (если он есть на машине проверки): всё восстанавливается бит в бит
    #[test]
    fn flac_roundtrip_with_ffmpeg() {
        let Ok(o) = std::process::Command::new("ffmpeg").arg("-version").output() else { eprintln!("ffmpeg нет — проверка пропущена"); return };
        if !o.status.success() { return; }
        let n = 88200 * 2 + 1234;
        let l: Vec<i32> = (0..n).map(|i| ((i as f64 * 0.0712).sin() * 4_000_000.0 + ((i * 7919) % 1001) as f64 - 500.0) as i32).collect();
        let r: Vec<i32> = (0..n).map(|i| ((i as f64 * 0.0313).sin() * 8_000_000.0) as i32).collect();
        let dir = std::env::temp_dir().join(format!("pulse-flac-{}", std::process::id())); std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.flac");
        { let mut f = std::fs::File::create(&p).unwrap(); let mut e = Encoder::new(&mut f, 88200, 2, 24).unwrap();
          let mut at = 0; while at < n { let k = 4096.min(n - at); e.frame(&[&l[at..at + k], &r[at..at + k]]).unwrap(); at += k; } e.finish().unwrap(); }
        let raw = dir.join("t.raw");
        let st = std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-i"]).arg(&p).args(["-f", "s32le", "-acodec", "pcm_s32le"]).arg(&raw).status().unwrap();
        assert!(st.success(), "ffmpeg не прочитал FLAC");
        let b = std::fs::read(&raw).unwrap();
        let got: Vec<i32> = b.chunks_exact(4).map(|c| i32::from_le_bytes(c.try_into().unwrap()) >> 8).collect();
        assert_eq!(got.len(), n * 2);
        for i in 0..n { assert_eq!((got[i * 2], got[i * 2 + 1]), (l[i], r[i]), "отсчёт {i}"); }
        let fl = std::fs::metadata(&p).unwrap().len(); eprintln!("FLAC: {} байт вместо {} (WAV)", fl, n * 6);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
