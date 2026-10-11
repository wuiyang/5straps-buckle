// Confirms the prepared tag before staging, and creates the GitHub release on it once all three
// versions are public on npm. The release names the tag and its notes only and attaches no files.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT, Refusal, runAsScript, runCommand } from './command.mjs'
import { CHANGELOG, changelogSection, isPlainVersion, tagOf } from './packages.mjs'

const COMMIT = /^[0-9a-f]{40}$/
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/
/** How many annotated tags deep a tag may point before the commit; git itself allows nesting. */
const TAG_DEPTH = 5

export function requirePreparedTag({ repository, version, sha, run = runCommand }) {
  const tag = releaseTag({ repository, version, sha })
  const tagged = remoteTagCommit({ run, repository, tag })
  if (!tagged) throw new Refusal(`The tag ${tag} is missing on GitHub: Prepare release must push it before publishing`)
  if (tagged !== sha) throw anotherCommit({ tag, tagged, sha, version })
  return `The prepared tag ${tag} names ${sha}.`
}

/**
 * Creates the release on the tag Prepare release pushed, or confirms it exists, and returns what it
 * did. The notes are the version's section of CHANGELOG.md in this checkout, the tagged commit.
 */
export function createGitHubRelease({ repository, version, sha, root = REPOSITORY_ROOT, run = runCommand }) {
  const tag = releaseTag({ repository, version, sha })
  const notes = changelogSection(readFileSync(join(root, CHANGELOG), 'utf8'), version)
  if (!notes) throw new Refusal(`${CHANGELOG} has no ${tag} section to take the release notes from`)
  requirePreparedTag({ repository, version, sha, run })
  if (releaseExists({ run, repository, tag })) return `The release ${tag} already exists on ${sha}; nothing to do.`
  run('gh', ['release', 'create', tag, '--repo', repository, '--title', tag, '--notes', notes, '--verify-tag'])
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

await runAsScript(import.meta.url, () => {
  const input = { repository: process.env.GITHUB_REPOSITORY, version: process.env.RELEASE_VERSION, sha: process.env.RELEASE_COMMIT }
  if (process.argv[2] === 'check-tag') return requirePreparedTag(input)
  if (process.argv[2] === 'release') return createGitHubRelease(input)
  throw new Refusal('Usage: node scripts/release/github-release.mjs check-tag|release')
})
