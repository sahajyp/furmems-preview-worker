// FurMems Co. print-file pipeline (used by make-print.mjs).
// 1. Paint the portrait with the SAME prompt as the website (styles.js buildPrompt):
//      engine "flux"   -> FLUX.2 Pro on fal.ai
//      engine "openai" -> the same OpenAI model as the website previews
// 2. Place the whole portrait on the product's print area with the SAME layout as the website
//    mockups (products.js), over a soft blurred copy of itself. Nothing is cropped.
// 3. Upscale that composition (Topaz or Recraft on fal.ai) toward the size Printify needs.
// Only plain fetch and Node built-ins are used, so there is nothing to install.

import { PRODUCTS } from "../src/products.js";
import { STYLES, buildPrompt } from "../src/styles.js";
import { decodePng, encodePng, composeOnArea } from "./image.mjs";

export const FAL_RUN = "https://fal.run/";
const FLUX_SIZE = { width: 1344, height: 2016 };       // 2:3 portrait, like the website previews
const OPENAI_SIZES = ["1440x2160", "1024x1536"];        // largest first; falls back if not accepted
const TOPAZ_MAX_FACTOR = 4;

export function findVariant(productKey, variantId) {
  const product = PRODUCTS[productKey];
  if (!product) throw new Error(`Unknown product "${productKey}". Use one of: ${Object.keys(PRODUCTS).join(", ")}`);
  const ready = product.options.filter((o) => o.id && o.width);
  const variant = variantId ? ready.find((o) => o.id === Number(variantId)) : ready.find((o) => o.id === product.default) || ready[0];
  if (!variant) throw new Error(`Unknown variant ${variantId} for ${productKey}. Options: ${ready.map((o) => `${o.id} (${o.name})`).join(", ")}`);
  const layout = { scale: 1, dy: 0, ...(product.layout || {}), ...(variant.layout || {}) };
  return { product, variant, layout };
}

// Width and height from PNG or JPEG bytes
export function imageSize(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), type: "png" };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8], type: "jpeg" };
      }
      i += 2 + len;
    }
  }
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return { width: 0, height: 0, type: "webp" };
  return { width: 0, height: 0, type: "unknown" };
}

export function dataUri(buf) {
  const t = imageSize(buf).type;
  const mime = t === "png" ? "image/png" : t === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
}

