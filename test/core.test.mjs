import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOT, loadCore, loadDls } from "./helpers.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const core = loadCore();
const dls = loadDls();
// Values from the vm context have another realm's prototypes; compare as JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

const LINKS = [
  ["https://chub.ai/characters/Creator/Some-Slug", "chub:creator/some-slug"],
  ["https://www.chub.ai/characters/creator/some-slug/", "chub:creator/some-slug"],
  ["http://characterhub.org/characters/creator/some-slug", "chub:creator/some-slug"],
  ["https://chub.ai/characters/creator/some-slug/main", "chub:creator/some-slug"],
  ["creator/some-slug", "chub:creator/some-slug"],
  ["https://chub.ai/lorebooks/creator/world-book", "chublore:creator/world-book"],
  ["https://janitorai.com/characters/0b4e2c1a-1111-4222-8333-944445555666_character-name", "uuid:0b4e2c1a-1111-4222-8333-944445555666"],
  ["https://pygmalion.chat/character/0B4E2C1A-1111-4222-8333-944445555666", "uuid:0b4e2c1a-1111-4222-8333-944445555666"],
  ["0b4e2c1a-1111-4222-8333-944445555666", "uuid:0b4e2c1a-1111-4222-8333-944445555666"],
  ["https://realm.risuai.net/character/AbCdEf", "risu:abcdef"],
  ["https://perchance.org/ai-character-chat?data=Name~Slug123.gz", "perchance:slug123.gz"],
  ["https://aicharactercards.com/character-cards/fantasy/creator/card-name/", "aicc:creator/card-name"],
  ["AICC/creator/card-name", "aicc:creator/card-name"],
  ["https://files.catbox.moe/abc.png?x=1", "url:files.catbox.moe/abc.png?x=1"],
  ["", ""],
  ["   ", ""],
  ["justoneword", ""],
];

test("normalizeSource matches the table", () => {
  for (const [input, key] of LINKS) assert.equal(core.normalizeSource(input), key, input);
});

test("normalizeSource agrees with Dupe Link Skip on every link it knows", () => {
  for (const [input] of LINKS) assert.equal(core.normalizeSource(input), dls.normalizeSource(input), input);
});

test("normalizeSource knows Marinara's extra sites", () => {
  assert.equal(
    core.normalizeSource("https://jannyai.com/characters/0b4e2c1a-1111-4222-8333-944445555666_character-x"),
    "uuid:0b4e2c1a-1111-4222-8333-944445555666",
  );
  assert.equal(core.normalizeSource("https://app.wyvern.chat/characters/AbC123"), "wyvern:abc123");
  assert.equal(core.normalizeSource("https://datacat.run/characters/XyZ"), "datacat:xyz");
});

test("keyFromBotBrowserSource maps Marinara's markers onto the same keys", () => {
  assert.equal(core.keyFromBotBrowserSource("chub:Creator/Slug"), "chub:creator/slug");
  assert.equal(core.keyFromBotBrowserSource("janny:0B4E2C1A-1111-4222-8333-944445555666"), "uuid:0b4e2c1a-1111-4222-8333-944445555666");
  assert.equal(core.keyFromBotBrowserSource("pygmalion:0b4e2c1a-1111-4222-8333-944445555666"), "uuid:0b4e2c1a-1111-4222-8333-944445555666");
  assert.equal(core.keyFromBotBrowserSource("wyvern:Abc"), "wyvern:abc");
  assert.equal(core.keyFromBotBrowserSource("nope"), "");
  assert.equal(core.keyFromBotBrowserSource(undefined), "");
});

test("keysFromCard collects every marker, main key first", () => {
  const keys = core.keysFromCard({
    name: "X",
    source: ["https://realm.risuai.net/character/abc", "not a url"],
    extensions: {
      char_importer: { source_key: "url:example.com/card.png" },
      chub: { full_path: "Creator/Slug" },
      botBrowserSource: "chub:creator/slug",
      source_url: "https://janitorai.com/characters/0b4e2c1a-1111-4222-8333-944445555666",
    },
  });
  assert.deepEqual(plain(keys), [
    "url:example.com/card.png",
    "chub:creator/slug",
    "uuid:0b4e2c1a-1111-4222-8333-944445555666",
    "risu:abc",
  ]);
  assert.deepEqual(plain(core.keysFromCard({ data: { extensions: { pygmalion_id: "0b4e2c1a-1111-4222-8333-944445555666" } } })), [
    "uuid:0b4e2c1a-1111-4222-8333-944445555666",
  ]);
  assert.deepEqual(plain(core.keysFromCard(null)), []);
});

