// AI portraits: turns a customer's pet photo into artwork in one of the FurMems styles,
// with a per-visitor limit and a shop-wide daily cap so costs stay predictable.
//
// GET  /quota                         -> { limit, remaining, resetsIn, windowMinutes, shopLimitReached }
// POST /generate { style, image }     -> { style, image: "data:image/jpeg;base64,...", quota }
// POST /extend { image, mask }        -> { image: "data:image/jpeg;base64,..." }
//   Extends a portrait's own background to the edges of a product shape (see EXTEND_PROMPT).
//   It has its own, separate limits and never uses up the visitor's portraits; when it is off or
//   over its limit the website quietly falls back to a soft blurred background.
//
// Limits live in Workers KV (binding QUOTA). Visitors are identified by a salted hash of their
// IP address; raw IPs are never stored.

import { STYLES, buildPrompt, EXTEND_PROMPT } from "./styles.js";
import { PRODUCTS, extensionSize } from "./products.js";

const OPENAI_EDITS = "https://api.openai.com/v1/images/edits";
const MAX_PHOTO_BASE64 = 8 * 1024 * 1024; // ~6 MB photo; the site sends ~1024px JPEGs

function fail(message, status = 400, extra) {
  const e = new Error(message);
  e.publicMessage = message;
  e.status = status;
  e.extra = extra;
  return e;
}

function settings(env) {
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    limit: num(env.GEN_LIMIT, 4),                 // portraits per visitor per window
    windowMinutes: num(env.GEN_WINDOW_MINUTES, 60),
    dailyCap: num(env.GEN_DAILY_CAP, 100),        // portraits per day for the whole shop
    model: env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
    quality: env.OPENAI_IMAGE_QUALITY || "medium",
    size: env.OPENAI_IMAGE_SIZE || "1024x1536",
    // Background extensions (POST /extend)
    extendEnabled: String(env.EXTEND_ENABLED || "true").toLowerCase() !== "false",
    extLimit: num(env.EXT_LIMIT, 24),             // extensions per visitor per window (about 4 per portrait)
    extDailyCap: num(env.EXT_DAILY_CAP, 400),     // extensions per day for the whole shop
    extQuality: env.OPENAI_EXTEND_QUALITY || "medium",
  };
}

async function visitorId(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const data = new TextEncoder().encode(`${ip}|${env.QUOTA_SALT || "furmems-co"}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(hash.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readQuota(request, env, kind = "gen") {
  if (!env.QUOTA) throw fail("AI portraits aren't set up yet.", 503);
  const s = settings(env);
  const ext = kind === "ext";
  const limit = ext ? s.extLimit : s.limit;
  const cap = ext ? s.extDailyCap : s.dailyCap;
  const now = Date.now();
  const windowMs = s.windowMinutes * 60 * 1000;
  const bucket = Math.floor(now / windowMs);
  const visitorKey = `${ext ? "ev" : "v"}:${await visitorId(request, env)}:${bucket}`;
  const dayKey = `${ext ? "ed" : "d"}:${new Date(now).toISOString().slice(0, 10)}`;
  const [v, d] = await Promise.all([env.QUOTA.get(visitorKey), env.QUOTA.get(dayKey)]);
  const used = Number(v) || 0;
  const dayUsed = Number(d) || 0;
  const shopLimitReached = dayUsed >= cap;
  return {
    s, visitorKey, dayKey, used, dayUsed,
    windowTtl: Math.max(60, Math.ceil((windowMs * 2) / 1000)),
    public: {
      limit,
      remaining: shopLimitReached ? 0 : Math.max(0, limit - used),
      resetsIn: Math.ceil(((bucket + 1) * windowMs - now) / 1000),
      windowMinutes: s.windowMinutes,
      shopLimitReached,
    },
  };
}

async function writeCounts(env, q, visitorCount, dayCount) {
  await Promise.all([
    env.QUOTA.put(q.visitorKey, String(Math.max(0, visitorCount)), { expirationTtl: q.windowTtl }),
    env.QUOTA.put(q.dayKey, String(Math.max(0, dayCount)), { expirationTtl: 2 * 24 * 3600 }),
  ]);
}

export async function quotaStatus(request, env) {
  return (await readQuota(request, env)).public;
}

function base64ToBytes(s) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function generatePortrait(request, env) {
  if (!env.OPENAI_API_KEY) throw fail("AI portraits aren't set up yet.", 503);

  let body;
  try { body = await request.json(); } catch { throw fail("Bad request."); }
  const style = STYLES[body && body.style];
  if (!style) throw fail("Unknown style.");
  const photo = typeof body.image === "string" ? body.image.replace(/^data:image\/\w+;base64,/, "") : "";
  if (!photo || photo.length > MAX_PHOTO_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(photo)) {
    throw fail("Please upload a JPG or PNG photo of your pet.");
  }

  // 1. Check and reserve this visitor's quota and the shop's daily budget
  const q = await readQuota(request, env);
  if (q.public.shopLimitReached) {
    throw fail("We've reached today's limit for AI previews. Please try again tomorrow, or order on Etsy and we'll send you a proof.", 429, { quota: q.public });
  }
  if (q.public.remaining <= 0) {
    const mins = Math.ceil(q.public.resetsIn / 60);
    throw fail(`You've used your ${q.s.limit} AI portraits for now. You can make more in ${mins} minute${mins === 1 ? "" : "s"}.`, 429, { quota: q.public });
  }
  await writeCounts(env, q, q.used + 1, q.dayUsed + 1);
  const quotaAfter = { ...q.public, remaining: q.public.remaining - 1 };

  // 2. Ask the image model to repaint the photo in the chosen style
  try {
    const form = new FormData();
    form.append("model", q.s.model);
    form.append("prompt", buildPrompt(body.style));
    form.append("image", new Blob([base64ToBytes(photo)], { type: "image/jpeg" }), "pet.jpg");
    form.append("size", q.s.size);
    form.append("quality", q.s.quality);
    form.append("output_format", "jpeg");
    form.append("output_compression", "88");
    form.append("n", "1");

    const res = await fetch(OPENAI_EDITS, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(150000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }

    if (!res.ok) {
      const err = (data && data.error) || {};
      console.log(`OpenAI ${res.status} ${err.code || ""}: ${String(err.message || text).slice(0, 600)}`);
      if (err.code === "moderation_blocked" || /safety|moderation/i.test(err.message || "")) {
        throw fail("Our AI artist couldn't paint this photo. Try a clear, close-up photo of just your pet.", 422);
      }
      if (res.status === 429) throw fail("Our AI artist is busy right now. Please try again in a minute.", 503);
      throw fail("We couldn't paint your portrait just now. Please try again.", 502);
    }

    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) throw fail("We couldn't paint your portrait just now. Please try again.", 502);
    if (data.usage) console.log("image usage", JSON.stringify(data.usage));
    return { style: body.style, image: `data:image/jpeg;base64,${b64}`, quota: quotaAfter };
  } catch (e) {
    // Give the visitor their portrait back if it didn't work
    try { await writeCounts(env, q, q.used, q.dayUsed); } catch (_) {}
    if (e && e.name === "TimeoutError") throw fail("Painting took too long. Please try again.", 504);
    throw e && e.publicMessage ? e : fail("We couldn't paint your portrait just now. Please try again.", 502);
  }
}

