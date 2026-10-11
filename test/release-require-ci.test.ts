import { describe, expect, it } from 'vitest'
import { blockingJobs, isReleaseCheckRun, repositoryOf, requireCi, workflowRunId } from '../scripts/release/require-ci.mjs'

// Source CI must pass in release-check.yml on main. A tagged metadata release may reuse only its
// strictly validated source parent's checks; release-source.test.ts covers that exemption.
// git and gh are answered here.

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

interface Run { id: number; name: string; head_sha: string; status: string; conclusion: string | null; started_at: string; app?: { slug: string }; details_url?: string }
const jobUrl = (workflowRun: number, id = 1) => `https://github.com/owner/repo/actions/runs/${workflowRun}/job/${id}`
const run = (name: string, conclusion: string | null, extra: Partial<Run> = {}): Run => ({ id: 1, name, head_sha: SHA, status: conclusion === null ? 'in_progress' : 'completed', conclusion, started_at: '2026-09-29T10:00:00Z', details_url: jobUrl(7, extra.id), ...extra })

interface WorkflowRun { path: string; event: string; head_branch: string; head_sha: string; conclusion: string | null }
/** Workflow run 7 is release-check.yml on a push to main, at SHA, and it succeeded. */
const RELEASE_CHECK: WorkflowRun = { path: '.github/workflows/release-check.yml', event: 'push', head_branch: 'main', head_sha: SHA, conclusion: 'success' }
/** A check run as requireCi counts it: read from a workflow run that succeeded. */
const counted = (check: Run) => ({ ...check, workflow_run: { id: 7, conclusion: 'success' } })

/**
 * Answers git and gh as a repository on master whose HEAD is SHA would, recording every gh call. A
 * workflow run lists as its jobs the check runs whose details_url names it, unless `jobs` says otherwise.
 */
