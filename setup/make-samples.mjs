// Make the sample pet portraits shown on furmems.com before a customer uploads a photo.
// It paints one photo in every style (same prompts as the website), then extends each painting's own
// background to the shape of every product (so the product previews have no blurry borders), and saves
// everything into the website's samples folder, along with samples/samples.json, which the site reads.
//
// Usage (Node 18+), from the worker folder:
//   Windows PowerShell:  $env:OPENAI_API_KEY="sk-..."
//   Mac/Linux:           export OPENAI_API_KEY="sk-..."
//   node setup/make-samples.mjs <photo.jpg> <Pet name> [--note "from a blurry phone photo"] [--site ../../furmems-site]
//        [--styles pastel,oil] [--quality high] [--no-extend]
//
// Run it once per sample pet. Running it again with the same name replaces that pet.
// The note under the slideshow ("Sample: Bella · <note>") only shows when you pass --note.
//
// Add the product backgrounds to pets you already made (no repainting):
//   node setup/make-samples.mjs --extend-only <Pet name>      (or --extend-only all)
//   Uses the full-quality PNG saved in ..\..\sample-masters when there is one; otherwise it converts the
//   website JPEG to PNG with Topaz on fal.ai first, so it also needs FAL_KEY.
//
// Remove a pet with:  node setup/make-samples.mjs --remove <Pet name>

import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { STYLES, buildPrompt } from "../src/styles.js";
import { decodePng, resize, artRect } from "./image.mjs";
import { encodeJpeg } from "./jpeg.mjs";
import { extensionGroups, extendForOption } from "./extend-lib.mjs";
import { toPng } from "./print-lib.mjs";

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => { const i = args.indexOf(`--${name}`); if (i === -1) return false; args.splice(i, 1); return true; };
const site = path.resolve(opt("site", "../../furmems-site"));
const masters = path.resolve(opt("masters", "../../sample-masters")); // full-quality PNGs, kept outside the repos
const only = opt("styles", "");
const quality = opt("quality", "high");
const extQuality = opt("ext-quality", "medium");
const model = opt("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst");
const removeName = opt("remove", "");
const extendOnly = opt("extend-only", "");
const note = opt("note", null);
const noExtend = flag("no-extend");

const samplesDir = path.join(site, "samples");
const jsonPath = path.join(samplesDir, "samples.json");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pet";
const openaiKey = process.env.OPENAI_API_KEY;

async function loadList() {
  try { return JSON.parse(await readFile(jsonPath, "utf8")); } catch { return []; }
}
async function saveList(list) {
  await writeFile(jsonPath, JSON.stringify(list, null, 2) + "\n");
  console.log(`Updated ${path.relative(process.cwd(), jsonPath)} (${list.length} sample pet${list.length === 1 ? "" : "s"})`);
}

// Extend one painting's background to every product shape; small JPEGs for the website
const SITE_LONG_SIDE = 1024;
async function extendAll(entry, styleId, artImg) {
  const groups = extensionGroups();
  entry.ext = entry.ext || {};
  entry.ext[styleId] = entry.ext[styleId] || {};
  let ok = 0;
  const run = async (g) => {
    try {
      const r = await extendForOption(artImg, g.productKey, g.option, { openaiKey, model, quality: extQuality });
      const k = SITE_LONG_SIDE / Math.max(r.image.width, r.image.height);
      const small = k < 1 ? resize(r.image, Math.round(r.image.width * k), Math.round(r.image.height * k)) : r.image;
      const file = `samples/${entry.id}-${styleId}-${g.group}.jpg`;
      await writeFile(path.join(site, file), encodeJpeg(small, 85));
      // where the portrait sits in this background (shares of its width and height), for the website
      const b = artRect(artImg.width, artImg.height, r.image.width, r.image.height, g.layout);
      const f = (v, d) => Math.round((v / d) * 10000) / 10000;
      entry.ext[styleId][g.group] = { src: file, w: small.width, h: small.height,
        box: [f(b.x, r.image.width), f(b.y, r.image.height), f(b.w, r.image.width), f(b.h, r.image.height)] };
      ok++;
    } catch (e) {
      console.log(`\n  ${g.group}: ${e.message}`);
    }
  };
  // three at a time
  for (let i = 0; i < groups.length; i += 3) await Promise.all(groups.slice(i, i + 3).map(run));
  console.log(`  product backgrounds: ${ok}/${groups.length}`);
}

