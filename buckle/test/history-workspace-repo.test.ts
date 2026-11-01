import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { parseBatch, parseBatchCheck, parseIndex, parseLocation, seedCandidates, writeIndex } from '../common/services/history/workspace-repo.js'

// Slice F3: the pure parts of a seed from a folder's repository, against what git itself writes and reads.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-workspace-repo-')); roots.push(root)
  const config = join(root, 'gitconfig'); writeFileSync(config, '')
  const top = join(root, 'repo')
  const git = (args: string[], env: Record<string, string> = {}) => execFileSync('git', args, { cwd: top, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, ...env } })
  mkdirSync(join(top, 'app', 'deep'), { recursive: true }); mkdirSync(join(top, 'other'))
  for (const name of ['app/a.txt', 'app/deep/a-much-longer-name-than-the-others.txt', 'app/deep/b.txt', 'app/secret.env', 'other/c.txt']) writeFileSync(join(top, name), `${name}\n`)
  git(['init', '--quiet']); git(['add', '-A'])
  return { root, top, git }
}
/** `git ls-files -s` of an index: each entry's mode, blob id, stage, and name. */
function listed(git: ReturnType<typeof repository>['git'], index?: string): string[] { return git(['ls-files', '-s'], index ? { GIT_INDEX_FILE: index } : {}).trim().split('\n') }

describe('a repository\'s index read in-process', () => {
  for (const version of [2, 3, 4]) it(`reads every entry of a version ${version} index, as git lists it`, () => {
    const { top, git } = repository()
    git(['update-index', '--index-version', String(version)])
    if (version === 3) git(['update-index', '--skip-worktree', 'other/c.txt'])
    const parsed = parseIndex(readFileSync(join(top, '.git', 'index')))!
    expect(parsed.entries.map(entry => `${entry.stat.readUInt32BE(24).toString(8)} ${entry.id} 0\t${entry.name.toString()}`)).toEqual(listed(git))
    expect(parsed.plain).toBe(version !== 3)
  })

  it('reads a split index as not plain, and a damaged one not at all', () => {
    const { top, git } = repository()
    git(['update-index', '--split-index'])
    expect(parseIndex(readFileSync(join(top, '.git', 'index')))?.plain).toBe(false)
    git(['update-index', '--no-split-index'])
    const index = readFileSync(join(top, '.git', 'index')); index[40] = index[40]! ^ 1
    expect(parseIndex(index)).toBeUndefined()
  })

  it('seeds the entries below a folder, outside a protected name and older than the index, in an index git reads as written', () => {
    const { top, git } = repository()
    const old = new Date(Date.now() - 86_400_000)
    for (const name of ['app/a.txt', 'app/deep/b.txt', 'app/secret.env', 'other/c.txt']) utimesSync(join(top, name), old, old)
    git(['add', '-A', '--refresh']); git(['update-index', '--really-refresh'])
    const mtimeSeconds = Math.floor(Date.now() / 1000) + 1
    const parsed = parseIndex(readFileSync(join(top, '.git', 'index')))!
    const seeded = seedCandidates({ entries: parsed.entries, mtimeSeconds, prefix: 'app', protect: ['secret.env'] })
    expect(seeded.map(entry => entry.name.toString())).toEqual(['a.txt', 'deep/a-much-longer-name-than-the-others.txt', 'deep/b.txt'])
    // An entry as new as its index git would check by content: never seeded.
    expect(seedCandidates({ entries: parsed.entries, mtimeSeconds: Math.floor(old.getTime() / 1000), prefix: 'app', protect: [] })).toEqual([])
    const seed = join(top, '..', 'seed-index'); writeFileSync(seed, writeIndex(seeded))
    const ids = Object.fromEntries(listed(git).map(line => [line.split('\t')[1], line.split(' ')[1]]))
    expect(listed(git, seed)).toEqual(['a.txt', 'deep/a-much-longer-name-than-the-others.txt', 'deep/b.txt'].map(name => `100644 ${ids[`app/${name}`]} 0\t${name}`))
  })
})

describe('git\'s answers read', () => {
  it('reads the repository rev-parse locates, and nothing from a git that echoes an option it does not know', () => {
    const id = 'a'.repeat(40)
    expect(parseLocation(`sha1\n/r\n/r/.git/index\n/r/.git/objects\n${id}\n`)).toEqual({ top: '/r', index: '/r/.git/index', objects: '/r/.git/objects' })
    expect(parseLocation(`sha256\n/r\n/r/.git/index\n/r/.git/objects\n${id}\n`)).toBeUndefined()
    expect(parseLocation(`--path-format=absolute\nsha1\n/r\n/r/.git/index\n/r/.git/objects\n${id}\n`)).toBeUndefined()
  })

  it('reads each blob a batch names, and leaves out one git answers missing', () => {
    const [one, two, gone] = ['1', '2', '3'].map(digit => digit.repeat(40)) as [string, string, string]
    expect(parseBatchCheck(Buffer.from(`${one} blob 3\n${gone} missing\n${two} tree 30\n`))).toEqual(new Map([[one, 3]]))
    const output = Buffer.concat([Buffer.from(`${one} blob 4\nab\n\n\n${gone} missing\n${two} blob 0\n\n`)])
    expect(parseBatch(output)).toEqual(new Map([[one, Buffer.from('ab\n\n')], [two, Buffer.alloc(0)]]))
    expect(parseBatch(Buffer.from(`${one} blob 9\nshort\n`))).toBeUndefined()
  })
})
