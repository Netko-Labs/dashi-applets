/**
 * bun scripts/rebuild.ts ID VERSION [--out DIR]: builds a version from its
 * source and refuses it unless it is the package the author signed.
 *
 *   1. fetch the source repository at the commit source.json pins;
 *   2. point its `file:` dependencies on Dashi's SDK and mirin at the
 *      commits versions/VERSION.json's `sdk` names (pack bundles both, so
 *      they are part of the bytes), fetched alone; without `sdk`, at the
 *      checkouts CI has (DASHI_SDK_DIR, MIRIN_DIR; ../dashiOS and ../mirin);
 *   3. `bun install --frozen-lockfile` if it has a lockfile, else `bun install`;
 *   4. pack it with the SDK, the pinned Dashi's own when `sdk` is given
 *      (reproducible: the same source, SDK and Bun make the same bytes, from
 *      any folder), and compare with versions/VERSION.json;
 *   5. check the author's signature on those bytes.
 *
 * With --out, the package and its .minisig are written there for the release.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFolder } from "./folders.ts";
import { pack } from "./sdk.ts";
import { verifyBytes } from "./verify.ts";

const run = (argv: string[], cwd: string): void => {
  const result = Bun.spawnSync(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed`);
};

/** The applet's package.json with its file: dependencies on Dashi and mirin pointed at these checkouts. */
export function pointDependencies(text: string, sdk: string, mirin: string): string {
  const pkg = JSON.parse(text) as Record<string, Record<string, string> | unknown>;
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg[field] as Record<string, string> | undefined;
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      const dashi = /^file:.*\/dashiOS\/(packages\/[\w-]+)$/.exec(spec);
      const mirinPath = /^file:.*\/mirin\/(packages\/[\w-]+)$/.exec(spec);
      if (dashi?.[1]) deps[name] = `file:${join(sdk, dashi[1])}`;
      else if (mirinPath?.[1]) deps[name] = `file:${join(mirin, mirinPath[1])}`;
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** `commit` of `url`, fetched alone into `dir`. */
function fetchAt(url: string, commit: string, dir: string): string {
  mkdirSync(dir, { recursive: true });
  run(["git", "init", "-q"], dir);
  run(["git", "fetch", "-q", "--depth", "1", url, commit], dir);
  run(["git", "checkout", "-q", "FETCH_HEAD"], dir);
  return dir;
}

const DASHI_REPO = process.env.DASHI_REPO_URL ?? "https://github.com/Netko-Labs/dashiOS";
const MIRIN_REPO = process.env.MIRIN_REPO_URL ?? "https://github.com/Netko-Labs/mirin";

export async function rebuild(root: string, id: string, version: string, out?: string): Promise<string> {
  const folder = readFolder(root, id);
  if (typeof folder === "string") throw new Error(`${id}: ${folder}`);
  const listed = folder.versions.find((each) => each.version === version);
  if (!listed) throw new Error(`${id} has no version ${version}`);
  const pinned = listed.sdk;
  // Side by side as `dashiOS` and `mirin`: Dashi's packages name mirin's as ../mirin.
  const sides = pinned ? mkdtempSync(join(tmpdir(), "sdk-")) : null;
  const sdk = sides && pinned ? fetchAt(DASHI_REPO, pinned.dashiOS, join(sides, "dashiOS")) : resolve(process.env.DASHI_SDK_DIR ?? join(root, "../dashiOS"));
  const mirin = sides && pinned ? fetchAt(MIRIN_REPO, pinned.mirin, join(sides, "mirin")) : resolve(process.env.MIRIN_DIR ?? join(root, "../mirin"));
  // Beside them too, as the author's folder is beside their checkouts: the bundle names each module by its path from here.
  const work = sides ? join(sides, "applet") : mkdtempSync(join(tmpdir(), `rebuild-${id}-`));
  mkdirSync(work, { recursive: true });
  run(["git", "init", "-q"], work);
  run(["git", "fetch", "-q", "--depth", "1", folder.source.url, folder.source.commit], work);
  run(["git", "checkout", "-q", "FETCH_HEAD"], work);
  const pkgPath = join(work, "package.json");
  writeFileSync(pkgPath, pointDependencies(readFileSync(pkgPath, "utf8"), sdk, mirin));
  run(["bun", "install"], work);
  // Packed by the pinned Dashi's own SDK, as the author's Dashi packed it.
  const packWith: typeof pack = pinned ? ((await import(join(sdk, "packages/applet/src/package.ts"))) as { pack: typeof pack }).pack : pack;
  const packed = await packWith(work);
  if (packed.manifest.id !== id || packed.manifest.version !== version) throw new Error(`the source at ${folder.source.commit} is ${packed.manifest.id} ${packed.manifest.version}`);
  if (packed.sha256 !== listed.sha256 || packed.bytes.byteLength !== listed.size)
    throw new Error(`${id} ${version}: the source builds to sha256 ${packed.sha256} (${packed.bytes.byteLength} bytes), not the package the author signed (${listed.sha256})`);
  const signed = verifyBytes(packed.bytes, listed.signature, folder.authorKey);
  if (signed !== true) throw new Error(`${id} ${version}: ${signed}`);
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, packed.name), packed.bytes);
    writeFileSync(join(out, `${packed.name}.minisig`), listed.signature);
  }
  return packed.sha256;
}

if (import.meta.main) {
  const [id, version, ...rest] = Bun.argv.slice(2);
  const at = rest.indexOf("--out");
  if (!id || !version) {
    console.error("bun scripts/rebuild.ts ID VERSION [--out DIR]");
    process.exit(2);
  }
  try {
    const digest = await rebuild(process.cwd(), id, version, at >= 0 ? rest[at + 1] : undefined);
    console.error(`✓ ${id} ${version} is its source (sha256 ${digest})`);
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
