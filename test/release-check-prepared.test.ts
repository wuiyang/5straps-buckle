import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkPrepared } from '../scripts/release/check-prepared.mjs'
import { RELEASE_FILES } from '../scripts/release/packages.mjs'
import { CHANGELOG, DIRECTORIES, NAMES, type Run, readChangelog, scratchRepository, setVersion, type PackageName } from './support/release-repository'

// The Prepare release commit job holds the push token and takes four files from a job that ran
// changelogen and its dependencies. Before it commits, this check refuses anything beyond the version
// of the three packages and one new changelog section on top. git is answered here.

const SECTION = '\n## v0.1.1\n\n[compare changes](https://github.com/wuiyang/5straps-buckle/compare/v0.1.0...v0.1.1)\n\n### Fixes\n\n- Something new ([c0ffee1](https://github.com/wuiyang/5straps-buckle/commit/c0ffee1))\n\n'
const MODIFIED = RELEASE_FILES.map(file => ` M ${file}`)

/** A clone at 0.1.0 whose four files then hold 0.1.1 as the prepare job writes them, and git answering as it would there. */
function prepared(status: readonly string[] = MODIFIED, versions: string | Partial<Record<PackageName, string>> = '0.1.0') {
  const root = scratchRepository({ versions })
  const head = Object.fromEntries(RELEASE_FILES.map(file => [file, readFileSync(join(root, file), 'utf8')]))
  for (const name of NAMES) setVersion(root, name, '0.1.1')
  const at = CHANGELOG.indexOf('## v0.1.0')
  writeFileSync(join(root, 'CHANGELOG.md'), `${CHANGELOG.slice(0, at)}${SECTION.trimStart()}${CHANGELOG.slice(at)}`)
  const run: Run = (command, args) => {
    if (command === 'git' && args.join(' ') === 'status --porcelain --untracked-files=all') return status.map(line => `${line}\n`).join('')
    const file = /^HEAD:(.+)$/.exec(args[1] ?? '')?.[1]
    if (command === 'git' && args[0] === 'show' && file && file in head) return head[file] ?? ''
    throw new Error(`unexpected ${command} ${args.join(' ')}`)
  }
  return { root, run, check: (version: unknown) => checkPrepared({ version, root, run }) }
}

const BUCKLE = join(DIRECTORIES['@5straps/buckle'], 'package.json')
const edit = (root: string, file: string, change: (text: string) => string) => writeFileSync(join(root, file), change(readFileSync(join(root, file), 'utf8')))

describe('the prepared release check', () => {
  it('passes the four files as the prepare job writes them', () => {
    expect(prepared().check('0.1.1')).toBe('The prepared files change only the version of the three packages, set to 0.1.1, and add the v0.1.1 section of CHANGELOG.md.')
  })

  it.each([
    ['another changed file', [...MODIFIED, ' M pnpm-lock.yaml']],
    ['a new file', [...MODIFIED, '?? .github/workflows/extra.yml']],
    ['one of the four missing', MODIFIED.slice(1)],
    ['a staged file', [...MODIFIED.slice(1), `M  ${RELEASE_FILES[0]}`]],
    ['a deleted package.json', [...MODIFIED.slice(0, 3), ` D ${RELEASE_FILES[3]}`]],
  ] as const)('refuses a working tree with %s', (_, status) => {
    expect(() => prepared(status).check('0.1.1')).toThrow('The prepared release must change exactly CHANGELOG.md, packages/protocol/package.json, packages/runtime/package.json, buckle/package.json')
  })

  it.each([
    ['a field beyond the version', (text: string) => text.replace('"version"', '"scripts": { "postinstall": "node x.js" },\n  "version"')],
    // JSON.parse keeps the last of two keys, so only the text shows the first.
    ['a duplicate key that JSON.parse hides', (text: string) => text.replace('"version"', '"version": "9.9.9",\n  "version"')],
    ['the same fields formatted differently', (text: string) => JSON.stringify(JSON.parse(text))],
    ['another version than the one asked for', (text: string) => text.replace('0.1.1', '0.1.2')],
  ])('refuses buckle/package.json with %s', (_, change) => {
    const release = prepared()
    edit(release.root, BUCKLE, change)
    expect(() => release.check('0.1.1')).toThrow('buckle/package.json must differ from HEAD only in its version, set to 0.1.1')
  })

  it('refuses a version that is not greater than the one at HEAD', () => {
    const release = prepared()
    for (const name of NAMES) setVersion(release.root, name, '0.1.0')
    expect(() => release.check('0.1.0')).toThrow('0.1.0 must be greater than "0.1.0", the version of packages/protocol/package.json at HEAD')
  })

  it.each(['v0.1.1', '0.1.1\n', '', undefined])('refuses %j as a version before reading anything', (version) => {
    expect(() => prepared().check(version)).toThrow('plain MAJOR.MINOR.PATCH')
  })

  it('refuses artifacts whose shared version differs from the inferred output', () => {
    const release = prepared()
    for (const name of NAMES) setVersion(release.root, name, '0.1.2')
    writeFileSync(join(release.root, 'CHANGELOG.md'), readChangelog(release.root).replaceAll('v0.1.1', 'v0.1.2'))
    expect(() => release.check('0.1.1')).toThrow('must differ from HEAD only in its version, set to 0.1.1')
  })

  it.each([
    ['0.1.0', '0.1.1'], ['0.1.0', '0.2.0'],
    ['1.2.3', '1.2.4'], ['1.2.3', '1.3.0'], ['1.2.3', '2.0.0'],
  ])('accepts the bounded bump from %s to %s', (previous, version) => {
    const release = prepared(MODIFIED, previous)
    for (const name of NAMES) setVersion(release.root, name, version)
    writeFileSync(join(release.root, 'CHANGELOG.md'), readChangelog(release.root).replaceAll('v0.1.1', `v${version}`))
    expect(() => release.check(version)).not.toThrow()
  })

  it('refuses differing package versions at HEAD', () => {
    const release = prepared(MODIFIED, { '@5straps/runtime': '0.0.9' })
    expect(() => release.check('0.1.1')).toThrow('must share one version at HEAD')
  })

  it('refuses an arbitrary higher version from the dependency job', () => {
    const release = prepared()
    for (const name of NAMES) setVersion(release.root, name, '9.9.9')
    writeFileSync(join(release.root, 'CHANGELOG.md'), readChangelog(release.root).replaceAll('v0.1.1', 'v9.9.9'))
    expect(() => release.check('9.9.9')).toThrow('must be a single changelogen version bump after 0.1.0')
  })

  it.each([
    ['an earlier section changed', (text: string) => text.replace('Refuse what should be refused', 'Something else')],
    ['the title changed', (text: string) => text.replace('# Changelog', '# Changes')],
    ['a second new section', (text: string) => text.replace('### Fixes', '## v9.9.9\n\n### Fixes')],
    ['text above the new section', (text: string) => text.replace('## v0.1.1', 'Run this first.\n\n## v0.1.1')],
    ['the new section below the earlier ones', () => `${CHANGELOG}${SECTION}`],
    ['no new section', () => CHANGELOG],
  ])('refuses a changelog with %s', (_, change) => {
    const release = prepared()
    writeFileSync(join(release.root, 'CHANGELOG.md'), change(readChangelog(release.root)))
    expect(() => release.check('0.1.1')).toThrow('CHANGELOG.md must differ from HEAD only by a new ## v0.1.1 section above the earlier ones')
  })
})
