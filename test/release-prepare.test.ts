import { spawnSync } from 'node:child_process'
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
  const prepare = (root: string, answers: Answers = {}, inferred = '0.1.1') => prepareRelease({ root, run: fake(root, answers).run, inferVersion: async () => inferred })

  it.each(['argument', 'environment'])('refuses a CLI version override through %s', source => {
    const script = join(import.meta.dirname, '../scripts/release/prepare.mjs')
    const result = spawnSync(process.execPath, [script, ...(source === 'argument' ? ['0.2.0'] : [])], {
      cwd: scratchRepository(), encoding: 'utf8',
      env: { ...process.env, RELEASE_VERSION: source === 'environment' ? '0.2.0' : '' },
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Prepare release infers its version from conventional commits; version overrides are not supported\n')
  })

  it('uses the inferred version in all three packages and writes its section above unchanged earlier ones', async () => {
    const root = scratchRepository()
    const { run, calls } = fake(root)
    const inferVersion = async ({ previous, root: source }: { previous: string; root: string }) => {
      expect(previous).toBe('0.1.0')
      expect(source).toBe(root)
      return '0.1.1'
    }
    await expect(prepareRelease({ root, run, inferVersion })).resolves.toEqual({ version: '0.1.1', previous: '0.1.0' })
    expect(readVersions(root)).toEqual(['0.1.1', '0.1.1', '0.1.1'])
    const changelog = readChangelog(root)
    expect(changelog.indexOf('## v0.1.1')).toBeLessThan(changelog.indexOf('## v0.1.0'))
    expect(changelog.endsWith(CHANGELOG.slice(CHANGELOG.indexOf('## v0.1.0')))).toBe(true)
    expect(calls).toContainEqual(['pnpm', 'run', 'version:set', '0.1.1'])
    expect(calls).toContainEqual(['pnpm', 'exec', 'changelogen', '--from', 'v0.1.0', '--to', 'HEAD', '-r', '0.1.1', '--output', 'CHANGELOG.md'])
    expect(calls.filter(call => call[0] === 'git' && ['commit', 'tag', 'push', 'add'].includes(call[1] ?? ''))).toEqual([])
  })

  it.each([
    ['an unchanged inferred version', '0.1.0', {}, 'must be greater than the current version'],
    ['an invalid inferred version', '0.1.1-rc.1', {}, 'changelogen inferred an invalid version'],
    ['a dirty working tree', '0.1.1', { dirty: true }, 'uncommitted changes'],
    ['a released version whose tag is missing', '0.1.1', { tags: [] }, 'The tag v0.1.0 of the current version is missing'],
    ['a version whose tag exists', '0.1.1', { tags: ['v0.1.0', 'v0.1.1'] }, 'The tag v0.1.1 already exists'],
    ['a version npm already holds', '0.1.1', { npm: { '@5straps/runtime': ['0.1.0', '0.1.1'] } }, 'npm already holds @5straps/runtime@0.1.1'],
    ['an npm that cannot answer', '0.1.1', { npmFails: true }, 'npm could not list the published versions'],
  ] as const)('refuses %s before changing release files', async (_, inferred, answers, reason) => {
    const root = scratchRepository()
    const { run, calls } = fake(root, answers)
    await expect(prepareRelease({ root, run, inferVersion: async () => inferred })).rejects.toThrow(reason)
    expect(calls.filter(call => call[0] === 'pnpm')).toEqual([])
    expect(readVersions(root)).toEqual(['0.1.0', '0.1.0', '0.1.0'])
    expect(readChangelog(root)).toBe(CHANGELOG)
  })

  it('prioritizes publishing a prepared version without inferring or changing another version', async () => {
    const changelog = `# Changelog\n${SECTION('0.1.1', 'v0.1.0')}\n\n${CHANGELOG.slice(CHANGELOG.indexOf('## v0.1.0'))}`
    const root = scratchRepository({ versions: '0.1.1', changelog })
    const { run, calls } = fake(root, { npmFails: true })
    let inferred = false
    await expect(prepareRelease({ root, run, inferVersion: async () => { inferred = true; return '0.1.2' } })).rejects.toThrow(
      'The tag v0.1.1 of the current version is missing from this clone, but CHANGELOG.md already has its section. Prepare release must push its release commit and tag together. Fetch tags (git fetch --tags origin), then inspect the preparation run and release history before retrying; publishing never creates a missing tag. If this version was already released, fetch existing tags (git fetch --tags origin); if its tag is also missing on GitHub, check the release history before restoring it',
    )
    expect(inferred).toBe(false)
    expect(calls.filter(call => call[0] === 'npm' || call[0] === 'pnpm')).toEqual([])
    expect(calls.filter(call => call[0] === 'git' && ['commit', 'tag', 'push', 'add'].includes(call[1] ?? ''))).toEqual([])
    expect(readVersions(root)).toEqual(['0.1.1', '0.1.1', '0.1.1'])
    expect(readChangelog(root)).toBe(changelog)
  })

  it('keeps tag recovery guidance for a published version with a missing tag', async () => {
    const root = scratchRepository()
    await expect(prepare(root, { tags: [] })).rejects.toThrow('If this version was already released, fetch existing tags (git fetch --tags origin)')
  })

  it('keeps tag recovery guidance when no changelog section identifies a prepared version', async () => {
    const root = scratchRepository({ changelog: '# Changelog\n' })
    const { run, calls } = fake(root, { tags: [] })
    await expect(prepareRelease({ root, run })).rejects.toThrow('The tag v0.1.0 of the current version is missing')
    expect(calls.filter(call => call[0] === 'npm' || call[0] === 'pnpm')).toEqual([])
  })

  it('leaves files unchanged when conventional commits yield no release', async () => {
    const root = scratchRepository()
    const { run, calls } = fake(root)
    await expect(prepareRelease({ root, run, inferVersion: async () => { throw new Error('No releasable conventional commits') } })).rejects.toThrow('No releasable conventional commits')
    expect(calls.filter(call => call[0] === 'pnpm' || call[0] === 'npm')).toEqual([])
    expect(readVersions(root)).toEqual(['0.1.0', '0.1.0', '0.1.0'])
    expect(readChangelog(root)).toBe(CHANGELOG)
  })

  it('refuses packages that do not share one version', async () => {
    const root = scratchRepository({ versions: { '@5straps/runtime': '0.1.1' } })
    await expect(prepare(root)).rejects.toThrow('must share one version')
  })

  it.each([
    ['changelogen wrote nothing', { changelogen: 'nothing' }, 'did not write one ## v0.1.1 section'],
    ['changelogen dropped earlier sections', { changelogen: 'rewrite' }, 'changed CHANGELOG.md beyond adding'],
    ['changelogen changed an earlier section', { changelogen: 'alter' }, 'changed CHANGELOG.md beyond adding'],
    ['changelogen changed the title', { changelogen: 'retitle' }, 'changed CHANGELOG.md beyond adding'],
    ['version:set missed a package', { versionSet: 'two' }, 'must share one version'],
  ] as const)('refuses when %s', async (_, answers, reason) => {
    await expect(prepare(scratchRepository(), answers)).rejects.toThrow(reason)
  })

  it('refuses a preexisting section when changelogen writes nothing', async () => {
    const root = scratchRepository({ changelog: `${CHANGELOG}${SECTION('0.1.1', 'v0.1.0')}\n` })
    await expect(prepare(root, { changelogen: 'nothing' })).rejects.toThrow('changed CHANGELOG.md beyond adding')
  })
})
