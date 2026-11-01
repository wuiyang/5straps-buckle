import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { objectFolders, parseBatch, parseBatchCheck, parseExistence, parseIndex, parseLocation, readRepositoryIndex, refreshedAs, seedCandidates, unverified, writeIndex } from '../common/services/history/workspace-repo.js'

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
  if (process.platform !== 'win32') symlinkSync('a.txt', join(top, 'app', 'link'))
  git(['init', '--quiet']); git(['add', '-A'])
  return { root, top, git }
}
/**
 * A version 4 index of `count` entries, its checksum left zero as `index.skipHash` writes it: the first named with
 * `first` bytes, each after it the whole name before it and `more` bytes besides.
 */
function prefixReuse(input: { first: number; count: number; more?: number }): Buffer {
  const fixed = Buffer.alloc(62); fixed.writeUInt32BE(0o100644, 24); fixed.fill(0xab, 40, 60); fixed.writeUInt16BE(0x0fff, 60)
  const header = Buffer.alloc(12); header.write('DIRC', 0, 'latin1'); header.writeUInt32BE(4, 4); header.writeUInt32BE(input.count, 8)
  const parts = [header]
  for (let at = 0; at < input.count; at++) parts.push(fixed, Buffer.from([0]), Buffer.alloc(at ? input.more ?? 0 : input.first, 0x61), Buffer.from([0]))
  return Buffer.concat([...parts, Buffer.alloc(20)])
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

  // G1 of the Codex review of F3: a pipe in the index's place with no writer would hold a blocking open, and the process, for good.
  it.skipIf(process.platform === 'win32')('reads no index that is a pipe or a link, and never waits for a pipe\'s writer', () => {
    const { root, top } = repository()
    const pipe = join(root, 'pipe'); execFileSync('mkfifo', [pipe])
    // A read that waits on the pipe would wait until this writer opens it, 1.5 seconds on.
    const writer = spawn('sh', ['-c', 'sleep 1.5; exec 3<>"$0"', pipe], { stdio: 'ignore' })
    try {
      const started = performance.now()
      expect(readRepositoryIndex(pipe)).toBeUndefined()
      expect(performance.now() - started).toBeLessThan(1000)
    } finally { writer.kill('SIGKILL') }
    const link = join(root, 'link'); symlinkSync(join(top, '.git', 'index'), link)
    expect(readRepositoryIndex(link)).toBeUndefined()
    expect(readRepositoryIndex(join(top, '.git', 'index'))).toBeDefined()
  })

  it('reads a split index as not plain, and a damaged one not at all', () => {
    const { top, git } = repository()
    git(['update-index', '--split-index'])
    expect(parseIndex(readFileSync(join(top, '.git', 'index')))?.plain).toBe(false)
    git(['update-index', '--no-split-index'])
    const index = readFileSync(join(top, '.git', 'index')); index[40] = index[40]! ^ 1
    expect(parseIndex(index)).toBeUndefined()
  })

  // G1 of the Codex recheck of F3: a version 4 name reuses the end of the one before it, so a short index can name far
  // more bytes than it holds. Past git's 4,096 bytes for one name, or 64 MiB for all, it reads as no index to seed from.
  it('reads a version 4 index whose names reuse one past git\'s limit, or name more than the input cap in all, as none to seed from', () => {
    expect(parseIndex(prefixReuse({ first: 4_097, count: 2 }))).toBeUndefined()
    expect(parseIndex(prefixReuse({ first: 4_000, count: 2, more: 97 }))).toBeUndefined()
    expect(parseIndex(prefixReuse({ first: 4_096, count: 16_385 }))).toBeUndefined()
    // Within both: every entry read, its name expanded in full.
    const within = parseIndex(prefixReuse({ first: 4_096, count: 16_384 }))!
    expect([within.plain, within.entries.length, within.entries.at(-1)!.name.length]).toEqual([true, 16_384, 4_096])
    expect(parseIndex(prefixReuse({ first: 4_000, count: 2, more: 96 }))!.entries.map(entry => entry.name.length)).toEqual([4_000, 4_096])
  })

  it('reads a version 4 index that says it holds more entries than the input cap can as none to seed from, before reading one', () => {
    const index = prefixReuse({ first: 8, count: 2 }); index.writeUInt32BE(1_048_577, 8)
    expect(parseIndex(index)).toBeUndefined()
  })

  it('seeds the files below a folder, outside a protected name and never a link, in an index git reads as written', () => {
    const { top, git } = repository()
    const parsed = parseIndex(readFileSync(join(top, '.git', 'index')))!
    const seeded = seedCandidates({ entries: parsed.entries, prefix: 'app', protect: ['secret.env'] })
    expect(seeded.map(entry => entry.name.toString())).toEqual(['a.txt', 'deep/a-much-longer-name-than-the-others.txt', 'deep/b.txt'])
    const seed = join(top, '..', 'seed-index'); writeFileSync(seed, writeIndex(seeded))
    const ids = Object.fromEntries(listed(git).map(line => [line.split('\t')[1], line.split(' ')[1]]))
    expect(listed(git, seed)).toEqual(['a.txt', 'deep/a-much-longer-name-than-the-others.txt', 'deep/b.txt'].map(name => `100644 ${ids[`app/${name}`]} 0\t${name}`))
  })
})

