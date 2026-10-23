// Make the print-ready file for a paid FurMems order.
//
// Paints the portrait with the SAME prompt as the website, places the whole pet on the product with the
// SAME layout as the website mockups, extends the painting's own background to every edge of the product
// (the pet itself is never changed), then upscales it (Topaz by default).
//   node setup/make-print.mjs --photo "C:\orders\bella.jpg" --style pastel --product canvas --size 18x24 --name "Order 1234 Bella"
//
// Or upscale artwork the customer already approved (e.g. their website preview):
//   node setup/make-print.mjs --art "C:\orders\bella-preview.jpg" --product mug --size pink --name "Order 1235"
//
// Options:
//   --product   canvas | mug | blanket | ornament
//   --size      the option to print: a variant id (91648) or its name (18x24, pink, heart, 60x80)
//   --style     pastel | watercolor | oil | halloween     (needed with --photo)
//   --engine    openai (default, same model and prompt as the website previews) | flux (FLUX.2 Pro on fal.ai)
//   --upscaler  topaz (default) | recraft | none
//   --topaz-model "CGI" (default, made for digital artwork) | "High Fidelity V2" | "Standard V2"
//   --no-extend skip the AI background extension (fills around the portrait with a soft blur instead)
//   --seed      a number, to repeat a result you liked
//   --out       folder for the files (default: ..\..\prints, outside your Git repos)
//   --upload    also add the final file to your Printify media library (needs PRINTIFY_TOKEN)
//
// Needs:  OPENAI_API_KEY (painting and background extension), FAL_KEY (fal.ai > Dashboard > Keys, used for upscaling), PRINTIFY_TOKEN for --upload
//   PowerShell:  $env:FAL_KEY="..."   Mac/Linux: export FAL_KEY="..."

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { PRODUCTS } from "../src/products.js";
import { makePrint } from "./print-lib.mjs";

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const key = argv[i].slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith("--")) flags[key] = true; else { flags[key] = next; i++; }
}

function usage(msg) {
  if (msg) console.error(msg + "\n");
  console.log('Usage: node setup/make-print.mjs (--photo <file> --style <style> | --art <file>) --product <product> --size <size> [--engine openai|flux] [--name "Order 1234"] [--upscaler topaz|recraft|none] [--upload]');
  process.exit(1);
}

const norm = (s) => String(s).toLowerCase().replace(/[×]/g, "x").replace(/[^a-z0-9x]/g, "");
function resolveVariant(productKey, size) {
  const product = PRODUCTS[productKey];
  if (!product) usage(`Unknown product "${productKey}". Use one of: ${Object.keys(PRODUCTS).join(", ")}`);
  if (!size || size === true) return undefined;
  const opt = product.options.find((o) => String(o.id) === String(size) || norm(o.name) === norm(size));
  if (!opt) usage(`Unknown size "${size}" for ${productKey}. Options: ${product.options.map((o) => `${o.name} (${o.id})`).join(", ")}`);
  return opt.id;
}

const productKey = flags.product;
if (!productKey || productKey === true) usage("Missing --product.");
if (!flags.photo && !flags.art) usage("Give --photo (customer's photo) or --art (approved artwork).");
if (flags.photo && !flags.style) usage("Missing --style (pastel, watercolor, oil or halloween).");
const variantId = resolveVariant(productKey, flags.size);
const engine = flags.engine && flags.engine !== true ? String(flags.engine).toLowerCase() : "openai";
if (!["flux", "openai"].includes(engine)) usage('--engine must be "flux" or "openai".');
const falKey = process.env.FAL_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
if (!falKey) usage("Set FAL_KEY first (see the top of this file). It's used for upscaling.");
if (flags.photo && engine === "openai" && !openaiKey) usage("Set OPENAI_API_KEY first. It paints the portrait, like the website previews.");
const extend = !flags["no-extend"];
if (extend && !openaiKey) usage("Set OPENAI_API_KEY first (it extends the background to the product's edges), or add --no-extend.");

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const outDir = path.resolve(flags.out && flags.out !== true ? flags.out : "../../prints");
const name = flags.name && flags.name !== true ? flags.name : (flags.photo || flags.art ? path.parse(flags.photo || flags.art).name : "order");

