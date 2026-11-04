// Char Importer: card files and bytes. Reads character JSON from PNG text
// chunks (tEXt, zTXt, iTXt; "ccv3" preferred over "chara"), like Marinara's
// client/src/lib/png-parser.ts, so hashes are taken from the same data
// Marinara will import.

const ciPng = (() => {
  "use strict";

  const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  const KEYWORDS = new Set(["ccv3", "chara"]);
  const MAX_INFLATED = 4 * 1024 * 1024;
  const utf8 = new TextDecoder();
  const latin1 = new TextDecoder("latin1");

  function isPng(bytes) {
    return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
  }

  function findNull(data, from) {
    for (let i = from; i < data.length; i++) if (data[i] === 0) return i;
    return -1;
  }

  function base64ToBytes(base64) {
    const clean = String(base64).replace(/\s+/g, "");
    if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(clean);
    const raw = atob(clean);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  function bytesToBase64(bytes) {
    if (typeof bytes.toBase64 === "function") return bytes.toBase64();
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  /** Chunk text that is either raw JSON or base64 of UTF-8 JSON. */
  function parseChunkText(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) return JSON.parse(trimmed);
    return JSON.parse(utf8.decode(base64ToBytes(trimmed)));
  }

  async function inflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INFLATED) {
        await reader.cancel();
        throw new Error("PNG text metadata is too large");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  /**
   * Character JSON from a PNG's text chunks.
   * @param {Uint8Array} bytes
   * @returns {Promise<object|null>}
   */
  async function readPngCard(bytes) {
    if (!isPng(bytes)) return null;
    const found = new Map();
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      offset += 4;
      if (offset + 4 + length + 4 > bytes.length) break;
      const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      offset += 4;
      const data = bytes.subarray(offset, offset + length);
      offset += length + 4;
      if (type === "IEND") break;
      if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") continue;

      const sep = findNull(data, 0);
      if (sep <= 0) continue;
      const keyword = latin1.decode(data.subarray(0, sep)).toLowerCase();
      if (!KEYWORDS.has(keyword) || found.has(keyword)) continue;
      try {
        if (type === "tEXt") {
          found.set(keyword, parseChunkText(latin1.decode(data.subarray(sep + 1))));
        } else if (type === "zTXt") {
          if (data[sep + 1] !== 0) continue;
          found.set(keyword, parseChunkText(utf8.decode(await inflate(data.subarray(sep + 2)))));
        } else {
          const compressed = data[sep + 1] === 1;
          const langEnd = findNull(data, sep + 3);
          if (langEnd < 0) continue;
          const transEnd = findNull(data, langEnd + 1);
          if (transEnd < 0) continue;
          const text = data.subarray(transEnd + 1);
          found.set(keyword, parseChunkText(utf8.decode(compressed ? await inflate(text) : text)));
        }
      } catch {
        // Malformed chunk; another chunk may still carry the card.
      }
    }
    return found.get("ccv3") ?? found.get("chara") ?? null;
  }

  /**
   * Card JSON from downloaded bytes: PNG text chunks, otherwise JSON.
   * @param {Uint8Array} bytes
   * @returns {Promise<object|null>}
   */
  async function readCard(bytes) {
    if (isPng(bytes)) return readPngCard(bytes);
    try {
      const text = utf8.decode(bytes).replace(/^﻿/, "");
      const json = JSON.parse(text);
      return json && typeof json === "object" ? json : null;
    } catch {
      return null;
    }
  }

  /** Image MIME type from magic bytes, or "". */
  function sniffImageType(bytes) {
    if (isPng(bytes)) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
      if (brand === "avif" || brand === "avis") return "image/avif";
    }
    return "";
  }

  const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };
  const extensionFor = (mime) => EXTENSIONS[mime] ?? "";

  function toDataUrl(bytes, mime) {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  }

  async function sha1Hex(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * One file from a ZIP archive (stored or deflated), e.g. card.json in a
   * RisuAI .charx. Reads the central directory, so data descriptors are fine.
   * @returns {Promise<Uint8Array|null>}
   */
  async function unzipEntry(bytes, wanted) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) return null;
    const count = view.getUint16(end + 10, true);
    let offset = view.getUint32(end + 16, true);
    for (let n = 0; n < count && offset + 46 <= bytes.length; n++) {
      if (view.getUint32(offset, true) !== 0x02014b50) return null;
      const method = view.getUint16(offset + 10, true);
      const size = view.getUint32(offset + 20, true);
      const nameLen = view.getUint16(offset + 28, true);
      const extraLen = view.getUint16(offset + 30, true);
      const commentLen = view.getUint16(offset + 32, true);
      const local = view.getUint32(offset + 42, true);
      const name = utf8.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
      offset += 46 + nameLen + extraLen + commentLen;
      if (name !== wanted) continue;
      if (view.getUint32(local, true) !== 0x04034b50) return null;
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method !== 8) return null;
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return null;
  }

  return Object.freeze({
    unzipEntry,
    isPng,
    readPngCard,
    readCard,
    base64ToBytes,
    bytesToBase64,
    sniffImageType,
    extensionFor,
    toDataUrl,
    sha1Hex,
  });
})();
