// End-to-end test against a DISPOSABLE Marinara Engine instance (it imports,
// merges and deletes characters). Never point it at your real library.
//
// Start a throwaway Marinara with its own data folder and port, e.g. an env
// file with PORT=7871, DATA_DIR=/tmp/me-test, ENABLE_EXTERNAL_EXTENSIONS=true,
// run it with MARINARA_ENV_FILE=that-file, then:
//
//   ME_URL=http://127.0.0.1:7871 \
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   CHROME=/usr/bin/google-chrome-stable \
//   [SHOTS=/some/dir] node scripts/e2e.mjs
//
// It deploys the extension, turns on the External Extensions gate, loads the
// companion userscript into the page with GM_* shims (downloads go through
// Node, like GM_xmlhttpRequest), and drives the real UI. Needs internet (Chub).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib.mjs";

const ME = (process.env.ME_URL ?? "").replace(/\/+$/, "");
if (!ME) throw new Error("Set ME_URL to a disposable Marinara instance");
const pw = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core");
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ONLY = new Set((process.env.STAGES ?? "").split(",").filter(Boolean));
const stage = (name) => !ONLY.size || ONLY.has(name);

const STARFIRE = "https://chub.ai/characters/kylaci/Starfire";
const STARFIRE_ALT = "https://www.characterhub.org/characters/kylaci/starfire/";
const GENSOKYO = "https://chub.ai/characters/punchchildren/grand-gensokyo-adventure-dd7ffd91";

// ── Marinara API ──

