// What a release is made of: the three packages, the version they share, its tag, its tarballs, and
// its changelog section. The prepare, plan, and GitHub release scripts read them from here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Refusal } from './command.mjs'

/** The published packages in the order they publish: buckle depends on the other two. */
export const PACKAGES = [
  { name: '@5straps/protocol', directory: 'packages/protocol' },
  { name: '@5straps/runtime', directory: 'packages/runtime' },
  { name: '@5straps/buckle', directory: 'buckle' },
]

export const CHANGELOG = 'CHANGELOG.md'

/** The four files a prepared release changes, as git names them from the repository root. */
export const RELEASE_FILES = [CHANGELOG, ...PACKAGES.map(({ directory }) => `${directory}/package.json`)]

/** MAJOR.MINOR.PATCH with no leading zeros, prerelease, or build part. */
const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function isPlainVersion(value) {
  return typeof value === 'string' && PLAIN_VERSION.test(value)
}

/** Negative, zero, or positive as `left` is lower than, equal to, or greater than `right`, both plain versions. */
export function compareVersions(left, right) {
  const [a, b] = [left, right].map(version => version.split('.').map(BigInt))
  const index = a.findIndex((part, at) => part !== b[at])
  if (index === -1) return 0
  return a[index] < b[index] ? -1 : 1
}

export function tagOf(version) {
  return `v${version}`
}

/** The file pnpm pack writes for a package: the scope's @ dropped and its slash made a hyphen. */
export function tarballOf(name, version) {
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`
}

/** The one version the three packages share, read from their package.json files. */
export function sharedVersion(root) {
  const versions = PACKAGES.map(({ name, directory }) => ({ name, version: JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')).version }))
  const distinct = [...new Set(versions.map(item => item.version))]
  if (distinct.length !== 1) throw new Refusal(`The three packages must share one version: ${versions.map(item => `${item.name} is ${item.version}`).join(', ')}`)
  const [version] = distinct
  if (!isPlainVersion(version)) throw new Refusal(`The packages' version ${version} is not a plain MAJOR.MINOR.PATCH version`)
  return version
}

/** The commit a tag in this clone names, or null when the clone has no such tag. */
export function localTagCommit({ run, tag }) {
  try {
    return run('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).trim()
  } catch (error) {
    // `rev-parse --verify --quiet` exits 1 and prints nothing for a ref the clone does not hold.
    if (error.status === 1) return null
    throw error
  }
}

export function requireLocalReleaseTag({ run, version, sha }) {
  const tag = tagOf(version)
  const tagged = localTagCommit({ run, tag })
  if (!tagged) throw new Refusal(`The tag ${tag} is missing: Prepare release must push the release commit and tag before publishing`)
  if (tagged !== sha) throw new Refusal(`The tag ${tag} names ${tagged}, not ${sha}: ${version} was released from another commit`)
  return tagged
}

/** The packages npm already holds at `version`. Failing to ask stops the release: guessing could publish twice or skip one. */
export function packagesOnNpm({ run, version }) {
  return PACKAGES.filter(({ name }) => {
    let versions
    try {
      versions = JSON.parse(run('npm', ['view', name, 'versions', '--json']))
    } catch (error) {
      throw new Refusal(`npm could not list the published versions of ${name} (${error.message}), so the release cannot tell what npm already holds`)
    }
    return [versions].flat().includes(version)
  }).map(({ name }) => name)
}

/** The changelog section headed `## v<version>`, without its heading, or null when there is none. */
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n')
  const start = lines.findIndex(line => line.trimEnd() === `## ${tagOf(version)}`)
  if (start === -1) return null
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, next === -1 ? undefined : next).join('\n').trim() || null
}

/**
 * Whether `after` is the changelog `before` with one section, headed `## v<version>`, added above
 * its earlier sections: the title and every earlier section kept byte for byte, and nothing else added.
 */
export function addsOnlySection({ before, after, version }) {
  const first = before.search(/^## /m)
  const [title, earlier] = first === -1 ? [before, ''] : [before.slice(0, first), before.slice(first)]
  if (after.length < title.length + earlier.length || !after.startsWith(title) || !after.endsWith(earlier)) return false
  const added = after.slice(title.length, after.length - earlier.length).split('\n')
  const start = added.findIndex(line => line.trim() !== '')
  if (start === -1 || added[start].trimEnd() !== `## ${tagOf(version)}`) return false
  return added.slice(start + 1).every(line => !/^##? /.test(line))
}
