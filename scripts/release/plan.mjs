// The second release step's packing, run by the Stage Buckle workflow once require-ci.mjs has passed:
//   node scripts/release/plan.mjs <empty or new directory>
// It plans the release of the checked-out commit, packs the three tarballs with pnpm, and writes the
// release notes, so the staging job only stages what this wrote.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REPOSITORY_ROOT, Refusal, runAsScript, runCommand, writeStepOutputs } from './command.mjs'
import { CHANGELOG, PACKAGES, changelogSection, requireLocalReleaseTag, packagesOnNpm, sharedVersion, tagOf, tarballOf } from './packages.mjs'

export const NOTES = 'notes.md'

/**
 * What releasing the checked-out commit would do: its version, commit, and notes, whether its tag
 * exists, and which packages npm already holds at that version. A tag on another commit refuses:
 * that version was prepared on another commit, and Prepare release makes the next one.
 */
export function planRelease({ root = REPOSITORY_ROOT, run = runCommand }) {
  const version = sharedVersion(root)
  const tag = tagOf(version)
  const notes = changelogSection(readFileSync(join(root, CHANGELOG), 'utf8'), version)
  if (!notes) throw new Refusal(`${CHANGELOG} has no ${tag} section: prepare ${version} first (the Prepare release workflow, or scripts/release/prepare.mjs)`)
  const sha = run('git', ['rev-parse', 'HEAD']).trim()
  const tagged = requireLocalReleaseTag({ run, version, sha })
  return { version, sha, notes, tagged: tagged !== null, published: packagesOnNpm({ run, version }) }
}

/**
 * Packs each package with pnpm, which writes `workspace:*` as the exact version and runs each
 * package's prepack build, then reads every tarball back. Returns the tarball paths in publish order.
 */
export function packRelease({ version, destination, run = runCommand }) {
  for (const { name } of PACKAGES) run('pnpm', ['--filter', name, 'pack', '--pack-destination', destination], { show: true })
  return PACKAGES.map(({ name }) => {
    const file = join(destination, tarballOf(name, version))
    if (!existsSync(file)) throw new Refusal(`pnpm pack did not write ${file}`)
    const manifest = JSON.parse(run('tar', ['-xzOf', file, 'package/package.json']))
    packReleaseCheck({ name, version, manifest, listing: run('tar', ['-tzf', file]).split('\n') })
    return file
  })
}

/**
 * A packed manifest names its package at the release version and each sibling package at exactly
 * that version, and the tarball holds every file its entry points name. A missing entry point means
 * the build did not run: prepack builds, and an `ignore-scripts` setting skips prepack.
 */
function packReleaseCheck({ name, version, manifest, listing }) {
  if (manifest.name !== name || manifest.version !== version) throw new Refusal(`The tarball for ${name}@${version} holds ${manifest.name}@${manifest.version}`)
  const siblings = ['dependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap(field => Object.entries(manifest[field] ?? {}))
    .filter(([dependency]) => PACKAGES.some(item => item.name === dependency))
  const loose = siblings.filter(([, range]) => range !== version)
  if (loose.length > 0) throw new Refusal(`${name}@${version} was packed depending on ${loose.map(([dependency, range]) => `${dependency}@${range}`).join(', ')}, not exactly ${version}`)
  const packed = new Set(listing.map(entry => entry.trim()))
  const missing = entryPoints(manifest).filter(path => !packed.has(`package/${path.replace(/^\.\//, '')}`))
  if (missing.length > 0) throw new Refusal(`${name}@${version} was packed without ${missing.join(', ')}, which its manifest points at: the build did not run (pnpm pack builds through prepack, which ignore-scripts skips)`)
}

/** The files a manifest's main, types, bin, and exports name, leaving out export patterns. */
function entryPoints(manifest) {
  const leaves = value => typeof value === 'string' ? [value] : Object.values(value ?? {}).flatMap(leaves)
  return [manifest.main, manifest.types, manifest.bin, manifest.exports].flatMap(leaves).filter(path => !path.includes('*'))
}

/** The plan, packing, and notes in one run, into a directory that holds nothing else. */
export function prepareArtifact({ destination, root = REPOSITORY_ROOT, run = runCommand }) {
  if (existsSync(destination) && readdirSync(destination).length > 0) throw new Refusal(`${destination} is not empty: the release artifact must hold only this release`)
  const plan = planRelease({ root, run })
  mkdirSync(destination, { recursive: true })
  const tarballs = packRelease({ version: plan.version, destination, run })
  writeFileSync(join(destination, NOTES), `${plan.notes}\n`)
  return { ...plan, tarballs }
}

await runAsScript(import.meta.url, () => {
  if (!process.argv[2]) throw new Refusal('Usage: node scripts/release/plan.mjs <directory for the tarballs and notes>')
  const plan = prepareArtifact({ destination: resolve(process.argv[2]) })
  writeStepOutputs({ version: plan.version, sha: plan.sha })
  const waiting = PACKAGES.map(({ name }) => name).filter(name => !plan.published.includes(name))
  return [
    `Release ${tagOf(plan.version)} of ${plan.sha}.`,
    `Not public yet: ${waiting.join(', ') || 'nothing, npm holds all three'}.`,
    `Already public on npm: ${plan.published.join(', ') || 'none'}.`,
    `Tag ${tagOf(plan.version)}: already on this commit.`,
    `Packed: ${plan.tarballs.join(', ')}.`,
  ].join('\n')
})