const H = { "Content-Type": "application/json", "x-marinara-csrf": "1" };
async function api(method, path, body) {
  const r = await fetch(`${ME}${path}`, { method, headers: body ? H : { "x-marinara-csrf": "1" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const characters = async () =>
  (await api("GET", "/api/characters")).map((row) => ({ ...row, data: typeof row.data === "string" ? JSON.parse(row.data) : row.data }));
const byName = async (name) => (await characters()).filter((c) => c.data.name === name);

// ── Setup ──

console.log("- deploy");
await api("PATCH", "/api/personal-extensions/policy/external", { enabled: true });
execFileSync(process.execPath, [join(ROOT, "scripts/deploy.mjs")], { env: { ...process.env, ME_URL: ME }, stdio: "inherit" });

const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const errors = [];

// The companion userscript, with GM_* backed by Node.
const userscript = readFileSync(join(ROOT, "userscript/CharImporter-companion.user.js"), "utf8");
const gmStore = new Map();
const bridgeLog = [];
await context.exposeBinding("__gmGet", (_src, key) => gmStore.get(key));
await context.exposeBinding("__gmSet", (_src, key, value) => void gmStore.set(key, value));
await context.exposeBinding("__gmFetch", async (_src, url, accept) => {
  bridgeLog.push(url);
  const r = await fetch(url, { headers: accept ? { Accept: accept } : {}, redirect: "follow" });
  const buf = Buffer.from(await r.arrayBuffer());
  const headers = [...r.headers].map(([k, v]) => `${k}: ${v}`).join("\r\n");
  return { status: r.status, statusText: r.statusText, finalUrl: r.url, headers, base64: buf.toString("base64"), type: r.headers.get("content-type") ?? "" };
});
const withBridge = async (page) => {
  await page.addInitScript(`(() => {
    const GM_getValue = (k, d) => { const v = window.__gmCache?.[k]; return v === undefined ? d : v; };
    const GM_setValue = (k, v) => { window.__gmCache[k] = v; window.__gmSet(k, v); };
    const GM_registerMenuCommand = () => {};
    const GM_xmlhttpRequest = (o) => {
      let aborted = false;
      window.__gmFetch(o.url, o.headers?.Accept).then((r) => {
        if (aborted) return;
        const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
        o.onprogress?.({ loaded: bytes.length, total: bytes.length, lengthComputable: true });
        o.onload?.({ status: r.status, statusText: r.statusText, finalUrl: r.finalUrl, responseHeaders: r.headers, response: new Blob([bytes], { type: r.type }), responseText: o.responseType === "text" ? new TextDecoder().decode(bytes) : undefined });
      }, (e) => o.onerror?.({ error: String(e) }));
      return { abort: () => { aborted = true; o.onabort?.(); } };
    };
    window.__gmCache = { trustedOrigins: { [location.origin]: true } };
    const run = () => { ${userscript.replace(/<\/script>/g, "")} };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();
  })();`);
};

async function openMarinara({ bridge = true } = {}) {
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/favicon|Failed to load resource/.test(t)) errors.push(t);
  });
  if (bridge) await withBridge(page);
  await page.goto(ME, { waitUntil: "networkidle" });
  const skip = page.getByRole("button", { name: "Skip Tutorial" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await page.locator(".ci-launcher").waitFor({ timeout: 20_000 });
  // Startup popups (What's New and the like) cover the top bar
  for (let i = 0; i < 4; i++) {
    const modal = page.locator('[data-component="Modal"]').first();
    if (!(await modal.isVisible().catch(() => false))) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
  return page;
}

const shot = async (page, name) => SHOTS && page.screenshot({ path: join(SHOTS, `${name}.png`) });

async function pasteAndImport(page, links, { contentCheck = false } = {}) {
  await page.locator(".ci-launcher").click();
  const dialog = page.locator(".ci-dialog", { hasText: "Import characters from links" });
  await dialog.waitFor();
  await dialog.locator("textarea").fill(links.join("\n"));
  const content = dialog.getByLabel("Also skip cards with identical content");
  if ((await content.isChecked()) !== contentCheck) await content.click();
  await shot(page, `paste-${Date.now()}`);
  await dialog.getByRole("button", { name: "Import" }).click();
  await page.locator(".ci-queue").waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll(".ci-queue-item").length > 0 && !document.querySelector(".ci-state--pending, .ci-state--running"),
    null,
    { timeout: 10 * 60_000, polling: 1000 },
  );
  const items = await page.$$eval(".ci-queue-item", (nodes) =>
    nodes.map((n) => ({ state: [...n.classList].find((c) => c.startsWith("ci-state--"))?.slice(10), text: n.querySelector(".ci-queue-url")?.textContent, note: n.querySelector(".ci-queue-note")?.textContent ?? "" })),
  );
  for (const i of items) console.log(`    [${i.state}] ${i.text} - ${i.note}`);
  await shot(page, `queue-${Date.now()}`);
  await page.locator(".ci-queue").getByRole("button", { name: "Clear" }).click();
  return items;
}

// ── Stages ──

let page = await openMarinara();
await shot(page, "home");

if (stage("import")) {
  console.log("- empty the (disposable) library");
  for (const c of await characters()) await api("DELETE", `/api/characters/${c.id}`);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".ci-launcher").waitFor();
  console.log("- import two Chub links plus a second spelling of one");
  const items = await pasteAndImport(page, [STARFIRE, GENSOKYO, STARFIRE_ALT]);
  assert.equal(items.filter((i) => i.state === "done" || i.state === "warn").length, 2, "two imported");
  assert.equal(items[2].state, "skipped", "alternate spelling skipped as duplicate link");

  const [starfire] = await byName("Starfire");
  assert.ok(starfire, "Starfire imported");
  const marker = starfire.data.extensions.char_importer;
  assert.equal(marker.source_key, "chub:kylaci/starfire");
  assert.match(marker.content_hash, /\./);
  assert.match(starfire.data.extensions.botBrowserSource, /^chub:kylaci\/Starfire$/i);
  const sprites = await api("GET", `/api/sprites/${starfire.id}`);
  console.log(`    Starfire: ${sprites.length} sprites, tags ${JSON.stringify(starfire.data.tags.slice(-3))}`);
  assert.ok(sprites.length > 0, "expressions became sprites");
  assert.ok(starfire.data.tags.includes("EXP Downloaded"), "expressions tag");
  const gallery = await api("GET", `/api/characters/${starfire.id}/gallery`);
  console.log(`    Starfire gallery: ${gallery.length} images`);

  const [gensokyo] = (await characters()).filter((c) => c.data.extensions?.char_importer?.source_key === "chub:punchchildren/grand-gensokyo-adventure-dd7ffd91");
  assert.ok(gensokyo, "Gensokyo imported");
  const books = await api("GET", `/api/lorebooks?characterId=${gensokyo.id}`);
  console.log(`    Gensokyo lorebooks: ${books.map((b) => b.name).join(", ")}`);
  assert.ok(books.length >= 1, "related lorebook linked");
}

if (stage("again")) {
  console.log("- the same links again are all skipped");
  const items = await pasteAndImport(page, [STARFIRE, GENSOKYO]);
  assert.ok(items.every((i) => i.state === "skipped"), "all skipped");
  assert.equal((await byName("Starfire")).length, 1);
}

// A card file on another site with Starfire's content: skipped by content hash.
let fileServer = null;
if (stage("content")) {
  console.log("- same card from another link: skipped by content");
  const [starfire] = await byName("Starfire");
  const card = JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: starfire.data });
  fileServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(card);
  }).listen(7899, "127.0.0.1");
  const items = await pasteAndImport(page, ["http://127.0.0.1:7899/starfire-copy.json"], { contentCheck: true });
  assert.equal(items[0].state, "skipped", `skipped by content (${items[0].note})`);
  assert.match(items[0].note, /Identical card/);
}

