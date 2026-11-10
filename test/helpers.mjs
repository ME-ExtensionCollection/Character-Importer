// Shared test helpers: load extension source files the way Marinara does
// (plain scripts sharing one scope, no modules).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { deflateSync } from "node:zlib";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runs extension/src files in one context and returns the value of `expr`.
 * @param {string[]} files paths under extension/src
 * @param {string} expr expression evaluated after the files, e.g. "ciCore"
 * @param {object} [globals] extra globals
 */
export function loadSrc(files, expr, globals = {}) {
  const code = files.map((f) => readFileSync(join(ROOT, "extension/src", f), "utf8")).join("\n\n");
  const context = vm.createContext({
    TextDecoder, TextEncoder, URL, Blob, Response, CompressionStream, DecompressionStream, crypto, atob, btoa, Uint8Array, console,
    ...globals,
  });
  return vm.runInContext(`${code}\n;(${expr})`, context, { filename: files.join("+") });
}

export const loadCore = () => loadSrc(["core.js"], "ciCore");
export const loadPng = () => loadSrc(["png.js"], "ciPng");

/** Dupe Link Skip's own normalizeSource/contentHash, for parity tests. */
export function loadDls() {
  const hash = readFileSync(join(ROOT, "test/fixtures/st-getStringHash.js"), "utf8");
  const core = readFileSync(join(ROOT, "test/fixtures/dls-core.js"), "utf8");
  const isValidUrl = (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  };
  const context = vm.createContext({ URL, isValidUrl });
  return vm.runInContext(`${hash}\n${core}\n;({ normalizeSource, contentHash, getStringHash })`, context);
}

export function readFixture(name) {
  return JSON.parse(readFileSync(join(ROOT, "test/fixtures", name), "utf8"));
}

// ── PNG builder ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)])), 8 + data.length);
  return out;
}

/**
 * Minimal 1x1 PNG with card text chunks.
 * @param {{type: "tEXt"|"zTXt"|"iTXt", keyword: string, json: object, compressed?: boolean}[]} texts
 */
export function makePng(texts) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(Buffer.from([0, 0, 0, 0, 0]));
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat)];
  for (const t of texts) {
    const base64 = Buffer.from(JSON.stringify(t.json), "utf8").toString("base64");
    const key = Buffer.from(t.keyword, "latin1");
    if (t.type === "tEXt") parts.push(chunk("tEXt", Buffer.concat([key, Buffer.from([0]), Buffer.from(base64, "latin1")])));
    if (t.type === "zTXt") parts.push(chunk("zTXt", Buffer.concat([key, Buffer.from([0, 0]), deflateSync(Buffer.from(base64, "latin1"))])));
    if (t.type === "iTXt") {
      const body = t.compressed ? deflateSync(Buffer.from(base64)) : Buffer.from(base64);
      parts.push(chunk("iTXt", Buffer.concat([key, Buffer.from([0, t.compressed ? 1 : 0, 0, 0, 0]), body])));
    }
  }
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}
