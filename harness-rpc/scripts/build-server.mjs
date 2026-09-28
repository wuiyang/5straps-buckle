// Builds the Nitro app (layers, custom entry, error handler) into .output, or --out-dir <dir>.
// --no-admin leaves the admin layer out, so that build serves no /setup route.
// The build cache goes under node_modules/.cache (or --build-dir), never into the source tree.
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { build, copyPublicAssets, createNitro, prepare } from 'nitro/builder'

const { values } = parseArgs({ options: {
  root: { type: 'string', default: '.' },
  'out-dir': { type: 'string' },
  'build-dir': { type: 'string' },
  'no-admin': { type: 'boolean', default: false },
} })
const rootDir = resolve(values.root)
const outDir = resolve(values['out-dir'] ?? join(rootDir, '.output'))
// Read by nitro.config.ts; build-time only.
process.env.BUCKLE_BUILD_ADMIN_LAYER = values['no-admin'] ? 'false' : 'true'

// preset and baseURL are pinned so NITRO_PRESET or NITRO_APP_BASE_URL in the caller's shell cannot change the build.
const nitro = await createNitro({
  rootDir, dev: false, preset: 'node_middleware', baseURL: '/', logLevel: 1,
  buildDir: resolve(values['build-dir'] ?? join(rootDir, 'node_modules', '.cache', 'nitro')),
  output: { dir: outDir },
})
try {
  await prepare(nitro)
  await copyPublicAssets(nitro)
  await build(nitro)
} finally {
  await nitro.close()
}
