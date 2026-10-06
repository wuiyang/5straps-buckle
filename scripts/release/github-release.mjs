// The GitHub side of a release, run by two jobs of the Release workflow through gh:
//   RELEASE_VERSION=<version> RELEASE_COMMIT=<sha> node scripts/release/github-release.mjs tag
//   RELEASE_VERSION=<version> RELEASE_COMMIT=<sha> RELEASE_NOTES=<file> node scripts/release/github-release.mjs release
// `tag` runs before anything is published: it creates the tag v<version> on the packed commit, or
// confirms it is there, and refuses a tag on another commit, so a version can only ever be finished
// from the commit that started it. `release` runs after publishing and creates the GitHub release on
// that tag, which must already name the commit; a release that already exists is left as it is.
import { Refusal, runAsScript, runCommand } from './command.mjs'
import { isPlainVersion, tagOf } from './packages.mjs'

const COMMIT = /^[0-9a-f]{40}$/
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/
/** How many annotated tags deep a tag may point before the commit; git itself allows nesting. */
const TAG_DEPTH = 5

/** Creates the lightweight tag on `sha`, or confirms it is there, and returns what it did. */
export function createReleaseTag({ repository, version, sha, run = runCommand }) {
  const tag = releaseTag({ repository, version, sha })
  const tagged = remoteTagCommit({ run, repository, tag })
  if (tagged === sha) return `The tag ${tag} is already on ${sha}; nothing to do.`
  if (tagged) throw anotherCommit({ tag, tagged, sha, version })
  // --raw-field sends each value as a string; --field would read a SHA of digits alone as a number.
  run('gh', ['api', `repos/${repository}/git/refs`, '--method', 'POST', '--raw-field', `ref=refs/tags/${tag}`, '--raw-field', `sha=${sha}`])
  const made = remoteTagCommit({ run, repository, tag })
  if (made !== sha) throw new Refusal(`The tag ${tag} was created, but it names ${made ?? 'nothing'}, not ${sha}: fix the tag by hand before publishing`)
  return `Created the tag ${tag} on ${sha}.`
}

/** Creates the release on the tag the tag job made, or confirms it exists, and returns what it did. */
export function createGitHubRelease({ repository, version, sha, notes, run = runCommand }) {
  const tag = releaseTag({ repository, version, sha })
  if (!notes) throw new Refusal('The release notes file is missing')
  const tagged = remoteTagCommit({ run, repository, tag })
  if (!tagged) throw new Refusal(`The tag ${tag} is missing on GitHub, and the tag job makes it before publishing: create it on ${sha} by hand, then run this job again`)
  if (tagged !== sha) throw anotherCommit({ tag, tagged, sha, version })
  if (releaseExists({ run, repository, tag })) return `The release ${tag} already exists on ${sha}; nothing to do.`
  run('gh', ['release', 'create', tag, '--repo', repository, '--title', tag, '--notes-file', notes, '--verify-tag'])
  return `Created the release ${tag} on the tag ${tag}, which names ${sha}.`
}

/** The tag of `version`, once the repository, version, and commit are each well formed. */
function releaseTag({ repository, version, sha }) {
  if (!REPOSITORY.test(repository ?? '')) throw new Refusal(`The repository must be owner/name; got ${JSON.stringify(repository ?? '')}`)
  if (!isPlainVersion(version)) throw new Refusal(`The version must be plain MAJOR.MINOR.PATCH; got ${JSON.stringify(version ?? '')}`)
  if (!COMMIT.test(sha ?? '')) throw new Refusal(`The released commit must be a full SHA; got ${JSON.stringify(sha ?? '')}`)
  return tagOf(version)
}

function anotherCommit({ tag, tagged, sha, version }) {
  return new Refusal(`The tag ${tag} names ${tagged}, not the released commit ${sha}: leave it and find out where ${version} came from`)
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

runAsScript(import.meta.url, () => {
  const input = { repository: process.env.GITHUB_REPOSITORY, version: process.env.RELEASE_VERSION, sha: process.env.RELEASE_COMMIT }
  if (process.argv[2] === 'tag') return createReleaseTag(input)
  if (process.argv[2] === 'release') return createGitHubRelease({ ...input, notes: process.env.RELEASE_NOTES })
  throw new Refusal('Usage: node scripts/release/github-release.mjs tag|release')
})
