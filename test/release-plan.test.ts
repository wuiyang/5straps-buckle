import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packRelease, planRelease, prepareArtifact } from '../scripts/release/plan.mjs'
import { NAMES, type Run, commandFailure, scratchDirectory, scratchRepository } from './support/release-repository'

// The Release workflow's pack job: the plan refuses a commit that cannot be released, pnpm packs the
// three tarballs, each packed manifest is read back, and the notes are the version's changelog
// section. git, npm, pnpm, and tar are answered here.

const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

const CHANGELOG = `# Changelog


## v0.1.1

[compare changes](https://github.com/wuiyang/5straps-buckle/compare/v0.1.0...v0.1.1)

### Fixes

- Something new ([c0ffee1](https://github.com/wuiyang/5straps-buckle/commit/c0ffee1))

## v0.1.0

### Fixes

- Something old ([b39daf2](https://github.com/wuiyang/5straps-buckle/commit/b39daf2))
`

type Manifest = { name: string; version: string; dependencies?: Record<string, string>; bin?: Record<string, string>; exports?: Record<string, Record<string, string>> }

interface Answers { tag?: string; npm?: Partial<Record<string, readonly string[]>>; packs?: readonly string[]; manifests?: Partial<Record<string, Manifest>>; unbuilt?: boolean }

/** The manifest pnpm packs for a package at 0.1.1: buckle names the other two exactly. */
function packed(name: string): Manifest {
  return name === '@5straps/buckle'
    ? { name, version: '0.1.1', bin: { buckle: './dist/main.js' }, dependencies: { '@5straps/protocol': '0.1.1', '@5straps/runtime': '0.1.1', 'zod': '4.4.3' } }
    : { name, version: '0.1.1', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './*': { default: './dist/*.js' } } }
}

/** What a tarball lists: the built files, unless the build never ran. */
function listing(name: string, unbuilt = false): string {
  const built = name === '@5straps/buckle' ? ['package/dist/main.js'] : ['package/dist/index.d.ts', 'package/dist/index.js']
  return ['package/package.json', 'package/README.md', ...(unbuilt ? [] : built)].join('\n')
}

