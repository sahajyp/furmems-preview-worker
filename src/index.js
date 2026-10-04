// FurMems Co. preview service (Cloudflare Worker)
// POST /mockup  { image: "<base64 JPEG/PNG, no data: prefix>", product: "mug" }
//   -> { mockups: ["data:image/jpeg;base64,...", ...] }
// Holds the Printify token server-side, creates a temporary product to get Printify's
// real mockups, copies the mockup images, then deletes the product and archives the upload.

import { PRODUCTS } from "./products.js";

const API = "https://api.printify.com/v1";
const MAX_IMAGE_BASE64 = 12 * 1024 * 1024; // ~9 MB image
const MAX_MOCKUPS = 3;

export default {
  async fetch(request, env, ctx) {
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
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
  if (!product.blueprint_id || !product.variant_id || !product.width) throw fail(`${product.label} previews aren't set up yet.`, 503);
  const image = typeof body.image === "string" ? body.image.replace(/^data:image\/\w+;base64,/, "") : "";
  if (!image || image.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(image)) throw fail("Please upload a JPG or PNG under 9 MB.");

  const shop = env.PRINTIFY_SHOP_ID;
  let uploadId = null;
  let productId = null;

  try {
    // 1. Upload the photo to Printify's media library
    const upload = await printify(env, "/uploads/images.json", {
      method: "POST",
      body: JSON.stringify({ file_name: `furmems-preview-${Date.now()}.jpg`, contents: image }),
    });
    uploadId = upload.id;

    // 2. Scale so the photo fills the whole print area (like CSS object-fit: cover)
    const imgAspect = upload.width / upload.height;
    const areaAspect = product.width / product.height;
    const scale = Math.max(1, imgAspect / areaAspect);

    // 3. Create a temporary product; Printify returns its mockup image URLs
    const created = await printify(env, `/shops/${shop}/products.json`, {
      method: "POST",
      body: JSON.stringify({
        title: "FurMems website preview (auto-deleted)",
        description: "Temporary product created for a website preview. Deleted automatically.",
        blueprint_id: product.blueprint_id,
        print_provider_id: product.print_provider_id,
        variants: [{ id: product.variant_id, price: 100, is_enabled: true }],
        print_areas: [
          {
            variant_ids: [product.variant_id],
            placeholders: [
              { position: product.position, images: [{ id: uploadId, x: 0.5, y: 0.5, scale, angle: 0 }] },
            ],
          },
        ],
      }),
    });
    productId = created.id;

    // 4. Copy the mockups before the product is deleted (their URLs stop working afterwards)
    const imgs = (created.images || [])
      .filter((i) => !i.variant_ids || i.variant_ids.includes(product.variant_id))
      .sort((a, b) => (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0))
      .slice(0, MAX_MOCKUPS);
    if (!imgs.length) throw fail("Our print partner didn't return a preview for this product.", 502);

    const mockups = (await Promise.all(imgs.map((i) => fetchAsDataUrl(i.src)))).filter(Boolean);
    if (!mockups.length) throw fail("The preview took too long to render. Please try again.", 504);
    return { product: body.product, mockups };
  } finally {
    // 5. Clean up in the background so the shop and media library stay tidy
    ctx.waitUntil(cleanup(env, shop, productId, uploadId));
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

async function cleanup(env, shop, productId, uploadId) {
  try {
    if (productId) await printify(env, `/shops/${shop}/products/${productId}.json`, { method: "DELETE" });
  } catch (e) { console.log("cleanup: delete product failed", productId); }
  try {
    if (uploadId) await printify(env, `/uploads/${uploadId}/archive.json`, { method: "POST" });
  } catch (e) { console.log("cleanup: archive upload failed", uploadId); }
}
