// Source commits require exact-commit CI; a strictly validated tagged release commit reuses its single parent.
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preparedSource } from './check-prepared.mjs'
import { Refusal } from './command.mjs'

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

/**
 * The workflow run id in a GitHub Actions check run's details_url,
 * `https://github.com/<owner>/<repo>/actions/runs/<id>/job/<job>`, or null for any other host or shape.
 */
export function workflowRunId(check) {
  let url
  try {
    url = new URL(String(check.details_url ?? ''))
  } catch {
    return null
  }
  if (url.origin !== 'https://github.com') return null
  return /^\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/job\/\d+$/.exec(url.pathname)?.[1] ?? null
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
 * not succeed, or ran in a workflow run that did not conclude success. A re-run replaces an earlier
 * run of the same job. `runs` are the check runs that count, each carrying its `workflow_run`.
 */
export function blockingJobs({ sha, runs, required = REQUIRED_JOBS }) {
  return required.flatMap((name) => {
    const latest = runs
      .filter(run => isRequiredCheck(run, { sha, required: [name] }))
      .sort((left, right) => String(right.started_at ?? '').localeCompare(String(left.started_at ?? '')) || right.id - left.id)[0]
    if (!latest) return [{ name, reason: `has not run on this commit ${WHERE}` }]
    if (latest.status !== 'completed') return [{ name, reason: `is ${latest.status}` }]
    if (latest.conclusion !== 'success') return [{ name, reason: `concluded ${latest.conclusion}` }]
    const workflowRun = latest.workflow_run
    if (workflowRun?.conclusion !== 'success') {
      return [{ name, reason: `ran in workflow run ${workflowRun?.id ?? 'unknown'}, which ${workflowRun?.conclusion ? `concluded ${workflowRun.conclusion}` : 'has not concluded'}` }]
    }
    return []
  })
}

/** `run(command, args)` returns stdout; injected so a test can answer for git and gh without a network. */
export function requireCi({ run, repository = process.env.GITHUB_REPOSITORY, githubActions = process.env.GITHUB_ACTIONS === 'true', sourceOnly = false }) {
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
  let checkedSha = sha
  if (!sourceOnly) {
    try {
      checkedSha = preparedSource({ run }) ?? sha
    } catch (error) {
      if (!(error instanceof Refusal)) throw error
      return { ok: false, message: error.message }
    }
  }
  const slug = repository || repositoryOf(run('git', ['remote', 'get-url', 'origin']))
  let runs
  try {
    runs = releaseCheckRuns({ run, slug, sha: checkedSha, checks: JSON.parse(run('gh', ['api', `repos/${slug}/commits/${checkedSha}/check-runs?per_page=100`])).check_runs ?? [] })
  } catch (error) {
    return { ok: false, message: ghFailure({ error, slug, githubActions, sourceOnly }) }
  }
  const blocking = blockingJobs({ sha: checkedSha, runs })
  if (blocking.length > 0) {
    return { ok: false, message: `CI has not passed on ${checkedSha}: ${blocking.map(job => `${job.name} ${job.reason}`).join('; ')}. Both ${REQUIRED_JOBS.join(' and ')} must succeed ${WHERE} ${sourceOnly ? 'before preparing a release' : 'before publishing'}.` }
  }
  return { ok: true, message: `CI passed on ${checkedSha}${checkedSha === sha ? '' : `, the validated source parent of tagged release ${sha}`}: ${REQUIRED_JOBS.join(' and ')} succeeded ${WHERE}.` }
}

/**
 * The check runs that count: a required job's, by GitHub Actions on `sha`, whose details_url names a
 * workflow run on github.com that is release-check.yml on main and lists the check run among its jobs.
 * A job of the same name in another workflow file, from a pull request or another branch, or posted
 * through the Checks API under a real run's URL, does not count. Each one carries its workflow run's
 * id and conclusion, which blockingJobs requires to be success. Each workflow run is read once.
 */
function releaseCheckRuns({ run, slug, sha, checks }) {
  const workflowRuns = new Map()
  const read = (id) => {
    if (!workflowRuns.has(id)) {
      const workflowRun = JSON.parse(run('gh', ['api', `repos/${slug}/actions/runs/${id}`]))
      // Every attempt's jobs, so a job an earlier attempt ran is still found after a re-run.
      const jobs = isReleaseCheckRun(workflowRun, sha) ? JSON.parse(run('gh', ['api', `repos/${slug}/actions/runs/${id}/jobs?filter=all&per_page=100`])).jobs ?? [] : null
      workflowRuns.set(id, { workflowRun, jobs })
    }
    return workflowRuns.get(id)
  }
  return checks.flatMap((check) => {
    const id = isRequiredCheck(check, { sha }) ? workflowRunId(check) : null
    if (!id) return []
    const { workflowRun, jobs } = read(id)
    // GitHub gives a workflow job the id of its check run.
    if (!jobs?.some(job => job.id === check.id)) return []
    return [{ ...check, workflow_run: { id: workflowRun.id ?? Number(id), conclusion: workflowRun.conclusion ?? null } }]
  })
}

/** One line for a gh call that could not run or answer, in place of its stack trace: the release reads CI through gh. */
function ghFailure({ error, slug, githubActions, sourceOnly }) {
  if (githubActions) {
    if (error?.code === 'ENOENT') return 'The GitHub CLI, gh, is not installed on this Actions runner: install it, then retry the job'
    // --source runs in Prepare release's prepare job; otherwise in Stage Buckle's pack job.
    const [job, workflow] = sourceOnly ? ['the prepare job in release-prepare.yml', 'Prepare release'] : ['the pack job in release.yml', 'Stage Buckle']
    return `gh could not read the CI results for ${slug} in GitHub Actions: check that ${job} grants checks: read and actions: read to GITHUB_TOKEN and repository policy permits them. After a workflow fix, wait for both required checks on the updated commit and start a new ${workflow} run`
  }
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
  const args = process.argv.slice(2)
  const result = args.length > 1 || args.some(arg => arg !== '--source')
    ? { ok: false, message: 'Usage: node scripts/release/require-ci.mjs [--source]' }
    : requireCi({ run, sourceOnly: args[0] === '--source' })
  process[result.ok ? 'stdout' : 'stderr'].write(`${result.message}\n`)
  process.exitCode = result.ok ? 0 : 1
}