test("getStringHash is SillyTavern's", () => {
  for (const s of ["", "a", "hello world", "ünïcødé ✓ 🙂", "x".repeat(10000)]) {
    for (const seed of [0, 1, 42]) assert.equal(core.getStringHash(s, seed), dls.getStringHash(s, seed));
  }
});

const CARD = {
  spec: "chara_card_v2",
  data: {
    name: "Tester",
    description: "A test\r\ncharacter.  ",
    personality: "curious",
    scenario: "",
    first_mes: "Hi!",
    mes_example: "",
    alternate_greetings: ["Hello", "", "Yo"],
    character_book: { entries: [{ keys: ["a", " b"], secondary_keys: [], content: "Lore" }] },
    creator: "someone",
    tags: ["x"],
    extensions: {},
  },
};

test("contentHash matches Dupe Link Skip for V2, V1 and Marinara-shaped data", () => {
  const h = core.contentHash(CARD);
  assert.match(h, /^[0-9a-z]+\.[0-9a-z]+$/);
  assert.equal(h, dls.contentHash(structuredClone(CARD)));
  assert.equal(core.contentHash(CARD.data), h, "data object alone hashes the same");
  const v1 = { ...CARD.data };
  delete v1.extensions;
  assert.equal(core.contentHash(v1), dls.contentHash(v1));
});

test("contentHash ignores metadata and empty cards", () => {
  const other = structuredClone(CARD);
  other.data.creator = "else";
  other.data.tags = ["y"];
  other.data.creator_notes = "notes";
  assert.equal(core.contentHash(other), core.contentHash(CARD));
  other.data.first_mes = "Changed";
  assert.notEqual(core.contentHash(other), core.contentHash(CARD));
  assert.equal(core.contentHash({ name: "Only a name" }), "");
  assert.equal(core.contentHash(null), "");
});

test("contentHash prefers a saved hash (ours, then Dupe Link Skip's)", () => {
  const card = structuredClone(CARD);
  card.data.extensions.dupe_link_skip = { content_hash: "old.hash" };
  assert.equal(core.contentHash(card), "old.hash");
  card.data.extensions.char_importer = { content_hash: "new.hash" };
  assert.equal(core.contentHash(card), "new.hash");
  assert.equal(core.contentHash(card, { ignoreSaved: true }), core.contentHash(CARD));
});

test("findAssetLinks flags asset hosts and asset words, skips images and blacklist", () => {
  const notes = [
    "Sprites here: https://files.catbox.moe/pack.zip.",
    "My ko-fi https://ko-fi.com/me and art https://example.com/pic.png",
    "Download the expression pack at https://example.com/stuff",
    "Random https://example.org/page with nothing",
    "Dupe https://files.catbox.moe/pack.zip",
  ].join("\n\n".repeat(30));
  const found = plain(core.findAssetLinks(notes, core.DEFAULT_LINK_BLACKLIST, []));
  assert.deepEqual(found.map((f) => f.url), ["https://files.catbox.moe/pack.zip", "https://example.com/stuff"]);
  assert.deepEqual(plain(core.findAssetLinks(notes, core.DEFAULT_LINK_BLACKLIST, ["https://example.com/stuff"])).map((f) => f.url), [
    "https://files.catbox.moe/pack.zip",
  ]);
  assert.equal(core.isLinkIgnored("https://sub.patreon.com/x", ["patreon.com"], []), true);
  assert.equal(core.isLinkIgnored("https://example.com/a/b", ["example.com/a"], []), true);
  assert.equal(core.isLinkIgnored("https://notpatreon.com/x", ["patreon.com"], []), false);
});

test("findDuplicateSets groups by key and hash", () => {
  const { identical, differing } = plain(
    core.findDuplicateSets([
      { id: "a", keys: ["chub:x/y"], hash: "h1", created: 3 },
      { id: "b", keys: ["chub:x/y"], hash: "h1", created: 1 },
      { id: "c", keys: [], hash: "h1", created: 2 },
      { id: "d", keys: ["chub:x/y"], hash: "h2", created: 4 },
      { id: "e", keys: ["chublore:x/y"], hash: "", created: 5 },
      { id: "f", keys: ["chublore:x/y"], hash: "", created: 6 },
      { id: "g", keys: ["risu:z"], hash: "", created: 7 },
    ]),
  );
  assert.deepEqual(identical.map((s) => s.map((e) => e.id)), [["b", "c", "a"]]);
  assert.deepEqual(differing.map((s) => s.map((e) => e.id)), [["b", "c", "a", "d"]]);
});

