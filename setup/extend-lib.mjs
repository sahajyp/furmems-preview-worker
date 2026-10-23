// AI background extension (Node side, used by make-samples.mjs and make-print.mjs).
// Places the whole portrait on a product's shape exactly where the website puts it, then asks OpenAI
// to repaint only the empty margins by continuing the painting's own background (styles.js EXTEND_PROMPT).
// The original portrait is always pasted back on top afterwards, so the pet itself never changes.

import { PRODUCTS, optionLayout, extensionGroup, extensionSize } from "../src/products.js";
import { EXTEND_PROMPT } from "../src/styles.js";
import { decodePng, encodePng, composeOnArea, extensionMask } from "./image.mjs";

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
 * Returns { group, image (decoded RGB at the extension size), bytes (PNG), usage }.
 */
export async function extendForOption(art, productKey, option, { openaiKey, model = "gpt-image-2.5-sunburst",
  quality = "medium", longSide = 1536, fetchImpl = fetch, log = () => {} } = {}) {
  if (!openaiKey) throw new Error("Set OPENAI_API_KEY first (needed for background extension).");
  const layout = optionLayout(productKey, option);
  const size = extensionSize(option, longSide);
  const group = extensionGroup(productKey, option);
  const input = composeOnArea(art, option.width, option.height, layout, { size });
  const mask = extensionMask(size.width, size.height, input.artBox);
  const imageBytes = encodePng(input), maskBytes = encodePng(mask);

  const call = async (withMask) => {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", EXTEND_PROMPT);
    form.append("image", new Blob([imageBytes], { type: "image/png" }), "art.png");
    if (withMask) form.append("mask", new Blob([maskBytes], { type: "image/png" }), "mask.png");
    form.append("size", `${size.width}x${size.height}`);
    form.append("quality", quality);
    form.append("output_format", "png");
    form.append("n", "1");
    const res = await fetchImpl(OPENAI_EDITS, {
      method: "POST", headers: { Authorization: `Bearer ${openaiKey}` }, body: form, signal: AbortSignal.timeout(300000),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data, msg: String((data.error && data.error.message) || `HTTP ${res.status}`) };
  };

  log(`Extending the background for ${group} (${size.width}x${size.height})...`);
  let r = await call(true);
  if (!r.res.ok && r.res.status === 400 && /mask/i.test(r.msg)) {
    log(`  The mask wasn't accepted (${r.msg.slice(0, 120)}); trying again without it.`);
    r = await call(false);
  }
  const b64 = r.res.ok && r.data.data && r.data.data[0] && r.data.data[0].b64_json;
  if (!b64) throw new Error(`Background extension failed: ${r.msg}`);
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  return { group, image: decodePng(bytes), bytes, usage: r.data.usage };
}
