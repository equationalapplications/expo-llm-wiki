// SHA-256 (FIPS 180-4) and a UTF-8 encoder, written out so core-okf keeps zero runtime
// dependencies and runs where neither `TextEncoder` nor a synchronous `crypto` is
// guaranteed (Hermes, browsers). Internal: used by deriveEventId and
// createEventIdDeriver, not exported from the package.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

const IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** One 64-byte block at `off` of `view` into state `H` (in place). */
function compress(H: Uint32Array, W: Uint32Array, view: DataView, off: number): void {
  for (let t = 0; t < 16; t++) W[t] = view.getUint32(off + t * 4);
  for (let t = 16; t < 64; t++) {
    const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
    const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
    W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let t = 0; t < 64; t++) {
    const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
    const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
  H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
}

/**
 * SHA-256 of `prefix` followed by a suffix given later, many times: the
 * prefix's whole blocks are hashed once here, and each call of the returned
 * function hashes only the rest (`remainder of prefix + suffix`). Same digest
 * as `sha256(concat(prefix, suffix))`.
 */
export function sha256WithPrefix(prefix: Uint8Array): (suffix: Uint8Array) => Uint8Array {
  const whole = prefix.length - (prefix.length % 64);
  const H = new Uint32Array(IV);
  const W = new Uint32Array(64);
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  for (let off = 0; off < whole; off += 64) compress(H, W, view, off);
  const rest = prefix.subarray(whole);
  return (suffix) => {
    const tailLen = rest.length + suffix.length;
    const bitLen = (prefix.length + suffix.length) * 8;
    const padded = new Uint8Array((((tailLen + 9 + 63) >> 6) << 6));
    padded.set(rest);
    padded.set(suffix, rest.length);
    padded[tailLen] = 0x80;
    const pv = new DataView(padded.buffer);
    // 64-bit big-endian length; messages here are far below 2^32 bytes.
    pv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
    pv.setUint32(padded.length - 4, bitLen >>> 0);
    const state = new Uint32Array(H);
    for (let off = 0; off < padded.length; off += 64) compress(state, W, pv, off);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, state[i]);
    return out;
  };
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return sha256WithPrefix(bytes)(new Uint8Array(0));
}

/** UTF-8 bytes of `s`; a lone UTF-16 surrogate encodes as U+FFFD, as TextEncoder does. */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}
