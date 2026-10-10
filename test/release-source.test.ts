import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { preparedSource } from '../scripts/release/check-prepared.mjs'
import { requireCi } from '../scripts/release/require-ci.mjs'
import { RELEASE_FILES } from '../scripts/release/packages.mjs'
import { type Run, scratchRepository } from './support/release-repository'

function repository(change: (root: string) => void = () => {}, subject = 'chore(release): v0.1.1 [skip ci]') {
  const root = scratchRepository()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Release test')
  git('config', 'user.email', 'release@example.invalid')
  git('add', '.')
  git('commit', '-m', 'fix: checked source')
  const source = git('rev-parse', 'HEAD').trim()
  for (const file of RELEASE_FILES.slice(1)) {
    const path = join(root, file)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"version": "0.1.0"', '"version": "0.1.1"'))
  }
  const path = join(root, 'CHANGELOG.md')
  const before = readFileSync(path, 'utf8')
  const first = before.indexOf('## ')
  writeFileSync(path, `${before.slice(0, first)}## v0.1.1\n\n### Fixes\n\n- Checked source.\n\n${before.slice(first)}`)
  change(root)
  git('add', '.')
  git('commit', '-m', subject)
  const sha = git('rev-parse', 'HEAD').trim()
  git('tag', 'v0.1.1')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  const calls: string[][] = []
  const run: Run = (command, args) => {
    calls.push([command, ...args])
    if (command === 'git') return git(...args)
    if (command === 'gh' && args[1]?.includes('/check-runs')) {
      const requested = /commits\/([^/]+)/.exec(args[1])?.[1]
      return JSON.stringify({ check_runs: requested === source ? ['verify', 'package-arm64'].map((name, index) => ({
        id: index + 1, name, head_sha: source, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' },
        details_url: `https://github.com/owner/repo/actions/runs/7/job/${index + 1}`,
      })) : [] })
    }
    if (command === 'gh' && args[1] === 'repos/owner/repo/actions/runs/7') {
      return JSON.stringify({ path: '.github/workflows/release-check.yml', event: 'push', head_branch: 'main', head_sha: source })
    }
    throw new Error(`unexpected ${command} ${args.join(' ')}`)
  }
  return { root, git, run, calls, source, sha }
}

