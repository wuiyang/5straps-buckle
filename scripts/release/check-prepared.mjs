// The Prepare release workflow's commit job, which holds the push token, runs this once it has copied
// the four files the prepare job wrote over a fresh checkout of the same commit:
//   RELEASE_VERSION=<version> node scripts/release/check-prepared.mjs
// The prepare job ran changelogen and its dependencies, so its files are taken as untrusted. This
// script uses only Node and git, and refuses unless the working tree changes exactly those four files,
// each package.json only in its version, set to <version>, and CHANGELOG.md only by a new top section.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT, Refusal, runAsScript, runCommand } from './command.mjs'
import { CHANGELOG, PACKAGES, RELEASE_FILES, addsOnlySection, compareVersions, isPlainVersion, tagOf } from './packages.mjs'

/** Refuses a working tree that holds anything beyond the prepared release of `version`. */
export function checkPrepared({ version, root = REPOSITORY_ROOT, run = runCommand }) {
  if (!isPlainVersion(version)) throw new Refusal(`The version must be plain MAJOR.MINOR.PATCH; got ${JSON.stringify(version ?? '')}`)
  checkChangedPaths({ run })
  for (const { directory } of PACKAGES) checkManifest({ file: `${directory}/package.json`, version, root, run })
  const before = run('git', ['show', `HEAD:${CHANGELOG}`])
  if (!addsOnlySection({ before, after: readFileSync(join(root, CHANGELOG), 'utf8'), version })) {
    throw new Refusal(`${CHANGELOG} must differ from HEAD only by a new ## ${tagOf(version)} section above the earlier ones`)
  }
  return `The prepared files change only the version of the three packages, set to ${version}, and add the ${tagOf(version)} section of ${CHANGELOG}.`
}

/** git status must name the four files, each changed in the working tree, and nothing else. */
function checkChangedPaths({ run }) {
  const listed = run('git', ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(line => line !== '')
  const expected = RELEASE_FILES.map(file => ` M ${file}`)
  if (listed.length !== expected.length || !expected.every(line => listed.includes(line))) {
    throw new Refusal(`The prepared release must change exactly ${RELEASE_FILES.join(', ')}; git status lists ${listed.map(line => JSON.stringify(line)).join(', ') || 'nothing'}`)
  }
}

/**
 * The file must be its HEAD text with the version value replaced, character for character, so no
 * other field, duplicate key, or formatting change rides along, and the version must go up.
 */
function checkManifest({ file, version, root, run }) {
  const before = run('git', ['show', `HEAD:${file}`])
  const previous = JSON.parse(before).version
  if (!isPlainVersion(previous) || compareVersions(version, previous) <= 0) throw new Refusal(`${version} must be greater than ${JSON.stringify(previous)}, the version of ${file} at HEAD`)
  const field = value => `"version": ${JSON.stringify(value)}`
  const after = readFileSync(join(root, file), 'utf8')
  if (after !== before.replace(field(previous), field(version)) || JSON.parse(after).version !== version) {
    throw new Refusal(`${file} must differ from HEAD only in its version, set to ${version}`)
  }
}

runAsScript(import.meta.url, () => checkPrepared({ version: process.env.RELEASE_VERSION }))
