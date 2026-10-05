import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareRelease } from '../scripts/release/prepare.mjs'
import { CHANGELOG, NAMES, type Run, commandFailure, readChangelog, readVersions, scratchRepository, setVersion } from './support/release-repository'

// Release step one checks the version against the packages, the tags, and npm, then sets it as
// `pnpm version:set` does and writes its changelog section with changelogen, keeping every earlier
// section as it was. git, npm, and pnpm are answered here; nothing commits, tags, or pushes.

const SECTION = (version: string, from: string) => `\n## v${version}\n\n[compare changes](https://github.com/wuiyang/5straps-buckle/compare/${from}...v${version})\n\n### Fixes\n\n- Something new ([c0ffee1](https://github.com/wuiyang/5straps-buckle/commit/c0ffee1))`

interface Answers { tags?: readonly string[]; npm?: Partial<Record<string, readonly string[]>>; npmFails?: boolean; dirty?: boolean; versionSet?: 'two'; changelogen?: 'insert' | 'nothing' | 'rewrite' | 'alter' | 'retitle' }

/** Answers git, npm, and pnpm as a clone at `root` would, doing what version:set and changelogen do to its files. */
function fake(root: string, answers: Answers = {}) {
  const calls: string[][] = []
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    const line = args.join(' ')
    if (command === 'git' && line === 'status --porcelain') return answers.dirty ? ' M CHANGELOG.md\n' : ''
    if (command === 'git' && args[0] === 'rev-parse') {
      const tag = /^refs\/tags\/(.+)\^\{commit\}$/.exec(args[3] ?? '')?.[1]
      if ((answers.tags ?? ['v0.1.0']).includes(tag ?? '')) return `${'a'.repeat(40)}\n`
      throw commandFailure(1)
    }
    if (command === 'npm' && args[0] === 'view') {
      if (answers.npmFails) throw commandFailure(1, 'npm error code ETIMEDOUT')
      return JSON.stringify(answers.npm?.[args[1] ?? ''] ?? ['0.1.0'])
    }
    if (command === 'pnpm' && args[0] === 'run' && args[1] === 'version:set') {
      for (const name of answers.versionSet === 'two' ? NAMES.slice(0, 2) : NAMES) setVersion(root, name, args[2] ?? '')
      return ''
    }
    if (command === 'pnpm' && args[1] === 'changelogen') {
      const version = args[args.indexOf('-r') + 1] ?? ''
      const from = args[args.indexOf('--from') + 1] ?? ''
      const changelog = readChangelog(root)
      // changelogen puts the new section before the first heading of level two or three.
      const at = changelog.search(/^###?\s+/m)
      const inserted = `${changelog.slice(0, at)}${SECTION(version, from)}\n\n${changelog.slice(at)}`
      const written = {
        insert: inserted,
        nothing: changelog,
        rewrite: `# Changelog\n${SECTION(version, from)}\n`,
        alter: inserted.replace('Refuse what should be refused', 'Something else'),
        retitle: inserted.replace('# Changelog', '# Changes'),
      }
      writeFileSync(join(root, 'CHANGELOG.md'), written[answers.changelogen ?? 'insert'])
      return ''
    }
    throw new Error(`unexpected ${command} ${line}`)
  }
  return { run, calls }
}