function fake(input: { onOrigin?: boolean; originAt?: string; dirty?: boolean; detached?: boolean; runs?: Run[]; workflowRuns?: Record<string, WorkflowRun>; jobs?: Record<string, number[]>; origin?: string; gh?: Error; workflowRunGh?: Error }) {
  const calls: string[][] = []
  const answer = (command: string, args: string[]): string => {
    calls.push([command, ...args])
    if (command === 'git' && args[0] === 'status') return input.dirty ? ' M package.json\n' : ''
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return `${SHA}\n`
    if (command === 'git' && args.join(' ') === 'rev-parse --abbrev-ref HEAD') return input.detached ? 'HEAD\n' : 'master\n'
    if (command === 'git' && args.join(' ') === 'rev-parse --verify --quiet refs/remotes/origin/master') {
      if (input.onOrigin === false) throw new Error('exit 1')
      return `${input.originAt ?? SHA}\n`
    }
    if (command === 'git' && args.join(' ') === 'show --no-patch --format=%s HEAD') return 'fix: source change\n'
    if (command === 'git' && args[0] === 'remote') return `${input.origin ?? 'git@github.com-alias:owner/repo.git'}\n`
    if (command === 'gh' && input.gh) throw input.gh
    const jobsOf = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/jobs\?filter=all&per_page=100$/.exec(args[1] ?? '')?.[1]
    if (command === 'gh' && jobsOf) {
      if (input.workflowRunGh) throw input.workflowRunGh
      const ids = input.jobs?.[jobsOf] ?? (input.runs ?? []).filter(check => workflowRunId(check) === jobsOf).map(check => check.id)
      return JSON.stringify({ total_count: ids.length, jobs: ids.map(id => ({ id, run_id: Number(jobsOf) })) })
    }
    const workflowRun = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)$/.exec(args[1] ?? '')?.[1]
    if (command === 'gh' && workflowRun) {
      if (input.workflowRunGh) throw input.workflowRunGh
      const answer = { 7: RELEASE_CHECK, ...input.workflowRuns }[workflowRun]
      if (!answer) throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { status: 1 })
      return JSON.stringify({ id: Number(workflowRun), ...answer })
    }
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

  it.each([
    ['a branch origin does not hold', { onOrigin: false }, 'is not what origin/master holds'],
    ['a HEAD behind or ahead of origin/master, even one on another origin branch', { originAt: OTHER }, `is not what origin/master holds (${OTHER})`],
    // The refusal says to fetch first: the check reads the local origin ref and never fetches (unverified item of the B23-B25 review).
    ['a local origin/master that may be stale', { originAt: OTHER }, 'fetch first (git fetch origin'],
    ['a dirty working tree', { dirty: true }, 'uncommitted changes'],
    ['a detached HEAD', { detached: true }, 'is detached'],
  ] as const)('refuses %s, before asking GitHub anything', (_, input, reason) => {
    const git = fake({ ...input, runs: [run('verify', 'success'), run('package-arm64', 'success')] })
    expect(requireCi({ run: git.run, repository: '' })).toEqual({ ok: false, message: expect.stringContaining(reason) })
    expect(git.calls.filter(call => call[0] === 'gh')).toEqual([])
  })

  // A machine without gh, or with gh signed out, gets one line naming gh and its login, not a stack trace.
  it.each([
    ['gh is not installed', Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' }), 'The GitHub CLI, gh, is not installed'],
    ['gh cannot answer', Object.assign(new Error('Command failed: gh api'), { status: 4 }), 'gh could not read the CI results for owner/repo'],
  ])('refuses in one line naming gh and its login when %s', (_, failure, reason) => {
    const result = requireCi({ run: fake({ gh: failure }).run, repository: '', githubActions: false })
    expect(result).toEqual({ ok: false, message: expect.stringContaining(reason) })
    expect(result.message).toContain('gh auth login')
    expect(result.message).not.toContain('\n')
  })

  it.each(['checks', 'workflow runs'])('explains workflow token permissions when Actions cannot read %s', (endpoint) => {
    const failure = Object.assign(new Error('gh: Resource not accessible by integration (HTTP 403)'), { status: 1 })
    const runs = [run('verify', 'success'), run('package-arm64', 'success', { id: 2 })]
    const git = fake({ runs, ...(endpoint === 'checks' ? { gh: failure } : { workflowRunGh: failure }) })
    const result = requireCi({ run: git.run, repository: '', githubActions: true })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('checks: read and actions: read to GITHUB_TOKEN')
    expect(result.message).toContain('repository policy')
    expect(result.message).toContain('both required checks on the updated commit')
    expect(result.message).toContain('start a new Stage Buckle run')
    expect(result.message).not.toContain('gh auth login')
    expect(result.message).not.toContain('HTTP 403')
    expect(result.message).not.toContain('\n')
  })

  it('asks for gh installation on an Actions runner without an interactive login', () => {
    const failure = Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' })
    const result = requireCi({ run: fake({ gh: failure }).run, repository: '', githubActions: true })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not installed on this Actions runner')
    expect(result.message).not.toContain('gh auth login')
  })

  it('counts only the runs GitHub Actions made: a check another app posted under a job\'s name is not that job', () => {
    const runs = [run('verify', 'success', { app: { slug: 'some-other-app' } }), run('package-arm64', 'success', { id: 2, app: { slug: 'github-actions' } })]
    expect(requireCi({ run: fake({ runs }).run, repository: '' })).toEqual({ ok: false, message: expect.stringContaining('verify has not run on this commit') })
    expect(blockingJobs({ sha: SHA, runs: [run('verify', 'success', { app: { slug: 'github-actions' } }), run('package-arm64', 'success', { id: 2 })].map(counted) })).toEqual([])
  })

  it('takes the latest run of each job, and the repository from the origin URL or GITHUB_REPOSITORY', () => {
    expect(blockingJobs({ sha: SHA, runs: [run('verify', 'failure'), run('verify', 'success', { id: 2, started_at: '2026-09-29T12:00:00Z' }), run('package-arm64', 'success')].map(counted) })).toEqual([])
    expect(repositoryOf('git@github.com-alias:wuiyang/5straps-buckle.git')).toBe('wuiyang/5straps-buckle')
    expect(repositoryOf('https://github.com/wuiyang/5straps-buckle.git')).toBe('wuiyang/5straps-buckle')
    expect(repositoryOf('https://github.com/wuiyang/5straps-buckle')).toBe('wuiyang/5straps-buckle')
    const git = fake({ runs: [run('verify', 'success'), run('package-arm64', 'success')] })
    requireCi({ run: git.run, repository: 'named/explicitly' })
    expect(git.calls.find(call => call[0] === 'gh')?.[2]).toBe(`repos/named/explicitly/commits/${SHA}/check-runs?per_page=100`)
  })
})

