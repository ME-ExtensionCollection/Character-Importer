// DEVELOPMENT ONLY. Pushes the extension into a running Marinara Engine and
// approves the new code hash, skipping the review dialog. Use it on your own
// install for your own code; for anyone else, hand out the folder or zip and
// let them review it in Settings > Addons.
//
// Needs ENABLE_EXTERNAL_EXTENSIONS=true and the Danger Zone toggle in
// Marinara. Privileged routes work from loopback; otherwise set ADMIN_SECRET.
//
// Usage: ME_URL=http://127.0.0.1:7860 [ADMIN_SECRET=...] node scripts/deploy.mjs
import { readExtension } from "./lib.mjs";

const base = (process.env.ME_URL ?? "http://127.0.0.1:7860").replace(/\/+$/, "");
const headers = { "Content-Type": "application/json", "x-marinara-csrf": "1" };
if (process.env.ADMIN_SECRET) headers["X-Admin-Secret"] = process.env.ADMIN_SECRET;

async function call(method, path, body) {
  const response = await fetch(`${base}/api/personal-extensions${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }
  if (!response.ok) throw new Error(`${method} ${path || "/"}: ${response.status} ${json?.error ?? text.slice(0, 300)}`);
  return json;
}

const { config, js, css } = readExtension();
const payload = { name: config.name, version: config.version, description: config.description ?? "", runtime: "client", capabilities: config.capabilities ?? [], js, css };

const list = await call("GET", "");
let ext = list.find((e) => e.name === config.name);
if (ext) {
  ext = await call("PATCH", `/${ext.id}`, { version: payload.version, description: payload.description, capabilities: payload.capabilities, js, css });
  console.log(`Updated "${config.name}" (${ext.id})`);
} else {
  ext = await call("POST", "", payload);
  console.log(`Created "${config.name}" (${ext.id})`);
}
if (ext.approvedHash === ext.contentHash && ext.enabled !== false) {
  console.log(`Unchanged, already approved: ${ext.contentHash}`);
} else {
  ext = await call("POST", `/${ext.id}/approve`, { contentHash: ext.contentHash, acknowledgeSandboxedCode: true, acknowledgeFullPageAccess: true });
  console.log(`Approved ${ext.contentHash}`);
}
console.log("Reload the Marinara tab to run the new code.");
