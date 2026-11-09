import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIndex } from "../scripts/build-index.ts";
import { readCatalog } from "../scripts/folders.ts";
import { pointDependencies } from "../scripts/rebuild.ts";
import { generateKeys, pack, sign, trustedComment, verifyIndex, verifyPackage } from "../scripts/sdk.ts";
import { verifySignatureOnly } from "../scripts/verify.ts";

// Throwaway keys, made for this run: no key is ever committed.
const dashi = generateKeys();
const author = generateKeys();
const stranger = generateKeys();

const MANIFEST = {
  id: "dev.example.weather",
  name: "Weather",
  version: "0.1.0",
  dashi: ">=0.4",
  entry: "src/main.ts",
  summary: "The weather where you are.",
  author: { name: "Alex Kim" },
  categories: ["status"],
  permissions: ["network"],
};

/** A version of the applet, packed and signed as `dashi-applet publish` would, and written into its folder in the catalog with its applet.json. */
async function publish(folder: string, manifest: typeof MANIFEST, signer = author) {
  const source = mkdtempSync(join(tmpdir(), "applet-source-"));
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "applet.json"), JSON.stringify(manifest));
  writeFileSync(join(source, "src/main.ts"), `console.log("${manifest.version}");\n`);
  const packed = await pack(source);
  mkdirSync(join(folder, "versions"), { recursive: true });
  writeFileSync(join(folder, "applet.json"), JSON.stringify(manifest));
  const version = { sha256: packed.sha256, size: packed.bytes.byteLength, released: "2026-11-04", bun: Bun.version };
  writeFileSync(join(folder, `versions/${manifest.version}.json`), JSON.stringify(version));
  writeFileSync(join(folder, `versions/${manifest.version}.minisig`), sign(packed.bytes, signer.secretKey, trustedComment(manifest, packed.sha256)));
  return packed;
}

/** A catalog with the applet's first version in it. */
async function catalogWith(signer = author) {
  const root = mkdtempSync(join(tmpdir(), "catalog-"));
  const folder = join(root, "applets", MANIFEST.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "source.json"), JSON.stringify({ url: "https://github.com/alex-kim/weather", commit: "0123456789abcdef0123456789abcdef01234567" }));
  writeFileSync(join(folder, "author.pub"), author.publicKey);
  const packed = await publish(folder, MANIFEST, signer);
  return { root, folder, packed };
}

/**
 * git in a throwaway catalog: its own empty config (no one's global or
 * system settings), and a made-up committer, so the history is the test's.
 */
function git(root: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Catalog Test",
      GIT_AUTHOR_EMAIL: "catalog-test@example.invalid",
      GIT_COMMITTER_NAME: "Catalog Test",
      GIT_COMMITTER_EMAIL: "catalog-test@example.invalid",
    },
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

const commitAll = (root: string, message: string): void => {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
};

test("a folder reads, its signature is its author's, and the index built from it checks as the store checks it", async () => {
  const { root, packed } = await catalogWith();
  const { applets, problems } = readCatalog(root);
  expect(problems).toEqual([]);
  const [applet] = applets;
  const [version] = applet?.versions ?? [];
  if (!applet || !version) throw new Error("one applet, one version");
  expect(verifySignatureOnly(version.signature, applet.authorKey, applet.id, version)).toBe(true);

  const index = buildIndex(root, "Netko-Labs/dashi-applets", new Date("2026-11-05T00:00:00Z"));
  const bytes = new TextEncoder().encode(JSON.stringify(index));
  const checked = verifyIndex(bytes, sign(bytes, dashi.secretKey, "dashi-applets index"), dashi.publicKey);
  if ("error" in checked) throw new Error(checked.error);
  const entry = checked.applets[0];
  const listed = entry?.versions[0];
  if (!entry || !listed) throw new Error("listed");
  expect(listed.url).toBe(
    "https://github.com/Netko-Labs/dashi-applets/releases/download/dev.example.weather-0.1.0/dev.example.weather-0.1.0.dashi-applet",
  );
  // The package CI rebuilt and released is what the store accepts.
  expect(verifyPackage(packed.bytes, entry, listed)).toBe(true);
  expect(verifyIndex(bytes, sign(bytes, stranger.secretKey, "x"), dashi.publicKey)).toHaveProperty("error");
});

