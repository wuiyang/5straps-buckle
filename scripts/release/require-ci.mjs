// Ruling 9 (2026-09-28): the ARM64 job blocks the release as the AMD64 gate does. `pnpm release`
// runs this first: it refuses to publish unless HEAD is on origin and both CI jobs, `verify` and
// `package-arm64`, finished successfully on that exact commit.
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REQUIRED_JOBS = ['verify', 'package-arm64']

/** owner/repo from an origin URL: https://github.com/o/r(.git), git@github.com:o/r.git, or an ssh host alias. */
export function repositoryOf(url) {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!match) throw new Error(`Cannot tell the GitHub repository from the origin URL ${url}`)
  return `${match[1]}/${match[2]}`
}

/**
 * What stops a release on this commit: each required job with no run on it, or whose latest run did
 * not succeed. A re-run replaces an earlier run of the same job.
 */
export function blockingJobs({ sha, runs, required = REQUIRED_JOBS }) {
  return required.flatMap((name) => {
    const latest = runs
      .filter(run => run.name === name && run.head_sha === sha)
      .sort((left, right) => String(right.started_at ?? '').localeCompare(String(left.started_at ?? '')) || right.id - left.id)[0]
    if (!latest) return [{ name, reason: 'has not run on this commit' }]
    if (latest.status !== 'completed') return [{ name, reason: `is ${latest.status}` }]
    if (latest.conclusion !== 'success') return [{ name, reason: `concluded ${latest.conclusion}` }]
    return []
  })
}

/** `run(command, args)` returns stdout; injected so a test can answer for git and gh without a network. */
export function requireCi({ run, repository = process.env.GITHUB_REPOSITORY }) {
  const sha = run('git', ['rev-parse', 'HEAD']).trim()
  const remotes = run('git', ['branch', '--remotes', '--contains', sha]).split('\n').map(line => line.trim()).filter(Boolean)
  if (!remotes.some(ref => ref.startsWith('origin/'))) {
    return { ok: false, message: `HEAD ${sha} is not on origin: push it and let CI run on it before releasing` }
  }
  const slug = repository || repositoryOf(run('git', ['remote', 'get-url', 'origin']))
  const response = JSON.parse(run('gh', ['api', `repos/${slug}/commits/${sha}/check-runs?per_page=100`]))
  const blocking = blockingJobs({ sha, runs: response.check_runs ?? [] })
  if (blocking.length > 0) {
    return { ok: false, message: `CI has not passed on ${sha}: ${blocking.map(job => `${job.name} ${job.reason}`).join('; ')}. Both ${REQUIRED_JOBS.join(' and ')} must succeed before publishing.` }
  }
  return { ok: true, message: `CI passed on ${sha}: ${REQUIRED_JOBS.join(' and ')} succeeded.` }
}

function run(command, args) {
  return execFileSync(command, args, { cwd: resolve(dirname(fileURLToPath(import.meta.url)), '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = requireCi({ run })
  process[result.ok ? 'stdout' : 'stderr'].write(`${result.message}\n`)
  process.exitCode = result.ok ? 0 : 1
}