describe('preparing a release', () => {
  it('sets the version in the three packages and writes its section above the earlier ones, unchanged', () => {
    const root = scratchRepository()
    const { run, calls } = fake(root)
    expect(prepareRelease({ version: '0.1.1', root, run })).toEqual({ version: '0.1.1', previous: '0.1.0' })
    expect(readVersions(root)).toEqual(['0.1.1', '0.1.1', '0.1.1'])
    const changelog = readChangelog(root)
    expect(changelog.indexOf('## v0.1.1')).toBeLessThan(changelog.indexOf('## v0.1.0'))
    expect(changelog.endsWith(CHANGELOG.slice(CHANGELOG.indexOf('## v0.1.0')))).toBe(true)
    expect(calls).toContainEqual(['pnpm', 'run', 'version:set', '0.1.1'])
    expect(calls).toContainEqual(['pnpm', 'exec', 'changelogen', '--from', 'v0.1.0', '--to', 'HEAD', '-r', '0.1.1', '--output', 'CHANGELOG.md'])
    expect(calls.filter(call => call[0] === 'git' && ['commit', 'tag', 'push', 'add'].includes(call[1] ?? ''))).toEqual([])
  })

  it('compares versions as numbers, so 0.10.0 follows 0.9.0', () => {
    const root = scratchRepository({ versions: '0.9.0' })
    expect(prepareRelease({ version: '0.10.0', root, run: fake(root, { tags: ['v0.9.0'] }).run }).previous).toBe('0.9.0')
  })

  it.each([
    'v0.1.1', '0.1', '0.1.1-rc.1', '0.1.1+build.5', '01.1.1', ' 0.1.1', '0.1.1\n', '0.1.1; echo owned', '', undefined,
  ])('refuses %j as a version before running anything', (version) => {
    const root = scratchRepository()
    const { run, calls } = fake(root)
    expect(() => prepareRelease({ version, root, run })).toThrow('plain MAJOR.MINOR.PATCH')
    expect(calls).toEqual([])
  })

  it.each([
    ['the current version', '0.1.0', {}, 'must be greater than the current version 0.1.0'],
    ['a lower version', '0.0.9', {}, 'must be greater than the current version 0.1.0'],
    ['a dirty working tree', '0.1.1', { dirty: true }, 'uncommitted changes'],
    ['a clone without the tag of the current version', '0.1.1', { tags: [] }, 'The tag v0.1.0 of the current version is missing'],
    ['a version whose tag exists', '0.1.1', { tags: ['v0.1.0', 'v0.1.1'] }, 'The tag v0.1.1 already exists'],
    ['a version npm already holds', '0.1.1', { npm: { '@5straps/runtime': ['0.1.0', '0.1.1'] } }, 'npm already holds @5straps/runtime@0.1.1'],
    ['an npm that cannot answer', '0.1.1', { npmFails: true }, 'npm could not list the published versions of @5straps/protocol'],
  ] as const)('refuses %s, changing nothing', (_, version, answers, reason) => {
    const root = scratchRepository()
    const { run, calls } = fake(root, answers)
    expect(() => prepareRelease({ version, root, run })).toThrow(reason)
    expect(calls.filter(call => call[0] === 'pnpm')).toEqual([])
    expect(readVersions(root)).toEqual(['0.1.0', '0.1.0', '0.1.0'])
    expect(readChangelog(root)).toBe(CHANGELOG)
  })

  it('refuses a changelog that already held the section when changelogen wrote nothing', () => {
    const root = scratchRepository({ changelog: `${CHANGELOG}${SECTION('0.1.1', 'v0.1.0')}\n` })
    expect(() => prepareRelease({ version: '0.1.1', root, run: fake(root, { changelogen: 'nothing' }).run })).toThrow('changed CHANGELOG.md beyond adding the ## v0.1.1 section above the earlier ones')
  })

  it('refuses packages that do not share one version', () => {
    const root = scratchRepository({ versions: { '@5straps/runtime': '0.1.1' } })
    expect(() => prepareRelease({ version: '0.2.0', root, run: fake(root).run })).toThrow('must share one version: @5straps/protocol is 0.1.0, @5straps/runtime is 0.1.1, @5straps/buckle is 0.1.0')
  })

  // changelogen logs a failure and still exits 0, so the files are read back.
  it.each([
    ['changelogen wrote nothing', { changelogen: 'nothing' }, 'did not write one ## v0.1.1 section'],
    ['changelogen dropped the earlier sections', { changelogen: 'rewrite' }, 'changed CHANGELOG.md beyond adding the ## v0.1.1 section'],
    ['changelogen changed an earlier section', { changelogen: 'alter' }, 'changed CHANGELOG.md beyond adding the ## v0.1.1 section'],
    ['changelogen changed the title', { changelogen: 'retitle' }, 'changed CHANGELOG.md beyond adding the ## v0.1.1 section'],
    ['version:set missed a package', { versionSet: 'two' }, 'must share one version'],
  ] as const)('refuses when %s', (_, answers, reason) => {
    const root = scratchRepository()
    expect(() => prepareRelease({ version: '0.1.1', root, run: fake(root, answers).run })).toThrow(reason)
  })
})
