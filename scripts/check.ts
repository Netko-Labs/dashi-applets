/**
 * bun scripts/check.ts [--base REF]: what CI checks on every pull request.
 *
 * - every applet's folder reads (folders.ts): the manifest validates, the
 *   folder is its id, the source is pinned, the key is a minisign key;
 * - every version's signature is the author's key's (over the package's
 *   bytes as listed: the rebuild, rebuild.ts, checks the bytes themselves);
 * - with --base: no author.pub changed (an update must be signed by the same
 *   key), no released version's files changed or went, and review.json and
 *   pulled.json changed only by maintainers (CODEOWNERS enforces who; this
 *   lists them so the reviewer sees it).
 *
 * Prints each problem and exits 1 if there is any; prints the versions that
 * are new against the base, one `id version` per line, on stdout.
 */

import { verifySignatureOnly } from "./verify.ts";
import { readCatalog } from "./folders.ts";

const args = Bun.argv.slice(2);
const at = args.indexOf("--base");
const base = at >= 0 ? args[at + 1] : undefined;
const root = process.cwd();

const { applets, problems } = readCatalog(root);
const messages = problems.map(({ id, problem }) => `${id}: ${problem}`);
/** The Bun the catalog builds with (package.json's packageManager): a version must be built with it, so the bytes match. */
const BUN = ((await Bun.file("package.json").json()) as { packageManager?: string }).packageManager?.replace(/^bun@/, "") ?? Bun.version;
for (const applet of applets) {
  for (const version of applet.versions) {
    if (version.bun !== BUN) messages.push(`${applet.id} ${version.version}: built with Bun ${version.bun}; the catalog builds with ${BUN}, so pack it with that one`);
    const checked = verifySignatureOnly(version.signature, applet.authorKey, applet.id, version);
    if (checked !== true) messages.push(`${applet.id} ${version.version}: ${checked}`);
  }
}

const fresh: string[] = [];
if (base) {
  const diff = Bun.spawnSync(["git", "diff", "--name-status", `${base}...HEAD`, "--", "applets"], { stdout: "pipe" });
  for (const line of diff.stdout.toString().split("\n").filter(Boolean)) {
    const [status = "", path = ""] = line.split("\t");
    const [, id, file = "", name = ""] = path.split("/");
    if (file === "author.pub" && status !== "A") messages.push(`${id}: author.pub changed; an update must be signed by the same key (a new key is a new applet)`);
    if (file === "versions" && status !== "A") messages.push(`${id}: versions/${name} was ${status === "D" ? "removed" : "changed"}; a released version never changes (pull it instead)`);
    if (file === "versions" && status === "A" && name.endsWith(".json")) fresh.push(`${id} ${name.replace(/\.json$/, "")}`);
    if (file === "review.json" || file === "pulled.json") console.error(`note: ${id}/${file} changed: maintainers only`);
  }
}

for (const message of messages) console.error(`✗ ${message}`);
for (const line of fresh) console.log(line);
if (messages.length === 0) console.error(`✓ ${applets.length} applet${applets.length === 1 ? "" : "s"}`);
process.exit(messages.length > 0 ? 1 : 0);
