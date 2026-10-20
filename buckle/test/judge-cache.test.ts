import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../common/runtime/config.js'
import { JUDGE_CACHE_LIMIT, JUDGE_CACHE_TTL_MS, judgeCacheKey, judgeCachePath, openJudgeCache } from '../common/services/judge/judge-cache.js'
import { settingsPath } from '../common/services/workspaces/workspace-settings.js'
import type { JudgeInput, JudgeProvider, JudgeVerdict } from '../common/types/ports/judge.js'
import { runCli } from './support/cli.js'
import { idOf, workspacesOf } from './support/workspaces.js'

// The decision AI's cache (D91, addendum B): a verdict kept under the provider, the model, the policy, the command, its
// inline code, and the sha of every file it ran, in memory and in an owner-only judge-cache.json that a restart keeps.

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-judge-cache-')))
  roots.push(root)
  return root
}

const verdict = (reasoning = 'Reads a file.'): JudgeVerdict => ({ kind: 'verdict', level: 'safe', confidence: 0.9, reasoning, model: 'claude-opus-5-5', latencyMs: 812, promptDigest: 'c'.repeat(64) })
const input = (overrides: Partial<JudgeInput> = {}): JudgeInput => ({
  command: 'python3 job.py', argv: ['python3', 'job.py'], interpreters: ['python3'], inline: null, env: [],
  files: [{ path: '/workspace/job.py', sha256: 'a'.repeat(64), bytes: 10, content: 'print(1)\n' }, { path: '/workspace/lib.py', sha256: 'b'.repeat(64), bytes: 5, content: 'x=1\n' }],
  packages: [{ name: 'requests', version: '2.32.0', socket: null }], packagesTruncated: false, truncated: false, standardScript: false, policy: { allow: [], deny: [], destructive: [], allowedInterpreters: [] },
  cwd: '/workspace', mounts: [{ target: '/workspace', access: 'read-write' }], description: null, reason: null, ...overrides,
})
const key = (asked: JudgeInput, overrides: { provider?: JudgeProvider; model?: string; policyUpdatedAt?: string | null } = {}) => judgeCacheKey({ provider: 'openai-compatible', model: 'claude-opus-5-5', policyUpdatedAt: '2026-10-17T00:00:00.000Z', asked, ...overrides })

describe('a verdict\'s cache key', () => {
  it('is the same for the same code in any order, and new after one byte of one file, or another command, inline code, package version, policy, provider, or model', () => {
    const base = key(input())
    expect(key(input({ files: [...input().files].reverse() }))).toBe(base)
    const changed = [
      key(input({ files: [input().files[0]!, { ...input().files[1]!, sha256: 'd'.repeat(64) }] })),
      key(input({ command: 'python3 job.py --fast' })),
      key(input({ inline: 'print(2)' })),
      key(input({ policy: { allow: [], deny: [], destructive: ['rm *'], allowedInterpreters: [] } })),
      key(input({ standardScript: true })),
      key(input({ packages: [{ name: 'requests', version: '2.32.1', socket: null }] })),
      key(input(), { policyUpdatedAt: '2026-10-18T00:00:00.000Z' }),
      key(input(), { provider: 'another-provider' as JudgeProvider }),
      key(input(), { model: 'claude-sonnet-5-5' }),
    ]
    expect(new Set([base, ...changed]).size).toBe(changed.length + 1)
  })

  it('holds a standard script\'s package.json text: a changed text is a new key, and a call with none keeps its key (addendum 3 R3)', () => {
    const base = key(input())
    expect(key(input({ scriptText: 'tsc -p .' }))).not.toBe(base)
    expect(key(input({ scriptText: 'tsc -p .' }))).not.toBe(key(input({ scriptText: 'tsc -p . && node deploy.js' })))
    expect(key(input({ scriptText: 'tsc -p .' }))).toBe(key(input({ scriptText: 'tsc -p .' })))
    expect(key(input())).toBe(base)
  })

  it('holds the working directory: the same command run from another folder is a new key', () => {
    expect(key(input({ cwd: '/workspace/sub' }))).not.toBe(key(input()))
  })

  it('holds the mounts with their access: one made writable, or one added, is a new key; another order is not', () => {
    const mounts: JudgeInput['mounts'] = [{ target: '/workspace', access: 'read-write' }, { target: '/data', access: 'read-only' }]
    const base = key(input({ mounts }))
    expect(key(input({ mounts: [...mounts].reverse() }))).toBe(base)
    expect(key(input({ mounts: [mounts[0]!, { target: '/data', access: 'read-write' }] }))).not.toBe(base)
    expect(key(input({ mounts: [...mounts, { target: '/secrets', access: 'read-only' }] }))).not.toBe(base)
  })

  it('pairs each sha with its file: two files swapping contents, or one moving, is a new key; another discovery order is not', () => {
    const [job, lib] = input().files as [JudgeInput['files'][number], JudgeInput['files'][number]]
    const base = key(input({ files: [job, lib] }))
    expect(key(input({ files: [lib, job] }))).toBe(base)
    expect(key(input({ files: [{ ...job, sha256: lib.sha256, content: lib.content }, { ...lib, sha256: job.sha256, content: job.content }] }))).not.toBe(base)
    expect(key(input({ files: [{ ...job, path: '/workspace/other.py' }, lib] }))).not.toBe(base)
  })
})