describe('the workflow a CI job ran in', () => {
  const passing = (workflowRun: number) => [run('verify', 'success', { details_url: jobUrl(workflowRun, 1) }), run('package-arm64', 'success', { id: 2, details_url: jobUrl(workflowRun, 2) })]

  it('counts release-check.yml on a push to main or a run started on main, reading each workflow run once', () => {
    for (const workflowRun of [RELEASE_CHECK, { ...RELEASE_CHECK, event: 'workflow_dispatch' }, { ...RELEASE_CHECK, path: '.github/workflows/release-check.yml@refs/heads/main' }]) {
      const git = fake({ runs: passing(8), workflowRuns: { 8: workflowRun } })
      expect(requireCi({ run: git.run, repository: '' })).toEqual({ ok: true, message: expect.stringContaining('succeeded in .github/workflows/release-check.yml on main') })
      expect(git.calls.filter(call => call[0] === 'gh' && call[2] === 'repos/owner/repo/actions/runs/8')).toHaveLength(1)
    }
  })

  it.each([
    ['another workflow file', { ...RELEASE_CHECK, path: '.github/workflows/other.yml' }],
    ['a copy of the file under another name', { ...RELEASE_CHECK, path: '.github/workflows/release-check.yml.bak' }],
    ['a pull request', { ...RELEASE_CHECK, event: 'pull_request' }],
    ['a run started on another branch', { ...RELEASE_CHECK, event: 'workflow_dispatch', head_branch: 'release-check-edit' }],
    ['a workflow run of another commit', { ...RELEASE_CHECK, head_sha: OTHER }],
  ])('refuses jobs that ran in %s', (_, workflowRun) => {
    const result = requireCi({ run: fake({ runs: passing(8), workflowRuns: { 8: workflowRun } }).run, repository: '' })
    expect(result).toEqual({ ok: false, message: expect.stringContaining('verify has not run on this commit in .github/workflows/release-check.yml on main; package-arm64 has not run') })
  })

  it('refuses a check run whose details_url names no workflow run, without asking for one', () => {
    const git = fake({ runs: [run('verify', 'success', { details_url: 'https://example.com/verify' }), run('package-arm64', 'success', { id: 2 })] })
    expect(requireCi({ run: git.run, repository: '' })).toEqual({ ok: false, message: expect.stringContaining('verify has not run on this commit') })
    expect(git.calls.filter(call => call[0] === 'gh' && /actions\/runs\/\d+$/.test(call[2] ?? ''))).toHaveLength(1)
  })

  it('lets a later success in another workflow hide no failure in release-check.yml', () => {
    const runs = [run('verify', 'failure'), run('package-arm64', 'success', { id: 2 }), run('verify', 'success', { id: 3, started_at: '2026-09-29T11:00:00Z', details_url: jobUrl(9, 3) })]
    const result = requireCi({ run: fake({ runs, workflowRuns: { 9: { ...RELEASE_CHECK, path: '.github/workflows/other.yml' } } }).run, repository: '' })
    expect(result).toEqual({ ok: false, message: expect.stringContaining('verify concluded failure') })
  })

  it('refuses in one line naming gh when the workflow run cannot be read', () => {
    const result = requireCi({ run: fake({ runs: passing(7), workflowRunGh: Object.assign(new Error('Command failed: gh api'), { status: 1 }) }).run, repository: '' })
    expect(result).toEqual({ ok: false, message: expect.stringContaining('gh could not read the CI results for owner/repo') })
  })

  // A workflow token with checks: write, on any branch, can post a check run named verify with
  // conclusion success and any details_url, under the github-actions app.
  it('refuses a check run posted under a real run\'s URL that the run does not list among its jobs', () => {
    const runs = [run('verify', 'success', { id: 900, details_url: jobUrl(7, 900) }), run('package-arm64', 'success', { id: 2 })]
    const git = fake({ runs, jobs: { 7: [1, 2] } })
    expect(requireCi({ run: git.run, repository: '' })).toEqual({ ok: false, message: expect.stringContaining('verify has not run on this commit') })
    expect(git.calls).toContainEqual(['gh', 'api', 'repos/owner/repo/actions/runs/7/jobs?filter=all&per_page=100'])
  })

  it.each([
    ['concluded failure', 'failure', 'verify ran in workflow run 8, which concluded failure'],
    ['was cancelled', 'cancelled', 'verify ran in workflow run 8, which concluded cancelled'],
    ['has not concluded, as during a re-run', null, 'verify ran in workflow run 8, which has not concluded'],
  ])('refuses checks that each say success when their workflow run %s', (_, conclusion, reason) => {
    const result = requireCi({ run: fake({ runs: passing(8), workflowRuns: { 8: { ...RELEASE_CHECK, conclusion } } }).run, repository: '' })
    expect(result).toEqual({ ok: false, message: expect.stringContaining(reason) })
  })

  it('refuses the forged shape: success check runs on another host, naming a failed release-check.yml run', () => {
    const runs = [run('verify', 'success', { id: 900, details_url: 'https://anything.example/actions/runs/7/job/900' }), run('package-arm64', 'success', { id: 901, details_url: 'https://anything.example/actions/runs/7/job/901' })]
    const git = fake({ runs, workflowRuns: { 7: { ...RELEASE_CHECK, conclusion: 'failure' } } })
    expect(requireCi({ run: git.run, repository: '' })).toEqual({ ok: false, message: expect.stringContaining('verify has not run on this commit in .github/workflows/release-check.yml on main; package-arm64 has not run') })
    expect(git.calls.filter(call => call[0] === 'gh' && /actions\/runs/.test(call[2] ?? ''))).toEqual([])
  })

  it('takes a workflow run\'s conclusion from GitHub, never from the check run\'s own fields', () => {
    const runs = passing(8).map(check => ({ ...check, workflow_run: { id: 8, conclusion: 'success' } }))
    const result = requireCi({ run: fake({ runs, workflowRuns: { 8: { ...RELEASE_CHECK, conclusion: 'failure' } } }).run, repository: '' })
    expect(result).toEqual({ ok: false, message: expect.stringContaining('which concluded failure') })
  })

  it.each([
    ['another host', 'https://anything.example/owner/repo/actions/runs/123/job/456'],
    ['a host that only starts with github.com', 'https://github.com.example/owner/repo/actions/runs/123/job/456'],
    ['github.com as a user name', 'https://github.com@anything.example/owner/repo/actions/runs/123/job/456'],
    ['plain http', 'http://github.com/owner/repo/actions/runs/123/job/456'],
    ['another port', 'https://github.com:8443/owner/repo/actions/runs/123/job/456'],
    ['no job', 'https://github.com/owner/repo/actions/runs/123'],
  ])('reads no workflow run id from a details_url on %s', (_, url) => {
    expect(workflowRunId({ details_url: url })).toBeNull()
  })

  it('reads the workflow run id from a job URL only', () => {
    expect(workflowRunId({ details_url: 'https://github.com/owner/repo/actions/runs/123/job/456' })).toBe('123')
    expect(workflowRunId({ details_url: 'https://github.com/owner/repo/runs/456' })).toBeNull()
    expect(workflowRunId({})).toBeNull()
    expect(isReleaseCheckRun({ ...RELEASE_CHECK, path: '.github/workflows/release-check.yml@main' }, SHA)).toBe(true)
    expect(isReleaseCheckRun(undefined, SHA)).toBe(false)
  })
})
