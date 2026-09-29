// Ruling 9 (2026-09-28): the ARM64 job blocks the release as the AMD64 gate does. `pnpm release`
// runs this first: it refuses to publish unless the working tree is clean, HEAD is exactly what origin
// holds for the current branch, and both CI jobs, `verify` and `package-arm64`, run by GitHub Actions,
// finished successfully on that exact commit (review of B20-B22).
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REQUIRED_JOBS = ['verify', 'package-arm64']
/** The app that runs the workflow's jobs; a check run another app posted under the same name does not count. */
export const CI_APP = 'github-actions'

/** owner/repo from an origin URL: https://github.com/o/r(.git), git@github.com:o/r.git, or an ssh host alias. */
export function repositoryOf(url) {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!match) throw new Error(`Cannot tell the GitHub repository from the origin URL ${url}`)
  return `${match[1]}/${match[2]}`
}

/**
 * What stops a release on this commit: each required job with no run on it by GitHub Actions, or
 * whose latest run did not succeed. A re-run replaces an earlier run of the same job. A run that
 * names its app is matched by that app too.
 */
export function blockingJobs({ sha, runs, required = REQUIRED_JOBS }) {
  return required.flatMap((name) => {
    const latest = runs
      .filter(run => run.name === name && run.head_sha === sha && (run.app?.slug ?? CI_APP) === CI_APP)
      .sort((left, right) => String(right.started_at ?? '').localeCompare(String(left.started_at ?? '')) || right.id - left.id)[0]
    if (!latest) return [{ name, reason: 'has not run on this commit' }]
    if (latest.status !== 'completed') return [{ name, reason: `is ${latest.status}` }]
    if (latest.conclusion !== 'success') return [{ name, reason: `concluded ${latest.conclusion}` }]
    return []
  })
}

/** `run(command, args)` returns stdout; injected so a test can answer for git and gh without a network. */
export function requireCi({ run, repository = process.env.GITHUB_REPOSITORY }) {
  if (run('git', ['status', '--porcelain']).trim() !== '') {
    return { ok: false, message: 'The working tree has uncommitted changes: a release publishes what CI checked, so commit or remove them first' }
  }
  const sha = run('git', ['rev-parse', 'HEAD']).trim()
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  if (branch === 'HEAD') return { ok: false, message: `HEAD ${sha} is detached: release from a branch that origin holds` }
  const pushed = tryRun(run, 'git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
  if (pushed !== sha) {
    return { ok: false, message: `HEAD ${sha} is not what origin/${branch} holds${pushed ? ` (${pushed})` : ''} in this clone: fetch first (git fetch origin; this check compares with the local origin/${branch} and never fetches), then push it and let CI run on it before releasing` }
  }
  const slug = repository || repositoryOf(run('git', ['remote', 'get-url', 'origin']))
  const response = JSON.parse(run('gh', ['api', `repos/${slug}/commits/${sha}/check-runs?per_page=100`]))
  const blocking = blockingJobs({ sha, runs: response.check_runs ?? [] })
  if (blocking.length > 0) {
    return { ok: false, message: `CI has not passed on ${sha}: ${blocking.map(job => `${job.name} ${job.reason}`).join('; ')}. Both ${REQUIRED_JOBS.join(' and ')} must succeed before publishing.` }
  }
  return { ok: true, message: `CI passed on ${sha}: ${REQUIRED_JOBS.join(' and ')} succeeded.` }
}

/** The command's trimmed stdout, or null when it fails: `rev-parse --verify` fails for a ref origin does not hold. */
function tryRun(run, command, args) {
  try {
    return run(command, args).trim() || null
  } catch {
    return null
  }
}

function run(command, args) {
  return execFileSync(command, args, { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = requireCi({ run })
  process[result.ok ? 'stdout' : 'stderr'].write(`${result.message}\n`)
  process.exitCode = result.ok ? 0 : 1
}