test("parseLinks splits lines, trims and drops repeats", () => {
  assert.deepEqual(plain(core.parseLinks(" a \n\nb\r\na\n  \nc")), ["a", "b", "c"]);
});

test("chubPacks and packEntries skip stock images", () => {
  const chub = {
    expressions: { expressions: { joy: "https://x/joy.png", sad: "https://lfs.charhub.io/lfs/88/emotions/sad.png", "": "https://x/y.png" } },
    alt_expressions: { Summer: { expressions: { joy: "https://x/s.png" } }, Empty: null },
  };
  const packs = core.chubPacks(chub);
  assert.deepEqual(plain(packs.map((p) => p.sub)), [null, "Summer"]);
  assert.deepEqual(plain(core.packEntries(packs[0].pack)), [["joy", "https://x/joy.png"]]);
});

test("composeImportTags keeps canonicals and filters other tags by mode", () => {
  const mapped = { canonical: ["Female", "Elf"], other: ["Cozy", "Dark Knight", "female "] };
  assert.deepEqual(plain(core.composeImportTags(mapped, "all")), ["Female", "Elf", "Cozy", "Dark Knight"]);
  assert.deepEqual(plain(core.composeImportTags(mapped, "existing", new Set(["cozy"]))), ["Female", "Elf", "Cozy"]);
  assert.deepEqual(plain(core.composeImportTags(mapped, "none")), ["Female", "Elf"]);
  assert.deepEqual(plain(core.composeImportTags({}, "all")), []);
});

test("stImagePath decodes Dupe Link Skip paths", () => {
  assert.deepEqual(plain(core.stImagePath("/user/images/%20Monster%20Academy/embed-x.png")), { folder: " Monster Academy", file: "embed-x.png" });
  assert.deepEqual(plain(core.stImagePath("/user/images/embed-x.png")), { folder: "", file: "embed-x.png" });
  assert.equal(core.stImagePath("https://i.ibb.co/x.png"), null);
  assert.equal(core.stImagePath("/user/images/"), null);
});

test("pickStFile prefers the exact folder, then a matching one, then any", () => {
  const index = core.stFileIndex([
    { path: "images/Airi6/embed-a.png", file: "airi6-a" },
    { path: "images/Other/embed-a.png", file: "other-a" },
    { path: "images/Airi/embed-b.png", file: "airi-b" },
    { path: "images/Zed/embed-b.png", file: "zed-b" },
    { path: "images/ Monster Academy/embed-c.png", file: "monster-c" },
    { path: "images/Somewhere/embed-d.png", file: "any-d" },
    { path: "images/embed-e.png", file: "root-e" },
  ]);
  const pick = (path, name) => core.pickStFile(core.stImagePath(path), index, name);
  assert.equal(pick("/user/images/Airi6/embed-a.png", "Airi"), "airi6-a");
  assert.equal(pick("/user/images/Airi3/embed-b.png", "Airi"), "airi-b");
  assert.equal(pick("/user/images/Monster%20Academy/embed-c.png", "Monster Academy"), "monster-c");
  assert.equal(pick("/user/images/Nobody/embed-d.png", "Nobody"), "any-d");
  assert.equal(pick("/user/images/embed-e.png", "X"), "root-e");
  assert.equal(pick("/user/images/Airi/embed-zzz.png", "Airi"), null);
  // Picking the parent of "images" keys the same way
  const parent = core.stFileIndex([{ path: "user/images/Airi6/embed-a.png", file: "p" }]);
  assert.equal(core.pickStFile(core.stImagePath("/user/images/Airi6/embed-a.png"), parent), "p");
});

