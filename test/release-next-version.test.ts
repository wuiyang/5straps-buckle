import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadChangelogConfig, parseCommits } from 'changelogen'
import { inferReleaseVersion, nextReleaseVersion } from '../scripts/release/next-version.mjs'
import { scratchRepository } from './support/release-repository'

const rawCommit = (message: string, body = '') => ({ message, body, shortHash: 'abc1234', author: { name: 'Test', email: 'test@example.com' } })

async function infer(previous: string, message: string, body = '') {
  const root = scratchRepository({ versions: previous })
  const config = await loadChangelogConfig(root, { from: `v${previous}`, to: 'HEAD', repo: 'wuiyang/5straps-buckle' })
  const commits = parseCommits([rawCommit(message, body)], config)
  return inferReleaseVersion({ previous, commits, config })
}

describe('changelogen version inference', () => {
  it.each([
    ['1.2.3', 'fix: repair', '', '1.2.4'],
    ['1.2.3', 'feat: extend', '', '1.3.0'],
    ['1.2.3', 'feat!: replace', '', '2.0.0'],
    ['1.2.3', 'fix: replace', 'BREAKING CHANGE: replaces the API', '2.0.0'],
    ['0.1.0', 'fix: repair', '', '0.1.1'],
    ['0.1.0', 'feat: extend', '', '0.1.1'],
    ['0.1.0', 'feat!: replace', '', '0.2.0'],
    ['0.1.0', 'docs: explain', '', '0.1.1'],
  ])('infers from %s and %s with body %s as %s', async (previous, message, body, expected) => {
    await expect(infer(previous, message, body)).resolves.toBe(expected)
  })

  it.each(['chore: tidy', 'test: cover', 'ci: check', 'unstructured message'])('refuses %s without a fallback patch', async message => {
    await expect(infer('0.1.0', message)).rejects.toThrow('No releasable conventional commits since v0.1.0')
  })

  it('uses only commits since the current shared-version tag and never changes the private root manifest', async () => {
    const root = scratchRepository()
    const manifest = `${JSON.stringify({ name: 'private-repo', private: true, changelog: { repo: 'wuiyang/5straps-buckle' } }, null, 2)}\n`
    writeFileSync(join(root, 'package.json'), manifest)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    git('init', '--quiet')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.com')
    git('add', '.')
    git('commit', '--quiet', '-m', 'feat!: old breaking change')
    git('tag', 'v0.1.0')
    await expect(nextReleaseVersion({ previous: '0.1.0', root })).rejects.toThrow('No releasable conventional commits')
    git('commit', '--quiet', '--allow-empty', '-m', 'fix: current repair')
    await expect(nextReleaseVersion({ previous: '0.1.0', root })).resolves.toBe('0.1.1')
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest)
    expect(git('status', '--porcelain')).toBe('')
    expect(git('tag', '--list')).toBe('v0.1.0\n')
  })
})
