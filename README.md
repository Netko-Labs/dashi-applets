# dashi-applets

Dashi's applet catalog: what the Applet Store lists and installs. No server:
this repository is the catalog, its pull requests are the review, its
releases hold the packages, and CI builds the index the store reads from the
`index` branch (`https://raw.githubusercontent.com/Netko-Labs/dashi-applets/index/index.json`).

The SDK, the protocol, the manifest, and the sandbox are in Dashi's
repository: `docs/applets.md` and `packages/applet` (Netko-Labs/dashiOS).

## Publishing an applet

```sh
cd my-applet                      # its own git repository, pushed, with author.pub in it
bun run publish                   # dashi-applet publish: packs, signs, and prepares the pull request here
git -C ../dashi-applets push -u origin publish/<id>-<version>
gh pr create --repo Netko-Labs/dashi-applets
```

`dashi-applet publish` never pushes; it writes the applet's folder on a new
branch of your checkout of this repository and says what to run.

## An applet's folder

```
applets/<id>/applet.json            the manifest (its schema: dashiOS packages/applet/manifest.schema.json)
applets/<id>/source.json            {"url": "https://github.com/OWNER/REPO", "commit": "<40 hex>"}: what CI builds
applets/<id>/author.pub             the author's minisign public key; the first pull request sets it, none changes it
applets/<id>/versions/<v>.json      {"sha256", "size", "released", "bun", "notes"?}: the package the author built
applets/<id>/versions/<v>.minisig   the author's signature on that package
applets/<id>/screenshots/…, icon    what applet.json names
applets/<id>/review.json            {"reviewed": true, "by": "…"}: maintainers only (CODEOWNERS)
applets/<id>/pulled.json            [{"version", "reason"}]: maintainers only, the kill switch
```

## What CI checks (`.github/workflows/catalog.yml`)

On every pull request, `scripts/check.ts`:

- every folder reads: the manifest validates, the folder is its id, the
  source is a pinned GitHub commit, the key is a minisign key;
- every version's signature is the author's key's, with the trusted comment
  `dashi-applet <id> <version> sha256:<hex>` naming it;
- it was built with the catalog's Bun (`package.json`'s `packageManager`);
- against the base: no `author.pub` changed (an update must be signed by the
  same key; a new key is a new applet), and no released version's files
  changed or went (a bad release is pulled, not rewritten).

Then `scripts/rebuild.ts` builds each new version from its source at the
pinned commit (its dependencies on Dashi's SDK and mirin pointed at CI's
checkouts of them), packs it with the SDK, and refuses it unless the bytes
are exactly the package the author signed. Packing is reproducible (sorted
names, fixed modes and times, the same Bun), so the package is its source.

On `main`, the publish job releases each new package as
`<id>-<version>.dashi-applet` and its `.minisig` in the release
`<id>-<version>`, builds `index.json` from every folder
(`scripts/build-index.ts`), signs it with Dashi's key, checks it the way the
store will (`scripts/verify-index.ts`), and commits both to the `index`
branch.

## index.json

Format 1, parsed by the store with dashiOS `packages/applet/src/catalog.ts`
(and by `build-index.ts` before it ships):

```json
{
  "format": 1,
  "generated": "2026-11-05T00:00:00Z",
  "applets": [{
    "manifest": { "id": "dev.netko.asus-control", "…": "the newest version's applet.json" },
    "authorKey": "RWQ…",
    "reviewed": true,
    "source": { "url": "https://github.com/Netko-Labs/asus-control", "commit": "…" },
    "icon": "https://raw.githubusercontent.com/Netko-Labs/dashi-applets/main/applets/…/icon.svg",
    "screenshots": ["https://raw.githubusercontent.com/…/screenshots/popover.png"],
    "versions": [{
      "version": "0.1.0", "dashi": ">=0.4", "released": "2026-11-04",
      "url": "https://github.com/Netko-Labs/dashi-applets/releases/download/dev.netko.asus-control-0.1.0/dev.netko.asus-control-0.1.0.dashi-applet",
      "sha256": "…", "size": 217088,
      "signature": "the author's .minisig, in full"
    }],
    "pulled": [{ "version": "0.0.9", "reason": "Drains the battery on the GA402" }]
  }]
}
```

`index.json.minisig` beside it is Dashi's signature. The store checks, before
anything runs: Dashi's signature on the index; the package's size and sha256;
the author's signature on it with the key the index lists; for an update,
that the key is the one the installed version was verified with. A pulled
version is never installed; where it is installed, the store turns it off and
offers the newest good one.

## Keys

All signatures are Ed25519 in minisign's format.

- **Dashi's index key.** Made once by the maintainers with
  `minisign -G -p keys/dashi-index.pub -s dashi-index.key` (encrypted with a
  passphrase) on an offline machine. The public half is committed here as
  `keys/dashi-index.pub` and in the Applet Store
  (dashiOS `packages/shell/src/applet-store/keys.ts`). The secret half and
  its passphrase are this repository's Actions secrets `DASHI_INDEX_KEY` and
  `DASHI_INDEX_KEY_PASSWORD`, in the `catalog-signing` environment, which
  only the publish job on `main` can use; keep an offline copy. To rotate:
  ship a Dashi that trusts both keys, switch the secrets, then drop the old
  key in a later Dashi. Until the key exists, the publish job stops at the
  signature check, and nothing is published.
- **An author's key.** `minisign -G -p author.pub -s ~/.minisign/<id>.key`,
  the public half committed in the applet's repository and copied here by
  `dashi-applet publish`, the secret half the author's alone. Sign each
  package with `minisign -S -s KEY -m dist/<id>-<version>.dashi-applet -t
  'dashi-applet <id> <version> sha256:<hex>'` (`dashi-applet pack` prints it).
  A lost key means publishing under a new id.
- **Throwaway keys** (`dashi-applet keygen`) are unencrypted and for trying
  things only. No secret key is ever committed here; the tests make theirs.

## Developing

The scripts import the SDK from a Dashi checkout beside this one
(`../dashiOS`). `bun test` builds a whole catalog from a test applet with
throwaway keys and checks it end to end.
