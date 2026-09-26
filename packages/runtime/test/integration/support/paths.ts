import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
export const fixtureRoot = join(packageRoot, 'test/fixture')
export const fixtureMain = join(fixtureRoot, 'main.ts')

export interface FixtureBuild {
  root: string
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
