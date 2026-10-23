// Minimal baseline JPEG encoder (RGB in, 4:4:4, standard Huffman tables), plain Node, no packages.
// Used to save website-ready sample images from PNG artwork.

const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28, 2, 4, 7, 13, 16, 26, 29, 42, 3, 8, 12, 17, 25, 30, 41, 43, 9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
];
const LUM_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CHR_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];

// Standard Huffman tables (JPEG Annex K)
const DC_LUM = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHR = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUM = { bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d], vals: [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa] };
const AC_CHR = { bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77], vals: [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
  0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
  0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa] };

function buildCodes({ bits, vals }) {
  const codes = {}; let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) codes[vals[k++]] = [code++, len];
    code <<= 1;
  }
  return codes;
}
function scaledQuant(base, quality) {
  const q = Math.min(100, Math.max(1, quality));
  const sf = q < 50 ? 5000 / q : 200 - q * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * sf + 50) / 100))));
}

// AAN forward DCT factors
const AAN = [1, 1.387039845, 1.306562965, 1.175875602, 1, 0.785694958, 0.541196100, 0.275899379];
function divisors(q) { // q in natural order
  const d = new Float64Array(64);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) d[r * 8 + c] = 1 / (q[r * 8 + c] * AAN[r] * AAN[c] * 8);
  return d;
}
function fdct(data) {
  for (let i = 0; i < 64; i += 8) rowcol(data, i, 1);
  for (let i = 0; i < 8; i++) rowcol(data, i, 8);
}
function rowcol(d, o, s) {
  const t0 = d[o] + d[o + 7 * s], t7 = d[o] - d[o + 7 * s], t1 = d[o + s] + d[o + 6 * s], t6 = d[o + s] - d[o + 6 * s];
  const t2 = d[o + 2 * s] + d[o + 5 * s], t5 = d[o + 2 * s] - d[o + 5 * s], t3 = d[o + 3 * s] + d[o + 4 * s], t4 = d[o + 3 * s] - d[o + 4 * s];
  let t10 = t0 + t3; const t13 = t0 - t3; let t11 = t1 + t2; const t12 = t1 - t2;
  d[o] = t10 + t11; d[o + 4 * s] = t10 - t11;
  const z1 = (t12 + t13) * 0.707106781;
  d[o + 2 * s] = t13 + z1; d[o + 6 * s] = t13 - z1;
  t10 = t4 + t5; t11 = t5 + t6; const t12b = t6 + t7;
  const z5 = (t10 - t12b) * 0.382683433, z2 = 0.541196100 * t10 + z5, z4 = 1.306562965 * t12b + z5, z3 = t11 * 0.707106781;
  const z11 = t7 + z3, z13 = t7 - z3;
  d[o + 5 * s] = z13 + z2; d[o + 3 * s] = z13 - z2; d[o + s] = z11 + z4; d[o + 7 * s] = z11 - z4;
}

class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  write(code, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1); this.n++;
      if (this.n === 8) { this.bytes.push(this.acc); if (this.acc === 0xff) this.bytes.push(0); this.acc = 0; this.n = 0; }
    }
  }
  flush() { if (this.n) this.write((1 << (8 - this.n)) - 1, 8 - this.n); }
}

function category(v) { let a = Math.abs(v), n = 0; while (a) { n++; a >>= 1; } return n; }
function bitsOf(v, n) { return v < 0 ? v + (1 << n) - 1 : v; }

export function encodeJpeg({ width, height, data }, quality = 88) {
  const lq = scaledQuant(LUM_Q, quality), cq = scaledQuant(CHR_Q, quality);
  const ld = divisors(lq), cd = divisors(cq);
  const dcL = buildCodes(DC_LUM), acL = buildCodes(AC_LUM), dcC = buildCodes(DC_CHR), acC = buildCodes(AC_CHR);
  const bw = new BitWriter();
  const prev = [0, 0, 0];
  const blk = [new Float64Array(64), new Float64Array(64), new Float64Array(64)];
  const tables = [[ld, dcL, acL], [cd, dcC, acC], [cd, dcC, acC]];
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        const px = Math.min(bx + x, width - 1), py = Math.min(by + y, height - 1), o = (py * width + px) * 3;
        const r = data[o], g = data[o + 1], b = data[o + 2], i = y * 8 + x;
        blk[0][i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
        blk[1][i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
        blk[2][i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
      }
      for (let c = 0; c < 3; c++) {
        const [div, dc, ac] = tables[c], d = blk[c];
        fdct(d);
        const q = new Int32Array(64);
        for (let i = 0; i < 64; i++) q[ZIGZAG[i]] = Math.round(d[i] * div[i]);
        const diff = q[0] - prev[c]; prev[c] = q[0];
        const dn = category(diff); bw.write(dc[dn][0], dc[dn][1]); if (dn) bw.write(bitsOf(diff, dn), dn);
        let run = 0;
        for (let i = 1; i < 64; i++) {
          const v = q[i];
          if (v === 0) { run++; continue; }
          while (run > 15) { bw.write(ac[0xf0][0], ac[0xf0][1]); run -= 16; }
          const n = category(v), sym = (run << 4) | n;
          bw.write(ac[sym][0], ac[sym][1]); bw.write(bitsOf(v, n), n); run = 0;
        }
        if (run) bw.write(ac[0x00][0], ac[0x00][1]);
      }
    }
  }
  bw.flush();
  const out = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const dqt = (id, q) => { out.push(0xff, 0xdb, 0, 67, id); for (let i = 0; i < 64; i++) out.push(q[ZIGZAGINV[i]]); };
  dqt(0, lq); dqt(1, cq);
  out.push(0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1);
  const dht = (cls, id, t) => { out.push(0xff, 0xc4, 0, 3 + 16 + t.vals.length, (cls << 4) | id, ...t.bits, ...t.vals); };
  dht(0, 0, DC_LUM); dht(1, 0, AC_LUM); dht(0, 1, DC_CHR); dht(1, 1, AC_CHR);
  out.push(0xff, 0xda, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0);
  return Buffer.concat([Buffer.from(out), Buffer.from(bw.bytes), Buffer.from([0xff, 0xd9])]);
}

// natural index for each zigzag position (DQT tables are written in zigzag order)
const ZIGZAGINV = new Array(64);
for (let i = 0; i < 64; i++) ZIGZAGINV[ZIGZAG[i]] = i;
