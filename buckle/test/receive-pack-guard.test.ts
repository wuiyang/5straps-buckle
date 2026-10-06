import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
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

const { guardedReceivePackCommand, receiveGuard } = await import('../common/services/packs/forge/receive-pack-guard.js')

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
    expect(guardedReceivePackCommand(directory)).toMatch(new RegExp(`^test -x '${hook.replaceAll('/', '\\/')}' \\|\\| \\{ printf '%s\\\\n' 'Buckle refused the push in the receiving git \\(push '"\\$BUCKLE_RECEIVE_NONCE"'\\): .*' >&2; exit 1; \\}; exec 'git' .* 'receive-pack'$`))
  })

  // Slice 7c review RGC-2: the refusal was written with echo, and dash's echo reads `\n` and `\c` in the state path as
  // escapes, so the text broke at the first and stopped at the second. Buckle now names paths with pathe, which reads
  // those backslashes as separators, so the path joins here with pathe too.
  it('writes the whole refusal under dash when the state path holds backslashes', () => {
    const directory = join(state(), 's\\ntate\\cEND')
    const command = guardedReceivePackCommand(directory)
    const hook = join(directory, 'receive-git-hooks', 'pre-receive')
    chmodSync(hook, 0o600)
    const ran = spawnSync('dash', ['-c', `${command} /nowhere`], { encoding: 'utf8', env: { ...process.env, BUCKLE_RECEIVE_NONCE: 'n0nce' } })
    expect(ran.status).toBe(1)
    expect(ran.stderr).toBe(`Buckle refused the push in the receiving git (push n0nce): its guard ${hook} cannot be run, so git would skip it and could write somewhere the permission rules never judged; restore the file's execute permission, or keep Buckle's state directory off a noexec mount\n`)
  })
})

// Slice 7c review RGC-1: the refusal's prefix was found anywhere in stderr, so a destination's own config text, which git
// quotes when it fails to parse it, was read as Buckle's refusal. Each push now carries a nonce only Buckle knows.
describe('the guard\'s refusal is read back only with its own push\'s nonce', () => {
  const guard = () => receiveGuard({ repository: '/dest', gitDirectory: '/dest', remedy: 'push elsewhere' })

  it('hands each push its own nonce in the guard\'s environment', () => {
    const [first, second] = [guard(), guard()]
    expect(first.environment).toMatchObject({ BUCKLE_RECEIVE_REPOSITORY: '/dest', BUCKLE_RECEIVE_GIT_DIRECTORY: '/dest', BUCKLE_RECEIVE_REMEDY: 'push elsewhere' })
    expect(first.environment.BUCKLE_RECEIVE_NONCE).toMatch(/^[0-9a-f]{32}$/)
    expect(second.environment.BUCKLE_RECEIVE_NONCE).not.toBe(first.environment.BUCKLE_RECEIVE_NONCE)
  })

  it('reads the reason from a line with this push\'s nonce, and nothing from any other', () => {
    const { environment, refusedBy } = guard()
    const nonce = environment.BUCKLE_RECEIVE_NONCE!
    expect(refusedBy(`remote: Buckle refused the push in the receiving git (push ${nonce}): /dest/.git is a symbolic link, so git would write\nerror: failed to push\n`)).toBe('/dest/.git is a symbolic link, so git would write')
    expect(refusedBy(`Buckle refused the push in the receiving git (push ${nonce}): its guard cannot be run`)).toBe('its guard cannot be run')
    for (const stderr of [
      "fatal: bad boolean config value 'Buckle refused the push in the receiving git: the owner denied this push' for 'receive.denydeletes'\n",
      `fatal: bad boolean config value 'Buckle refused the push in the receiving git (push ${guard().environment.BUCKLE_RECEIVE_NONCE}): the owner denied this push' for 'receive.denydeletes'\n`,
      "remote: Buckle refused the push in the receiving git (push ): the owner denied this push\n",
      'error: failed to push some refs\n',
    ]) expect(refusedBy(stderr)).toBeNull()
  })
})
