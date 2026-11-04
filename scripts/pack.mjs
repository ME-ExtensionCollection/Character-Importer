// Builds dist/char-importer-<version>.zip for Settings > Addons > Import
// Extension File: the manifest plus every file it names. Also copies the
// companion userscript next to it.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { EXT, ROOT, readExtension } from "./lib.mjs";

const { config, jsPaths } = readExtension();
const files = ["manifest.json", ...jsPaths, ...(config.cssPath ? [config.cssPath] : [])];

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const locals = [];
const centrals = [];
let offset = 0;
for (const file of files) {
  const data = readFileSync(join(EXT, file));
  const packed = deflateRawSync(data);
  const name = Buffer.from(file.replace(/\\/g, "/"));
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0x0021, 12); // 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, packed);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + packed.length;
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const out = join(ROOT, "dist");
mkdirSync(out, { recursive: true });
const zipPath = join(out, `char-importer-${config.version}.zip`);
writeFileSync(zipPath, Buffer.concat([...locals, ...centrals, end]));
copyFileSync(join(ROOT, "userscript/CharImporter-companion.user.js"), join(out, "CharImporter-companion.user.js"));
console.log(`${zipPath} (${files.length} files)`);
