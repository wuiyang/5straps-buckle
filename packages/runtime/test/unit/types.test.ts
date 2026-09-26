import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc')

describe('F55 Nitro and H3 type augmentation', () => {
  it('compiles the augmentation program, including every @ts-expect-error check', () => {
    const run = () => execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'test/types/tsconfig.json')], { encoding: 'utf8', stdio: 'pipe' })
    expect(run).not.toThrow()
  }, 60_000)
})
