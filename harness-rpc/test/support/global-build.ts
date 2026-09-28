import { execFile } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TestProject } from 'vitest/node'
import { PACKAGE_ROOT } from './sources.js'

const run = promisify(execFile)
/** What the package's build reads: the sources, their configs and the build scripts. */
const BUILD_INPUTS = ['main.ts', 'nitro.config.ts', 'package.json', 'tsconfig.json', 'tsconfig.build.json', 'common', 'cli', 'mcp', 'server', 'layers', 'scripts', 'skills']

/** The package as a run installs it: dist, .output and skills under one root, found from its package.json. */
export interface BuckleBuild {
  root: string
  main: string
  /** Built entries: the full build, a second copy of it (its own Nitro app), and the build without the admin layer. */
  entries: Record<'full' | 'second' | 'headless', string>
  outputs: Record<'full' | 'headless', string>
}

declare module 'vitest' {
  export interface ProvidedContext {
    buckleBuild: BuckleBuild
  }
}

/**
 * Vitest global setup for the HTTP tests. Builds a copy of the package under one temp root with its
 * own build scripts: tsc into dist, and Nitro into .output with and without the admin layer. The
 * source tree, its dist and its .output are never written, so a concurrent build or gate run never
 * reads a half-written file. node_modules is linked, so @5straps/runtime resolves to one copy.
 */
export default async function setup(project: TestProject): Promise<() => void> {
  const temp = mkdtempSync(join(process.env.BUCKLE_TEST_SYSTEM_TMPDIR ?? tmpdir(), 'buckle-build-'))
  const remove = () => rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  try {
    const root = copyPackage(temp)
    await Promise.all([
      build(root, ['scripts/build.mjs']),
      build(root, ['scripts/build-server.mjs', '--build-dir', join(temp, 'nitro-full')]),
      build(root, ['scripts/build-server.mjs', '--no-admin', '--out-dir', join(root, '.output-headless'), '--build-dir', join(temp, 'nitro-headless')]),
    ])
    cpSync(join(root, '.output'), join(root, '.output-2'), { recursive: true })
    project.provide('buckleBuild', describeBuild(root))
  } catch (error) {
    remove()
    throw error
  }
  return remove
}

function copyPackage(temp: string): string {
  const root = join(temp, 'buckle')
  mkdirSync(root)
  for (const input of BUILD_INPUTS) cpSync(join(PACKAGE_ROOT, input), join(root, input), { recursive: true })
  // The copied tsconfig extends the repository's base config one level up.
  copyFileSync(join(PACKAGE_ROOT, '..', 'tsconfig.base.json'), join(temp, 'tsconfig.base.json'))
  symlinkSync(join(PACKAGE_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir')
  return root
}

async function build(root: string, args: string[]): Promise<void> {
  try {
    await run(process.execPath, args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string }
    throw new Error(`Buckle build failed (${args.join(' ')}):\n${stdout}\n${stderr}`, { cause: error })
  }
}

function describeBuild(root: string): BuckleBuild {
  const entry = (output: string) => join(root, output, 'server', 'index.mjs')
  return {
    root,
    main: join(root, 'dist', 'main.js'),
    entries: { full: entry('.output'), second: entry('.output-2'), headless: entry('.output-headless') },
    outputs: { full: join(root, '.output'), headless: join(root, '.output-headless') },
  }
}
