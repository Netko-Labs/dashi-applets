/**
 * bun scripts/build-index.ts [--repo OWNER/NAME] [--out DIR] [--sign-with KEY]:
 * index.json from every applet's folder (README.md, "index.json"), with the
 * release assets' and raw files' addresses on GitHub. CI signs it with
 * Dashi's key using the minisign tool; --sign-with signs it with an
 * unencrypted key, for tests and test catalogs only.
 *
 * Every entry is read here with the Dashi parser beside the catalog
 * (`../dashiOS`, CI's checkout of main) before anything is written. Dashi
 * 0.5's store skips an entry it can't read and lists the rest ("1 applet
 * needs a newer Dashi"), so the index would still check out with a bad entry
 * in it: here a skipped entry fails the build, and a bad entry never ships
 * unnoticed.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppletFolder, readCatalog } from "./folders.ts";
import { type CatalogIndex, compareVersions, INDEX_FORMAT, manifestJson, parseIndex, sign } from "./sdk.ts";

export const releaseTag = (id: string, version: string): string => `${id}-${version}`;

const git = (root: string, args: string[]): string | null => {
  const run = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return run.exitCode === 0 ? run.stdout.toString() : null;
};

/**
 * Each version's Dashi range, as its own applet.json named it. The folder
 * keeps only the newest applet.json, so an older version's range comes from
 * the history: the latest applet.json that named that version, among the
 * states the branch itself was in (first parent: on main, what was merged,
 * never a pull request's commits along the way). A version missing here has
 * no range anyone can vouch for, and buildIndex refuses it.
 */
export function dashiRanges(root: string, applet: AppletFolder): Map<string, string> {
  const ranges = new Map([[applet.manifest.version, applet.manifest.dashi]]);
  const wanted = (): boolean => applet.versions.some((each) => !ranges.has(each.version));
  if (!wanted()) return ranges;
  const path = `applets/${applet.id}/applet.json`;
  for (const commit of git(root, ["log", "--first-parent", "--format=%H", "--", path])?.split("\n").filter(Boolean) ?? []) {
    try {
      const named = JSON.parse(git(root, ["show", `${commit}:./${path}`]) ?? "") as Record<string, unknown>;
      if (typeof named.version === "string" && typeof named.dashi === "string" && !ranges.has(named.version)) ranges.set(named.version, named.dashi);
    } catch {
      // An applet.json that isn't JSON names no range.
    }
    if (!wanted()) break;
  }
  return ranges;
}

export function indexEntry(applet: AppletFolder, repo: string, ranges: Map<string, string>): Record<string, unknown> {
  const raw = (path: string): string => `https://raw.githubusercontent.com/${repo}/main/applets/${applet.id}/${path}`;
  const versions = [...applet.versions].sort((a, b) => compareVersions(b.version, a.version));
  return {
    manifest: manifestJson(applet.manifest),
    authorKey: applet.authorKey,
    reviewed: applet.reviewed,
    source: applet.source,
    ...(applet.manifest.icon ? { icon: raw(applet.manifest.icon) } : {}),
    screenshots: applet.manifest.screenshots.map(raw),
    versions: versions.map((each) => ({
      version: each.version,
      dashi: ranges.get(each.version),
      url: `https://github.com/${repo}/releases/download/${releaseTag(applet.id, each.version)}/${applet.id}-${each.version}.dashi-applet`,
      sha256: each.sha256,
      size: each.size,
      signature: each.signature,
      released: each.released,
      ...(each.notes ? { notes: each.notes } : {}),
    })),
    pulled: applet.pulled,
  };
}

export function buildIndex(root: string, repo: string, now = new Date()): CatalogIndex {
  const { applets, problems } = readCatalog(root);
  const messages = problems.map(({ id, problem }) => `${id}: ${problem}`);
  const entries = applets.map((applet) => {
    const ranges = dashiRanges(root, applet);
    for (const { version } of applet.versions.filter((each) => !ranges.has(each.version)))
      messages.push(`${applet.id} ${version}: no applet.json in the history names ${version}, so its Dashi range is unknown (the build needs the whole history: fetch-depth 0)`);
    return indexEntry(applet, repo, ranges);
  });
  if (messages.length > 0) throw new Error(messages.join("\n"));
  const value = { format: INDEX_FORMAT, generated: now.toISOString(), applets: entries };
  // What the store will parse, parsed here first: a bad index never ships.
  const index = parseIndex(value);
  if ("error" in index) throw new Error(`the index doesn't parse: ${index.error}`);
  // From Dashi 0.5 the parser skips an entry it can't read instead of refusing the index; here, that is still a refusal.
  const skipped = "skipped" in index ? (index.skipped as Array<{ id: string | null; reason: string }>) : [];
  if (skipped.length > 0)
    throw new Error(
      skipped
        .map(({ id, reason }) => `${id ?? "an applet"}: Dashi's store would skip it ("needs a newer Dashi") and list the rest: ${reason}`)
        .join("\n"),
    );
  return value as unknown as CatalogIndex;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const out = flag("--out") ?? "dist";
  let index: CatalogIndex;
  try {
    index = buildIndex(process.cwd(), flag("--repo") ?? "Netko-Labs/dashi-applets");
  } catch (error) {
    for (const line of (error instanceof Error ? error.message : String(error)).split("\n")) console.error(`✗ ${line}`);
    console.error("✗ no index was written");
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  const bytes = new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(join(out, "index.json"), bytes);
  const key = flag("--sign-with");
  if (key) writeFileSync(join(out, "index.json.minisig"), sign(bytes, readFileSync(key, "utf8"), `dashi-applets index ${index.generated}`));
  console.error(`✓ ${join(out, "index.json")}: ${index.applets.length} applet${index.applets.length === 1 ? "" : "s"}${key ? ", signed" : ""}`);
}
