// FurMems Co. print-file pipeline (used by make-print.mjs).
// 1. FLUX.2 Pro (fal.ai) paints the customer's photo in the chosen style, shaped like the product's print area
// 2. Topaz or Recraft (fal.ai) upscales it toward the size Printify needs for that product
// Only plain fetch is used, so there is nothing to install.

import { PRODUCTS } from "../src/products.js";
import { STYLES } from "../src/styles.js";

export const FAL_RUN = "https://fal.run/";
const MAX_SIDE = 2048;          // FLUX.2 Pro output: long side
const MAX_AREA = 4_000_000;     // ~4 MP
const MIN_AREA = 1_048_576;     // ~1 MP
const TOPAZ_MAX_FACTOR = 4;

export function findVariant(productKey, variantId) {
  const product = PRODUCTS[productKey];
  if (!product) throw new Error(`Unknown product "${productKey}". Use one of: ${Object.keys(PRODUCTS).join(", ")}`);
  const ready = product.options.filter((o) => o.id && o.width);
  const variant = variantId ? ready.find((o) => o.id === Number(variantId)) : ready.find((o) => o.id === product.default) || ready[0];
  if (!variant) {
    throw new Error(`Unknown variant ${variantId} for ${productKey}. Options: ${ready.map((o) => `${o.id} (${o.name})`).join(", ")}`);
  }
  return { product, variant };
}

// Largest size with the print area's shape that FLUX.2 Pro can make, in multiples of 16
export function generationSize(targetW, targetH) {
  const aspect = targetW / targetH;
  let w, h;
  if (aspect >= 1) { w = MAX_SIDE; h = w / aspect; } else { h = MAX_SIDE; w = h * aspect; }
  const area = w * h;
  if (area > MAX_AREA) { const k = Math.sqrt(MAX_AREA / area); w *= k; h *= k; }
  // Small print areas (ornaments): paint at about their own size (at least ~1 MP) instead of the maximum
  if (targetW * targetH < w * h) {
    const k = Math.sqrt(Math.max(targetW * targetH, MIN_AREA) / (w * h));
    if (k < 1) { w *= k; h *= k; }
  }
  const r16 = (v) => Math.max(512, Math.ceil(v / 16) * 16);
  return { width: r16(w), height: r16(h) };
}

export function compositionHint(w, h, productKey) {
  const aspect = w / h;
  if (productKey === "ornament") {
    return "Square composition with the pet centered and filling most of the frame. Keep the ears and face well inside the edges, because the edges will be cropped into a circle or heart shape.";
  }
  if (aspect > 1.6) {
    return "Wide horizontal composition: the pet centered, with the painted background continuing smoothly to the far left and right edges. Keep the pet and important details away from the outer edges.";
  }
  if (aspect > 1.1) {
    return "Landscape composition with the pet centered and soft painted background around it. Keep important details away from the edges.";
  }
  if (aspect < 0.9) {
    return "Vertical portrait composition with the pet centered and a little breathing room around it. Keep important details away from the edges, which wrap around the canvas sides.";
  }
  return "Square composition with the pet centered and a little breathing room around it.";
}

// Width and height from PNG or JPEG bytes (no image library needed)
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
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
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

/**
 * Make a print file.
 * Either `photo` (customer's photo bytes, painted by FLUX.2 Pro) or `art` (already-approved artwork bytes,
 * e.g. the preview the customer saw) must be given.
 */
export async function makePrint({ photo, art, style, productKey, variantId, upscaler = "topaz", topazModel = "CGI",
  falKey, seed, fetchImpl = fetch, log = () => {} }) {
  if (!falKey) throw new Error("Set FAL_KEY first.");
  const { product, variant } = findVariant(productKey, variantId);
  const target = { width: variant.width, height: variant.height };
  const steps = [];
  let artUrl, artBytes, artSize;

  if (art) {
    artBytes = art;
    artSize = imageSize(art);
    artUrl = dataUri(art);
    log(`Using the approved artwork (${artSize.width}x${artSize.height}).`);
  } else {
    const st = STYLES[style];
    if (!st) throw new Error(`Unknown style "${style}". Use one of: ${Object.keys(STYLES).join(", ")}`);
    if (!photo) throw new Error("Give the customer's photo or an approved artwork file.");
    const size = generationSize(target.width, target.height);
    log(`Painting ${st.name} with FLUX.2 Pro at ${size.width}x${size.height}...`);
    const input = {
      prompt: `${st.prompt} ${compositionHint(size.width, size.height, productKey)}`,
      image_urls: [dataUri(photo)],
      image_size: size,
      output_format: "png",
      safety_tolerance: "2",
    };
    if (seed !== undefined) input.seed = Number(seed);
    const out = await falRun("fal-ai/flux-2-pro/edit", input, { falKey, fetchImpl });
    const img = out.images && out.images[0];
    if (!img || !img.url) throw new Error("FLUX.2 Pro returned no image.");
    artUrl = img.url;
    artBytes = await download(artUrl, fetchImpl);
    artSize = imageSize(artBytes);
    const inSize = imageSize(photo);
    steps.push({ step: "flux-2-pro", width: artSize.width, height: artSize.height, seed: out.seed, inputWidth: inSize.width, inputHeight: inSize.height });
  }

  // How much bigger the artwork needs to be to fill the print area at full resolution
  const need = Math.max(target.width / artSize.width, target.height / artSize.height);
  let finalBytes = artBytes, finalSize = artSize, used = "none", finalUrl = art ? null : artUrl;

  if (need > 1.05 && upscaler !== "none") {
    let which = upscaler;
    if (which === "recraft" && artSize.type !== "png") {
      log("Recraft only accepts PNG artwork, so using Topaz instead.");
      which = "topaz";
    }
    if (which === "recraft") {
      log("Upscaling with Recraft Crisp...");
      const out = await falRun("fal-ai/recraft/upscale/crisp", { image_url: artUrl }, { falKey, fetchImpl });
      if (!out.image || !out.image.url) throw new Error("Recraft returned no image.");
      finalBytes = await download(out.image.url, fetchImpl);
      finalUrl = out.image.url;
    } else {
      const factor = Math.min(TOPAZ_MAX_FACTOR, Math.ceil(need * 10) / 10);
      log(`Upscaling ${factor}x with Topaz (${topazModel})...`);
      const out = await falRun("fal-ai/topaz/upscale/image", {
        image_url: artUrl, model: topazModel, upscale_factor: factor, output_format: "jpeg", face_enhancement: false,
      }, { falKey, fetchImpl });
      if (!out.image || !out.image.url) throw new Error("Topaz returned no image.");
      finalBytes = await download(out.image.url, fetchImpl);
      finalUrl = out.image.url;
    }
    finalSize = imageSize(finalBytes);
    used = which;
    steps.push({ step: which, width: finalSize.width, height: finalSize.height });
  }

  const coverage = Math.min(finalSize.width / target.width, finalSize.height / target.height);
  return {
    product: product.label, variant: variant.name, variantId: variant.id, target,
    art: { bytes: artBytes, ...artSize }, final: { bytes: finalBytes, url: finalUrl, ...finalSize },
    upscaler: used, coverage, steps,
  };
}
