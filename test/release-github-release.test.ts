import { describe, expect, it } from 'vitest'
import { createGitHubRelease, requirePreparedTag } from '../scripts/release/github-release.mjs'
import { CHANGELOG, type Run, commandFailure, scratchRepository } from './support/release-repository'

// Stage Buckle's confirm-tag job checks the prepared tag before staging, and its github-release job
// creates the GitHub release on that tag once all three versions are public, never creating a tag.
// The notes are the version's changelog section in the checkout. gh is answered here.

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const TAG_OBJECT = 'c'.repeat(40)
const REPOSITORY = 'wuiyang/5straps-buckle'

type Ref = { ref: string; object: { sha: string; type: 'commit' | 'tag' } }

interface Answers { refs?: readonly Ref[]; annotated?: { sha: string; type: 'commit' | 'tag' }; release?: 'exists' | 'missing' | 'fails' }

const commitRef = (sha: string, tag = 'v0.1.1'): Ref => ({ ref: `refs/tags/${tag}`, object: { sha, type: 'commit' } })
const ANNOTATED: Ref = { ref: 'refs/tags/v0.1.1', object: { sha: TAG_OBJECT, type: 'tag' } }

/** Answers gh as GitHub would for the tag's refs, an annotated tag object, and the release. */
function fake(answers: Answers = {}) {
  const calls: string[][] = []
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    const path = args[1] ?? ''
    if (command === 'gh' && path === `repos/${REPOSITORY}/git/matching-refs/tags/v0.1.1`) return JSON.stringify(answers.refs ?? [])
    if (command === 'gh' && path === `repos/${REPOSITORY}/git/tags/${TAG_OBJECT}`) return JSON.stringify({ object: answers.annotated })
    if (command === 'gh' && path === `repos/${REPOSITORY}/releases/tags/v0.1.1`) {
      if (answers.release === 'exists') return JSON.stringify({ tag_name: 'v0.1.1' })
      throw commandFailure(1, answers.release === 'fails' ? 'gh: Bad credentials (HTTP 401)\n' : 'gh: Not Found (HTTP 404)\n')
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') return ''
    throw new Error(`unexpected ${command} ${args.join(' ')}`)
  }
  return {
    run,
    calls,
    tagCreations: () => calls.filter(call => call[2] === `repos/${REPOSITORY}/git/refs`),
    releaseCreations: () => calls.filter(call => call[1] === 'release'),
  }
}

const NOTES = '[compare changes](https://github.com/wuiyang/5straps-buckle/compare/v0.1.0...v0.1.1)\n\n### Fixes\n\n- Something new'
/** A checkout of the release commit: its changelog holds the v0.1.1 section above the earlier ones. */
const checkout = () => scratchRepository({ versions: '0.1.1', changelog: `# Changelog\n\n\n## v0.1.1\n\n${NOTES}\n\n${CHANGELOG.slice(CHANGELOG.indexOf('## v0.1.0'))}` })

const release = (run: Run, input: Partial<{ repository: string; version: string; sha: string; root: string }> = {}) =>
  createGitHubRelease({ repository: REPOSITORY, version: '0.1.1', sha: SHA, root: checkout(), run, ...input })

describe('confirming the prepared tag before npm publishing', () => {
  it.each([
    ['a lightweight tag', { refs: [commitRef(SHA)] }],
    ['an annotated tag', { refs: [ANNOTATED], annotated: { sha: SHA, type: 'commit' } }],
  ] as const)('accepts %s without creating or moving anything', (_, answers) => {
    const gh = fake(answers)
    expect(requirePreparedTag({ repository: REPOSITORY, version: '0.1.1', sha: SHA, run: gh.run })).toBe(`The prepared tag v0.1.1 names ${SHA}.`)
    expect(gh.calls.every(call => call[1] === 'api' && call.length === 3)).toBe(true)
  })

  it.each([
    ['a missing tag', {}],
    ['a prefix-only tag', { refs: [commitRef(SHA, 'v0.1.10')] }],
    ['a moved tag', { refs: [commitRef(OTHER)] }],
    ['a moved annotated tag', { refs: [ANNOTATED], annotated: { sha: OTHER, type: 'commit' } }],
  ] as const)('refuses %s without making a tag', (_, answers) => {
    const gh = fake(answers)
    expect(() => requirePreparedTag({ repository: REPOSITORY, version: '0.1.1', sha: SHA, run: gh.run })).toThrow()
    expect(gh.calls.every(call => call[1] === 'api' && call.length === 3)).toBe(true)
  })
})

describe('the GitHub release', () => {
  it('creates the release on the tag already on the released commit, never making or moving a tag', () => {
    const gh = fake({ refs: [commitRef(SHA)] })
    expect(release(gh.run)).toBe(`Created the release v0.1.1 on the tag v0.1.1, which names ${SHA}.`)
    expect(gh.releaseCreations()).toEqual([['gh', 'release', 'create', 'v0.1.1', '--repo', REPOSITORY, '--title', 'v0.1.1', '--notes', NOTES, '--verify-tag']])
    expect(gh.tagCreations()).toEqual([])
  })

  it('does nothing when the tag and the release already exist on the released commit', () => {
    const gh = fake({ refs: [commitRef(SHA)], release: 'exists' })
    expect(release(gh.run)).toBe(`The release v0.1.1 already exists on ${SHA}; nothing to do.`)
    expect(gh.releaseCreations()).toEqual([])
  })

  it('follows an annotated tag to its commit', () => {
    const gh = fake({ refs: [ANNOTATED], annotated: { sha: SHA, type: 'commit' }, release: 'exists' })
    expect(release(gh.run)).toContain('already exists')
  })

  it.each([
    ['the tag is missing', {}, 'The tag v0.1.1 is missing on GitHub'],
    ['the tag names another commit', { refs: [commitRef(OTHER)] }, `The tag v0.1.1 names ${OTHER}, not the released commit ${SHA}`],
    ['an annotated tag leads to another commit', { refs: [ANNOTATED], annotated: { sha: OTHER, type: 'commit' } }, `names ${OTHER}`],
    ['GitHub cannot say whether the release exists', { refs: [commitRef(SHA)], release: 'fails' }, 'exited with 1'],
  ] as const)('refuses, creating nothing, when %s', (_, answers, reason) => {
    const gh = fake(answers)
    expect(() => release(gh.run)).toThrow(reason)
    expect(gh.releaseCreations()).toEqual([])
    expect(gh.tagCreations()).toEqual([])
  })
})

describe('the GitHub release inputs', () => {
  it.each([
    ['a repository that is not owner/name', { repository: 'wuiyang/5straps-buckle/extra' }, 'owner/name'],
    ['a version that is not plain', { version: 'v0.1.1' }, 'plain MAJOR.MINOR.PATCH'],
    ['a short commit', { sha: 'abc1234' }, 'full SHA'],
  ])('refuse %s before asking GitHub anything', (_, input, reason) => {
    for (const step of [release, (run: Run, input: Partial<{ repository: string; version: string; sha: string }>) => requirePreparedTag({ repository: REPOSITORY, version: '0.1.1', sha: SHA, run, ...input })]) {
      const gh = fake()
      expect(() => step(gh.run, input)).toThrow(reason)
      expect(gh.calls).toEqual([])
    }
  })

  it('refuses a checkout whose changelog has no section for the version before asking GitHub anything', () => {
    const gh = fake()
    expect(() => release(gh.run, { root: scratchRepository({ versions: '0.1.1' }) })).toThrow('CHANGELOG.md has no v0.1.1 section to take the release notes from')
    expect(gh.calls).toEqual([])
  })
})
