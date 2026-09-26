import { fileURLToPath } from 'node:url'
import { defineConfig } from 'nitro'

// Build-time switches only; runtime configuration is loaded by main.ts at startup.
const adminLayer = process.env.FIXTURE_ADMIN_LAYER !== 'false'
const bakedDatabase = process.env.FIXTURE_BAKED_DATABASE ?? fileURLToPath(new URL('./.data/baked.sqlite', import.meta.url))

export default defineConfig({
  preset: 'node_middleware',
  // Custom entry: exports the Nitro app instead of listening, so main.ts owns bootstrap.
  entry: './server/entry.ts',
  serverEntry: false,
  serverDir: false,
  errorHandler: './server/error.ts',
  features: { websocket: true },
  extends: ['./layers/common', './layers/mcp', ...(adminLayer ? ['./layers/admin'] : [])],
  experimental: { database: true },
  // F39: these options are serialised into the build; useDatabase() cannot see a startup-resolved path.
  database: { default: { connector: 'sqlite', options: { path: bakedDatabase } } },
  // One copy of @5straps/runtime shared with main.ts: its ALS stores and typed errors live in that module.
  rolldownConfig: { external: [/^@5straps\/runtime(\/|$)/] },
})