// Width and height of a PNG, read from its header
function pngSize(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

// Every size the website may ask for (one per product shape)
function allowedExtendSizes() {
  const set = new Set();
  for (const p of Object.values(PRODUCTS)) for (const o of p.options) {
    if (o.id && o.width) { const e = extensionSize(o); set.add(`${e.width}x${e.height}`); }
  }
  return set;
}

export async function extendBackground(request, env) {
  const s = settings(env);
  if (!env.OPENAI_API_KEY || !s.extendEnabled) throw fail("Background extension is off.", 503);

  let body;
  try { body = await request.json(); } catch { throw fail("Bad request."); }
  const clean = (v) => (typeof v === "string" ? v.replace(/^data:image\/\w+;base64,/, "") : "");
  const image = clean(body && body.image);
  const mask = clean(body && body.mask);
  const ok = (v) => v && v.length <= MAX_PHOTO_BASE64 && /^[A-Za-z0-9+/=]+$/.test(v);
  if (!ok(image) || !ok(mask)) throw fail("Bad image.");
  const imageBytes = base64ToBytes(image);
  const maskBytes = base64ToBytes(mask);
  const size = pngSize(imageBytes);
  const msize = pngSize(maskBytes);
  if (!size || !msize || size.width !== msize.width || size.height !== msize.height) throw fail("Bad image.");
  if (!allowedExtendSizes().has(`${size.width}x${size.height}`)) throw fail("Unsupported size.");

  // Separate, quiet limits: extensions never use up a visitor's portraits
  const q = await readQuota(request, env, "ext");
  if (q.public.shopLimitReached || q.public.remaining <= 0) throw fail("Background extension limit reached.", 429);
  await writeCounts(env, q, q.used + 1, q.dayUsed + 1);

  const call = async (withMask) => {
    const form = new FormData();
    form.append("model", s.model);
    form.append("prompt", EXTEND_PROMPT);
    form.append("image", new Blob([imageBytes], { type: "image/png" }), "art.png");
    if (withMask) form.append("mask", new Blob([maskBytes], { type: "image/png" }), "mask.png");
    form.append("size", `${size.width}x${size.height}`);
    form.append("quality", s.extQuality);
    form.append("output_format", "jpeg");
    form.append("output_compression", "90");
    form.append("n", "1");
    const res = await fetch(OPENAI_EDITS, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(150000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }
    return { res, data, text };
  };

  try {
    let r = await call(true);
    const msg = (x) => String((x.data && x.data.error && x.data.error.message) || x.text || "");
    // If the model doesn't accept the mask, the prompt alone still describes the job
    if (!r.res.ok && r.res.status === 400 && /mask/i.test(msg(r))) {
      console.log("extend: mask rejected, retrying without it:", msg(r).slice(0, 300));
      r = await call(false);
    }
    if (!r.res.ok) {
      console.log(`OpenAI extend ${r.res.status}: ${msg(r).slice(0, 600)}`);
      throw fail("Couldn't extend the background.", r.res.status === 429 ? 503 : 502);
    }
    const b64 = r.data && r.data.data && r.data.data[0] && r.data.data[0].b64_json;
    if (!b64) throw fail("Couldn't extend the background.", 502);
    if (r.data.usage) console.log("extend usage", JSON.stringify(r.data.usage));
    return { width: size.width, height: size.height, image: `data:image/jpeg;base64,${b64}` };
  } catch (e) {
    try { await writeCounts(env, q, q.used, q.dayUsed); } catch (_) {}
    if (e && e.name === "TimeoutError") throw fail("Background extension took too long.", 504);
    throw e && e.publicMessage ? e : fail("Couldn't extend the background.", 502);
  }
}