describe('the judge cache file', () => {
  it('keeps a verdict across a restart, in a file only the owner reads', async () => {
    const filePath = judgeCachePath(scratch())
    await openJudgeCache({ filePath }).set('e'.repeat(64), verdict())
    expect(openJudgeCache({ filePath }).get('e'.repeat(64))).toEqual(verdict())
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it(`holds at most ${JUDGE_CACHE_LIMIT} verdicts, dropping the oldest`, async () => {
    const filePath = judgeCachePath(scratch())
    const cache = openJudgeCache({ filePath })
    const keys = Array.from({ length: JUDGE_CACHE_LIMIT + 1 }, (_, index) => index.toString(16).padStart(64, '0'))
    writeFileSync(filePath, JSON.stringify({ version: 1, entries: keys.slice(0, JUDGE_CACHE_LIMIT).map(item => ({ key: item, at: new Date().toISOString(), verdict: verdict() })) }), { mode: 0o600 })
    await cache.set(keys.at(-1)!, verdict('newest'))
    const held = JSON.parse(readFileSync(filePath, 'utf8')) as { entries: Array<{ key: string }> }
    expect(held.entries).toHaveLength(JUDGE_CACHE_LIMIT)
    expect(held.entries[0]!.key).toBe(keys[1])
    expect(cache.get(keys[0]!)).toBeUndefined()
    expect(cache.get(keys.at(-1)!)).toMatchObject({ reasoning: 'newest' })
  })

  it('forgets a verdict 24 hours after it was given, and drops an expired one from the file', async () => {
    const filePath = judgeCachePath(scratch())
    let clock = Date.parse('2026-10-18T00:00:00.000Z')
    const cache = openJudgeCache({ filePath, now: () => clock })
    await cache.set('e'.repeat(64), verdict())
    clock += JUDGE_CACHE_TTL_MS - 1
    expect(cache.get('e'.repeat(64))).toEqual(verdict())
    expect(openJudgeCache({ filePath, now: () => clock }).get('e'.repeat(64))).toEqual(verdict())
    clock += 1
    expect(cache.get('e'.repeat(64))).toBeUndefined()
    expect(openJudgeCache({ filePath, now: () => clock }).get('e'.repeat(64))).toBeUndefined()
    await cache.set('f'.repeat(64), verdict('later'))
    const held = JSON.parse(readFileSync(filePath, 'utf8')) as { entries: Array<{ key: string }> }
    expect(held.entries.map(entry => entry.key)).toEqual(['f'.repeat(64)])
  })

  it('takes no verdict dated in the future, as from a file another clock wrote', async () => {
    const filePath = judgeCachePath(scratch())
    writeFileSync(filePath, JSON.stringify({ version: 1, entries: [{ key: 'e'.repeat(64), at: '2099-01-01T00:00:00.000Z', verdict: verdict() }] }), { mode: 0o600 })
    expect(openJudgeCache({ filePath }).get('e'.repeat(64))).toBeUndefined()
  })

  it('reads a clear another process made, and a damaged file fails no call', async () => {
    const filePath = judgeCachePath(scratch())
    const serving = openJudgeCache({ filePath })
    await serving.set('e'.repeat(64), verdict())
    expect(serving.get('e'.repeat(64))).toBeDefined()
    expect(await openJudgeCache({ filePath }).clear()).toBe(1)
    expect(serving.get('e'.repeat(64))).toBeUndefined()
    writeFileSync(filePath, '{ damaged', { mode: 0o600 })
    expect(serving.get('e'.repeat(64))).toBeUndefined()
    await expect(serving.set('f'.repeat(64), verdict())).resolves.toBeUndefined()
  })
})

describe('buckle workspace judge-cache clear', () => {
  it('empties the workspace\'s kept verdicts and says how many', async () => {
    const root = scratch()
    const folder = join(root, 'site')
    mkdirSync(folder)
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'judge-cache-admin-credential', BUCKLE_SANDBOX: 'none' })
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const buckle = (argv: string[]) => runCli({ argv: ['workspace', ...argv], config, confirm: null, cwd: folder })
    expect((await buckle(['init'])).exitCode).toBe(0)
    const manager = await workspacesOf(config)
    const filePath = judgeCachePath(dirname(settingsPath(config.stateDirectory, idOf(manager, 'site'))))
    await openJudgeCache({ filePath }).set('e'.repeat(64), verdict())
    out = ''
    expect((await buckle(['judge-cache', 'clear'])).exitCode).toBe(0)
    expect(out).toContain('Workspace site: the decision AI\'s 1 kept verdict is cleared, so each call is rated again; 0 kept Socket summaries are cleared too.')
    expect(openJudgeCache({ filePath }).get('e'.repeat(64))).toBeUndefined()
    expect((await buckle(['judge-cache', 'empty'])).exitCode).toBe(1)
    await manager.close()
  })
})