const started = Date.now();
const result = await makePrint({
  photo: flags.photo ? await readFile(flags.photo) : undefined,
  art: flags.art ? await readFile(flags.art) : undefined,
  style: flags.style, productKey, variantId, engine, openaiKey,
  upscaler: flags.upscaler && flags.upscaler !== true ? flags.upscaler : "topaz",
  topazModel: flags["topaz-model"] && flags["topaz-model"] !== true ? flags["topaz-model"] : "CGI",
  extend, seed: flags.seed, falKey, log: (m) => console.log(m),
}).catch((e) => { console.error("\n" + e.message); process.exit(1); });

await mkdir(outDir, { recursive: true });
const base = [slug(name), flags.style || "approved", flags.art ? "" : engine, productKey, slug(result.variant)].filter(Boolean).join("-");
const artFile = path.join(outDir, `${base}-art.${result.art.type === "png" ? "png" : "jpg"}`);
const layoutFile = path.join(outDir, `${base}-layout.png`);
const extFile = path.join(outDir, `${base}-background.png`);
const printFile = path.join(outDir, `${base}-PRINT.${result.final.type === "png" ? "png" : "jpg"}`);
if (!flags.art) await writeFile(artFile, result.art.bytes);
await writeFile(layoutFile, result.layoutFile.bytes);
if (result.extension) await writeFile(extFile, result.extension.bytes);
await writeFile(printFile, result.final.bytes);

// Rough cost from fal's published prices
const mp = (w, h) => Math.ceil((w * h) / 1e6);
let cost = 0;
for (const s of result.steps) {
  if (s.step === "flux-2-pro") cost += 0.03 + 0.015 * (mp(s.width, s.height) - 1 + mp(s.inputWidth || 1000, s.inputHeight || 1000));
  if (s.step === "openai") cost += 0.08; // rough: high quality portrait; see your OpenAI usage page for exact
  if (s.step === "openai-extend") cost += 0.08; // rough: high quality background extension
  if (s.step === "topaz") cost += 0.08 * Math.ceil((s.width * s.height) / 24e6);
  if (s.step === "recraft") cost += 0.004;
}

const pct = Math.round(result.coverage * 100);
console.log(`
${result.product}, ${result.variant}
  Printify print area:  ${result.target.width} x ${result.target.height}
  Your print file:      ${result.final.width} x ${result.final.height}  (${pct}% of full resolution${result.upscaler !== "none" ? `, upscaled with ${result.upscaler}` : ""})
  Saved:                ${printFile}
  Layout preview:       ${layoutFile}${flags.art ? "" : `\n  Portrait (send as the proof): ${artFile}`}
  Took ${Math.round((Date.now() - started) / 1000)}s, about $${cost.toFixed(2)}${result.steps[0] && result.steps[0].seed !== undefined ? `, seed ${result.steps[0].seed}` : ""}`);
if (result.extendError) console.log(`  Note: the background extension didn't work (${result.extendError}), so a soft blurred background was used. Run again to retry.`);
if (pct < 50) console.log("  Note: this is well below full resolution. Check Printify's quality indicator before ordering, or choose a smaller size.");
const mb = result.final.bytes.length / 1048576;
if (mb > 95) console.log(`  Warning: the print file is ${mb.toFixed(0)} MB, over Printify's 100 MB upload limit. Run again with --upscaler topaz (it makes a smaller JPEG).`);

if (flags.upload) {
  const token = process.env.PRINTIFY_TOKEN;
  if (!token) { console.error("\n--upload needs PRINTIFY_TOKEN set."); process.exit(1); }
  console.log("\nUploading to your Printify media library...");
  const res = await fetch("https://api.printify.com/v1/uploads/images.json", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "FurMems-Print/1.0" },
    // Large files go by URL (Printify fetches them from fal); local-only files are sent directly
    body: JSON.stringify(result.final.url && !result.final.url.startsWith("data:")
      ? { file_name: path.basename(printFile), url: result.final.url }
      : { file_name: path.basename(printFile), contents: Buffer.from(result.final.bytes).toString("base64") }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`Printify upload failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`); process.exit(1); }
  console.log(`Uploaded as "${data.file_name}" (${data.width} x ${data.height}). Find it under My library in the Printify editor.`);
}
