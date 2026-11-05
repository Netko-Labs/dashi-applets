/**
 * bun scripts/build-index.ts [--repo OWNER/NAME] [--out DIR] [--sign-with KEY]:
 * index.json from every applet's folder (README.md, "index.json"), with the
 * release assets' and raw files' addresses on GitHub. CI signs it with
 * Dashi's key using the minisign tool; --sign-with signs it with an
 * unencrypted key, for tests and test catalogs only.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AppletFolder, readCatalog } from "./folders.ts";
import { type CatalogIndex, compareVersions, INDEX_FORMAT, manifestJson, parseIndex, sign } from "./sdk.ts";

export const releaseTag = (id: string, version: string): string => `${id}-${version}`;

export function indexEntry(applet: AppletFolder, repo: string): Record<string, unknown> {
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
      // The newest manifest's range stands for every version until the folders keep each version's.
      dashi: applet.manifest.dashi,
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
  if (problems.length > 0) throw new Error(problems.map(({ id, problem }) => `${id}: ${problem}`).join("\n"));
  const value = { format: INDEX_FORMAT, generated: now.toISOString(), applets: applets.map((applet) => indexEntry(applet, repo)) };
  // What the store will parse, parsed here first: a bad index never ships.
  const index = parseIndex(value);
  if ("error" in index) throw new Error(`the index doesn't parse: ${index.error}`);
  return value as unknown as CatalogIndex;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const out = flag("--out") ?? "dist";
  const index = buildIndex(process.cwd(), flag("--repo") ?? "Netko-Labs/dashi-applets");
  mkdirSync(out, { recursive: true });
  const bytes = new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(join(out, "index.json"), bytes);
  const key = flag("--sign-with");
  if (key) writeFileSync(join(out, "index.json.minisig"), sign(bytes, readFileSync(key, "utf8"), `dashi-applets index ${index.generated}`));
  console.error(`✓ ${join(out, "index.json")}: ${index.applets.length} applet${index.applets.length === 1 ? "" : "s"}${key ? ", signed" : ""}`);
}
