/**
 * The parts of Dashi's applet SDK (@dashi/applet) the catalog's scripts use:
 * the manifest, packages, signatures, and the index. Imported by path from a
 * Dashi checkout beside this one (`../dashiOS`, where CI checks it out too),
 * and only the modules that need nothing but Bun.
 */

export {
  type CatalogIndex,
  INDEX_FORMAT,
  type IndexApplet,
  type IndexVersion,
  parseIndex,
  trustedComment,
  verifyIndex,
  verifyPackage,
} from "../../dashiOS/packages/applet/src/catalog.ts";
export { compareVersions, type Manifest, manifestJson, readManifest } from "../../dashiOS/packages/applet/src/manifest.ts";
export { pack, sha256, unpack } from "../../dashiOS/packages/applet/src/package.ts";
export { generateKeys, type KeyPair, parsePublicKey, publicKeyLine, sign, verify, verifyTrustedComment } from "../../dashiOS/packages/applet/src/signing/minisign.ts";
export { writeTar } from "../../dashiOS/packages/applet/src/tar.ts";