async function falRun(model, input, { falKey, fetchImpl = fetch, timeoutMs = 300000 }) {
  if (!falKey) throw new Error("Set FAL_KEY first.");
  const res = await fetchImpl(FAL_RUN + model, {
    method: "POST",
    headers: { Authorization: `Key ${falKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const detail = data.detail ? (typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail)) : text;
    throw new Error(`${model} failed (${res.status}): ${String(detail).slice(0, 500)}`);
  }
  return data;
}

async function download(url, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function paintWithFlux(photo, styleId, { falKey, seed, fetchImpl, log }) {
  log(`Painting ${STYLES[styleId].name} with FLUX.2 Pro (${FLUX_SIZE.width}x${FLUX_SIZE.height})...`);
  const input = { prompt: buildPrompt(styleId), image_urls: [dataUri(photo)], image_size: FLUX_SIZE, output_format: "png", safety_tolerance: "2" };
  if (seed !== undefined) input.seed = Number(seed);
  const out = await falRun("fal-ai/flux-2-pro/edit", input, { falKey, fetchImpl });
  const img = out.images && out.images[0];
  if (!img || !img.url) throw new Error("FLUX.2 Pro returned no image.");
  return { bytes: await download(img.url, fetchImpl), seed: out.seed, step: "flux-2-pro" };
}

async function paintWithOpenAI(photo, styleId, { openaiKey, model, quality, fetchImpl, log }) {
  if (!openaiKey) throw new Error("Set OPENAI_API_KEY first (needed for --engine openai).");
  let lastErr;
  for (const size of OPENAI_SIZES) {
    log(`Painting ${STYLES[styleId].name} with ${model} (${quality}, ${size})...`);
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", buildPrompt(styleId));
    form.append("image", new Blob([photo], { type: imageSize(photo).type === "png" ? "image/png" : "image/jpeg" }), "pet.jpg");
    form.append("size", size);
    form.append("quality", quality);
    form.append("output_format", "png");
    form.append("n", "1");
    const res = await fetchImpl("https://api.openai.com/v1/images/edits", {
      method: "POST", headers: { Authorization: `Bearer ${openaiKey}` }, body: form, signal: AbortSignal.timeout(300000),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.data && data.data[0] && data.data[0].b64_json) {
      return { bytes: new Uint8Array(Buffer.from(data.data[0].b64_json, "base64")), step: "openai", usage: data.usage };
    }
    const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
    lastErr = new Error(`OpenAI failed: ${msg}`);
    if (!/size/i.test(msg)) break; // only retry when the size wasn't accepted
  }
  throw lastErr;
}

/**
 * Make a print file. Give either `photo` (customer's photo, painted now) or `art` (an approved
 * portrait, e.g. the preview the customer saw on the website).
 */
export async function makePrint({ photo, art, style, productKey, variantId, engine = "flux", upscaler = "topaz",
  topazModel = "CGI", falKey, openaiKey, openaiModel = "gpt-image-2.5-sunburst", openaiQuality = "high",
  seed, fetchImpl = fetch, log = () => {} }) {
  const { product, variant, layout } = findVariant(productKey, variantId);
  const target = { width: variant.width, height: variant.height };
  const steps = [];

  // 1. The portrait (PNG)
  let artBytes;
  if (art) {
    artBytes = art;
    if (imageSize(art).type !== "png") {
      log("Converting the approved artwork to PNG (Topaz 1x)...");
      const out = await falRun("fal-ai/topaz/upscale/image", { image_url: dataUri(art), model: topazModel, upscale_factor: 1, output_format: "png", face_enhancement: false }, { falKey, fetchImpl });
      if (!out.image || !out.image.url) throw new Error("Topaz returned no image.");
      artBytes = await download(out.image.url, fetchImpl);
      steps.push({ step: "topaz", ...imageSize(artBytes) });
    }
    log(`Using the approved artwork (${imageSize(artBytes).width}x${imageSize(artBytes).height}).`);
  } else {
    if (!STYLES[style]) throw new Error(`Unknown style "${style}". Use one of: ${Object.keys(STYLES).join(", ")}`);
    if (!photo) throw new Error("Give the customer's photo or an approved artwork file.");
    const painted = engine === "openai"
      ? await paintWithOpenAI(photo, style, { openaiKey, model: openaiModel, quality: openaiQuality, fetchImpl, log })
      : await paintWithFlux(photo, style, { falKey, seed, fetchImpl, log });
    artBytes = painted.bytes;
    const inSize = imageSize(photo);
    steps.push({ step: painted.step, ...imageSize(artBytes), seed: painted.seed, usage: painted.usage, inputWidth: inSize.width, inputHeight: inSize.height });
  }

  // 2. Place the whole portrait on the print area, same layout as the website mockups
  log(`Placing it on the ${product.label.toLowerCase()} (${variant.name}) print area...`);
  const composed = composeOnArea(decodePng(artBytes), target.width, target.height, layout);
  const layoutBytes = encodePng(composed);

  // 3. Upscale toward Printify's full resolution
  const need = Math.min(target.width / composed.width, target.height / composed.height);
  let finalBytes = layoutBytes, finalUrl = null, used = "none";
  if (need > 1.05 && upscaler !== "none") {
    if (upscaler === "recraft") {
      log("Upscaling with Recraft Crisp...");
      const out = await falRun("fal-ai/recraft/upscale/crisp", { image_url: dataUri(layoutBytes) }, { falKey, fetchImpl });
      if (!out.image || !out.image.url) throw new Error("Recraft returned no image.");
      finalUrl = out.image.url;
    } else {
      const factor = Math.min(TOPAZ_MAX_FACTOR, Math.ceil(need * 10) / 10);
      log(`Upscaling ${factor}x with Topaz (${topazModel})...`);
      const out = await falRun("fal-ai/topaz/upscale/image", {
        image_url: dataUri(layoutBytes), model: topazModel, upscale_factor: factor, output_format: "jpeg", face_enhancement: false,
      }, { falKey, fetchImpl });
      if (!out.image || !out.image.url) throw new Error("Topaz returned no image.");
      finalUrl = out.image.url;
    }
    finalBytes = await download(finalUrl, fetchImpl);
    used = upscaler === "recraft" ? "recraft" : "topaz";
    steps.push({ step: used, ...imageSize(finalBytes) });
  }

  const finalSize = imageSize(finalBytes);
  const coverage = Math.min(finalSize.width / target.width, finalSize.height / target.height);
  return {
    product: product.label, variant: variant.name, variantId: variant.id, target, layout, engine: art ? "approved art" : engine,
    art: { bytes: artBytes, ...imageSize(artBytes) },
    layoutFile: { bytes: layoutBytes, width: composed.width, height: composed.height, type: "png" },
    final: { bytes: finalBytes, url: finalUrl, ...finalSize },
    upscaler: used, coverage, steps,
  };
}