describe('CI inheritance for prepared release metadata', () => {
  it('uses only the exact source parent checks for a strictly validated tagged metadata commit', () => {
    const repo = repository()
    expect(preparedSource({ run: repo.run })).toBe(repo.source)
    expect(requireCi({ run: repo.run, repository: 'owner/repo' })).toMatchObject({ ok: true, message: expect.stringContaining('validated source parent') })
    expect(repo.calls).toContainEqual(['gh', 'api', `repos/owner/repo/commits/${repo.source}/check-runs?per_page=100`])
    expect(repo.calls).not.toContainEqual(['gh', 'api', `repos/owner/repo/commits/${repo.sha}/check-runs?per_page=100`])
  })

  it('requires HEAD checks when Prepare asks for source-only CI, even for tagged metadata', () => {
    const repo = repository()
    expect(requireCi({ run: repo.run, repository: 'owner/repo', sourceOnly: true }).ok).toBe(false)
    expect(repo.calls).toContainEqual(['gh', 'api', `repos/owner/repo/commits/${repo.sha}/check-runs?per_page=100`])
    expect(repo.calls).not.toContainEqual(['gh', 'api', `repos/owner/repo/commits/${repo.source}/check-runs?per_page=100`])
  })

  it.each([
    ['an extra source file', (root: string) => writeFileSync(join(root, 'extra.mjs'), 'throw 1\n'), 'exactly the four regular release files'],
    ['an executable manifest', (root: string) => chmodSync(join(root, 'buckle/package.json'), 0o755), 'without mode changes'],
    ['an added manifest field', (root: string) => {
      const file = join(root, 'buckle/package.json')
      writeFileSync(file, readFileSync(file, 'utf8').replace('"version"', '"scripts": {"postinstall": "bad"}, "version"'))
    }, 'only in its version'],
    ['rewritten earlier changelog', (root: string) => {
      const file = join(root, 'CHANGELOG.md')
      writeFileSync(file, readFileSync(file, 'utf8').replace('# Changelog', '# Changed'))
    }, 'only by a new ## v0.1.1 section'],
  ])('refuses inheritance for %s without reading CI', (_, change, reason) => {
    const repo = repository(change)
    expect(requireCi({ run: repo.run, repository: 'owner/repo' })).toMatchObject({ ok: false, message: expect.stringContaining(reason) })
    expect(repo.calls.filter(call => call[0] === 'gh')).toEqual([])
  })

  it.each(['missing', 'moved'])('refuses a %s release tag without reading CI', state => {
    const repo = repository()
    repo.git('tag', '-d', 'v0.1.1')
    if (state === 'moved') repo.git('tag', 'v0.1.1', repo.source)
    expect(requireCi({ run: repo.run, repository: 'owner/repo' })).toMatchObject({ ok: false, message: expect.stringContaining('The tag v0.1.1') })
    expect(repo.calls.filter(call => call[0] === 'gh')).toEqual([])
  })

  it('gives a noncanonical release subject no parent CI exemption', () => {
    const repo = repository(() => {}, 'chore(release): v0.1.1 unexpected')
    expect(requireCi({ run: repo.run, repository: 'owner/repo' }).ok).toBe(false)
    expect(repo.calls).toContainEqual(['gh', 'api', `repos/owner/repo/commits/${repo.sha}/check-runs?per_page=100`])
  })

  it('requires source parent checks rather than walking to an earlier successful ancestor', () => {
    const repo = repository()
    const missingParentChecks: Run = (command, args) => command === 'gh' && args[1]?.includes('/check-runs')
      ? JSON.stringify({ check_runs: [] }) : repo.run(command, args)
    expect(requireCi({ run: missingParentChecks, repository: 'owner/repo' })).toMatchObject({ ok: false, message: expect.stringContaining(`CI has not passed on ${repo.source}`) })
    expect(repo.calls.filter(call => call[0] === 'git' && call[1] === 'show' && call[2] === '--no-patch' && call[3] === '--format=%P')).toEqual([
      ['git', 'show', '--no-patch', '--format=%P', 'HEAD'],
    ])
  })

  it('refuses a merge release commit', () => {
    const repo = repository()
    const tree = repo.git('rev-parse', 'HEAD^{tree}').trim()
    const merge = repo.git('commit-tree', tree, '-p', repo.sha, '-p', repo.source, '-m', 'chore(release): v0.1.1 [skip ci]').trim()
    repo.git('update-ref', 'refs/heads/main', merge)
    repo.git('update-ref', 'refs/remotes/origin/main', merge)
    expect(() => preparedSource({ run: repo.run })).toThrow('exactly one parent')
  })

  it('allows the local release command only with its version tag on HEAD', () => {
    const repo = repository()
    expect(requireCi({ run: repo.run, repository: 'owner/repo', release: true, root: repo.root }).ok).toBe(true)
  })

  it.each(['missing', 'moved'])('refuses a local source release with a %s version tag before reading CI', state => {
    const repo = repository(() => {}, 'fix: checked source with a prepared version')
    repo.git('tag', '-d', 'v0.1.1')
    if (state === 'moved') repo.git('tag', 'v0.1.1', repo.source)
    expect(requireCi({ run: repo.run, repository: 'owner/repo', release: true, root: repo.root })).toMatchObject({ ok: false, message: expect.stringContaining('The tag v0.1.1') })
    expect(repo.calls.filter(call => call[0] === 'gh')).toEqual([])
  })

  it('rejects mixing source-only CI with release validation through the helper or CLI', () => {
    const repo = repository()
    expect(requireCi({ run: repo.run, sourceOnly: true, release: true })).toMatchObject({ ok: false, message: 'Source-only CI and release validation cannot be combined' })
    expect(repo.calls).toEqual([])
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '../scripts/release/require-ci.mjs'), '--source', '--release'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('Usage: node scripts/release/require-ci.mjs [--source|--release]\n')
  })

})
