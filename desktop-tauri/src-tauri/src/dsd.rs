// DSD (SACD-рипы и Hi-Res): файлы .dsf (Sony DSD Stream File) и .dff (Philips DSDIFF, без сжатия DST).
//
// DSD — однобитный звук с частотой 2,8224 МГц (DSD64) и выше. Колонки и ЦАП в обычном режиме играют PCM, поэтому
// «Пульс» переводит DSD в PCM сам: фильтр нижних частот (окно Кайзера, подавление ≥ 100 дБ, ровно до 24 кГц) и
// прореживание до 88,2 кГц (DSD с частотой из семейства 48 кГц — до 96 кГц). Фильтр считается таблицами по байтам
// (8 однобитных отсчётов за одно обращение) — это быстро и точно. Уровень не меняется: 100 % модуляции DSD = 0 дБFS
// (обычная громкость SACD — около 50 % модуляции, то есть на ~6 дБ тише громких PCM-записей — так задумано форматом,
// искусственно не поднимаем, чтобы не было перегрузки).
//
// Многоканальные DSD (5.1) играются левым и правым каналами (первые два).

use std::f64::consts::PI;
use std::io::{Read, Seek, SeekFrom, Write};

pub trait Src: Read + Seek + Send {}
impl<T: Read + Seek + Send> Src for T {}