if (!existsSync(path.join(site, "index.html"))) {
  console.error(`Couldn't find the website at ${site}. Pass --site <path to your furmems-site folder>.`);
  process.exit(1);
}
await mkdir(samplesDir, { recursive: true });
await mkdir(masters, { recursive: true });

if (removeName) {
  const list = (await loadList()).filter((p) => p.id !== slug(removeName));
  await saveList(list);
  process.exit(0);
}

if (!openaiKey) {
  console.error("Set OPENAI_API_KEY first (see the top of this file).");
  process.exit(1);
}

if (extendOnly) {
  const list = await loadList();
  const pets = extendOnly.toLowerCase() === "all" ? list : list.filter((p) => p.id === slug(extendOnly));
  if (!pets.length) { console.error(`No sample pet called "${extendOnly}". Pets: ${list.map((p) => p.name).join(", ") || "none"}`); process.exit(1); }
  for (const pet of pets) {
    for (const [styleId, file] of Object.entries(pet.art || {})) {
      if (only && !only.split(",").includes(styleId)) continue;
      console.log(`${pet.name}, ${STYLES[styleId] ? STYLES[styleId].name : styleId}:`);
      const master = path.join(masters, `${pet.id}-${styleId}.png`);
      let png;
      if (existsSync(master)) png = await readFile(master);
      else {
        if (!process.env.FAL_KEY) { console.error("  No PNG master for this painting; set FAL_KEY so it can be converted."); process.exit(1); }
        process.stdout.write("  converting the website JPEG to PNG (Topaz)... ");
        png = await toPng(await readFile(path.join(site, file)), { falKey: process.env.FAL_KEY });
        await writeFile(master, png);
        console.log("done");
      }
      await extendAll(pet, styleId, decodePng(png));
      await saveList(list); // save as we go
    }
  }
  console.log("Done. Commit and push the furmems-site folder to put the new previews live.");
  process.exit(0);
}

const [photoPath, ...nameParts] = args;
const petName = nameParts.join(" ").trim();
if (!photoPath || !petName) {
  console.log('Usage: node setup/make-samples.mjs <photo.jpg> <Pet name> [--note "from a blurry phone photo"] [--site ../../furmems-site] [--styles pastel,oil] [--quality high] [--no-extend]');
  process.exit(1);
}

const id = slug(petName);
const ext = path.extname(photoPath).toLowerCase() === ".png" ? "png" : "jpg";
const photoFile = `samples/${id}.${ext}`;
const size = (await stat(photoPath)).size;
if (size > 1.5 * 1024 * 1024) {
  console.warn(`Note: ${path.basename(photoPath)} is ${(size / 1048576).toFixed(1)} MB. Smaller photos (under ~1 MB) load faster on the site.`);
}
await copyFile(photoPath, path.join(site, photoFile));
const photo = await readFile(photoPath);

const styleIds = only ? only.split(",").map((s) => s.trim()).filter((s) => STYLES[s]) : Object.keys(STYLES);
const list = await loadList();
const entry = list.find((p) => p.id === id) || { id, name: petName, photo: photoFile, art: {} };
entry.name = petName;
if (note !== null && note !== "") entry.note = note; else delete entry.note; // the note only shows when given
entry.photo = photoFile;

for (const styleId of styleIds) {
  process.stdout.write(`Painting ${petName} as ${STYLES[styleId].name}... `);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", buildPrompt(styleId));
  form.append("image", new Blob([photo], { type: ext === "png" ? "image/png" : "image/jpeg" }), `pet.${ext}`);
  form.append("size", "1024x1536");
  form.append("quality", quality);
  form.append("output_format", "png");
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.data || !data.data[0] || !data.data[0].b64_json) {
    console.log("failed");
    console.error(`  ${res.status}: ${(data.error && data.error.message) || "no image returned"}`);
    continue;
  }
  const png = Buffer.from(data.data[0].b64_json, "base64");
  await writeFile(path.join(masters, `${id}-${styleId}.png`), png);
  const art = decodePng(png);
  const file = `samples/${id}-${styleId}.jpg`;
  await writeFile(path.join(site, file), encodeJpeg(art, 90));
  entry.art[styleId] = file;
  if (entry.ext) delete entry.ext[styleId]; // old backgrounds belong to the old painting
  console.log(`saved ${file}`);
  if (!noExtend) await extendAll(entry, styleId, art);
}

if (!list.includes(entry)) list.push(entry);
await saveList(list);
console.log("Done. Commit and push the furmems-site folder to put the samples live.");
