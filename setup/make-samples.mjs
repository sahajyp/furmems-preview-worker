// Make the sample pet portraits shown on furmems.com before a customer uploads a photo.
// It paints one photo in every style (same prompts as the website) and saves the results
// into the website's samples folder, along with samples/samples.json, which the site reads.
//
// Usage (Node 18+), from the worker folder:
//   Windows PowerShell:  $env:OPENAI_API_KEY="sk-..."
//   Mac/Linux:           export OPENAI_API_KEY="sk-..."
//   node setup/make-samples.mjs <photo.jpg> <Pet name> [--note "from a blurry phone photo"] [--site ../../furmems-site] [--styles pastel,oil] [--quality high]
//
// Run it once per sample pet. Running it again with the same name replaces that pet.
// Remove a pet with:  node setup/make-samples.mjs --remove <Pet name>

import { readFile, writeFile, mkdir, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { STYLES, buildPrompt } from "../src/styles.js";

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const site = path.resolve(opt("site", "../../furmems-site"));
const only = opt("styles", "");
const quality = opt("quality", "high");
const model = opt("model", process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst");
const removeName = opt("remove", "");
const note = opt("note", null);

const samplesDir = path.join(site, "samples");
const jsonPath = path.join(samplesDir, "samples.json");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pet";

async function loadList() {
  try { return JSON.parse(await readFile(jsonPath, "utf8")); } catch { return []; }
}
async function saveList(list) {
  await writeFile(jsonPath, JSON.stringify(list, null, 2) + "\n");
  console.log(`Updated ${path.relative(process.cwd(), jsonPath)} (${list.length} sample pet${list.length === 1 ? "" : "s"})`);
}

if (!existsSync(path.join(site, "index.html"))) {
  console.error(`Couldn't find the website at ${site}. Pass --site <path to your furmems-site folder>.`);
  process.exit(1);
}
await mkdir(samplesDir, { recursive: true });

if (removeName) {
  const list = (await loadList()).filter((p) => p.id !== slug(removeName));
  await saveList(list);
  process.exit(0);
}

const [photoPath, ...nameParts] = args;
const petName = nameParts.join(" ").trim();
if (!photoPath || !petName) {
  console.log('Usage: node setup/make-samples.mjs <photo.jpg> <Pet name> [--note "from a blurry phone photo"] [--site ../../furmems-site] [--styles pastel,oil] [--quality high]');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY first (see the top of this file).");
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
if (note !== null) entry.note = note;
entry.photo = photoFile;

for (const styleId of styleIds) {
  process.stdout.write(`Painting ${petName} as ${STYLES[styleId].name}... `);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", buildPrompt(styleId));
  form.append("image", new Blob([photo], { type: ext === "png" ? "image/png" : "image/jpeg" }), `pet.${ext}`);
  form.append("size", "1024x1536");
  form.append("quality", quality);
  form.append("output_format", "jpeg");
  form.append("output_compression", "90");
  const res = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.data || !data.data[0] || !data.data[0].b64_json) {
    console.log("failed");
    console.error(`  ${res.status}: ${(data.error && data.error.message) || "no image returned"}`);
    continue;
  }
  const file = `samples/${id}-${styleId}.jpg`;
  await writeFile(path.join(site, file), Buffer.from(data.data[0].b64_json, "base64"));
  entry.art[styleId] = file;
  console.log(`saved ${file}`);
}

if (!list.includes(entry)) list.push(entry);
await saveList(list);
console.log("Done. Commit and push the furmems-site folder to put the samples live.");
