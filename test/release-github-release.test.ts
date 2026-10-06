import { describe, expect, it } from 'vitest'
import { createGitHubRelease, createReleaseTag } from '../scripts/release/github-release.mjs'
import { type Run, commandFailure } from './support/release-repository'

// The Release workflow's tag job puts v<version> on the packed commit before anything is published,
// and refuses a tag on another commit, so a version is only ever finished from the commit that
// started it. Its last job creates the GitHub release on that tag. Both do nothing when their part
// already exists, so a failed run can be repeated. gh is answered here.

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const TAG_OBJECT = 'c'.repeat(40)
const REPOSITORY = 'wuiyang/5straps-buckle'

type Ref = { ref: string; object: { sha: string; type: 'commit' | 'tag' } }

interface Answers { refs?: readonly Ref[]; refsAfter?: readonly Ref[]; annotated?: { sha: string; type: 'commit' | 'tag' }; release?: 'exists' | 'missing' | 'fails' }

const commitRef = (sha: string, tag = 'v0.1.1'): Ref => ({ ref: `refs/tags/${tag}`, object: { sha, type: 'commit' } })
const ANNOTATED: Ref = { ref: 'refs/tags/v0.1.1', object: { sha: TAG_OBJECT, type: 'tag' } }

/** Answers gh as GitHub would; once the tag is created, it reads as `refsAfter`, or on SHA. */
function fake(answers: Answers = {}) {
  const calls: string[][] = []
  let created = false
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    const path = args[1] ?? ''
    if (command === 'gh' && path === `repos/${REPOSITORY}/git/matching-refs/tags/v0.1.1`) return JSON.stringify(created ? answers.refsAfter ?? [commitRef(SHA)] : answers.refs ?? [])
    if (command === 'gh' && path === `repos/${REPOSITORY}/git/tags/${TAG_OBJECT}`) return JSON.stringify({ object: answers.annotated })
    if (command === 'gh' && path === `repos/${REPOSITORY}/git/refs`) {
      created = true
      return '{}'
    }
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

const tag = (run: Run, input: Partial<{ repository: string; version: string; sha: string }> = {}) =>
  createReleaseTag({ repository: REPOSITORY, version: '0.1.1', sha: SHA, run, ...input })
const release = (run: Run, input: Partial<{ repository: string; version: string; sha: string; notes: string }> = {}) =>
  createGitHubRelease({ repository: REPOSITORY, version: '0.1.1', sha: SHA, notes: 'release/notes.md', run, ...input })

describe('the release tag', () => {
  it('creates a lightweight tag on the packed commit when GitHub has none', () => {
    const gh = fake()
    expect(tag(gh.run)).toBe(`Created the tag v0.1.1 on ${SHA}.`)
    expect(gh.tagCreations()).toEqual([['gh', 'api', `repos/${REPOSITORY}/git/refs`, '--method', 'POST', '--raw-field', 'ref=refs/tags/v0.1.1', '--raw-field', `sha=${SHA}`]])
  })

  // A tag only matches by prefix through matching-refs: v0.1.10 is not v0.1.1.
  it('reads a tag that only shares the prefix as no tag', () => {
    const gh = fake({ refs: [commitRef(OTHER, 'v0.1.10')] })
    tag(gh.run)
    expect(gh.tagCreations()).toHaveLength(1)
  })

  it.each([
    ['a lightweight tag', { refs: [commitRef(SHA)] }],
    ['an annotated tag', { refs: [ANNOTATED], annotated: { sha: SHA, type: 'commit' } }],
  ] as const)('does nothing when %s already names the packed commit', (_, answers) => {
    const gh = fake(answers)
    expect(tag(gh.run)).toBe(`The tag v0.1.1 is already on ${SHA}; nothing to do.`)
    expect(gh.tagCreations()).toEqual([])
  })

  // A repeated Release from a main that moved after a partial publish stops here, before publishing.
  it.each([
    ['the tag names another commit', { refs: [commitRef(OTHER)] }, `The tag v0.1.1 names ${OTHER}, not the released commit ${SHA}`],
    ['an annotated tag leads to another commit', { refs: [ANNOTATED], annotated: { sha: OTHER, type: 'commit' } }, `names ${OTHER}`],
  ] as const)('refuses, creating nothing, when %s', (_, answers, reason) => {
    const gh = fake(answers)
    expect(() => tag(gh.run)).toThrow(reason)
    expect(gh.tagCreations()).toEqual([])
  })

  it('refuses when the created tag reads back on another commit', () => {
    expect(() => tag(fake({ refsAfter: [commitRef(OTHER)] }).run)).toThrow(`it names ${OTHER}, not ${SHA}`)
  })
})

describe('the GitHub release', () => {
  it('creates the release on the tag already on the released commit, never making or moving a tag', () => {
    const gh = fake({ refs: [commitRef(SHA)] })
    expect(release(gh.run)).toBe(`Created the release v0.1.1 on the tag v0.1.1, which names ${SHA}.`)
    expect(gh.releaseCreations()).toEqual([['gh', 'release', 'create', 'v0.1.1', '--repo', REPOSITORY, '--title', 'v0.1.1', '--notes-file', 'release/notes.md', '--verify-tag']])
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

describe('the inputs of both jobs', () => {
  it.each([
    ['a repository that is not owner/name', { repository: 'wuiyang/5straps-buckle/extra' }, 'owner/name'],
    ['a version that is not plain', { version: 'v0.1.1' }, 'plain MAJOR.MINOR.PATCH'],
    ['a short commit', { sha: 'abc1234' }, 'full SHA'],
  ])('refuse %s before asking GitHub anything', (_, input, reason) => {
    for (const step of [tag, release]) {
      const gh = fake()
      expect(() => step(gh.run, input)).toThrow(reason)
      expect(gh.calls).toEqual([])
    }
  })

  it('refuses a release with no notes file before asking GitHub anything', () => {
    const gh = fake()
    expect(() => release(gh.run, { notes: '' })).toThrow('notes file is missing')
    expect(gh.calls).toEqual([])
  })
})
