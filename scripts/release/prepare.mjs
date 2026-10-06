// The first release step, run by the Prepare release workflow or by hand:
//   node scripts/release/prepare.mjs <version>    (or RELEASE_VERSION=<version>)
// It checks the version, sets it in the three packages as `pnpm version:set` does, and writes its
// changelog section with changelogen. It commits nothing: in the workflow, a later job that installs
// nothing checks the four files again (check-prepared.mjs) and commits them, and a person releasing
// by hand reads the result first.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOSITORY_ROOT, Refusal, runAsScript, runCommand, writeStepOutputs } from './command.mjs'
import { CHANGELOG, PACKAGES, addsOnlySection, compareVersions, isPlainVersion, localTagCommit, packagesOnNpm, sharedVersion, tagOf } from './packages.mjs'

/** Prepares `version` in the clone at `root` and returns it with the version it follows. */
export function prepareRelease({ version, root = REPOSITORY_ROOT, run = runCommand }) {
  const previous = prepareReleaseGuard({ version, root, run })
  const changelog = readFileSync(join(root, CHANGELOG), 'utf8')
  run('pnpm', ['run', 'version:set', version])
  run('pnpm', ['exec', 'changelogen', '--from', tagOf(previous), '--to', 'HEAD', '-r', version, '--output', CHANGELOG])
  prepareReleaseCheck({ version, root, changelog })
  return { version, previous }
}

/** Refuses a version that cannot be released next, and returns the version it follows. */
function prepareReleaseGuard({ version, root, run }) {
  if (!isPlainVersion(version)) throw new Refusal(`The version must be plain MAJOR.MINOR.PATCH, such as 0.2.0, with no v, prerelease, or build part; got ${JSON.stringify(version ?? '')}`)
  if (run('git', ['status', '--porcelain']).trim() !== '') throw new Refusal('The working tree has uncommitted changes: the release commit must hold only the version and the changelog')
  const previous = sharedVersion(root)
  if (compareVersions(version, previous) <= 0) throw new Refusal(`${version} must be greater than the current version ${previous}`)
  if (!localTagCommit({ run, tag: tagOf(previous) })) throw new Refusal(`The tag ${tagOf(previous)} of the current version is missing from this clone, and the new changelog section starts there: in a clone, fetch the tags (git fetch --tags origin); if GitHub lacks the tag, push it from the clone that made it (git push origin ${tagOf(previous)})`)
  if (localTagCommit({ run, tag: tagOf(version) })) throw new Refusal(`The tag ${tagOf(version)} already exists`)
  const published = packagesOnNpm({ run, version })
  if (published.length > 0) throw new Refusal(`npm already holds ${published.map(name => `${name}@${version}`).join(', ')}`)
  return previous
}

/**
 * changelogen reports a failure and still exits 0, so the result is read back: every package at the
 * new version, one new section, and the earlier sections kept byte for byte after it.
 */
function prepareReleaseCheck({ version, root, changelog }) {
  if (sharedVersion(root) !== version) throw new Refusal(`pnpm version:set did not set ${version} in the three packages`)
  const written = readFileSync(join(root, CHANGELOG), 'utf8')
  const heading = `## ${tagOf(version)}`
  if (written.split('\n').filter(line => line.trimEnd() === heading).length !== 1) throw new Refusal(`changelogen did not write one ${heading} section into ${CHANGELOG}`)
  if (!addsOnlySection({ before: changelog, after: written, version })) throw new Refusal(`changelogen changed ${CHANGELOG} beyond adding the ${heading} section above the earlier ones`)
}

runAsScript(import.meta.url, () => {
  const { version, previous } = prepareRelease({ version: process.argv[2] ?? process.env.RELEASE_VERSION })
  writeStepOutputs({ version })
  return `Set ${PACKAGES.map(({ name }) => name).join(', ')} to ${version}, and wrote the ${tagOf(version)} section of ${CHANGELOG} from the commits since ${tagOf(previous)}.`
})
