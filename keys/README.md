# keys/

`dashi-index.pub` is the public half of Dashi's index key (README.md, "Keys"):
key id A9B2934342336BC1. The publish job checks every index it signs against
it, and Dashi's store ships the same key (dashiOS
`packages/shell/src/applet-store/keys.ts`). The secret half, locked with a
passphrase, is in the `catalog-signing` environment's secrets
(`DASHI_INDEX_KEY`, `DASHI_INDEX_KEY_PASSWORD`) and offline with the
maintainers. Never put a secret key in this repository.