#[derive(Debug, Clone)]
pub struct Info { pub kind: &'static str, pub fs: u32, pub channels: usize, pub samples: u64, pub out_rate: u32 }
impl Info {
    pub fn duration(&self) -> f64 { self.samples as f64 / self.fs.max(1) as f64 }
    /// «DSD64», «DSD128»…
    pub fn grade(&self) -> String { let base = if self.fs % 44100 == 0 { 44100 } else { 48000 }; format!("DSD{}", self.fs / base) }
}

pub struct Reader {
    src: Box<dyn Src>,
    pub info: Info,
    data_off: u64,
    block: u64,          // DSF: байт на канал в блоке (4096); DFF: 0 — байты каналов чередуются
    lsb_first: bool,     // DSF: младший бит — первый по времени
    pos: u64,            // байт на канал, который читаем следующим
    bytes_per_ch: u64,
    step: usize,         // новых байт на канал на один выходной отсчёт (прореживание / 8)
    tables: Vec<[f32; 256]>,
    nb: usize,
    hist: Vec<Vec<u8>>,  // по каналу: кольцо байтов удвоенной длины (окно фильтра всегда подряд)
    hp: usize,
    inbuf: Vec<Vec<u8>>, in_at: usize,
}

fn rev8(b: u8) -> u8 { b.reverse_bits() }

fn rd<const N: usize>(s: &mut dyn Src) -> Result<[u8; N], String> { let mut b = [0u8; N]; s.read_exact(&mut b).map_err(|e| format!("чтение заголовка: {e}"))?; Ok(b) }

fn i0(x: f64) -> f64 { let mut s = 1.0; let mut t = 1.0; let y = x * x / 4.0; for k in 1..60 { t *= y / (k * k) as f64; s += t; if t < 1e-14 * s { break; } } s }

/// Коэффициенты фильтра нижних частот для частоты DSD fs и прореживания до out (сумма = 1).
pub fn design(fs: u32, out: u32) -> Vec<f64> {
    let fs = fs as f64; let pass = 24000.0f64.min(out as f64 * 0.27); let stop = out as f64 * 0.5;
    let fc = (pass + stop) / 2.0; let dw = 2.0 * PI * (stop - pass) / fs; let a = 100.0;
    let mut n = ((a - 8.0) / (2.285 * dw)).ceil() as usize + 1;
    n = (n + 7) / 8 * 8;
    let beta = 0.1102 * (a - 8.7);
    let m = (n - 1) as f64 / 2.0;
    let mut h: Vec<f64> = (0..n).map(|i| {
        let x = i as f64 - m; let w = 2.0 * fc / fs;
        let s = if x.abs() < 1e-12 { w } else { (PI * w * x).sin() / (PI * x) };
        let r = x / m; s * i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0(beta)
    }).collect();
    let sum: f64 = h.iter().sum(); h.iter_mut().for_each(|v| *v /= sum);
    h
}

impl Reader {
    pub fn open(mut src: Box<dyn Src>) -> Result<Reader, String> {
        src.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let id = rd::<4>(&mut *src)?;
        let (info, data_off, block, lsb, bytes_per_ch);
        if &id == b"DSD " {
            // DSF: little-endian
            let _sz = u64::from_le_bytes(rd::<8>(&mut *src)?); let _total = rd::<8>(&mut *src)?; let _meta = rd::<8>(&mut *src)?;
            if &rd::<4>(&mut *src)? != b"fmt " { return Err("DSF: нет блока fmt".into()); }
            let fsz = u64::from_le_bytes(rd::<8>(&mut *src)?);
            let mut f = vec![0u8; (fsz.saturating_sub(12)) as usize]; src.read_exact(&mut f).map_err(|e| e.to_string())?;
            if f.len() < 40 { return Err("DSF: короткий блок fmt".into()); }
            let le32 = |o: usize| u32::from_le_bytes(f[o..o + 4].try_into().unwrap());
            if le32(4) != 0 { return Err("DSF: сжатый DSD не поддерживается".into()); }
            let ch = le32(12) as usize; let fs = le32(16); let bits = le32(20);
            let samples = u64::from_le_bytes(f[24..32].try_into().unwrap()); let blk = le32(32) as u64;
            if bits != 1 && bits != 8 { return Err(format!("DSF: {bits} бит на отсчёт — не DSD")); }
            if ch == 0 || ch > 6 || fs < 2_000_000 || blk == 0 { return Err("DSF: неверные параметры".into()); }
            // DSF с bits=1 — младший бит первый; bits=8 — старший
            lsb = bits == 1;
            loop {
                let cid = rd::<4>(&mut *src)?; let csz = u64::from_le_bytes(rd::<8>(&mut *src)?);
                if &cid == b"data" { data_off = src.stream_position().map_err(|e| e.to_string())?; break; }
                src.seek(SeekFrom::Current(csz as i64 - 12)).map_err(|e| e.to_string())?;
            }
            block = blk; bytes_per_ch = (samples + 7) / 8;
            info = Info { kind: "DSF", fs, channels: ch, samples, out_rate: 0 };
        } else if &id == b"FRM8" {
            // DSDIFF: big-endian, вложенные блоки
            let _sz = rd::<8>(&mut *src)?;
            if &rd::<4>(&mut *src)? != b"DSD " { return Err("DFF: не DSD".into()); }
            let (mut fs, mut ch, mut cmpr_ok, mut d) = (0u32, 0usize, true, None);
            loop {
                let mut cid = [0u8; 4]; if src.read_exact(&mut cid).is_err() { break; }
                let csz = u64::from_be_bytes(rd::<8>(&mut *src)?);
                let start = src.stream_position().map_err(|e| e.to_string())?;
                match &cid {
                    b"PROP" => {
                        let _snd = rd::<4>(&mut *src)?;
                        let end = start + csz;
                        while src.stream_position().map_err(|e| e.to_string())? + 12 <= end {
                            let sid = rd::<4>(&mut *src)?; let ssz = u64::from_be_bytes(rd::<8>(&mut *src)?);
                            let sst = src.stream_position().map_err(|e| e.to_string())?;
                            match &sid {
                                b"FS  " => fs = u32::from_be_bytes(rd::<4>(&mut *src)?),
                                b"CHNL" => ch = u16::from_be_bytes(rd::<2>(&mut *src)?) as usize,
                                b"CMPR" => { cmpr_ok = &rd::<4>(&mut *src)? == b"DSD "; }
                                _ => {}
                            }
                            src.seek(SeekFrom::Start(sst + ssz + (ssz & 1))).map_err(|e| e.to_string())?;
                        }
                    }
                    b"DSD " => { d = Some((start, csz)); break; }
                    b"DST " => return Err("DFF со сжатием DST пока не поддерживается".into()),
                    _ => {}
                }
                src.seek(SeekFrom::Start(start + csz + (csz & 1))).map_err(|e| e.to_string())?;
            }
            if !cmpr_ok { return Err("DFF со сжатием DST пока не поддерживается".into()); }
            let (off, len) = d.ok_or("DFF: нет звука (блок DSD)")?;
            if ch == 0 || ch > 6 || fs < 2_000_000 { return Err("DFF: неверные параметры".into()); }
            data_off = off; block = 0; lsb = false; bytes_per_ch = len / ch as u64;
            info = Info { kind: "DFF", fs, channels: ch, samples: bytes_per_ch * 8, out_rate: 0 };
        } else {
            return Err("не DSD (ждали DSF или DFF)".into());
        }
        let base = if info.fs % 44100 == 0 { 44100 * 64 } else { 48000 * 64 };
        let mult = ((info.fs as f64 / base as f64).round() as u32).max(1);
        let decim = 32 * mult;                     // DSD64 → ÷32, DSD128 → ÷64, …
        let out_rate = info.fs / decim;
        let h = design(info.fs, out_rate);
        let nb = h.len() / 8;
        // таблица m: вклад байта, отстоящего на m байтов от самого нового (старший бит — раньше по времени)
        let tables: Vec<[f32; 256]> = (0..nb).map(|m| {
            let mut t = [0f32; 256];
            for v in 0..256usize { let mut s = 0.0; for k in 0..8 { let bit = (v >> (7 - k)) & 1; s += h[8 * m + 7 - k] * if bit == 1 { 1.0 } else { -1.0 }; } t[v] = s as f32; }
            t
        }).collect();
        let nch = info.channels;
        let mut r = Reader { src, info: Info { out_rate, ..info }, data_off, block, lsb_first: lsb, pos: 0, bytes_per_ch, step: (decim / 8) as usize, tables, nb,
            hist: vec![vec![0x69u8; 2 * nb]; nch.min(2)], hp: 0, inbuf: vec![Vec::new(); nch], in_at: 0 };
        r.seek(0.0)?;
        Ok(r)
    }

