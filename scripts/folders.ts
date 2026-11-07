/**
 * Reading the catalog: one folder per applet under applets/ (README.md,
 * "An applet's folder"), each checked field by field. Nothing is trusted
 * because it is in the repository: pull requests write it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Manifest, parsePublicKey, publicKeyLine, readManifest } from "./sdk.ts";

export interface VersionFile {
  version: string;
  sha256: string;
  size: number;
  released: string;
  /** The Bun that built it: the catalog rebuilds with the same. */
  bun: string;
  notes?: string;
  /** The Dashi and mirin commits it was built against (pack bundles both): the catalog rebuilds against the same. */
  sdk?: { dashiOS: string; mirin: string };
  /** The author's .minisig over the package. */
  signature: string;
}

export interface AppletFolder {
  id: string;
  dir: string;
  manifest: Manifest;
  source: { url: string; commit: string };
  /** The author's key, minisign's base64 line. */
  authorKey: string;
  versions: VersionFile[];
  reviewed: boolean;
  pulled: Array<{ version: string; reason: string }>;
}

export type Problem = { id: string; problem: string };

const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

function readVersion(dir: string, name: string): VersionFile | string {
  const version = name.replace(/\.json$/, "");
  const sigPath = join(dir, "versions", `${version}.minisig`);
  if (!existsSync(sigPath)) return `versions/${version}.minisig is missing`;
  const value = json(join(dir, "versions", name));
  const stray = Object.keys(value).find((key) => !["sha256", "size", "released", "bun", "notes", "sdk"].includes(key));
  if (stray) return `versions/${name} has an unknown field “${stray}”`;
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) return `versions/${name}: sha256 must be 64 hex digits`;
  if (typeof value.size !== "number" || !Number.isInteger(value.size) || value.size <= 0) return `versions/${name}: size is wrong`;
  if (typeof value.released !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.released)) return `versions/${name}: released must be YYYY-MM-DD`;
  if (typeof value.bun !== "string" || !/^\d+\.\d+\.\d+$/.test(value.bun)) return `versions/${name}: bun must be the Bun version that built it`;
  if (value.notes !== undefined && typeof value.notes !== "string") return `versions/${name}: notes must be text`;
  const sdk = value.sdk as Record<string, unknown> | undefined;
  const isCommit = (each: unknown): each is string => typeof each === "string" && /^[0-9a-f]{40}$/.test(each);
  if (sdk !== undefined && (typeof sdk !== "object" || sdk === null || !isCommit(sdk.dashiOS) || !isCommit(sdk.mirin) || Object.keys(sdk).length !== 2))
    return `versions/${name}: sdk must be {"dashiOS": "<40 hex>", "mirin": "<40 hex>"}, the commits it was built against`;
  return {
    version,
    sha256: value.sha256,
    size: value.size,
    released: value.released,
    bun: value.bun,
    ...(typeof value.notes === "string" ? { notes: value.notes } : {}),
    ...(sdk ? { sdk: { dashiOS: sdk.dashiOS as string, mirin: sdk.mirin as string } } : {}),
    signature: readFileSync(sigPath, "utf8"),
  };
}

export function readFolder(root: string, id: string): AppletFolder | string {
  const dir = join(root, "applets", id);
  try {
    const manifest = readManifest(readFileSync(join(dir, "applet.json"), "utf8"));
    if ("error" in manifest) return `applet.json: ${manifest.error}`;
    if (manifest.id !== id) return `applet.json says ${manifest.id}, but the folder is ${id}`;
    const source = json(join(dir, "source.json"));
    if (typeof source.url !== "string" || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(source.url)) return "source.json: url must be a GitHub repository";
    if (typeof source.commit !== "string" || !/^[0-9a-f]{40}$/.test(source.commit)) return "source.json: commit must be a full commit hash";
    const key = parsePublicKey(readFileSync(join(dir, "author.pub"), "utf8"));
    if (!key) return "author.pub is not a minisign public key";
    const versionsDir = join(dir, "versions");
    const versions: VersionFile[] = [];
    for (const name of existsSync(versionsDir) ? readdirSync(versionsDir).filter((each) => each.endsWith(".json")) : []) {
      const version = readVersion(dir, name);
      if (typeof version === "string") return version;
      versions.push(version);
    }
    if (versions.length === 0) return "there are no versions";
    if (!versions.some((each) => each.version === manifest.version)) return `applet.json is ${manifest.version}, which has no versions/${manifest.version}.json`;
    const review = existsSync(join(dir, "review.json")) ? json(join(dir, "review.json")) : {};
    const pulled: unknown = existsSync(join(dir, "pulled.json")) ? JSON.parse(readFileSync(join(dir, "pulled.json"), "utf8")) : [];
    const isPull = (each: unknown): each is { version: string; reason: string } =>
      typeof each === "object" && each !== null && typeof (each as Record<string, unknown>).version === "string" && typeof (each as Record<string, unknown>).reason === "string";
    if (!Array.isArray(pulled) || !pulled.every(isPull)) return "pulled.json must be a list of {version, reason}";
    const missing = [...manifest.screenshots, ...(manifest.icon ? [manifest.icon] : [])].find((path) => !existsSync(join(dir, path)));
    if (missing) return `${missing}, which applet.json names, is not in the folder`;
    return {
      id,
      dir,
      manifest,
      source: { url: source.url, commit: source.commit },
      authorKey: publicKeyLine(key),
      versions,
      reviewed: review.reviewed === true,
      pulled,
    };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Every applet's folder; the ones that don't read are problems. */
export function readCatalog(root: string): { applets: AppletFolder[]; problems: Problem[] } {
  const dir = join(root, "applets");
  const applets: AppletFolder[] = [];
  const problems: Problem[] = [];
  for (const id of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (id.startsWith(".") || id.endsWith(".md")) continue;
    const folder = readFolder(root, id);
    if (typeof folder === "string") problems.push({ id, problem: folder });
    else applets.push(folder);
  }
  return { applets, problems };
}
