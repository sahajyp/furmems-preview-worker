// FurMems Co. preview service (Cloudflare Worker)
// GET  /products -> product options for the site (labels, variant ids, defaults)
// POST /mockup   { product: "mug", variant: 72183, image: "<base64>", backImage?: "<base64>" }
//   -> { mockups: ["data:image/jpeg;base64,...", ...] }
// Holds the Printify token server-side, creates a temporary product to get Printify's
// real mockups, copies the mockup images, then deletes the product and archives the upload.

import { PRODUCTS } from "./products.js";

const API = "https://api.printify.com/v1";
const MAX_IMAGE_BASE64 = 12 * 1024 * 1024; // ~9 MB image
const MAX_MOCKUPS = 4;

export default {
  async fetch(request, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (request.method === "GET" && url.pathname === "/products") return json(publicProducts());
    if (!allowed.includes(origin)) return json({ error: "This preview service only works on furmems.com." }, 403);
    if (request.method !== "POST" || url.pathname !== "/mockup") return json({ error: "Not found" }, 404);

    if (env.LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return json({ error: "You're making previews quickly. Wait a minute and try again." }, 429);
    }

    try {
      return json(await makeMockup(request, env, ctx));
    } catch (err) {
      console.log("mockup error:", err && err.stack ? err.stack : err);
      return json({ error: (err && err.publicMessage) || "We couldn't make that preview. Please try again." }, (err && err.status) || 502);
    }
  },
};

function publicProducts() {
  const out = {};
  for (const [key, p] of Object.entries(PRODUCTS)) {
    out[key] = {
      label: p.label, optionName: p.optionName, default: p.default, back: !!p.back,
      options: p.options.filter((o) => o.id && o.width).map((o) => ({ id: o.id, name: o.name, width: o.width, height: o.height })),
    };
  }
  return out;
}

function cleanBase64(v) {
  const s = typeof v === "string" ? v.replace(/^data:image\/\w+;base64,/, "") : "";
  return s && s.length <= MAX_IMAGE_BASE64 && /^[A-Za-z0-9+/=]+$/.test(s) ? s : "";
}

// Scale so the image fills the whole print area (like CSS object-fit: cover)
function coverScale(img, area) {
  return Math.max(1, (img.width / img.height) / (area.width / area.height));
}

function fail(message, status = 400) {
  const e = new Error(message);
  e.publicMessage = message;
  e.status = status;
  return e;
}

async function printify(env, path, init = {}) {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.PRINTIFY_TOKEN}`,
      "Content-Type": "application/json;charset=utf-8",
      "User-Agent": "FurMems-Preview/1.0",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  if (!res.ok) {
    console.log(`Printify ${init.method || "GET"} ${path} -> ${res.status}: ${String(text).slice(0, 800)}`);
    if (res.status === 429) throw fail("Our print partner is busy right now. Please try again in a minute.", 503);
    throw fail("Our print partner couldn't make that preview. Please try a different photo.", 502);
  }
  return data;
}

async function makeMockup(request, env, ctx) {
  if (!env.PRINTIFY_TOKEN || !env.PRINTIFY_SHOP_ID) throw fail("The preview service isn't configured yet.", 500);

  let body;
  try { body = await request.json(); } catch { throw fail("Bad request."); }
  const product = PRODUCTS[body && body.product];
  if (!product) throw fail("Unknown product.");
  const ready = product.options.filter((o) => o.id && o.width);
  if (!ready.length) throw fail(`${product.label} previews aren't set up yet.`, 503);
  const variant = ready.find((o) => o.id === Number(body.variant)) || ready.find((o) => o.id === product.default) || ready[0];
  const image = cleanBase64(body.image);
  if (!image) throw fail("Please upload a JPG or PNG under 9 MB.");
  const backImage = product.back && body.backImage ? cleanBase64(body.backImage) : "";

  const shop = env.PRINTIFY_SHOP_ID;
  const uploads = [];
  let productId = null;

  try {
    // 1. Upload the artwork to Printify's media library
    const uploadImage = async (contents, name) => {
      const up = await printify(env, "/uploads/images.json", {
        method: "POST",
        body: JSON.stringify({ file_name: `furmems-${name}-${Date.now()}.jpg`, contents }),
      });
      uploads.push(up.id);
      return up;
    };
    const front = await uploadImage(image, "front");
    const back = backImage ? await uploadImage(backImage, "back") : null;

    // 2. Place the images on the print areas
    const placeholders = [
      { position: "front", images: [{ id: front.id, x: 0.5, y: 0.5, scale: coverScale(front, variant), angle: 0 }] },
    ];
    if (back) placeholders.push({ position: "back", images: [{ id: back.id, x: 0.5, y: 0.5, scale: coverScale(back, variant), angle: 0 }] });

    // 3. Create a temporary product; Printify returns its mockup image URLs
    const created = await printify(env, `/shops/${shop}/products.json`, {
      method: "POST",
      body: JSON.stringify({
        title: "FurMems website preview (auto-deleted)",
        description: "Temporary product created for a website preview. Deleted automatically.",
        blueprint_id: product.blueprint_id,
        print_provider_id: product.print_provider_id,
        variants: [{ id: variant.id, price: 100, is_enabled: true }],
        print_areas: [{ variant_ids: [variant.id], placeholders }],
      }),
    });
    productId = created.id;

    // 4. Copy the mockups before the product is deleted (their URLs stop working afterwards)
    const imgs = (created.images || [])
      .filter((i) => !i.variant_ids || i.variant_ids.includes(variant.id))
      .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0))
      .slice(0, MAX_MOCKUPS);
    if (!imgs.length) throw fail("Our print partner didn't return a preview for this product.", 502);

    const mockups = (await Promise.all(imgs.map((i) => fetchAsDataUrl(i.src)))).filter(Boolean);
    if (!mockups.length) throw fail("The preview took too long to render. Please try again.", 504);
    return { product: body.product, variant: variant.id, mockups };
  } finally {
    // 5. Clean up in the background so the shop and media library stay tidy
    ctx.waitUntil(cleanup(env, shop, productId, uploads));
  }
}

async function fetchAsDataUrl(src) {
  // Printify renders mockups on first request, so retry briefly
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(src, { headers: { "User-Agent": "FurMems-Preview/1.0" } });
      const type = res.headers.get("Content-Type") || "";
      if (res.ok && type.startsWith("image/")) {
        const buf = new Uint8Array(await res.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        return `data:${type.split(";")[0]};base64,${btoa(bin)}`;
      }
    } catch (e) {
      console.log("mockup fetch failed:", src, e);
    }
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  return null;
}

async function cleanup(env, shop, productId, uploadIds) {
  try {
    if (productId) await printify(env, `/shops/${shop}/products/${productId}.json`, { method: "DELETE" });
  } catch (e) { console.log("cleanup: delete product failed", productId); }
  for (const id of uploadIds) {
    try { await printify(env, `/uploads/${id}/archive.json`, { method: "POST" }); }
    catch (e) { console.log("cleanup: archive upload failed", id); }
  }
}