if (stage("bridge")) {
  console.log("- RisuRealm link through the userscript bridge");
  const before = bridgeLog.length;
  const risu = process.env.RISU_URL ?? "https://realm.risuai.net/character/054bbeb3-e56c-4e21-b6ca-bedeb15c31e1";
  const items = await pasteAndImport(page, [risu]);
  console.log(`    bridge requests: ${bridgeLog.slice(before).map((u) => new URL(u).hostname).join(", ") || "none"}`);
  assert.ok(items[0].state === "done" || items[0].state === "warn", `Risu import (${items[0].note}); set RISU_URL if the card was removed`);
  assert.ok(bridgeLog.length > before, "went through the userscript");
}

if (stage("duplicates")) {
  console.log("- Flag duplicates merges and deletes an identical copy");
  const [starfire] = await byName("Starfire");
  // A second copy made with Marinara's own importer (no marker, same content)
  const copy = structuredClone(starfire.data);
  delete copy.extensions.char_importer;
  copy.tags = [...copy.tags, "from-copy"];
  const result = await api("POST", "/api/import/st-character", { spec: "chara_card_v2", spec_version: "2.0", data: copy });
  assert.ok(result.success, "copy imported");
  assert.equal((await byName("Starfire")).length, 2);

  await page.locator(".ci-launcher").click({ button: "right" });
  const tools = page.locator(".ci-dialog", { hasText: "Char Importer" });
  await tools.getByRole("tab", { name: "Library" }).click();
  await tools.getByRole("button", { name: "Flag duplicates…" }).click();
  const review = page.locator('.ci-dialog[aria-label="Flag duplicates"]');
  await review.waitFor({ timeout: 120_000 });
  await shot(page, "dupes-review");
  await review.getByRole("button", { name: "Apply" }).click();
  const confirmBox = page.locator('.ci-dialog[aria-label="Delete duplicates?"]');
  await confirmBox.getByRole("button", { name: /Merge & delete/ }).click();
  await review.waitFor({ state: "detached", timeout: 120_000 });
  const left = await byName("Starfire");
  assert.equal(left.length, 1, "one Starfire left");
  assert.equal(left[0].id, starfire.id, "the older copy is kept");
  assert.ok(left[0].data.tags.includes("from-copy"), "tags merged");
  await tools.getByRole("tab", { name: "Backups" }).click();
  await tools.getByText("Starfire").first().waitFor();
  console.log("    merged, deleted, backup listed");
  await page.keyboard.press("Escape");
}

if (stage("resume")) {
  console.log("- reload in the middle of an import resumes it");
  const link = "https://chub.ai/characters/shaolan98/Monika";
  await page.locator(".ci-launcher").click();
  const dialog = page.locator(".ci-dialog", { hasText: "Import characters from links" });
  await dialog.locator("textarea").fill(link);
  await dialog.getByRole("button", { name: "Import" }).click();
  // Wait until the card is in and its sprites are downloading, then reload
  await page.waitForFunction(() => /Expressions \d+ \/ \d+/.test(document.querySelector(".ci-state--running .ci-queue-note")?.textContent ?? ""), null, { timeout: 180_000 });
  await page.close();
  page = await openMarinara();
  const queue = page.locator(".ci-queue");
  await queue.getByRole("button", { name: "Resume" }).click();
  await page.waitForFunction(() => !document.querySelector(".ci-state--pending, .ci-state--running"), null, { timeout: 10 * 60_000, polling: 1000 });
  const note = await queue.locator(".ci-queue-note").first().textContent();
  console.log(`    ${note}`);
  assert.match(note, /before the reload/);
  assert.equal((await byName("Monika")).length, 1, "no second copy");
}

if (errors.length) console.log(`Page errors:\n  ${[...new Set(errors)].join("\n  ")}`);
fileServer?.close();
await browser.close();
console.log("e2e passed");
