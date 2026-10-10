// The ARM64 job blocks a release as the AMD64 job does. The Publish Buckle workflow and `pnpm release` run
// this first: it refuses to publish unless the working tree is clean, HEAD is exactly what origin
// holds for the current branch, and both CI jobs, `verify` and `package-arm64`, finished successfully
// on that exact commit in release-check.yml, run by GitHub Actions on a push to main or started on main.
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REQUIRED_JOBS = ['verify', 'package-arm64']
/** The app that runs the workflow's jobs; a check run another app posted under the same name does not count. */
export const CI_APP = 'github-actions'
/** The workflow whose jobs count, and the runs of it that count: a push to main, or a run started on main. */
export const CI_WORKFLOW = '.github/workflows/release-check.yml'
export const CI_EVENTS = ['push', 'workflow_dispatch']
export const CI_BRANCH = 'main'
const WHERE = `in ${CI_WORKFLOW} on ${CI_BRANCH}`

/** owner/repo from an origin URL: https://github.com/o/r(.git), git@github.com:o/r.git, or an ssh host alias. */
export function repositoryOf(url) {
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  if (!match) throw new Error(`Cannot tell the GitHub repository from the origin URL ${url}`)
  return `${match[1]}/${match[2]}`
}

/** Whether a check run is a run of one of the `required` jobs on `sha` by GitHub Actions. A run that names its app is matched by that app too. */
function isRequiredCheck(check, { sha, required = REQUIRED_JOBS }) {
  return required.includes(check.name) && check.head_sha === sha && (check.app?.slug ?? CI_APP) === CI_APP
}

/** The workflow run id in a GitHub Actions check run's details_url, `.../actions/runs/<id>/job/<job>`, or null. */
export function workflowRunId(check) {
  return /\/actions\/runs\/(\d+)(?:\/|$)/.exec(String(check.details_url ?? ''))?.[1] ?? null
}

/**
 * Whether a workflow run, as gh api repos/<slug>/actions/runs/<id> answers, is release-check.yml on a
 * push to main or a run started on main, for `sha`. GitHub may write the path with `@<ref>` after it.
 */
export function isReleaseCheckRun(workflowRun, sha) {
  return String(workflowRun?.path ?? '').split('@')[0] === CI_WORKFLOW
    && CI_EVENTS.includes(workflowRun.event)
    && workflowRun.head_branch === CI_BRANCH
    && workflowRun.head_sha === sha
}

/**
 * What stops a release on this commit: each required job with no run on it, or whose latest run did
 * not succeed. A re-run replaces an earlier run of the same job. `runs` are the check runs that count.
 */
export function blockingJobs({ sha, runs, required = REQUIRED_JOBS }) {
  return required.flatMap((name) => {
    const latest = runs
      .filter(run => isRequiredCheck(run, { sha, required: [name] }))
      .sort((left, right) => String(right.started_at ?? '').localeCompare(String(left.started_at ?? '')) || right.id - left.id)[0]
    if (!latest) return [{ name, reason: `has not run on this commit ${WHERE}` }]
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
  let runs
  try {
    runs = releaseCheckRuns({ run, slug, sha, checks: JSON.parse(run('gh', ['api', `repos/${slug}/commits/${sha}/check-runs?per_page=100`])).check_runs ?? [] })
  } catch (error) {
    return { ok: false, message: ghFailure({ error, slug }) }
  }
  const blocking = blockingJobs({ sha, runs })
  if (blocking.length > 0) {
    return { ok: false, message: `CI has not passed on ${sha}: ${blocking.map(job => `${job.name} ${job.reason}`).join('; ')}. Both ${REQUIRED_JOBS.join(' and ')} must succeed ${WHERE} before publishing.` }
  }
  return { ok: true, message: `CI passed on ${sha}: ${REQUIRED_JOBS.join(' and ')} succeeded ${WHERE}.` }
}

/**
 * The check runs that count: a required job's, by GitHub Actions on `sha`, whose workflow run, named
 * by its details_url, is release-check.yml on main. A job of the same name in another workflow file,
 * or from a pull request or another branch, does not count. Each workflow run is read once.
 */
function releaseCheckRuns({ run, slug, sha, checks }) {
  const workflowRuns = new Map()
  return checks.filter((check) => {
    const id = isRequiredCheck(check, { sha }) ? workflowRunId(check) : null
    if (!id) return false
    if (!workflowRuns.has(id)) workflowRuns.set(id, JSON.parse(run('gh', ['api', `repos/${slug}/actions/runs/${id}`])))
    return isReleaseCheckRun(workflowRuns.get(id), sha)
  })
}

/** One line for a gh call that could not run or answer, in place of its stack trace: the release reads CI through gh. */
function ghFailure({ error, slug }) {
  if (error?.code === 'ENOENT') return `The GitHub CLI, gh, is not installed: a release reads CI results through it. Install gh, run gh auth login with an account that can read ${slug}, then release again`
  return `gh could not read the CI results for ${slug}: run gh auth login with an account that can read it, check gh api works, then release again`
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
