// AI background extension (Node side, used by make-samples.mjs and make-print.mjs).
// Places the whole portrait on a product's shape exactly where the website puts it, then asks OpenAI to turn
// it into one seamless painting that reaches every edge (styles.js EXTEND_PROMPT). The AI's whole image is
// used (nothing pasted on top, so no visible rectangle); align.mjs measures where the pet ended up so it can
// be lined up with the product layout, and rejects bad results (black edges, a moved or changed pet),
// which are retried.

import { PRODUCTS, optionLayout, extensionGroup, extensionSize } from "../src/products.js";
import { EXTEND_PROMPT } from "../src/styles.js";
import { decodePng, encodePng, composeOnArea, extensionMask } from "./image.mjs";
import { checkExtension } from "./align.mjs";

const OPENAI_EDITS = "https://api.openai.com/v1/images/edits";

// One entry per product shape ("group"); options that share a shape and layout share an extension
export function extensionGroups(productKeys = Object.keys(PRODUCTS)) {
  const groups = new Map();
  for (const key of productKeys) {
    const p = PRODUCTS[key];
    for (const o of p.options.filter((x) => x.id && x.width)) {
      const g = extensionGroup(key, o);
      if (!groups.has(g)) groups.set(g, { group: g, productKey: key, option: o, layout: optionLayout(key, o), size: extensionSize(o) });
    }
  }
  return [...groups.values()];
}

/**
 * Extend the background of `art` (decoded RGB image) to the shape of one product option.
 * Tries up to `attempts` times until the result passes the checks.
 * Returns { group, image (decoded RGB at the extension size), bytes (PNG), box (measured art position in image),
 *           ok, reason, score, tries, usage }.
 */
export async function extendForOption(art, productKey, option, { openaiKey, model = "gpt-image-2.5-sunburst",
  quality = "medium", longSide = 1536, attempts = 3, fetchImpl = fetch, log = () => {} } = {}) {
  if (!openaiKey) throw new Error("Set OPENAI_API_KEY first (needed for background extension).");
  const layout = optionLayout(productKey, option);
  const size = extensionSize(option, longSide);
  const group = extensionGroup(productKey, option);
  const input = composeOnArea(art, option.width, option.height, layout, { size, edge: true });
  const mask = extensionMask(size.width, size.height, input.artBox);
  const imageBytes = encodePng(input), maskBytes = encodePng(mask);
  let withMask = true, opaque = true;

  const call = async () => {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", EXTEND_PROMPT);
    form.append("image", new Blob([imageBytes], { type: "image/png" }), "art.png");
    if (withMask) form.append("mask", new Blob([maskBytes], { type: "image/png" }), "mask.png");
    form.append("size", `${size.width}x${size.height}`);
    form.append("quality", quality);
    form.append("output_format", "png");
    if (opaque) form.append("background", "opaque");
    form.append("n", "1");
    const res = await fetchImpl(OPENAI_EDITS, {
      method: "POST", headers: { Authorization: `Bearer ${openaiKey}` }, body: form, signal: AbortSignal.timeout(300000),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data, msg: String((data.error && data.error.message) || `HTTP ${res.status}`) };
  };
  const once = async () => {
    let r;
    for (let i = 0; i < 4; i++) {
      try { r = await call(); } catch (e) { // dropped connection: wait and try again
        if (i === 3) throw e;
        log(`  Connection problem (${e.cause && e.cause.code || e.message}); trying again...`);
        await new Promise((ok) => setTimeout(ok, 3000 * (i + 1)));
        continue;
      }
      if (!r.res.ok && r.res.status === 400 && opaque && /background/i.test(r.msg)) { opaque = false; continue; }
      if (!r.res.ok && r.res.status === 400 && withMask && /mask/i.test(r.msg)) {
        log(`  The mask wasn't accepted (${r.msg.slice(0, 120)}); trying again without it.`);
        withMask = false; continue;
      }
      if (!r.res.ok && (r.res.status === 429 || r.res.status >= 500) && i < 3) { await new Promise((ok) => setTimeout(ok, 5000 * (i + 1))); continue; }
      break;
    }
    const b64 = r.res.ok && r.data.data && r.data.data[0] && r.data.data[0].b64_json;
    if (!b64) throw new Error(`Background extension failed: ${r.msg}`);
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    return { bytes, image: decodePng(bytes), usage: r.data.usage };
  };

  log(`Extending the background for ${group} (${size.width}x${size.height})...`);
  let best = null;
  for (let t = 1; t <= attempts; t++) {
    const out = await once();
    const check = checkExtension(out.image, art, input.artBox);
    const result = { group, ...out, box: check.box, ok: check.ok, reason: check.reason, score: check.box.score, tries: t };
    if (!best || (result.ok && !best.ok) || (result.ok === best.ok && result.score < best.score)) best = result;
    if (check.ok) break;
    log(`  Try ${t}: ${check.reason}${t < attempts ? "; trying again." : "."}`);
  }
  return best;
}