function fake(answers: Answers = {}) {
  const calls: string[][] = []
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') return `${HEAD}\n`
    if (command === 'git' && args[0] === 'rev-parse') {
      if (answers.tag && args[3] === 'refs/tags/v0.1.1^{commit}') return `${answers.tag}\n`
      throw commandFailure(1)
    }
    if (command === 'npm' && args[0] === 'view') return JSON.stringify(answers.npm?.[args[1] ?? ''] ?? ['0.1.0'])
    if (command === 'pnpm' && args[2] === 'pack') {
      const name = args[1] ?? ''
      // pnpm pack names a scoped package's tarball without the @ and with the slash made a hyphen.
      if ((answers.packs ?? NAMES).includes(name)) writeFileSync(join(args[4] ?? '', `${name.slice(1).replace('/', '-')}-0.1.1.tgz`), '')
      return ''
    }
    if (command === 'tar') {
      const name = NAMES.find(item => (args[1] ?? '').endsWith(`${item.slice(1).replace('/', '-')}-0.1.1.tgz`)) ?? ''
      if (args[0] === '-tzf') return `${listing(name, answers.unbuilt)}\n`
      return JSON.stringify(answers.manifests?.[name] ?? packed(name))
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`)
  }
  return { run, calls }
}

describe('planning a release', () => {
  it('releases the shared version from HEAD with its changelog section as the notes', () => {
    const root = scratchRepository({ versions: '0.1.1', changelog: CHANGELOG })
    expect(planRelease({ root, run: fake().run })).toEqual({
      version: '0.1.1',
      sha: HEAD,
      notes: '[compare changes](https://github.com/wuiyang/5straps-buckle/compare/v0.1.0...v0.1.1)\n\n### Fixes\n\n- Something new ([c0ffee1](https://github.com/wuiyang/5straps-buckle/commit/c0ffee1))',
      tagged: false,
      published: [],
    })
  })

  // A repeated run: npm already has some packages, and the tag may already be on this commit.
  it('says which packages npm already holds, and accepts the tag on this commit', () => {
    const root = scratchRepository({ versions: '0.1.1', changelog: CHANGELOG })
    const plan = planRelease({ root, run: fake({ tag: HEAD, npm: { '@5straps/protocol': ['0.1.0', '0.1.1'], '@5straps/runtime': ['0.1.1'] } }).run })
    expect(plan).toMatchObject({ tagged: true, published: ['@5straps/protocol', '@5straps/runtime'] })
  })

  it.each([
    ['the tag names another commit', { versions: '0.1.1', changelog: CHANGELOG }, { tag: OTHER }, `The tag v0.1.1 names ${OTHER}, not ${HEAD}`],
    ['the changelog has no section for the version', { versions: '0.1.2', changelog: CHANGELOG }, {}, 'CHANGELOG.md has no v0.1.2 section'],
    ['the packages disagree', { versions: { '@5straps/protocol': '0.1.1', '@5straps/runtime': '0.1.1' }, changelog: CHANGELOG }, {}, '@5straps/buckle is 0.1.0'],
  ] as const)('refuses when %s', (_, repository, answers, reason) => {
    const root = scratchRepository(repository)
    expect(() => planRelease({ root, run: fake(answers).run })).toThrow(reason)
  })
})

describe('packing a release', () => {
  it('packs protocol, runtime, then buckle with pnpm and returns the tarballs in that order', () => {
    const destination = scratchDirectory('release-pack-')
    const { run, calls } = fake()
    expect(packRelease({ version: '0.1.1', destination, run })).toEqual(['protocol', 'runtime', 'buckle'].map(name => join(destination, `5straps-${name}-0.1.1.tgz`)))
    expect(calls.filter(call => call[0] === 'pnpm')).toEqual(NAMES.map(name => ['pnpm', '--filter', name, 'pack', '--pack-destination', destination]))
  })

  it.each([
    ['buckle still names workspace:*', { manifests: { '@5straps/buckle': { ...packed('@5straps/buckle'), dependencies: { '@5straps/protocol': 'workspace:*', '@5straps/runtime': '0.1.1' } } } }, '@5straps/buckle@0.1.1 was packed depending on @5straps/protocol@workspace:*, not exactly 0.1.1'],
    ['buckle names a range', { manifests: { '@5straps/buckle': { ...packed('@5straps/buckle'), dependencies: { '@5straps/protocol': '0.1.1', '@5straps/runtime': '^0.1.1' } } } }, '@5straps/runtime@^0.1.1'],
    ['a tarball holds another version', { manifests: { '@5straps/runtime': { name: '@5straps/runtime', version: '0.1.0' } } }, 'The tarball for @5straps/runtime@0.1.1 holds @5straps/runtime@0.1.0'],
    ['pnpm wrote no tarball for a package', { packs: ['@5straps/protocol', '@5straps/buckle'] }, 'pnpm pack did not write'],
    // prepack builds; a machine whose npm config sets ignore-scripts packs the sources alone.
    ['the build never ran', { unbuilt: true }, '@5straps/protocol@0.1.1 was packed without ./dist/index.d.ts, ./dist/index.js, which its manifest points at'],
  ] as const)('refuses when %s', (_, answers, reason) => {
    expect(() => packRelease({ version: '0.1.1', destination: scratchDirectory('release-pack-'), run: fake(answers).run })).toThrow(reason)
  })
})

describe('the release artifact', () => {
  it('holds the three tarballs and the notes', () => {
    const root = scratchRepository({ versions: '0.1.1', changelog: CHANGELOG })
    const destination = join(scratchDirectory('release-artifact-'), 'release')
    const result = prepareArtifact({ destination, root, run: fake().run })
    expect(result.tarballs.every(file => existsSync(file))).toBe(true)
    expect(readFileSync(join(destination, 'notes.md'), 'utf8')).toBe(`${result.notes}\n`)
  })

  it('refuses a directory that already holds something, packing nothing', () => {
    const root = scratchRepository({ versions: '0.1.1', changelog: CHANGELOG })
    const destination = scratchDirectory('release-artifact-')
    writeFileSync(join(destination, '5straps-buckle-0.1.0.tgz'), '')
    const { run, calls } = fake()
    expect(() => prepareArtifact({ destination, root, run })).toThrow('is not empty')
    expect(calls).toEqual([])
  })
})
