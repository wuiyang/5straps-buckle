// Builds the Nitro fixture at <rootDir> into <outDir>/.output. Run in its own process so build-time env stays per variant.
import { join, resolve } from 'node:path'
import { build, copyPublicAssets, createNitro, prepare } from 'nitro/builder'

const [rootDir, outDir, ...flags] = process.argv.slice(2)
if (!rootDir || !outDir) throw new TypeError('Usage: build-fixture.ts <rootDir> <outDir> [--no-admin]')
const output = resolve(outDir)
process.env.FIXTURE_ADMIN_LAYER = flags.includes('--no-admin') ? 'false' : 'true'
process.env.FIXTURE_BAKED_DATABASE = join(output, 'baked', 'baked.sqlite')

// preset and baseURL are pinned so NITRO_PRESET or NITRO_APP_BASE_URL in the caller's shell cannot change the build.
const nitro = await createNitro({ rootDir: resolve(rootDir), dev: false, preset: 'node_middleware', baseURL: '/', buildDir: join(output, '.nitro'), output: { dir: join(output, '.output') } })
await prepare(nitro)
await copyPublicAssets(nitro)
await build(nitro)
await nitro.close()
