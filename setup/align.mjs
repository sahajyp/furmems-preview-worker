// Finds where the pet painting actually ended up inside an AI-extended background, and checks the result.
//
// The AI repaints the whole image when it extends a background, so the painting can come back a little
// shifted or resized. We show the AI's image as one seamless piece (no original pasted on top), and use the
// measured position to line it up so the pet sits exactly where the product layout puts it.
// The website has the same code in index.html (measureArtBox), keep the two in step.

import { resize } from "./image.mjs";

const SCALES = { min: 0.86, max: 1.14 };
const SHIFT = 0.1; // search up to 10% of the art's size in each direction

// Zero-mean absolute difference between the art (resized to bw x bh) and image A at (x0, y0), on the art's
// inner area (its edges are where the AI blends, so they're left out). Lower is better. Lighting changes
// (a brighter or warmer repaint) don't count against it.
function score(A, art, x0, y0, step) {
  const w = art.width, h = art.height, mx = Math.floor(w * 0.12), my = Math.floor(h * 0.1);
  let n = 0;
  const sumA = [0, 0, 0], sumO = [0, 0, 0];
  for (let y = my; y < h - my; y += step) {
    const ay = y0 + y; if (ay < 0 || ay >= A.height) continue;
    for (let x = mx; x < w - mx; x += step) {
      const ax = x0 + x; if (ax < 0 || ax >= A.width) continue;
      const a = (ay * A.width + ax) * 3, o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) { sumA[c] += A.data[a + c]; sumO[c] += art.data[o + c]; }
      n++;
    }
  }
  if (n < 30) return Infinity;
  const off = [0, 1, 2].map((c) => (sumA[c] - sumO[c]) / n);
  let d = 0;
  for (let y = my; y < h - my; y += step) {
    const ay = y0 + y; if (ay < 0 || ay >= A.height) continue;
    for (let x = mx; x < w - mx; x += step) {
      const ax = x0 + x; if (ax < 0 || ax >= A.width) continue;
      const a = (ay * A.width + ax) * 3, o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) d += Math.abs(A.data[a + c] - art.data[o + c] - off[c]);
    }
  }
  return d / (n * 3);
}

function search(A, art, box, f, scales, shiftPx, center, step) {
  let best = { score: Infinity };
  for (const s of scales) {
    const bw = Math.max(8, Math.round(box.w * f * s)), bh = Math.max(8, Math.round(box.h * f * s));
    const small = resize(art, bw, bh);
    const cx = center.x * f, cy = center.y * f;
    const bx = Math.round(cx - bw / 2), by = Math.round(cy - bh / 2);
    for (let dy = -shiftPx; dy <= shiftPx; dy++) for (let dx = -shiftPx; dx <= shiftPx; dx++) {
      const sc = score(A, small, bx + dx, by + dy, step);
      if (sc < best.score) best = { score: sc, s, x: (bx + dx) / f, y: (by + dy) / f, w: bw / f, h: bh / f };
    }
  }
  return best;
}

/**
 * Where is the art inside the AI image? A and art are RGB images; box is where it was placed {x,y,w,h} in A.
 * Returns { x, y, w, h, scale, score } in A's pixels. score is the average colour difference (0-255) after
 * lining up: roughly under 20 = the same painting, over 35 = the AI changed it a lot.
 */
export function measureArtBox(A, art, box) {
  // coarse: A at ~144 px on its long side
  const k1 = 144 / Math.max(A.width, A.height);
  const A1 = resize(A, Math.max(16, Math.round(A.width * k1)), Math.max(16, Math.round(A.height * k1)));
  const fx1 = A1.width / A.width;
  const scales1 = []; for (let s = SCALES.min; s <= SCALES.max + 1e-9; s += 0.02) scales1.push(+s.toFixed(3));
  const c0 = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const shift1 = Math.max(2, Math.round(box.w * fx1 * SHIFT));
  // work from a smaller copy of the art (much faster, same result)
  const pre = (k) => { const w = Math.round(box.w * k * 2.4); return w < art.width ? resize(art, w, Math.round(w * art.height / art.width)) : art; };
  const b1 = search(A1, pre(fx1), box, fx1, scales1, shift1, c0, 2);
  // fine: A at ~512 px, around the coarse answer
  const k2 = 512 / Math.max(A.width, A.height);
  const A2 = k2 < 1 ? resize(A, Math.round(A.width * k2), Math.round(A.height * k2)) : A;
  const fx2 = A2.width / A.width;
  const scales2 = []; for (let d = -0.03; d <= 0.0301; d += 0.005) scales2.push(+(b1.s + d).toFixed(4));
  const c1 = { x: b1.x + b1.w / 2, y: b1.y + b1.h / 2 };
  const b2 = search(A2, pre(fx2), box, fx2, scales2, 5, c1, 2);
  return { x: b2.x, y: b2.y, w: b2.w, h: b2.h, scale: b2.s, score: b2.score };
}

// Share of very dark pixels
function darkShare(img, inside) {
  let dark = 0, n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    if (!inside(x, y)) continue;
    const o = (y * img.width + x) * 3, l = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
    if (l < 24) dark++; n++;
  }
  return n ? dark / n : 0;
}

/**
 * Check an AI-extended background. Returns { ok, reason, box } where box is the measured art position.
 * Rejects: black or empty margins, a painting that moved or changed too much.
 */
export function checkExtension(A, art, box) {
  const m = measureArtBox(A, art, box);
  const pad = 0.03 * Math.min(m.w, m.h);
  const inMargin = (x, y) => x < m.x - pad || x >= m.x + m.w + pad || y < m.y - pad || y >= m.y + m.h + pad;
  const artDark = darkShare(art, () => true), marginDark = darkShare(A, inMargin);
  if (marginDark > 0.08 && marginDark > artDark * 3 + 0.03) return { ok: false, reason: "the extended area came back black or empty", box: m };
  const edge = (v, lo, hi) => v <= lo + 0.004 || v >= hi - 0.004;
  if (edge(m.scale, SCALES.min, SCALES.max) && m.score > 20) return { ok: false, reason: "the painting was resized too much", box: m };
  if (m.score > 35) return { ok: false, reason: `the painting changed too much (difference ${m.score.toFixed(0)})`, box: m };
  return { ok: true, box: m };
}
