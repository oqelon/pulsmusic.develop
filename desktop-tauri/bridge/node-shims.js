// Маленькая замена того, что yandex.js брал из Node.js, — чтобы тот же самый файл работал в окне Tauri без изменений:
//  • crypto: createHash('md5') (подпись ссылки на MP3) и createHmac('sha256', ключ) (подпись get-file-info и текста);
//    обе — синхронные, как в Node, на чистом JavaScript (в браузерном WebCrypto нет MD5 и нет синхронных вызовов);
//  • fetch: запросы идут через tauri-plugin-http (из программы, без ограничений CORS; адреса — только разрешённые).
// Здесь нет ни ключей, ни токенов: соль и ключ подписи — те же открытые константы, что и в yandex.js.
/* eslint-disable no-bitwise */
var PulseShims = (function () {
  'use strict';
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
  function hex(b) { var s = ''; for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16); return s; }
  function b64(b) { var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }

  // ——— SHA-256 (FIPS 180-4)
  var K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(msg) {
    var l = msg.length, n = ((l + 9 + 63) >> 6) << 6, p = new Uint8Array(n);
    p.set(msg); p[l] = 0x80;
    var bits = l * 8; for (var i = 0; i < 8; i++) p[n - 1 - i] = (i < 4 ? (bits >>> (8 * i)) : Math.floor(bits / 4294967296) >>> (8 * (i - 4))) & 255;
    var H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), W = new Uint32Array(64);
    var r = function (x, k) { return (x >>> k) | (x << (32 - k)); };
    for (var o = 0; o < n; o += 64) {
      for (var t = 0; t < 16; t++) W[t] = (p[o + 4 * t] << 24) | (p[o + 4 * t + 1] << 16) | (p[o + 4 * t + 2] << 8) | p[o + 4 * t + 3];
      for (t = 16; t < 64; t++) { var s0 = r(W[t - 15], 7) ^ r(W[t - 15], 18) ^ (W[t - 15] >>> 3), s1 = r(W[t - 2], 17) ^ r(W[t - 2], 19) ^ (W[t - 2] >>> 10); W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0; }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = r(e, 6) ^ r(e, 11) ^ r(e, 25), ch = (e & f) ^ (~e & g), t1 = (h + S1 + ch + K[t] + W[t]) | 0;
        var S0 = r(a, 2) ^ r(a, 13) ^ r(a, 22), mj = (a & b) ^ (a & c) ^ (b & c), t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    var out = new Uint8Array(32); for (i = 0; i < 8; i++) { out[4 * i] = H[i] >>> 24; out[4 * i + 1] = H[i] >>> 16; out[4 * i + 2] = H[i] >>> 8; out[4 * i + 3] = H[i]; }
    return out;
  }
  function hmac256(key, msg) {
    if (key.length > 64) key = sha256(key);
    var k = new Uint8Array(64); k.set(key);
    var ip = new Uint8Array(64), op = new Uint8Array(64); for (var i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
    return sha256(concat(op, sha256(concat(ip, msg))));
  }

  // ——— MD5 (RFC 1321)
  var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  var T = new Uint32Array(64); for (var q = 0; q < 64; q++) T[q] = Math.floor(Math.abs(Math.sin(q + 1)) * 4294967296);
  function md5(msg) {
    var l = msg.length, n = ((l + 9 + 63) >> 6) << 6, p = new Uint8Array(n);
    p.set(msg); p[l] = 0x80;
    var bits = l * 8; for (var i = 0; i < 8; i++) p[n - 8 + i] = (i < 4 ? (bits >>> (8 * i)) : Math.floor(bits / 4294967296) >>> (8 * (i - 4))) & 255;
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476, M = new Uint32Array(16);
    for (var o = 0; o < n; o += 64) {
      for (var j = 0; j < 16; j++) M[j] = p[o + 4 * j] | (p[o + 4 * j + 1] << 8) | (p[o + 4 * j + 2] << 16) | (p[o + 4 * j + 3] << 24);
      var A = a0, B = b0, C = c0, D = d0;
      for (i = 0; i < 64; i++) {
        var F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + T[i] + M[g]) | 0; A = D; D = C; C = B; B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    var out = new Uint8Array(16), w = [a0, b0, c0, d0];
    for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) out[4 * i + j] = (w[i] >>> (8 * j)) & 255;
    return out;
  }

  function digester(fn) {
    var parts = new Uint8Array(0);
    var h = { update: function (s) { parts = concat(parts, typeof s === 'string' ? utf8(s) : new Uint8Array(s)); return h; },
      digest: function (enc) { var d = fn(parts); return enc === 'hex' ? hex(d) : enc === 'base64' ? b64(d) : d; } };
    return h;
  }
  var crypto = {
    createHash: function (alg) { if (String(alg).toLowerCase() !== 'md5') throw new Error('нет ' + alg); return digester(md5); },
    createHmac: function (alg, key) { if (String(alg).toLowerCase() !== 'sha256') throw new Error('нет ' + alg); var k = typeof key === 'string' ? utf8(key) : new Uint8Array(key); return digester(function (m) { return hmac256(k, m); }); },
  };
  return { crypto: crypto, _sha256: sha256, _md5: md5 };
})();
if (typeof module !== 'undefined') module.exports = PulseShims;