test("a signature by another key, or one that names another version, is a problem", async () => {
  const { root } = await catalogWith(stranger);
  const [applet] = readCatalog(root).applets;
  const [version] = applet?.versions ?? [];
  if (!applet || !version) throw new Error("one applet, one version");
  expect(verifySignatureOnly(version.signature, applet.authorKey, applet.id, version)).toContain("signed by key");
  expect(verifySignatureOnly(version.signature, applet.authorKey, applet.id, { ...version, version: "0.2.0" })).not.toBe(true);
});

test("a folder that isn't right is a problem, not a crash", async () => {
  const { root, folder } = await catalogWith();
  writeFileSync(join(folder, "source.json"), JSON.stringify({ url: "https://example.com/x", commit: "abc" }));
  expect(readCatalog(root).problems).toEqual([{ id: MANIFEST.id, problem: "source.json: url must be a GitHub repository" }]);
  writeFileSync(join(folder, "applet.json"), JSON.stringify({ ...MANIFEST, id: "dev.example.other" }));
  expect(readCatalog(root).problems[0]?.problem).toContain("but the folder is");
  expect(() => buildIndex(root, "Netko-Labs/dashi-applets")).toThrow();
});

test("the rebuild points an applet's SDK and mirin dependencies at CI's checkouts", () => {
  const pkg = JSON.stringify({
    dependencies: {
      "@dashi/applet": "file:/home/pejedev/Developer/dashiOS/packages/applet",
      "@dashi/ui": "file:/home/pejedev/Developer/dashiOS/packages/dashi-ui",
      "@mirinjs/metal": "file:/home/pejedev/Developer/mirin/packages/mirin-metal",
      react: "^19.2.0",
    },
  });
  expect(JSON.parse(pointDependencies(pkg, "/ci/dashiOS", "/ci/mirin")).dependencies).toEqual({
    "@dashi/applet": "file:/ci/dashiOS/packages/applet",
    "@dashi/ui": "file:/ci/dashiOS/packages/dashi-ui",
    "@mirinjs/metal": "file:/ci/mirin/packages/mirin-metal",
    react: "^19.2.0",
  });
});

test("each version keeps the Dashi range its own applet.json named, from main's history", async () => {
  const { root, folder } = await catalogWith();
  git(root, "init", "-q", "-b", "main");
  commitAll(root, "weather 0.1.0");
  // A pull request's commits along the way aren't main's: one that said 0.1.0 needed only Dashi 0.1 is never believed.
  git(root, "switch", "-q", "-c", "publish/weather-0.2.0");
  writeFileSync(join(folder, "applet.json"), JSON.stringify({ ...MANIFEST, dashi: ">=0.1" }));
  commitAll(root, "weather 0.1.0, any Dashi");
  await publish(folder, { ...MANIFEST, version: "0.2.0", dashi: ">=0.5" });
  commitAll(root, "weather 0.2.0");
  git(root, "switch", "-q", "main");
  git(root, "merge", "-q", "--no-ff", "-m", "Merge weather 0.2.0", "publish/weather-0.2.0");

  const index = buildIndex(root, "Netko-Labs/dashi-applets");
  const listed = index.applets[0]?.versions.map(({ version, dashi }) => ({ version, dashi }));
  expect(listed).toEqual([
    { version: "0.2.0", dashi: ">=0.5" },
    { version: "0.1.0", dashi: ">=0.4" },
  ]);
});

test("a version whose range no applet.json names is refused, not given the newest one's", async () => {
  // No history at all: 0.1.0's applet.json is gone, and nothing says what it needed.
  const { root, folder } = await catalogWith();
  await publish(folder, { ...MANIFEST, version: "0.2.0", dashi: ">=0.5" });
  expect(() => buildIndex(root, "Netko-Labs/dashi-applets")).toThrow("dev.example.weather 0.1.0: no applet.json in the history names 0.1.0");
});