// G2 of the Codex review of F3: what a seed keeps is what git hashed from the file, never the repository's stat data.
describe('a side index with no stat data, refreshed by git', () => {
  it('takes the file\'s own stat data only where the file hashes to its blob, and writes no object', () => {
    const { root, top, git } = repository()
    const old = new Date(Date.now() - 86_400_000)
    for (const name of ['app/a.txt', 'app/deep/b.txt', 'other/c.txt']) utimesSync(join(top, name), old, old)
    const entries = seedCandidates({ entries: parseIndex(readFileSync(join(top, '.git', 'index')))!.entries, prefix: '', protect: [] })
    // The same length, other bytes; gone; and a pipe in a file's place, which git never opens.
    writeFileSync(join(top, 'app', 'deep', 'b.txt'), 'APP/DEEP/B.TXT\n'); utimesSync(join(top, 'app', 'deep', 'b.txt'), old, old)
    rmSync(join(top, 'app', 'secret.env'))
    if (process.platform !== 'win32') { rmSync(join(top, 'other', 'c.txt')); execFileSync('mkfifo', [join(top, 'other', 'c.txt')]) }
    const sizes = new Map(entries.map(entry => [entry.id, `${entry.name.toString()}\n`.length]))
    const side = join(root, 'side-index'); const store = join(root, 'store'); mkdirSync(store)
    writeFileSync(side, writeIndex(entries.map(entry => unverified(entry, sizes.get(entry.id)!))))
    git(['update-index', '-q', '--refresh'], { GIT_INDEX_FILE: side, GIT_OBJECT_DIRECTORY: store })
    const kept = parseIndex(readFileSync(side))!.entries.filter(entry => refreshedAs(entry, sizes.get(entry.id)!)).map(entry => entry.name.toString())
    expect(kept).toEqual(['app/a.txt', 'app/deep/a-much-longer-name-than-the-others.txt', ...process.platform === 'win32' ? ['other/c.txt'] : []])
    expect(readdirSync(store)).toEqual([])
  })
})

// G3 of the Codex recheck of F3: where git looks for a repository's objects, which a sweep stats before it removes a copy.
describe('a repository\'s object folders, as git follows its alternates', () => {
  it('follows alternates relative to the folder that names them, and absolute ones, each once, skipping comments', () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-workspace-repo-')); roots.push(root)
    const [own, shared, deeper] = ['own', 'shared', 'deeper'].map(name => join(root, name, 'objects')) as [string, string, string]
    for (const folder of [own, shared, deeper]) mkdirSync(join(folder, 'info'), { recursive: true })
    writeFileSync(join(own, 'info', 'alternates'), `# a comment\n../../shared/objects\n\n${deeper}\n`)
    writeFileSync(join(shared, 'info', 'alternates'), `${own}\n../../deeper/objects\n`)
    expect(objectFolders(own)).toEqual([own, shared, deeper])
    expect(objectFolders(deeper)).toEqual([deeper])
  })

  it('reads no folders where an alternates file names one by a quoted path, goes past git\'s depth, or is a pipe, and never waits for one', () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-workspace-repo-')); roots.push(root)
    const chain = Array.from({ length: 7 }, (_, at) => join(root, `level${at}`, 'objects'))
    for (const [at, folder] of chain.entries()) { mkdirSync(join(folder, 'info'), { recursive: true }); if (at < 6) writeFileSync(join(folder, 'info', 'alternates'), `${chain[at + 1]}\n`) }
    expect(objectFolders(chain[1]!)).toEqual(chain.slice(1))
    expect(objectFolders(chain[0]!)).toBeUndefined()
    writeFileSync(join(chain[6]!, 'info', 'alternates'), '"quoted\\tname"\n')
    expect(objectFolders(chain[6]!)).toBeUndefined()
    if (process.platform === 'win32') return
    rmSync(join(chain[6]!, 'info', 'alternates')); execFileSync('mkfifo', [join(chain[6]!, 'info', 'alternates')])
    const started = performance.now()
    expect(objectFolders(chain[6]!)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(1000)
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
    expect(parseExistence(Buffer.from(`${one}\n${gone} missing\n${two}\n`))).toEqual(new Set([one, two]))
  })
})
