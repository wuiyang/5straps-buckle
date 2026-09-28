import { describe, expect, it } from 'vitest'
import { blockingJobs, repositoryOf, requireCi } from '../scripts/release/require-ci.mjs'

// B22, ruling 9: `pnpm release` publishes only when verify and package-arm64 both succeeded on the
// exact commit being released, and that commit is on origin. git and gh are answered by the test.

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

interface Run { id: number; name: string; head_sha: string; status: string; conclusion: string | null; started_at: string }
const run = (name: string, conclusion: string | null, extra: Partial<Run> = {}): Run => ({ id: 1, name, head_sha: SHA, status: conclusion === null ? 'in_progress' : 'completed', conclusion, started_at: '2026-09-29T10:00:00Z', ...extra })

/** Answers git and gh as a repository whose HEAD is SHA would, recording every gh call. */
function fake(input: { onOrigin?: boolean; runs?: Run[]; origin?: string }) {
  const calls: string[][] = []
  const answer = (command: string, args: string[]): string => {
    calls.push([command, ...args])
    if (command === 'git' && args[0] === 'rev-parse') return `${SHA}\n`
    if (command === 'git' && args[0] === 'branch') return input.onOrigin === false ? '  local-only\n' : '  origin/master\n'
    if (command === 'git' && args[0] === 'remote') return `${input.origin ?? 'git@github.com-alias:owner/repo.git'}\n`
    if (command === 'gh') return JSON.stringify({ total_count: input.runs?.length ?? 0, check_runs: input.runs ?? [] })
    throw new Error(`unexpected ${command} ${args.join(' ')}`)
  }
  return { run: answer, calls }
}

describe('the CI requirement before publishing', () => {
  it('allows a release when verify and package-arm64 both succeeded on HEAD', () => {
    const git = fake({ runs: [run('verify', 'success'), run('package-arm64', 'success', { id: 2 })] })
    expect(requireCi({ run: git.run, repository: '' })).toEqual({ ok: true, message: expect.stringContaining('verify and package-arm64 succeeded') })
    expect(git.calls).toContainEqual(['gh', 'api', `repos/owner/repo/commits/${SHA}/check-runs?per_page=100`])
  })

  it.each([
    ['the ARM64 job failed', [run('verify', 'success'), run('package-arm64', 'failure')], 'package-arm64 concluded failure'],
    ['the ARM64 job never ran', [run('verify', 'success')], 'package-arm64 has not run on this commit'],
    ['verify is still running', [run('verify', null), run('package-arm64', 'success')], 'verify is in_progress'],
    ['both passed on another commit only', [run('verify', 'success', { head_sha: OTHER }), run('package-arm64', 'success', { head_sha: OTHER })], 'verify has not run on this commit'],
    ['a re-run failed after an earlier success', [run('verify', 'success'), run('package-arm64', 'success'), run('package-arm64', 'cancelled', { id: 3, started_at: '2026-09-29T11:00:00Z' })], 'package-arm64 concluded cancelled'],
  ])('refuses when %s', (_, runs, reason) => {
    const result = requireCi({ run: fake({ runs }).run, repository: '' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain(reason)
  })

  it('refuses a HEAD that is not on origin, before asking GitHub anything', () => {
    const git = fake({ onOrigin: false, runs: [run('verify', 'success'), run('package-arm64', 'success')] })
    expect(requireCi({ run: git.run, repository: '' })).toEqual({ ok: false, message: expect.stringContaining('is not on origin') })
    expect(git.calls.filter(call => call[0] === 'gh')).toEqual([])
  })

  it('takes the latest run of each job, and the repository from the origin URL or GITHUB_REPOSITORY', () => {
    expect(blockingJobs({ sha: SHA, runs: [run('verify', 'failure'), run('verify', 'success', { id: 2, started_at: '2026-09-29T12:00:00Z' }), run('package-arm64', 'success')] })).toEqual([])
    expect(repositoryOf('git@github.com-alias:wuiyang/buckle.git')).toBe('wuiyang/buckle')
    expect(repositoryOf('https://github.com/wuiyang/buckle.git')).toBe('wuiyang/buckle')
    expect(repositoryOf('https://github.com/wuiyang/buckle')).toBe('wuiyang/buckle')
    const git = fake({ runs: [run('verify', 'success'), run('package-arm64', 'success')] })
    requireCi({ run: git.run, repository: 'named/explicitly' })
    expect(git.calls.find(call => call[0] === 'gh')?.[2]).toBe(`repos/named/explicitly/commits/${SHA}/check-runs?per_page=100`)
  })
})
