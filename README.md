# Char Importer for Marinara Engine

Import characters by pasting links, skip the ones you already have, and pull
in their Chub extras. This is a port of the SillyTavern **Dupe Link Skip**
extension: same link keys and content hashes, so both agree on what counts
as a duplicate.

Browse a card site as usual, copy links, paste them all at once:

- **Duplicate links are skipped.** `chub.ai` vs `characterhub.org`, `www`,
  trailing slashes and bare `creator/slug` IDs all count as the same link.
  Cards you got from Marinara's own card browser count too.
- **Identical cards are skipped** (optional): the same card text from a
  different site or link.
- **Chub extras:** expression packs become sprites, the Chub gallery goes to
  the character's gallery, linked lorebooks are downloaded once and linked.
- **Card images saved locally:** images in the card text are stored in the
  character's gallery and the text points at the local copies. Greetings use
  Marinara's own format, so a compatible export restores the web links.
- **Asset links:** links in creator notes that look like sprite packs or file
  hosts are listed (and the character tagged) so you can grab them by hand.
- **Tidy tags with Tag Merger** (optional, needs the Tag Merger extension
  enabled): tags that match one of its canonicals become that canonical,
  plus its implications, and always stay. Other tags are standardized and
  follow the Card tags choice, so "No card tags" keeps only canonicals.
  Tag Merger's Removed list isn't applied here.
- **Import queue:** links run one at a time; the queue survives reloads.
  After a reload, Resume finishes the card that was cut off instead of
  importing it twice.
- **Library tools:** fetch assets for characters imported earlier, retry
  images that failed, and **Flag duplicates**, which merges identical copies
  (gallery, sprites, tags, favorite, lorebook links), backs each one up in
  your browser, then deletes it. Copies used in chats or groups are never
  deleted.
- **Coming from SillyTavern:** cards whose images Dupe Link Skip saved on the
  SillyTavern server show `/user/images/…` paths that Marinara doesn't have.
  In Tools → Assets → SillyTavern import, pick SillyTavern's
  `data/<user>/user/images` folder and choose Restore from folder. Images are
  matched by file name, so ones under a numbered folder (`Airi6` for `Airi`)
  are found too, and Chub gallery images SillyTavern saved are uploaded so
  Fetch assets skips them. Card images not found are listed: pick a folder for that card,
  or reset its links to the original web links so Retry failed images
  downloads them.

Supported links: Chub characters and lorebooks, JanitorAI / JannyAI,
Pygmalion, Wyvern, DataCat, RisuRealm (PNG or `.charx`),
AICharacterCards, GitHub, and direct links to PNG or JSON cards.
Not yet: Perchance, and Chub expression packs that only come as a zip.

## Install

Char Importer needs to read other websites and create characters, which
only Marinara's **full page access** extensions can do. That runs it with the
same rights as Marinara itself, so Marinara asks you to turn on two
switches first:

1. Set `ENABLE_EXTERNAL_EXTENSIONS=true` in Marinara's `.env` and restart.
2. **Settings → Advanced → Danger Zone → Allow third-party extension imports.**
3. **Settings → Addons → External Extensions → Import Extension Folder**, pick
   this repo's `extension/` folder (or **Import Extension File** with the zip
   from `npm run pack`).
4. **Review and Run**, and approve.

A button with an import arrow appears in the top bar, next to Settings.
Click it to paste links; right-click (or Shift+click) for settings and tools.
Marinara's own *Import Character* dialog also gets an "Import from links"
card at the top.

### Companion userscript (recommended)

`userscript/CharImporter-companion.user.js`, for Violentmonkey or
Tampermonkey. It replaces the Dupe Link Skip Chub userscript and works for
SillyTavern too.

- **On Chub** it hides cards you already own (from Marinara and SillyTavern
  both). The banner above the list shows them again.
- **On Marinara** it downloads for the extension from sites that block
  downloads from the Marinara page (RisuRealm, AICharacterCards, most image
  hosts, Chub's gallery API). Requests are GET only, without your cookies,
  never to local network addresses, and the first time a page asks you're
  asked to allow it. The userscript menu can revoke that, or limit downloads
  to known card and image sites.

If Marinara or SillyTavern runs on an address the `@match` lines don't
cover, add a line for it, e.g. `// @match *://192.168.1.10:7860/*`
(`*://` matches both http and https).

### Chub in another browser

To hide owned cards in a browser that doesn't have Marinara open, install
the userscript there too, then:

1. In Marinara, open Char Importer → Tools → Companion userscript and copy
   the "Chub in another browser" sync address.
2. In the other browser, pick "Char Importer: set Marinara sync address" from
   the userscript menu and paste it.

Chub pages there fetch the list from Marinara at most every 5 minutes
("sync owned list now" forces it). Marinara saves the list whenever Char
Importer runs, so keep using it as usual in your main browser. If Marinara
runs on the same computer, use `127.0.0.1` as the host so no login is
needed; otherwise sign in to Marinara once in that browser. With a
self-signed certificate, open the address once there to accept it.

Without the userscript, Chub cards, JanitorAI, Pygmalion, Wyvern and
DataCat still work (Marinara's server fetches those), and card images are
saved through Marinara's server. Sprites from blocked hosts are fetched
through a temporary gallery copy.

## Things that work differently from SillyTavern

- Marinara shows the sprite whose name matches the expression. The first
  expression pack becomes the character's sprites; alternate packs are kept
  in sprite folders named `Chub - <name>` but aren't shown in chat, and there
  is no outfit switcher.
- Settings follow your Marinara install; the library index, import queue,
  failed images and duplicate backups are kept in this browser.
- Marinara doesn't announce new or deleted characters, so the index catches
  up before each import run (or with **Library → Load new**).

## Development

```
npm run check     # compile check of the joined source + unit tests
npm run pack      # dist/char-importer-<version>.zip + the userscript
```

`scripts/deploy.mjs` pushes the extension into a running Marinara **and
approves it**, skipping the review dialog. Use it only on your own install,
for your own code:

```
ME_URL=http://127.0.0.1:7860 [ADMIN_SECRET=...] node scripts/deploy.mjs
```

then reload the Marinara tab.

`scripts/e2e.mjs` drives the real UI in Chrome against a **throwaway**
Marinara (it empties the library, imports, merges and deletes). Run Marinara
with its own data folder and port (`MARINARA_ENV_FILE` pointing at an env
file with `PORT`, `DATA_DIR`, `ENABLE_EXTERNAL_EXTENSIONS=true`), then:

```
ME_URL=http://127.0.0.1:7871 PLAYWRIGHT_CORE=/path/to/playwright-core \
CHROME=/usr/bin/google-chrome-stable node scripts/e2e.mjs
```

Stages: `import`, `again`, `content`, `bridge`, `duplicates`, `resume`
(pick with `STAGES=a,b`). Needs internet.

All source files share one function scope (Marinara joins the manifest's
`jsPath` files and wraps them in one async function), so each file defines
one `ci*` namespace and nothing uses `import`/`export`.
