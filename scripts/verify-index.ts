/**
 * bun scripts/verify-index.ts INDEX.json KEY.pub: checks the index and its
 * .minisig beside it the way the Applet Store will (@dashi/applet's
 * verifyIndex), before CI publishes them.
 */

import { readFileSync } from "node:fs";
import { verifyIndex } from "./sdk.ts";

const [indexPath, keyPath] = Bun.argv.slice(2);
if (!indexPath || !keyPath) {
  console.error("bun scripts/verify-index.ts INDEX.json KEY.pub");
  process.exit(2);
}
const index = verifyIndex(new Uint8Array(readFileSync(indexPath)), readFileSync(`${indexPath}.minisig`, "utf8"), readFileSync(keyPath, "utf8"));
if ("error" in index) {
  console.error(`✗ ${index.error}`);
  process.exit(1);
}
console.error(`✓ signed by Dashi's key: ${index.applets.length} applet${index.applets.length === 1 ? "" : "s"}`);
