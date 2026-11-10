import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach } from 'vitest'

// A scratch repository shaped like this one for the release script tests: the three package.json
// files and a changelog. Commands are answered by each test, so nothing here touches a network.

export const DIRECTORIES = { '@5straps/protocol': 'packages/protocol', '@5straps/runtime': 'packages/runtime', '@5straps/buckle': 'buckle' } as const
export type PackageName = keyof typeof DIRECTORIES
export const NAMES = Object.keys(DIRECTORIES) as PackageName[]

export const CHANGELOG = `# Changelog


## v0.1.0

[compare changes](https://github.com/wuiyang/5straps-buckle/compare/400459e...v0.1.0)

### Fixes

- Refuse what should be refused ([b39daf2](https://github.com/wuiyang/5straps-buckle/commit/b39daf2))
`

export type Run = (command: string, args: string[], options?: { show?: boolean }) => string

const made: string[] = []

afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A fresh directory, removed after the test that made it. */
export function scratchDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  made.push(directory)
  return directory
}

export function linkedScriptPath(script: string): string {
  const link = join(scratchDirectory('release-script-link-'), 'scripts')
  symlinkSync(dirname(script), link, 'junction')
  return join(link, basename(script))
}

/** A scratch repository whose packages hold `versions` (one version for all, or one each) and whose changelog is `changelog`. */
export function scratchRepository(input: { versions?: string | Partial<Record<PackageName, string>>; changelog?: string } = {}): string {
  const root = scratchDirectory('release-repository-')
  for (const name of NAMES) {
    const version = typeof input.versions === 'object' ? input.versions[name] ?? '0.1.0' : input.versions ?? '0.1.0'
    setVersion(root, name, version)
  }
  writeFileSync(join(root, 'CHANGELOG.md'), input.changelog ?? CHANGELOG)
  return root
}

export function setVersion(root: string, name: PackageName, version: string): void {
  mkdirSync(join(root, DIRECTORIES[name]), { recursive: true })
  writeFileSync(join(root, DIRECTORIES[name], 'package.json'), `${JSON.stringify({ name, version }, null, 2)}\n`)
}

export function readVersions(root: string): string[] {
  return NAMES.map(name => JSON.parse(readFileSync(join(root, DIRECTORIES[name], 'package.json'), 'utf8')).version)
}

export function readChangelog(root: string): string {
  return readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
}

/** A failed command as the release scripts' runner reports it. */
export function commandFailure(status: number, stderr = ''): Error {
  return Object.assign(new Error(`exited with ${status}`), { status, stderr })
}