    pub fn out_rate(&self) -> u32 { self.info.out_rate }

    /// Перемотка (с точностью до байта DSD — 2,8 мкс). Фильтр начинает с «тишины» (0x69 — нулевой уровень DSD).
    pub fn seek(&mut self, t: f64) -> Result<(), String> {
        let b = ((t.max(0.0) * self.info.fs as f64 / 8.0) as u64).min(self.bytes_per_ch);
        self.pos = b; self.in_at = 0; self.inbuf.iter_mut().for_each(|v| v.clear());
        for h in self.hist.iter_mut() { h.iter_mut().for_each(|x| *x = 0x69); }
        self.hp = 0;
        Ok(())
    }

    // прочитать следующие байты каналов в inbuf (по блоку)
    fn fill(&mut self) -> Result<bool, String> {
        if self.pos >= self.bytes_per_ch { return Ok(false); }
        let nch = self.info.channels as u64;
        let take;
        if self.block > 0 {
            let blk = self.pos / self.block; let within = self.pos % self.block;
            take = (self.block - within).min(self.bytes_per_ch - self.pos);
            for c in 0..nch {
                let off = self.data_off + blk * self.block * nch + c * self.block + within;
                self.src.seek(SeekFrom::Start(off)).map_err(|e| e.to_string())?;
                let buf = &mut self.inbuf[c as usize]; buf.clear(); buf.resize(take as usize, 0);
                self.src.read_exact(buf).map_err(|e| format!("чтение DSD: {e}"))?;
            }
        } else {
            take = 8192.min(self.bytes_per_ch - self.pos);
            let mut raw = vec![0u8; (take * nch) as usize];
            self.src.seek(SeekFrom::Start(self.data_off + self.pos * nch)).map_err(|e| e.to_string())?;
            self.src.read_exact(&mut raw).map_err(|e| format!("чтение DSD: {e}"))?;
            for c in 0..nch as usize { let b = &mut self.inbuf[c]; b.clear(); b.extend(raw.iter().skip(c).step_by(nch as usize)); }
        }
        if self.lsb_first { for b in self.inbuf.iter_mut() { b.iter_mut().for_each(|x| *x = rev8(*x)); } }
        self.pos += take; self.in_at = 0;
        Ok(true)
    }

