import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPng, makePng } from "./helpers.mjs";

const png = loadPng();
const plain = (value) => JSON.parse(JSON.stringify(value));
const V2 = { spec: "chara_card_v2", data: { name: "Ünïcødé ✓", description: "d" } };
const V3 = { spec: "chara_card_v3", data: { name: "Three", description: "d3" } };

test("reads tEXt chara with UTF-8 content", async () => {
  assert.deepEqual(plain(await png.readCard(makePng([{ type: "tEXt", keyword: "chara", json: V2 }]))), V2);
});

test("prefers ccv3 over chara regardless of order", async () => {
  const bytes = makePng([
    { type: "tEXt", keyword: "chara", json: V2 },
    { type: "tEXt", keyword: "ccv3", json: V3 },
  ]);
  assert.deepEqual(plain(await png.readCard(bytes)), V3);
});

test("reads zTXt and iTXt (plain and compressed)", async () => {
  assert.deepEqual(plain(await png.readCard(makePng([{ type: "zTXt", keyword: "chara", json: V2 }]))), V2);
  assert.deepEqual(plain(await png.readCard(makePng([{ type: "iTXt", keyword: "chara", json: V2 }]))), V2);
  assert.deepEqual(plain(await png.readCard(makePng([{ type: "iTXt", keyword: "ccv3", json: V3, compressed: true }]))), V3);
});

test("PNG without a card is null; JSON bytes parse; junk is null", async () => {
  assert.equal(await png.readCard(makePng([])), null);
  assert.deepEqual(plain(await png.readCard(new TextEncoder().encode("﻿" + JSON.stringify(V2)))), V2);
  assert.equal(await png.readCard(new TextEncoder().encode("not json")), null);
});

test("truncated PNG does not throw", async () => {
  const bytes = makePng([{ type: "tEXt", keyword: "chara", json: V2 }]);
  assert.equal(await png.readCard(bytes.subarray(0, 40)), null);
});

test("base64 round trip, sniffing, sha1", async () => {
  const bytes = makePng([]);
  assert.deepEqual([...png.base64ToBytes(png.bytesToBase64(bytes))], [...bytes]);
  assert.equal(png.sniffImageType(bytes), "image/png");
  assert.equal(png.sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(png.sniffImageType(new Uint8Array([1, 2, 3, 4])), "");
  assert.equal(png.extensionFor("image/webp"), "webp");
  assert.equal(await png.sha1Hex(new TextEncoder().encode("abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.match(png.toDataUrl(new Uint8Array([1, 2]), "image/png"), /^data:image\/png;base64,AQI=$/);
});

test("unzipEntry reads stored and deflated files from a zip", async () => {
  const { deflateRawSync } = await import("node:zlib");
  const files = [
    ["assets/a.txt", Buffer.from("not this one"), 0],
    ["card.json", Buffer.from(JSON.stringify(V3)), 8],
    ["plain.txt", Buffer.from("stored"), 0],
  ];
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data, method] of files) {
    const body = method === 8 ? deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, body);
    centrals.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const size = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  const zip = new Uint8Array(Buffer.concat([...locals, ...centrals, end]));
  const card = await png.unzipEntry(zip, "card.json");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(card)), V3);
  assert.equal(new TextDecoder().decode(await png.unzipEntry(zip, "plain.txt")), "stored");
  assert.equal(await png.unzipEntry(zip, "missing.json"), null);
  assert.equal(await png.unzipEntry(new Uint8Array(10), "card.json"), null);
});
