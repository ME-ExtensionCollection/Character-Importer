// Shared by the build, deploy and pack scripts: reads the extension the same
// way Marinara's folder import does (jsPath files joined with "\n\n").
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EXT = join(ROOT, "extension");

export function readExtension() {
  const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
  const config = manifest.config;
  if (manifest.kind !== "marinara.personal-extension" || manifest.version !== 1) throw new Error("manifest.json: unexpected kind/version");
  const jsPaths = Array.isArray(config.jsPath) ? config.jsPath : [config.jsPath];
  const js = jsPaths.map((p) => readFileSync(join(EXT, p), "utf8")).join("\n\n");
  const css = config.cssPath ? readFileSync(join(EXT, config.cssPath), "utf8") : "";
  return { manifest, config, jsPaths, js, css };
}
