// Look up Printify catalog IDs for src/products.js
// Usage (Node 18+):
//   PRINTIFY_TOKEN=xxx node setup/find-products.mjs shops
//   PRINTIFY_TOKEN=xxx node setup/find-products.mjs search mug
//   PRINTIFY_TOKEN=xxx node setup/find-products.mjs providers <blueprint_id>
//   PRINTIFY_TOKEN=xxx node setup/find-products.mjs variants <blueprint_id> <print_provider_id> [product_key]
const token = process.env.PRINTIFY_TOKEN;
if (!token) { console.error("Set PRINTIFY_TOKEN first."); process.exit(1); }
const get = async (p) => {
  const r = await fetch("https://api.printify.com/v1" + p, { headers: { Authorization: `Bearer ${token}`, "User-Agent": "FurMems-Setup/1.0" } });
  if (!r.ok) { console.error(r.status, await r.text()); process.exit(1); }
  return r.json();
};
const [cmd, a, b, key] = process.argv.slice(2);

if (cmd === "shops") {
  for (const s of await get("/shops.json")) console.log(`${s.id}\t${s.title}\t(${s.sales_channel})`);
} else if (cmd === "search") {
  const q = (a || "").toLowerCase();
  const list = (await get("/catalog/blueprints.json")).filter((x) => `${x.title} ${x.brand} ${x.model}`.toLowerCase().includes(q));
  for (const x of list) console.log(`${x.id}\t${x.title} — ${x.brand} ${x.model}`);
  console.log(`\n${list.length} match(es). Next: providers <blueprint_id>`);
} else if (cmd === "providers") {
  for (const p of await get(`/catalog/blueprints/${a}/print_providers.json`)) {
    const loc = p.location ? ` — ${p.location.city || ""}, ${p.location.country || ""}` : "";
    console.log(`${p.id}\t${p.title}${loc}`);
  }
  console.log("\nNext: variants <blueprint_id> <print_provider_id> <product_key>");
} else if (cmd === "variants") {
  const data = await get(`/catalog/blueprints/${a}/print_providers/${b}/variants.json`);
  for (const v of data.variants) {
    const ph = (v.placeholders || []).map((p) => `${p.position} ${p.width}x${p.height}`).join(", ");
    console.log(`${v.id}\t${v.title}\t[${ph}]`);
  }
  const v = data.variants[0];
  const ph = (v.placeholders || []).find((p) => p.position === "front") || (v.placeholders || [])[0];
  if (ph) {
    console.log(`\nPaste into src/products.js (swap variant_id/size for a different row if you prefer):`);
    console.log(`  ${key || "product"}: { label: "${key || "Product"}", blueprint_id: ${a}, print_provider_id: ${b}, variant_id: ${v.id}, position: "${ph.position}", width: ${ph.width}, height: ${ph.height} },`);
  }
} else {
  console.log("Commands: shops | search <word> | providers <blueprint_id> | variants <blueprint_id> <provider_id> [product_key]");
}