test("normalizeSource and keysFromCard know Botbooru", () => {
  assert.equal(core.normalizeSource("https://botbooru.com/character/97064"), "botbooru:97064");
  assert.equal(core.normalizeSource("https://www.botbooru.com/post/97064"), "botbooru:97064");
  assert.equal(core.normalizeSource("https://botbooru.com/download/png/97064"), "botbooru:97064");
  assert.equal(core.normalizeSource("https://botbooru.com/wiki?t=meta"), "url:botbooru.com/wiki?t=meta");
  assert.equal(core.normalizeSource("https://botbooru.com/profile/12695"), "botbooruuser:12695");
  // A Botbooru re-upload of a Chub card answers to both
  const keys = plain(core.keysFromCard({ extensions: { botbooru: { post_id: 97064 }, chub: { full_path: "DerpyOrangeCat/n-o-v-a-631623cf289c" } } }));
  assert.ok(keys.includes("botbooru:97064"));
  assert.ok(keys.includes("chub:derpyorangecat/n-o-v-a-631623cf289c"));
  // Links recorded on a copy found identical elsewhere
  const linked = plain(core.keysFromCard({ extensions: { char_importer: { source_key: "chub:a/b", also_keys: ["botbooru:5", 7] } } }));
  assert.deepEqual(linked, ["chub:a/b", "botbooru:5"]);
  // Obsolete (merged-away) links still count
  const merged = plain(core.keysFromCard({ extensions: { char_importer: { source_key: "chub:a/b", obsolete_keys: ["botbooru:9"] } } }));
  assert.deepEqual(merged, ["chub:a/b", "botbooru:9"]);
  assert.equal(core.botbooruUploader({ data: { extensions: { botbooru: { full_path: "Jenkitsune/97064" } } } }), "jenkitsune");
});

test("normTag spells tags the way Botbooru does", () => {
  assert.equal(core.normTag("  Game Character "), "game_character");
  assert.equal(core.normTag("NTR"), "ntr");
  assert.equal(core.normTag("general:cute"), "cute");
  assert.equal(core.normTag("Writer:SomeOne"), "someone");
});

test("normName matches names across punctuation, case and spacing", () => {
  assert.equal(core.normName("  Lirael   Sunfire!! "), "lirael sunfire");
  assert.equal(core.normName("LIRAEL-sunfire"), "lirael sunfire");
  assert.equal(core.normName(undefined), "");
});

test("a repost carrying the original's key as also_keys is grouped with it", () => {
  const { identical, differing } = plain(
    core.findDuplicateSets([
      { id: "orig", keys: ["chub:author/card"], hash: "h1", created: 1 },
      { id: "repost", keys: ["botbooru:5", "chub:author/card"], hash: "h2", created: 2 },
    ]),
  );
  assert.equal(identical.length, 0);
  assert.deepEqual(differing.map((g) => g.map((e) => e.id)), [["orig", "repost"]]);
});

test("owned list packs, reads back, and refuses damaged copies", async () => {
  const paths = Array.from({ length: 20000 }, (_, i) => `creator${i % 900}/some-card-slug-${i}`);
  const botbooru = Array.from({ length: 3000 }, (_, i) => String(100000 + i));
  const packed = await core.packOwned(paths, botbooru, 123);
  const plainSize = JSON.stringify({ paths, botbooru }).length;
  assert.ok(JSON.stringify(packed).length < plainSize / 3, `packed ${JSON.stringify(packed).length} of ${plainSize}`);
  const back = await core.unpackOwned(JSON.parse(JSON.stringify(packed)));
  assert.deepEqual([...back.paths], paths);
  assert.deepEqual([...back.botbooru], botbooru);
  assert.equal(back.updated, 123);
  // The older plain list still reads
  assert.deepEqual([...(await core.unpackOwned({ paths: ["a/b"], botbooru: ["1"] })).paths], ["a/b"]);
  // A flipped byte in the middle: gzip's CRC (or inflate) catches it
  const bin = atob(packed.data);
  const mid = bin.length >> 1;
  const flipped = btoa(bin.slice(0, mid) + String.fromCharCode(bin.charCodeAt(mid) ^ 0x40) + bin.slice(mid + 1));
  await assert.rejects(core.unpackOwned({ ...packed, data: flipped }));
  // Cut short, or counts that don't match
  await assert.rejects(core.unpackOwned({ ...packed, data: packed.data.slice(0, -400) }));
  await assert.rejects(core.unpackOwned({ ...packed, count: packed.count + 1 }));
  await assert.rejects(core.unpackOwned({ ...packed, format: "something-else" }));
});

test("the userscript's unpackOwned reads what the extension packs", async () => {
  const src = readFileSync(join(ROOT, "userscript/CharImporter-companion.user.js"), "utf8");
  const fn = src.match(/ {2}const OWNED_FORMAT = [\s\S]*?\n {2}async function unpackOwned\(stored\) \{[\s\S]*?\n {2}\}\n/)[0];
  const unpack = new Function(`${fn}; return unpackOwned;`)();
  const packed = await core.packOwned(["x/y", "z/w"], ["7"], 5);
  assert.deepEqual(await unpack(packed), { paths: ["x/y", "z/w"], botbooru: ["7"], updated: 5 });
  await assert.rejects(unpack({ ...packed, botbooruCount: 0 }));
});
