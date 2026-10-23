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
export function encodePng({ width, height, data, channels = 3 }) {
  const ch = channels, stride = width * ch, raw = Buffer.alloc((stride + 1) * height);
  const tmp = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const up = y ? data.subarray((y - 1) * stride, y * stride) : null;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const t = tmp[f]; let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? row[i - ch] : 0, b = up ? up[i] : 0, c = up && i >= ch ? up[i - ch] : 0;
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
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2;
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

// Where the portrait sits inside an area of W x H (same rule as the website)
export function artRect(artW, artH, W, H, layout = {}) {
  const scale = layout.scale || 1, dy = layout.dy || 0;
  const f = Math.min((W * scale) / artW, (H * scale) / artH);
  const w = artW * f, h = artH * f;
  return { x: (W - w) / 2, y: (H - h) / 2 + dy * H, w, h };
}

/**
 * Place the whole artwork on a print area of areaW x areaH using layout {scale, dy}.
 * Options:
 *   size:     {width, height} exact output size (default: keep the art at <= 1:1, so the result may be
 *             smaller than the print area; upscale it afterwards)
 *   backdrop: an image (same shape as the area) to fill around the art, e.g. an AI-extended background.
 *             Without it, a soft blurred copy of the art is used.
 *   feather:  soften the art's edges into the backdrop (share of the art's shorter side, e.g. 0.02)
 * Returns { width, height, data, artBox }.
 */
export function composeOnArea(art, areaW, areaH, layout = {}, opts = {}) {
  let W, H;
  if (opts.size) { W = opts.size.width; H = opts.size.height; }
  else {
    const fit = Math.min((areaW * (layout.scale || 1)) / art.width, (areaH * (layout.scale || 1)) / art.height);
    const k = Math.min(1, 1 / fit);
    W = Math.max(1, Math.round(areaW * k)); H = Math.max(1, Math.round(areaH * k));
  }
  const box = artRect(art.width, art.height, W, H, layout);
  const out = Buffer.alloc(W * H * 3), px = new Float64Array(3), bg = new Float64Array(3);
  const back = opts.backdrop;
  const t = back ? null : tiny(art, 16);
  const cs = t ? Math.max(W / t.width, H / t.height) : 0;
  const ox = t ? (W - t.width * cs) / 2 : 0, oy = t ? (H - t.height * cs) / 2 : 0;
  const bsx = back ? back.width / W : 0, bsy = back ? back.height / H : 0;
  const s = art.width / box.w; // output px -> art px
  const fe = opts.feather ? Math.max(1, opts.feather * Math.min(box.w, box.h)) : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      let alpha = 0;
      if (inside) {
        alpha = 1;
        if (fe) alpha = Math.min(1, (Math.min(x - box.x, box.x + box.w - x, y - box.y, box.y + box.h - y) + 0.5) / fe);
      }
      if (alpha < 1) {
        if (back) bilinear(back, (x + 0.5) * bsx - 0.5, (y + 0.5) * bsy - 0.5, bg, 0);
        else {
          bilinear(t, (x - ox + 0.5) / cs - 0.5, (y - oy + 0.5) / cs - 0.5, bg, 0);
          // same soft cream wash as the website (25%)
          bg[0] = bg[0] * 0.75 + 255 * 0.25; bg[1] = bg[1] * 0.75 + 249 * 0.25; bg[2] = bg[2] * 0.75 + 244 * 0.25;
        }
      }
      if (alpha > 0) bilinear(art, (x - box.x + 0.5) * s - 0.5, (y - box.y + 0.5) * s - 0.5, px, 0);
      out[o] = px[0] * alpha + bg[0] * (1 - alpha);
      out[o + 1] = px[1] * alpha + bg[1] * (1 - alpha);
      out[o + 2] = px[2] * alpha + bg[2] * (1 - alpha);
    }
  }
  return { width: W, height: H, data: out, artBox: box };
}

// Mask for the AI background extension: transparent = repaint (around the art), opaque = keep.
// The opaque area is inset a little so the AI can blend the seam.
export function extensionMask(W, H, box, inset = 0.015) {
  const d = Buffer.alloc(W * H * 4), m = inset * Math.min(box.w, box.h);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 4;
    const keep = x >= box.x + m && x < box.x + box.w - m && y >= box.y + m && y < box.y + box.h - m;
    d[o] = d[o + 1] = d[o + 2] = 0; d[o + 3] = keep ? 255 : 0;
  }
  return { width: W, height: H, data: d, channels: 4 };
}

// Resize an RGB image to w x h (box-averages when shrinking, bilinear when growing)
export function resize(img, w, h) {
  let src = img;
  // shrink in halves first so the result stays smooth
  while (src.width >= w * 2 && src.height >= h * 2) {
    const hw = Math.floor(src.width / 2), hh = Math.floor(src.height / 2), d = Buffer.alloc(hw * hh * 3);
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) for (let c = 0; c < 3; c++) {
      const a = ((2 * y) * src.width + 2 * x) * 3 + c, b = a + src.width * 3;
      d[(y * hw + x) * 3 + c] = (src.data[a] + src.data[a + 3] + src.data[b] + src.data[b + 3] + 2) >> 2;
    }
    src = { width: hw, height: hh, data: d };
  }
  const out = Buffer.alloc(w * h * 3), px = new Float64Array(3), sx = src.width / w, sy = src.height / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    bilinear(src, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, px, 0);
    const o = (y * w + x) * 3; out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2];
  }
  return { width: w, height: h, data: out };
}
