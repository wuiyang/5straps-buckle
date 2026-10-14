import { defineConfig } from 'nitro'

// Build-time switch only (scripts/build-server.mjs --no-admin): a node built without the admin layer
// serves no /setup route at all. Runtime configuration is loaded by main.ts at startup.
const adminLayer = process.env.BUCKLE_BUILD_ADMIN_LAYER !== 'false'

export default defineConfig({
  preset: 'node_middleware',
  // Custom entry: exports the Nitro app instead of listening, so main.ts owns bootstrap.
  entry: './server/entry.ts',
  serverEntry: false,
  serverDir: false,
  errorHandler: './server/error.ts',
  extends: ['./layers/common', './layers/mcp', ...(adminLayer ? ['./layers/admin'] : [])],
  // One copy of each, shared with main.ts: @5straps/runtime holds the ALS stores and the host slot,
  // and h3 is the copy @5straps/runtime/nitro uses (ruling 3 of 2026-09-28). What stays external is
  // installed with the package and audited there: code mode's VM too (owner decision D82), pi-codemode and the
  // QuickJS build it loads, whose worker file and wasm are read from where they are installed.
  rolldownConfig: { external: [/^@5straps\//, /^@modelcontextprotocol\//, /^zod(\/|$)/, /^h3(\/|$)/, /^@earendil-works\/pi-codemode(\/|$)/, /^quickjs-wasi(\/|$)/] },
})
