import { describe, expect, it } from 'vitest'
import { createGitHubRelease } from '../scripts/release/github-release.mjs'
import { type Run, commandFailure } from './support/release-repository'

// The Release workflow's last job tags the released commit with its GitHub release. It does nothing
// when both already exist there, so a failed run can be repeated, and refuses a tag on another commit.
// gh is answered here.

const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const TAG_OBJECT = 'c'.repeat(40)
const REPOSITORY = 'wuiyang/5straps-buckle'

type Ref = { ref: string; object: { sha: string; type: 'commit' | 'tag' } }

interface Answers { refs?: readonly Ref[]; refsAfter?: readonly Ref[]; annotated?: { sha: string; type: 'commit' | 'tag' }; release?: 'exists' | 'missing' | 'fails' }

const commitRef = (sha: string, tag = 'v0.1.1'): Ref => ({ ref: `refs/tags/${tag}`, object: { sha, type: 'commit' } })

/** Answers gh as GitHub would; after a release is created, the tag reads as `refsAfter`, or on SHA. */
function fake(answers: Answers = {}) {
  const calls: string[][] = []
  let created = false
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    const path = args[1] ?? ''
    if (command === 'gh' && path === `repos/${REPOSITORY}/git/matching-refs/tags/v0.1.1`) return JSON.stringify(created ? answers.refsAfter ?? [commitRef(SHA)] : answers.refs ?? [])
    if (command === 'gh' && path === `repos/${REPOSITORY}/git/tags/${TAG_OBJECT}`) return JSON.stringify({ object: answers.annotated })
    if (command === 'gh' && path === `repos/${REPOSITORY}/releases/tags/v0.1.1`) {
      if (answers.release === 'exists') return JSON.stringify({ tag_name: 'v0.1.1' })
      throw commandFailure(1, answers.release === 'fails' ? 'gh: Bad credentials (HTTP 401)\n' : 'gh: Not Found (HTTP 404)\n')
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') {
      created = true
      return ''
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`)
  }
  return { run, calls, creations: () => calls.filter(call => call[1] === 'release') }
}

const release = (run: Run, input: Partial<{ repository: string; version: string; sha: string; notes: string }> = {}) =>
  createGitHubRelease({ repository: REPOSITORY, version: '0.1.1', sha: SHA, notes: 'release/notes.md', run, ...input })

describe('the GitHub release', () => {
  it('creates the tag on the released commit with the release when neither exists', () => {
    const gh = fake()
    expect(release(gh.run)).toBe(`Created the release v0.1.1 and its tag on ${SHA}.`)
    expect(gh.creations()).toEqual([['gh', 'release', 'create', 'v0.1.1', '--repo', REPOSITORY, '--title', 'v0.1.1', '--notes-file', 'release/notes.md', '--target', SHA]])
  })

  // A tag only matches by prefix through matching-refs: v0.1.10 is not v0.1.1.
  it('reads a tag that only shares the prefix as no tag', () => {
    const gh = fake({ refs: [commitRef(OTHER, 'v0.1.10')] })
    release(gh.run)
    expect(gh.creations()[0]).toContain('--target')
  })

  it('creates only the release on a tag already on the released commit, without moving the tag', () => {
    const gh = fake({ refs: [commitRef(SHA)] })
    expect(release(gh.run)).toBe(`Created the release v0.1.1 and its tag on ${SHA}.`)
    expect(gh.creations()).toEqual([['gh', 'release', 'create', 'v0.1.1', '--repo', REPOSITORY, '--title', 'v0.1.1', '--notes-file', 'release/notes.md', '--verify-tag']])
  })

  it('does nothing when the tag and the release already exist on the released commit', () => {
    const gh = fake({ refs: [commitRef(SHA)], release: 'exists' })
    expect(release(gh.run)).toBe(`The release v0.1.1 already exists on ${SHA}; nothing to do.`)
    expect(gh.creations()).toEqual([])
  })

  it('follows an annotated tag to its commit', () => {
    const gh = fake({ refs: [{ ref: 'refs/tags/v0.1.1', object: { sha: TAG_OBJECT, type: 'tag' } }], annotated: { sha: SHA, type: 'commit' }, release: 'exists' })
    expect(release(gh.run)).toContain('already exists')
  })

  it.each([
    ['the tag names another commit', { refs: [commitRef(OTHER)] }, `The tag v0.1.1 names ${OTHER}, not the released commit ${SHA}`],
    ['an annotated tag leads to another commit', { refs: [{ ref: 'refs/tags/v0.1.1', object: { sha: TAG_OBJECT, type: 'tag' } }], annotated: { sha: OTHER, type: 'commit' } }, `names ${OTHER}`],
    ['GitHub cannot say whether the release exists', { refs: [commitRef(SHA)], release: 'fails' }, 'exited with 1'],
    ['the created tag names another commit', { refsAfter: [commitRef(OTHER)] }, `its tag names ${OTHER}, not ${SHA}`],
  ] as const)('refuses when %s', (_, answers, reason) => {
    const gh = fake(answers)
    expect(() => release(gh.run)).toThrow(reason)
    if (!('refsAfter' in answers)) expect(gh.creations()).toEqual([])
  })

  it.each([
    ['a repository that is not owner/name', { repository: 'wuiyang/5straps-buckle/extra' }, 'owner/name'],
    ['a version that is not plain', { version: 'v0.1.1' }, 'plain MAJOR.MINOR.PATCH'],
    ['a short commit', { sha: 'abc1234' }, 'full SHA'],
    ['no notes file', { notes: '' }, 'notes file is missing'],
  ])('refuses %s before asking GitHub anything', (_, input, reason) => {
    const gh = fake()
    expect(() => release(gh.run, input)).toThrow(reason)
    expect(gh.calls).toEqual([])
  })
})
