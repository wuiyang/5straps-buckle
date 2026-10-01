import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Paths whose execute test fails whatever their mode, as every file on a noexec mount does. */
const noexec = vi.hoisted(() => new Set<string>())
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    accessSync: (path: string, mode?: number) => {
      if (noexec.has(String(path))) throw Object.assign(new Error(`EACCES: permission denied, access '${String(path)}'`), { code: 'EACCES' })
      actual.accessSync(path, mode)
    },
  }
})

const { guardedReceivePackCommand } = await import('../common/services/packs/forge/receive-pack-guard.js')

const roots: string[] = []
afterEach(() => {
  noexec.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function state(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-receive-guard-'))
  roots.push(root)
  return root
}

// Slice 7b review RG-1: git skips a pre-receive hook it cannot execute, so the guard must be executable before a push.
describe('the receive-pack guard before a push', () => {
  it('writes the guard executable under a umask that would drop its execute bit, its directory already there', () => {
    const directory = state()
    mkdirSync(join(directory, 'receive-git-hooks'), { mode: 0o700 })
    const previous = process.umask(0o177)
    try {
      guardedReceivePackCommand(directory)
    } finally {
      process.umask(previous)
    }
    expect(statSync(join(directory, 'receive-git-hooks', 'pre-receive')).mode & 0o777).toBe(0o700)
  })

  it('raises GIT_ISOLATION_UNAVAILABLE before the push when the guard still cannot be run, as on a noexec mount', () => {
    const directory = state()
    noexec.add(join(directory, 'receive-git-hooks', 'pre-receive'))
    expect(() => guardedReceivePackCommand(directory)).toThrow(expect.objectContaining({ code: 'GIT_ISOLATION_UNAVAILABLE', message: expect.stringMatching(/cannot be run .*noexec mount.*not run without it/) }))
  })

  it('names a command that tests the guard before it starts receive-pack', () => {
    const directory = state()
    const hook = join(directory, 'receive-git-hooks', 'pre-receive')
    expect(guardedReceivePackCommand(directory)).toMatch(new RegExp(`^test -x '${hook.replaceAll('/', '\\/')}' \\|\\| \\{ echo 'Buckle refused the push in the receiving git: .*' >&2; exit 1; \\}; exec 'git' .* 'receive-pack'$`))
  })
})
