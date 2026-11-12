import axios from "axios";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const dominio = process.argv[2];
if (!dominio) { console.error("uso: node headers.js <dominio>"); process.exit(1); }

const base = `https://${dominio}`;
let html = "";
try {
  html = (await axios.get(base + "/", { headers: { "user-agent": UA }, timeout: 20000, responseType: "text", validateStatus: () => true })).data;
} catch (e) {
  console.error("falhou abrir a home: " + e.message);
  process.exit(1);
}
if (typeof html !== "string" || html.length < 200) { console.error("home vazia"); process.exit(1); }

const srcs = [...html.matchAll(/(?:src|href)="([^"]+\.m?js[^"]*)"/g)]
  .map((m) => { try { return new URL(m[1], base + "/").href; } catch { return null; } })
  .filter(Boolean);

let blob = html;
let baixados = 0;
for (const s of [...new Set(srcs)].slice(0, 8)) {
  try {
    const r = await axios.get(s, { headers: { "user-agent": UA }, timeout: 30000, responseType: "text", validateStatus: () => true });
    if (typeof r.data === "string") { blob += "\n" + r.data; baixados++; }
  } catch {}
}
console.log(`bundles: ${baixados} | ${(blob.length / 1024).toFixed(0)}kb\n`);

const PADROES = [
  /setRequestHeader\(\s*["']([^"']+)["']/g,
  /headers\s*\[\s*["']([^"']+)["']\s*\]\s*=/g,
  /["'](authorization|x-[a-z0-9-]{2,30}|auth-token|access-token|token|tenantid)["']\s*:/gi,
];

const vistos = new Set();
let total = 0;
for (const re of PADROES) {
  for (const m of blob.matchAll(re)) {
    const ctx = blob.slice(Math.max(0, m.index - 100), m.index + 130).replace(/\s+/g, " ");
    const chave = m[1] + "|" + ctx.slice(0, 45);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    console.log(`[${m[1]}] ...${ctx}...\n`);
    if (++total > 50) process.exit(0);
  }
}
if (!total) console.log("nada encontrado");