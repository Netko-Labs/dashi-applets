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

/** An applet's source, packed and signed as `dashi-applet publish` would, and its folder in a catalog. */
async function catalogWith(signer = author) {
  const source = mkdtempSync(join(tmpdir(), "applet-source-"));
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "applet.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(source, "src/main.ts"), 'console.log("21°");\n');
  const packed = await pack(source);
  const root = mkdtempSync(join(tmpdir(), "catalog-"));
  const folder = join(root, "applets", MANIFEST.id);
  mkdirSync(join(folder, "versions"), { recursive: true });
  writeFileSync(join(folder, "applet.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(folder, "source.json"), JSON.stringify({ url: "https://github.com/alex-kim/weather", commit: "0123456789abcdef0123456789abcdef01234567" }));
  writeFileSync(join(folder, "author.pub"), author.publicKey);
  writeFileSync(join(folder, "versions/0.1.0.json"), JSON.stringify({ sha256: packed.sha256, size: packed.bytes.byteLength, released: "2026-11-04", bun: Bun.version }));
  writeFileSync(join(folder, "versions/0.1.0.minisig"), sign(packed.bytes, signer.secretKey, trustedComment(MANIFEST, packed.sha256)));
  return { root, folder, packed };
}

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
