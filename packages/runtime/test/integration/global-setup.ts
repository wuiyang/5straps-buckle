import { execFile } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { TestProject } from 'vitest/node'
import { buildVariant, fixtureRoot, packageRoot, type FixtureBuild } from './support/paths.js'

const run = promisify(execFile)
// Source-only entries: dependencies come from the linked node_modules, and the fixture tsconfig maps imports to src/ for typechecking.
const FIXTURE_SOURCE_ONLY = new Set(['node_modules', '.data', 'tsconfig.json'])

declare module 'vitest' {
  export interface ProvidedContext {
    fixtureBuild: FixtureBuild
  }
}

// Runs only for the fixture project. Everything is built under one temp root: a private copy of
// @5straps/runtime, a copy of the fixture and both Nitro builds. packages/runtime/dist and the source
// tree are never written, so a concurrent test run or release gate never reads a half-written file.
// main.ts (run from the copied fixture) and the bundle both resolve <root>/node_modules/@5straps/runtime.
export default async function setup(project: TestProject): Promise<() => void> {
  const root = mkdtempSync(join(process.env.RUNTIME_TEST_SYSTEM_TMPDIR ?? tmpdir(), 'runtime-fixture-build-'))
  const remove = () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  try {
    linkDependencies(root)
    await buildRuntimeCopy(join(root, 'node_modules/@5straps/runtime'))
    const copiedFixture = copyFixture(root)
    const build: FixtureBuild = { root, fixtureRoot: copiedFixture, main: join(copiedFixture, 'main.ts'), full: buildVariant(root, 'full'), headless: buildVariant(root, 'headless') }
    await Promise.all([buildFixture(copiedFixture, build.full.outDir, []), buildFixture(copiedFixture, build.headless.outDir, ['--no-admin'])])
    project.provide('fixtureBuild', build)
  } catch (error) {
    remove()
    throw error
  }
  return remove
}

// The package's own dependencies, linked so the copied fixture and the runtime copy resolve them.
function linkDependencies(root: string): void {
  const source = join(packageRoot, 'node_modules')
  mkdirSync(join(root, 'node_modules/@5straps'), { recursive: true })
  for (const entry of readdirSync(source)) {
    if (entry.startsWith('.') || entry === '@5straps') continue
    symlinkSync(join(source, entry), join(root, 'node_modules', entry), 'dir')
  }
}

async function buildRuntimeCopy(target: string): Promise<void> {
  mkdirSync(target)
  copyFileSync(join(packageRoot, 'package.json'), join(target, 'package.json'))
  const tsc = join(packageRoot, 'node_modules/.bin/tsc')
  await run(tsc, ['-p', 'tsconfig.build.json', '--outDir', join(target, 'dist'), '--declaration', 'false', '--sourceMap', 'false'], { cwd: packageRoot })
}

function copyFixture(root: string): string {
  const target = join(root, 'fixture')
  cpSync(fixtureRoot, target, { recursive: true, filter: source => !FIXTURE_SOURCE_ONLY.has(basename(source)) })
  // The source fixture is ESM through packages/runtime/package.json; the copy needs its own module scope.
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ private: true, type: 'module' })}\n`)
  return target
}

async function buildFixture(rootDir: string, outDir: string, flags: string[]): Promise<void> {
  const script = join(packageRoot, 'test/integration/support/build-fixture.ts')
  try {
    await run(process.execPath, ['--import', 'tsx', script, rootDir, outDir, ...flags], { cwd: packageRoot, maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
    throw new Error(`Fixture build failed for ${outDir}:\n${stdout}\n${stderr}`, { cause: error })
  }
}