    /// Следующие до max кадров PCM (стерео: левый, правый). None — конец файла.
    pub fn next(&mut self, max: usize) -> Result<Option<(Vec<f32>, Vec<f32>)>, String> {
        let nout = self.hist.len(); let nb = self.nb;
        let mut out: Vec<Vec<f32>> = vec![Vec::with_capacity(max); 2];
        'frames: while out[0].len() < max {
            for _ in 0..self.step {
                if self.in_at >= self.inbuf[0].len() { if !self.fill()? { break 'frames; } }
                let p = self.hp;
                for c in 0..nout { let v = self.inbuf[c][self.in_at]; self.hist[c][p] = v; self.hist[c][p + nb] = v; }
                self.in_at += 1; self.hp = (p + 1) % nb;
            }
            // окно фильтра: hist[hp .. hp+nb] — от старого к новому
            for c in 0..nout {
                let w = &self.hist[c][self.hp..self.hp + nb];
                let mut s = 0f32;
                for m in 0..nb { s += self.tables[m][w[nb - 1 - m] as usize]; }
                out[c].push(s);
            }
        }
        if out[0].is_empty() { return Ok(None); }
        let r = if nout > 1 { out.pop().unwrap() } else { out[0].clone() };
        let l = out.swap_remove(0);
        Ok(Some((l, r)))
    }
}

/// Сохранить DSD как PCM 24 бит: WAV.
pub fn to_wav(r: &mut Reader, w: &mut (impl Write + Seek), progress: &mut dyn FnMut(f64)) -> Result<u64, String> {
    let rate = r.out_rate(); let ch = 2u16; let bps = 24u16;
    let hdr = |frames: u64| -> Vec<u8> {
        let data = frames * ch as u64 * 3; let mut h = Vec::with_capacity(44);
        h.extend_from_slice(b"RIFF"); h.extend_from_slice(&((36 + data).min(u32::MAX as u64) as u32).to_le_bytes()); h.extend_from_slice(b"WAVEfmt ");
        h.extend_from_slice(&16u32.to_le_bytes()); h.extend_from_slice(&1u16.to_le_bytes()); h.extend_from_slice(&ch.to_le_bytes()); h.extend_from_slice(&rate.to_le_bytes());
        h.extend_from_slice(&(rate * ch as u32 * 3).to_le_bytes()); h.extend_from_slice(&(ch * 3).to_le_bytes()); h.extend_from_slice(&bps.to_le_bytes());
        h.extend_from_slice(b"data"); h.extend_from_slice(&(data.min(u32::MAX as u64) as u32).to_le_bytes()); h
    };
    w.write_all(&hdr(0)).map_err(|e| e.to_string())?;
    r.seek(0.0)?;
    let total = (r.info.duration() * rate as f64).max(1.0); let mut frames = 0u64; let mut buf = Vec::with_capacity(4096 * 6);
    while let Some((l, rr)) = r.next(4096)? {
        buf.clear();
        for i in 0..l.len() { for v in [l[i], rr[i]] { let s = (v.clamp(-1.0, 1.0) as f64 * 8388607.0).round() as i32; buf.extend_from_slice(&s.to_le_bytes()[..3]); } }
        w.write_all(&buf).map_err(|e| e.to_string())?; frames += l.len() as u64; progress(frames as f64 / total);
    }
    w.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?; w.write_all(&hdr(frames)).map_err(|e| e.to_string())?;
    Ok(frames)
}

/// Сохранить DSD как PCM 24 бит: FLAC (без потерь, примерно вдвое меньше WAV).
pub fn to_flac(r: &mut Reader, w: &mut (impl Write + Seek), progress: &mut dyn FnMut(f64)) -> Result<u64, String> {
    let rate = r.out_rate();
    let mut enc = crate::flacw::Encoder::new(w, rate, 2, 24)?;
    r.seek(0.0)?;
    let total = (r.info.duration() * rate as f64).max(1.0); let mut frames = 0u64;
    let mut pend: [Vec<i32>; 2] = [Vec::new(), Vec::new()];
    while let Some((l, rr)) = r.next(4096)? {
        for i in 0..l.len() { pend[0].push((l[i].clamp(-1.0, 1.0) as f64 * 8388607.0).round() as i32); pend[1].push((rr[i].clamp(-1.0, 1.0) as f64 * 8388607.0).round() as i32); }
        while pend[0].len() >= 4096 {
            let a: Vec<i32> = pend[0].drain(..4096).collect(); let b: Vec<i32> = pend[1].drain(..4096).collect();
            enc.frame(&[&a, &b])?;
        }
        frames += l.len() as u64; progress(frames as f64 / total);
    }
    if !pend[0].is_empty() { let a = std::mem::take(&mut pend[0]); let b = std::mem::take(&mut pend[1]); enc.frame(&[&a, &b])?; }
    enc.finish()?;
    Ok(frames)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// простой DSD-модулятор 2-го порядка (для проверок): синус f Гц, амплитуда a
    pub fn modulate(fs: u32, secs: f64, f: [f64; 2], a: f64) -> [Vec<u8>; 2] {
        let n = (fs as f64 * secs) as usize / 8 * 8;
        let mut out = [Vec::with_capacity(n / 8), Vec::with_capacity(n / 8)];
        for c in 0..2 {
            let (mut s1, mut s2) = (0f64, 0f64); let mut y = 0f64; let mut byte = 0u8;
            for i in 0..n {
                let x = a * (2.0 * PI * f[c] * i as f64 / fs as f64).sin();
                // 2-й порядок, устойчивый при a ≤ 0,5
                s1 += x - y; s2 += s1 - y;
                y = if s2 >= 0.0 { 1.0 } else { -1.0 };
                byte = (byte << 1) | (y > 0.0) as u8;
                if i % 8 == 7 { out[c].push(byte); byte = 0; }
            }
        }
        out
    }
    pub fn dsf(fs: u32, d: &[Vec<u8>; 2]) -> Vec<u8> {
        let bpc = d[0].len(); let blk = 4096usize; let nblk = (bpc + blk - 1) / blk; let data_len = nblk * blk * 2;
        let mut v = Vec::new();
        v.extend_from_slice(b"DSD "); v.extend_from_slice(&28u64.to_le_bytes()); v.extend_from_slice(&((28 + 52 + 12 + data_len) as u64).to_le_bytes()); v.extend_from_slice(&0u64.to_le_bytes());
        v.extend_from_slice(b"fmt "); v.extend_from_slice(&52u64.to_le_bytes());
        for x in [1u32, 0, 2, 2, fs, 1] { v.extend_from_slice(&x.to_le_bytes()); }
        v.extend_from_slice(&((bpc * 8) as u64).to_le_bytes()); v.extend_from_slice(&(blk as u32).to_le_bytes()); v.extend_from_slice(&0u32.to_le_bytes());
        v.extend_from_slice(b"data"); v.extend_from_slice(&((12 + data_len) as u64).to_le_bytes());
        for b in 0..nblk { for c in 0..2 { for i in 0..blk { let k = b * blk + i; v.push(if k < bpc { d[c][k].reverse_bits() } else { 0x69u8.reverse_bits() }); } } }
        v
    }
    pub fn dff(fs: u32, d: &[Vec<u8>; 2]) -> Vec<u8> {
        let bpc = d[0].len();
        let mut prop = Vec::new(); prop.extend_from_slice(b"SND ");
        prop.extend_from_slice(b"FS  "); prop.extend_from_slice(&4u64.to_be_bytes()); prop.extend_from_slice(&fs.to_be_bytes());
        prop.extend_from_slice(b"CHNL"); prop.extend_from_slice(&10u64.to_be_bytes()); prop.extend_from_slice(&2u16.to_be_bytes()); prop.extend_from_slice(b"SLFTSRGT");
        prop.extend_from_slice(b"CMPR"); prop.extend_from_slice(&20u64.to_be_bytes()); prop.extend_from_slice(b"DSD "); prop.push(14); prop.extend_from_slice(b"not compressed"); prop.push(0);
        let mut body = Vec::new(); body.extend_from_slice(b"DSD ");
        body.extend_from_slice(b"FVER"); body.extend_from_slice(&4u64.to_be_bytes()); body.extend_from_slice(&0x01050000u32.to_be_bytes());
        body.extend_from_slice(b"PROP"); body.extend_from_slice(&(prop.len() as u64).to_be_bytes()); body.extend_from_slice(&prop);
        body.extend_from_slice(b"DSD "); body.extend_from_slice(&((bpc * 2) as u64).to_be_bytes());
        for i in 0..bpc { body.push(d[0][i]); body.push(d[1][i]); }
        let mut v = Vec::new(); v.extend_from_slice(b"FRM8"); v.extend_from_slice(&(body.len() as u64).to_be_bytes()); v.extend_from_slice(&body); v
    }
    // амплитуда и частота синуса (метод наименьших квадратов на известной частоте) и уровень остатка
    pub fn fit(x: &[f32], rate: f64, f: f64) -> (f64, f64) {
        let (mut ss, mut sc, mut cc, mut sx, mut cx) = (0.0, 0.0, 0.0, 0.0, 0.0);
        for (i, &v) in x.iter().enumerate() { let w = 2.0 * PI * f * i as f64 / rate; let (s, c) = (w.sin(), w.cos()); ss += s * s; sc += s * c; cc += c * c; sx += s * v as f64; cx += c * v as f64; }
        let det = ss * cc - sc * sc; let a = (sx * cc - cx * sc) / det; let b = (cx * ss - sx * sc) / det;
        let mut e = 0.0; for (i, &v) in x.iter().enumerate() { let w = 2.0 * PI * f * i as f64 / rate; let r = v as f64 - a * w.sin() - b * w.cos(); e += r * r; }
        let amp = (a * a + b * b).sqrt(); let rms_e = (e / x.len() as f64).sqrt();
        (amp, 20.0 * ((amp / 2f64.sqrt()) / rms_e).log10())
    }

    #[test]
    fn dsf_and_dff_decode_to_clean_pcm() {
        let fs = 2_822_400; let d = modulate(fs, 1.0, [1000.0, 3000.0], 0.5);
        for (name, bytes) in [("dsf", dsf(fs, &d)), ("dff", dff(fs, &d))] {
            let mut r = Reader::open(Box::new(std::io::Cursor::new(bytes))).unwrap();
            assert_eq!(r.out_rate(), 88200, "{name}"); assert_eq!(r.info.grade(), "DSD64");
            assert!((r.info.duration() - 1.0).abs() < 0.01, "{name}: длительность {}", r.info.duration());
            let mut l = Vec::new(); let mut rr = Vec::new(); while let Some((a, b)) = r.next(4096).unwrap() { l.extend(a); rr.extend(b); }
            assert!((l.len() as i64 - 88200).abs() < 100, "{name}: кадров {}", l.len());
            let (al, snr_l) = fit(&l[8820..80000], 88200.0, 1000.0); let (ar, snr_r) = fit(&rr[8820..80000], 88200.0, 3000.0);
            eprintln!("{name}: L 1 кГц амплитуда {al:.4}, сигнал/шум {snr_l:.1} дБ; R 3 кГц {ar:.4}, {snr_r:.1} дБ");
            assert!((al - 0.5).abs() < 0.01 && (ar - 0.5).abs() < 0.01, "{name}: амплитуда {al} {ar}");
            assert!(snr_l > 60.0 && snr_r > 60.0, "{name}: шум {snr_l} {snr_r}");
        }
    }

    #[test]
    fn seek_lands_on_the_right_time() {
        let fs = 2_822_400; let d = modulate(fs, 2.0, [1000.0, 1000.0], 0.5);
        let mut r = Reader::open(Box::new(std::io::Cursor::new(dsf(fs, &d)))).unwrap();
        let mut full = Vec::new(); while let Some((a, _)) = r.next(4096).unwrap() { full.extend(a); }
        r.seek(1.25).unwrap();
        let (a, _) = r.next(4096).unwrap().unwrap();
        // после разгона фильтра (~1100 отсчётов на входе = 12 на выходе) звук совпадает с непрерывным
        let at = (1.25 * 88200.0) as usize;
        let diff = (40..4000).map(|i| (a[i] - full[at + i]).abs()).fold(0f32, f32::max);
        assert!(diff < 1e-3, "после перемотки отличие {diff}");
    }

    #[test]
    fn dsd128_halves_decimation() {
        let fs = 5_644_800; let d = modulate(fs, 0.3, [1000.0, 1000.0], 0.5);
        let mut r = Reader::open(Box::new(std::io::Cursor::new(dsf(fs, &d)))).unwrap();
        assert_eq!(r.out_rate(), 88200); assert_eq!(r.info.grade(), "DSD128");
        let mut l = Vec::new(); while let Some((a, _)) = r.next(4096).unwrap() { l.extend(a); }
        let (al, snr) = fit(&l[4000..24000], 88200.0, 1000.0);
        assert!((al - 0.5).abs() < 0.01 && snr > 60.0, "DSD128: {al} {snr}");
    }

    #[test]
    fn wav_export_roundtrip() {
        let fs = 2_822_400; let d = modulate(fs, 0.5, [1000.0, 2000.0], 0.5);
        let mut r = Reader::open(Box::new(std::io::Cursor::new(dsf(fs, &d)))).unwrap();
        let mut out = std::io::Cursor::new(Vec::new());
        let n = to_wav(&mut r, &mut out, &mut |_| {}).unwrap();
        let v = out.into_inner();
        assert_eq!(&v[0..4], b"RIFF"); assert_eq!(u32::from_le_bytes(v[24..28].try_into().unwrap()), 88200);
        assert_eq!(v.len() as u64, 44 + n * 6);
    }

    #[test]
    fn rejects_garbage() {
        assert!(Reader::open(Box::new(std::io::Cursor::new(b"RIFF0000WAVE".to_vec()))).is_err());
    }
}
