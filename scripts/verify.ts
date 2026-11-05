/**
 * The signature checks the catalog makes before a version is released: the
 * .minisig is the author key's, and its trusted comment names this applet,
 * this version, and these bytes (`dashi-applet <id> <version> sha256:<hex>`,
 * what `dashi-applet pack --sign` and the minisign line it prints write).
 */

import type { VersionFile } from "./folders.ts";
import { verify, verifyTrustedComment } from "./sdk.ts";

/** Before the bytes are rebuilt: the author's key made it, and it names this version and its sha256. */
export function verifySignatureOnly(signature: string, authorKey: string, id: string, version: Pick<VersionFile, "version" | "sha256">): true | string {
  const checked = verifyTrustedComment(signature, authorKey);
  if (!checked.ok) return checked.reason;
  if (checked.trustedComment !== `dashi-applet ${id} ${version.version} sha256:${version.sha256}`)
    return "the signature's trusted comment doesn't name this applet, version, and sha256";
  return true;
}

/** The rebuilt package's bytes against the author's signature. */
export function verifyBytes(bytes: Uint8Array, signature: string, authorKey: string): true | string {
  const checked = verify(bytes, signature, authorKey);
  return checked.ok ? true : checked.reason;
}
