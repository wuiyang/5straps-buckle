// The last release step, run by the Release workflow after the packages are on npm:
//   RELEASE_VERSION=<version> RELEASE_COMMIT=<sha> RELEASE_NOTES=<file> node scripts/release/github-release.mjs
// It creates the tag v<version> on the released commit with its GitHub release, through gh. A release
// that already exists on that commit is left as it is, so a failed run can be repeated; a tag on
// another commit refuses.
import { Refusal, runAsScript, runCommand } from './command.mjs'
import { isPlainVersion, tagOf } from './packages.mjs'

const COMMIT = /^[0-9a-f]{40}$/
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/
/** How many annotated tags deep a tag may point before the commit; git itself allows nesting. */
const TAG_DEPTH = 5

/** Creates the release, or confirms it exists on `sha`, and returns what it did. */
export function createGitHubRelease({ repository, version, sha, notes, run = runCommand }) {
  if (!REPOSITORY.test(repository ?? '')) throw new Refusal(`The repository must be owner/name; got ${JSON.stringify(repository ?? '')}`)
  if (!isPlainVersion(version)) throw new Refusal(`The version must be plain MAJOR.MINOR.PATCH; got ${JSON.stringify(version ?? '')}`)
  if (!COMMIT.test(sha ?? '')) throw new Refusal(`The released commit must be a full SHA; got ${JSON.stringify(sha ?? '')}`)
  if (!notes) throw new Refusal('The release notes file is missing')
  const tag = tagOf(version)
  const tagged = remoteTagCommit({ run, repository, tag })
  if (tagged && tagged !== sha) throw new Refusal(`The tag ${tag} names ${tagged}, not the released commit ${sha}: leave it and find out where ${version} came from`)
  if (tagged && releaseExists({ run, repository, tag })) return `The release ${tag} already exists on ${sha}; nothing to do.`
  run('gh', ['release', 'create', tag, '--repo', repository, '--title', tag, '--notes-file', notes, ...(tagged ? ['--verify-tag'] : ['--target', sha])])
  const made = remoteTagCommit({ run, repository, tag })
  if (made !== sha) throw new Refusal(`The release ${tag} was created, but its tag names ${made ?? 'nothing'}, not ${sha}: fix the tag and the release by hand`)
  return `Created the release ${tag} and its tag on ${sha}.`
}

/** The commit a tag on GitHub names, through any annotated tags, or null when GitHub has no such tag. */
function remoteTagCommit({ run, repository, tag }) {
  // matching-refs answers a list, empty when nothing matches, so a missing tag is never read from an error.
  const refs = JSON.parse(run('gh', ['api', `repos/${repository}/git/matching-refs/tags/${tag}`]))
  let target = refs.find(ref => ref.ref === `refs/tags/${tag}`)?.object
  if (!target) return null
  for (let depth = 0; target.type === 'tag' && depth < TAG_DEPTH; depth += 1) {
    target = JSON.parse(run('gh', ['api', `repos/${repository}/git/tags/${target.sha}`])).object
  }
  if (target.type !== 'commit') throw new Refusal(`The tag ${tag} does not lead to a commit within ${TAG_DEPTH} annotated tags`)
  return target.sha
}

/**
 * Whether GitHub has a published release for the tag. Only gh's HTTP 404 means none; any other failure
 * stops here, and a 404 read wrongly only lets `gh release create` refuse the duplicate.
 */
function releaseExists({ run, repository, tag }) {
  try {
    run('gh', ['api', `repos/${repository}/releases/tags/${tag}`])
    return true
  } catch (error) {
    if (/\(HTTP 404\)/.test(error.stderr ?? '')) return false
    throw error
  }
}

runAsScript(import.meta.url, () => createGitHubRelease({
  repository: process.env.GITHUB_REPOSITORY,
  version: process.env.RELEASE_VERSION,
  sha: process.env.RELEASE_COMMIT,
  notes: process.env.RELEASE_NOTES,
}))
