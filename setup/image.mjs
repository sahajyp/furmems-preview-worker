// Minimal image tools for the print pipeline, in plain Node (no packages needed):
// read/write 8-bit PNGs, and place artwork on a print area exactly like the website does
// (whole artwork fitted by the product's layout, over a soft blurred copy of itself).

import zlib from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------- PNG decode (8-bit gray, RGB, palette, gray+alpha, RGBA; not interlaced) -> RGB ----------
export function decodePng(input) {
  const buf = Buffer.from(input);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("Not a PNG file.");
  let pos = 8, width, height, depth, type, interlace, palette, trns;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === "PLTE") palette = data;
    else if (kind === "tRNS") trns = data;
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} isn't supported (needs 8-bit).`);
  if (interlace) throw new Error("Interlaced PNGs aren't supported.");
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!ch) throw new Error(`PNG color type ${type} isn't supported.`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch, out = Buffer.alloc(width * height * 3);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3, i = x * ch;
      let r, g, bl, al = 255;
      if (type === 0) { r = g = bl = cur[i]; }
      else if (type === 4) { r = g = bl = cur[i]; al = cur[i + 1]; }
      else if (type === 2) { r = cur[i]; g = cur[i + 1]; bl = cur[i + 2]; }
      else if (type === 6) { r = cur[i]; g = cur[i + 1]; bl = cur[i + 2]; al = cur[i + 3]; }
      else { const p = cur[i] * 3; r = palette[p]; g = palette[p + 1]; bl = palette[p + 2]; if (trns && cur[i] < trns.length) al = trns[cur[i]]; }
      if (al < 255) { const k = al / 255; r = r * k + 255 * (1 - k); g = g * k + 255 * (1 - k); bl = bl * k + 255 * (1 - k); }
      out[o] = r; out[o + 1] = g; out[o + 2] = bl;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

// ---------- PNG encode (RGB, per-row filter choice for smaller files) ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(kind, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
export function encodePng({ width, height, data }) {
  const stride = width * 3, raw = Buffer.alloc((stride + 1) * height);
  const tmp = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const up = y ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const t = tmp[f]; let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0, b = up ? up[i] : 0, c = up && i >= 3 ? up[i - 3] : 0;
        let p;
        if (f === 0) p = 0; else if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
        else { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const v = (row[i] - p) & 255; t[i] = v; sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    raw[y * (stride + 1)] = best;
    tmp[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- sampling ----------
function bilinear(img, fx, fy, out, o) {
  const w = img.width, h = img.height, d = img.data;
  fx = Math.min(Math.max(fx, 0), w - 1); fy = Math.min(Math.max(fy, 0), h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0, ty = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = d[(y0 * w + x0) * 3 + c], b = d[(y0 * w + x1) * 3 + c], cc = d[(y1 * w + x0) * 3 + c], dd = d[(y1 * w + x1) * 3 + c];
    out[o + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + dd * tx) * ty;
  }
}
// Box-average down to a tiny image (the "blur" source), like the website's 16px-wide canvas
function tiny(img, tw) {
  const th = Math.max(1, Math.round((tw * img.height) / img.width));
  const out = { width: tw, height: th, data: new Float64Array(tw * th * 3) };
  const sx = img.width / tw, sy = img.height / th;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    const xa = Math.floor(x * sx), xb = Math.max(xa + 1, Math.floor((x + 1) * sx)), ya = Math.floor(y * sy), yb = Math.max(ya + 1, Math.floor((y + 1) * sy));
    for (let yy = ya; yy < yb; yy += 2) for (let xx = xa; xx < xb; xx += 2) { const o = (yy * img.width + xx) * 3; r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++; }
    const o = (y * tw + x) * 3; out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n;
  }
  return out;
}

/**
 * Place the whole artwork on a print area of areaW x areaH using layout {scale, dy}.
 * The result keeps the art at (at most) its own resolution, so it may be smaller than the
 * print area; upscale it afterwards. Returns { width, height, data, artBox }.
 */
export function composeOnArea(art, areaW, areaH, layout = {}) {
  const scale = layout.scale || 1, dy = layout.dy || 0;
  const fit = Math.min((areaW * scale) / art.width, (areaH * scale) / art.height); // art -> area units
  const k = Math.min(1, 1 / fit);                                                   // keep art at <= 1:1
  const W = Math.max(1, Math.round(areaW * k)), H = Math.max(1, Math.round(areaH * k));
  const dw = art.width * fit * k, dh = art.height * fit * k;
  const ax = (W - dw) / 2, ay = (H - dh) / 2 + dy * H;
  const out = Buffer.alloc(W * H * 3), px = new Float64Array(3);
  const t = tiny(art, 16), cs = Math.max(W / t.width, H / t.height);
  const ox = (W - t.width * cs) / 2, oy = (H - t.height * cs) / 2;
  const s = 1 / (fit * k); // output px -> art px
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      if (x >= ax && x < ax + dw && y >= ay && y < ay + dh) {
        bilinear(art, (x - ax + 0.5) * s - 0.5, (y - ay + 0.5) * s - 0.5, px, 0);
        out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2];
      } else {
        bilinear(t, (x - ox + 0.5) / cs - 0.5, (y - oy + 0.5) / cs - 0.5, px, 0);
        // same soft cream wash as the website (25%)
        out[o] = px[0] * 0.75 + 255 * 0.25; out[o + 1] = px[1] * 0.75 + 249 * 0.25; out[o + 2] = px[2] * 0.75 + 244 * 0.25;
      }
    }
  }
  return { width: W, height: H, data: out, artBox: { x: ax, y: ay, w: dw, h: dh } };
}
