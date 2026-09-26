import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TestProject } from 'vitest/node'
import { buildVariant, packageRoot, type FixtureBuild } from './support/paths.js'

const run = promisify(execFile)

declare module 'vitest' {
  export interface ProvidedContext {
    fixtureBuild: FixtureBuild
  }
}

// Builds @5straps/runtime and the fixture once per run. The fixture resolves the runtime through
// <root>/node_modules, a symlink to this package, so main.ts and the bundle load one copy of dist.
export default async function setup(project: TestProject): Promise<() => void> {
  await run(join(packageRoot, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.build.json'], { cwd: packageRoot })
  const root = mkdtempSync(join(process.env.RUNTIME_TEST_SYSTEM_TMPDIR ?? tmpdir(), 'runtime-fixture-build-'))
  mkdirSync(join(root, 'node_modules/@5straps'), { recursive: true })
  symlinkSync(packageRoot, join(root, 'node_modules/@5straps/runtime'), 'dir')
  const build: FixtureBuild = { root, full: buildVariant(root, 'full'), headless: buildVariant(root, 'headless') }
  await Promise.all([buildFixture(build.full.outDir, []), buildFixture(build.headless.outDir, ['--no-admin'])])
  project.provide('fixtureBuild', build)
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

async function buildFixture(outDir: string, flags: string[]): Promise<void> {
  const script = join(packageRoot, 'test/integration/support/build-fixture.ts')
  try {
    await run(process.execPath, ['--import', 'tsx', script, outDir, ...flags], { cwd: packageRoot, maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
    throw new Error(`Fixture build failed for ${outDir}:\n${stdout}\n${stderr}`, { cause: error })
  }
}
