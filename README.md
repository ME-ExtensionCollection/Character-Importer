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
  A queue that was running when you reloaded (say, to update extensions)
  carries on by itself, finishing the card that was cut off instead of
  importing it twice. One you stopped, or one left for over 10 minutes,
  comes back paused with Resume and Dismiss (dismissed links stay listed for
  "Copy remaining" until you press Clear). Only one Marinara tab runs the
  queue at a time. "Resume the import queue after a reload" in settings
  turns the automatic part off.
- **Library tools:** fetch assets for characters imported earlier, retry
  images that failed, and **Flag duplicates**, which merges identical copies
  (gallery, sprites, tags, favorite, lorebook links), backs each one up in
  your browser, then deletes it. Copies used in chats or groups are never
  deleted.
- **Failed card images:** in View failed…, each card can be retried, opened
  in Marinara's editor, or have its failed links removed (images the author
  deleted); each link can be edited to fix a typo and retried. Changes to the
  card text are saved as a new version, so they can be reverted.
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
AICharacterCards, Botbooru, GitHub, and direct links to PNG or JSON cards.

Botbooru cards (with their embedded lorebook) download without an account.
Their gallery is only shown to logged-in users, so it's read through the
companion userscript with your Botbooru login. Botbooru keeps that login
in the page rather than a cookie, so the userscript copies it whenever you
open botbooru.com: log in there once, in the browser Marinara is open in.
Without it, the import says so and offers the login page or to ignore
Botbooru galleries (Tools → Import turns them back on); Fetch assets picks
up skipped galleries later.

A Botbooru profile link (`botbooru.com/profile/<id>`) queues every card
that creator uploaded, newest first, leaving out cards already in your
library or already queued. It needs the same login: logged out, Botbooru
lists only a creator's few safe-for-work cards, so the import stops and
says so rather than queueing part of the list. Tags listed under "Leave out of
profile imports" (Tools → Import) skip a creator's cards that have them;
pasting one of those cards on its own still imports it.
Other extensions can add to that list through `window.marinaraCharImporter`
(`addProfileTagBlacklist(tags)`, `isOnProfileTagBlacklist(tag)`,
`profileTagBlacklist()`); Char Triage uses it for its "Tags you delete" list.

A card that names another source you already have (such as a Botbooru
re-upload of a Chub card) is skipped only if it's identical. The skipped
link is then recorded on your copy, so later imports, profile imports and
hiding owned cards know the card from there too. The same goes for cards
skipped by "Also skip cards with identical content", and for an unchanged
Botbooru fork of a card you have (skipped as irrelevant; a fork with
changes is imported and noted as one).

**Botbooru repost accounts** (Tools → Import): archivist accounts that
repost other people's cards. Their cards still import, since a repost may
keep images the original lost or come from another source. One that
differs from a card you have, shares no link with it, but has the same
name and creator is linked to it as a duplicate, and Flag duplicates
keeps the author's copy rather than the repost.

**Copies that differ** (Flag duplicates → "Same link, different
content"): pick the copy to keep (newest non-repost by default) and tick
"Merge the others into the chosen copy". Their gallery, sprites, tags and
lorebook links move over, their links are recorded on the kept copy as
obsolete (still hidden on Chub and Botbooru, never imported or offered as
an update again), and each is backed up in this browser before it's
deleted. Creators who
moved from Chub often updated their cards on Botbooru, so a copy that
differs is imported and noted as a possible update; Flag duplicates groups
the two (they share the Chub link) so you can compare or keep both.

Botbooru's own "Downloaded" filter only knows cards downloaded with your
Botbooru login, so imports send it. A Botbooru link you already have isn't
simply skipped if Botbooru doesn't have it down as downloaded (e.g. it was
imported without your login): it's downloaded with your login and compared
with your copy, skipped (now marked) if identical, imported as a possible
update if not. Profile imports use Botbooru's record the same way: cards
it has as downloaded are left out, ones changed since are queued as
updates. **Tools → Assets → Tell Botbooru which cards you have** does this
once for every Botbooru card already in the library, and offers to queue
the ones that changed.
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
- **On Botbooru** it does the same for cards imported from Botbooru
  (Marinara only). A Botbooru re-upload of a Chub card you have isn't
  hidden: the list doesn't say where a card came from, and it may be an
  updated version anyway.
- **On Marinara** it downloads for the extension from sites that block
  downloads from the Marinara page (RisuRealm, AICharacterCards, most image
  hosts, Chub's gallery API, Botbooru). Requests are GET only, without your
  cookies, never to local network addresses, and the first time a page asks
  you're asked to allow it. The one exception is a few read-only Botbooru
  addresses (character pages, card downloads, creators' card lists and the
  login check), which carry your Botbooru login for galleries, full creator
  lists, and so imports count as downloads on your Botbooru account (its
  "Downloaded" filter and "Only updated" view then know about them); you're asked once before that happens. The
  userscript copies the login from botbooru.com pages beforehand (so the
  first import has it) and deletes it if you say no. The userscript menu can revoke either, or limit downloads
  to known card and image sites.

If Marinara or SillyTavern runs on an address the `@match` lines don't
cover, add a line for it, e.g. `// @match *://192.168.1.10:7860/*`
(`*://` matches both http and https).

### Chub in another browser

To hide owned cards (Chub and Botbooru) in a browser that doesn't have Marinara open, install
the userscript there too, then:

1. In Marinara, open Char Importer → Tools → Companion userscript and copy
   the "Chub in another browser" sync address.
2. In the other browser, pick "Char Importer: set Marinara sync address" from
   the userscript menu and paste it.

Chub pages there fetch the list from Marinara at most every 30 seconds
("sync owned list now" forces it). Marinara saves the list whenever Char
Importer runs, so keep using it as usual in your main browser. If Marinara
runs on the same computer, use `127.0.0.1` as the host so no login is
needed; otherwise sign in to Marinara once in that browser. With a
self-signed certificate, open the address once there to accept it.

Without the userscript, Chub cards, JanitorAI, Pygmalion, Wyvern and
DataCat still work (Marinara's server fetches those), and card images are
saved through Marinara's server. Sprites from blocked hosts are fetched
through a temporary gallery copy.

## Turning Marinara off when the queue finishes

While the queue runs and the watcher script below is running, the queue
panel has **Turn off Marinara when done** (for that session only; without
a watcher it isn't shown). When the queue finishes on its own, not when you stop
it, the panel counts down 30 seconds (with Cancel), then writes a request
to Char Importer's storage on the server. Marinara can't stop itself from
the page, so a small script on the server's computer does the stopping:

```sh
# from any folder, while Marinara runs; the address is under Tools → Companion userscript
node /path/to/CharImporter/tools/shutdown-watcher.mjs \
  "https://127.0.0.1:7860/api/personal-extensions/<id>/storage"
```

It uses no packages. Besides a heartbeat in the same storage (every 30
seconds, cleared when it exits), which is how the queue knows to offer the
checkbox, it writes nothing. It checks every 10 seconds, and
on a request made after it started finds the process listening on the
address's port (Linux, or wherever `lsof` exists) and sends it SIGINT (as
Ctrl+C does, so saves are flushed), then SIGTERM if it's still running a
minute later. If Marinara runs in Docker or as another user, give
`--pid <id>`, or start Marinara through the watcher with
`--cwd /path/to/Marinara-Engine -- pnpm start`. `--then "systemctl poweroff"` runs a command afterwards. Use
`127.0.0.1` as the host so no login is needed; its self-signed
certificate is accepted there (`--insecure` for other hosts).

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
