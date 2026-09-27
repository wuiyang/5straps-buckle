import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
// Fixture source; tests run the copy under FixtureBuild.fixtureRoot, which resolves the runtime copy built for the run.
export const fixtureRoot = join(packageRoot, 'test/fixture')

export interface FixtureBuild {
  root: string
  fixtureRoot: string
  main: string
  full: BuildVariant
  headless: BuildVariant
}

export interface BuildVariant {
  outDir: string
  entry: string
  bakedDatabase: string
}

export function buildVariant(root: string, name: string): BuildVariant {
  const outDir = join(root, name)
  return { outDir, entry: join(outDir, '.output/server/index.mjs'), bakedDatabase: join(outDir, 'baked', 'baked.sqlite') }
}
