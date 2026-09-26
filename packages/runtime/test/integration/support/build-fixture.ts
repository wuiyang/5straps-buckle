// Builds the Nitro fixture into <outDir>/.output. Run in its own process so build-time env stays per variant.
import { join, resolve } from 'node:path'
import { build, copyPublicAssets, createNitro, prepare } from 'nitro/builder'
import { fixtureRoot } from './paths.js'

const [outDir, ...flags] = process.argv.slice(2)
if (!outDir) throw new TypeError('Usage: build-fixture.ts <outDir> [--no-admin]')
const output = resolve(outDir)
process.env.FIXTURE_ADMIN_LAYER = flags.includes('--no-admin') ? 'false' : 'true'
process.env.FIXTURE_BAKED_DATABASE = join(output, 'baked', 'baked.sqlite')

const nitro = await createNitro({ rootDir: fixtureRoot, dev: false, buildDir: join(output, '.nitro'), output: { dir: join(output, '.output') } })
await prepare(nitro)
await copyPublicAssets(nitro)
await build(nitro)
await nitro.close()
