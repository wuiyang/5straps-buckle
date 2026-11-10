import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { join } from 'node:path'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { HarnessManifestSchema } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../common/adapters/process-runner.js'
import { findExecutable } from '../common/domain/executable.js'
import { createPathView } from '../common/domain/path-view.js'
import { searchBuiltin, SCAN_BUDGET_BYTES } from '../common/services/packs/fs/builtin-search.js'
import { matchesPattern, passesGlob } from '../common/services/packs/fs/ignore-files.js'
import { searchInput } from '../common/services/packs/fs/schemas.js'
import { searchContent } from '../common/services/packs/fs/search.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { settleAuditLogs } from './support/action-log-writer.js'
import { processorTime } from './support/processor-time.js'

// fs_search_content without ripgrep (the fs-verbs brief): Buckle's own walker, with ripgrep's ignore rules, limits, read
// judgement, and output shape, offered wherever the fs pack is.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A repository with what ripgrep leaves out (ignored, hidden, a link) beside what it searches. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-search-'))
  roots.push(root)
  const files: Record<string, string> = {
    '.gitignore': 'ignored.txt\nlogs/\n*.cache\n!keep.cache\n',
    'sub/.ignore': '*.tmp\n',
    'a.txt': 'hello world\nnothing here\nsay HELLO again\n',
    'crlf.txt': 'first hello\r\nsecond line\r\nhello third\r\n',
    'no-newline.md': 'hello at the end',
    'unicode.md': 'héllo hello wörld hello\n',
    'sub/b.txt': 'nested hello\n',
    'sub/c.tmp': 'hello in an ignored temp\n',
    'sub/deep/d.md': 'deep hellooo\n',
    'ignored.txt': 'hello that git ignores\n',
    'logs/today.log': 'hello in an ignored folder\n',
    'x.cache': 'hello in a cache\n',
    'keep.cache': 'hello kept by a negation\n',
    '.hidden/h.txt': 'hello hidden\n',
    '.dot.txt': 'hello dotted\n',
  }
  mkdirSync(join(root, '.git'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  symlinkSync('a.txt', join(root, 'link.txt'))
  return root
}

const sorted = (output: JsonValue) => {
  const matches = (output as { matches: JsonObject[] }).matches.map(({ path, line, text, ranges }) => ({ path, line, text, ranges }))
  return matches.sort((left, right) => String(left.path).localeCompare(String(right.path)) || Number(left.line) - Number(right.line))
}

function builtin(root: string, args: Record<string, unknown>, extra: Partial<Parameters<typeof searchBuiltin>[0]> = {}) {
  return searchBuiltin({ args: searchInput.parse(args), paths: createPathView({ root, mount: null }), signal: new AbortController().signal, authorizeRead: async () => true, protectedRoots: [], ...extra })
}

const rgPath = findExecutable('rg')

describe.skipIf(rgPath === null)('the walker against ripgrep', () => {
  it.each([
    ['a word', { pattern: 'hello' }],
    ['a regular expression', { pattern: 'hel+o+\\b' }],
    ['case folded', { pattern: 'HELLO', caseSensitive: false }],
    ['a glob on names', { pattern: 'hello', glob: '*.md' }],
    ['a glob on a path', { pattern: 'hello', glob: 'sub/*.txt' }],
    ['a glob that leaves out', { pattern: 'hello', glob: '!*.md' }],
    ['a folder below the root', { pattern: 'hello', path: 'sub' }],
    ['a limit', { pattern: 'hello', limit: 3 }],
  ])('finds what ripgrep finds for %s', async (_name, args) => {
    const root = fixture()
    const paths = createPathView({ root, mount: null })
    const parsed = searchInput.parse(args)
    const expected = await searchContent({ args: parsed, paths, runProcess, ripgrep: { path: rgPath!, argv0: 'rg', args: [] }, timeoutMs: 20_000, signal: new AbortController().signal, authorizeRead: async () => true, protectedRoots: [], environment: () => ({ PATH: process.env.PATH ?? '' }) })
    const found = await builtin(root, args)
    if (parsed.limit < 200) expect(sorted(found).length).toBe(sorted(expected).length)
    else expect(sorted(found)).toEqual(sorted(expected))
    expect((found as JsonObject).excludedFiles).toBe((expected as JsonObject).excludedFiles)
  })
})

describe('the walker', () => {
  it('reads ripgrep\'s ignore rules, leaves hidden names and links out, and answers in its shape', async () => {
    const root = fixture()
    const found = await builtin(root, { pattern: 'hello' })
    expect(sorted(found).map(match => match.path)).toEqual(['./a.txt', './crlf.txt', './crlf.txt', './keep.cache', './no-newline.md', './sub/b.txt', './sub/deep/d.md', './unicode.md'])
    expect(sorted(found).find(match => match.path === './unicode.md')).toEqual({ path: './unicode.md', line: 1, text: 'héllo hello wörld hello', ranges: [{ start: 7, end: 12 }, { start: 20, end: 25 }] })
    expect(sorted(found).filter(match => match.path === './crlf.txt')).toEqual([
      { path: './crlf.txt', line: 1, text: 'first hello', ranges: [{ start: 6, end: 11 }] },
      { path: './crlf.txt', line: 3, text: 'hello third', ranges: [{ start: 0, end: 5 }] },
    ])
    expect(found).toMatchObject({ truncated: false, excludedFiles: 0 })
  })

  it('reads .gitignore only inside a git repository', async () => {
    const root = fixture()
    rmSync(join(root, '.git'), { recursive: true })
    expect(sorted(await builtin(root, { pattern: 'git ignores' })).map(match => match.path)).toEqual(['./ignored.txt'])
  })

  it('skips a binary file by a NUL byte in its first 8 KiB', async () => {
    const root = fixture()
    writeFileSync(join(root, 'blob.bin'), Buffer.concat([Buffer.from('hello'), Buffer.from([0]), Buffer.from('hello\n')]))
    writeFileSync(join(root, 'late.bin'), Buffer.concat([Buffer.from(`${'x'.repeat(9_000)}\nhello\n`), Buffer.from([0])]))
    expect(sorted(await builtin(root, { pattern: 'hello', glob: '*.bin' })).map(match => match.path)).toEqual(['./late.bin'])
  })

  it('stops at its scan budget and says it was cut short', async () => {
    const root = fixture()
    expect(SCAN_BUDGET_BYTES).toBe(64 * 1_048_576)
    const found = await builtin(root, { pattern: 'hello' }, { scanBudgetBytes: 40 })
    expect(found).toMatchObject({ truncated: true })
    expect(sorted(found).length).toBeLessThan(3)
  })

  it('judges each file where it lands, counts the ones it may not read, and marks the ones it matched as read', async () => {
    const root = fixture()
    const judged: string[] = []
    const known: string[] = []
    const found = await builtin(root, { pattern: 'nested|wörld' }, { authorizeRead: async (path) => { judged.push(path); return !path.endsWith('a.txt') }, known: path => known.push(path) })
    expect(judged).toContain(join(root, 'sub/b.txt'))
    expect(sorted(found).map(match => match.path)).toEqual(['./sub/b.txt', './unicode.md'])
    expect((found as JsonObject).excludedFiles).toBe(1)
    expect(known.sort()).toEqual([join(root, 'sub/b.txt'), join(root, 'unicode.md')])
  })

  it('refuses a pattern no regular expression reads', async () => {
    await expect(builtin(fixture(), { pattern: '(unclosed' })).rejects.toThrow('is not a regular expression this search reads')
  })
})

/** A pattern, a subject, whether ripgrep's rules match the two, and (where node:path matchesGlob answers otherwise) why. */
type GlobCase = [pattern: string, subject: string, expected: boolean, nodeDiffers?: string]

const GLOB_CASES: GlobCase[] = [
  // `*` and `?` stay within one name
  ['a*b', 'axxb', true], ['a*b', 'a/b', false], ['a?c', 'abc', true], ['a?c', 'a/c', false],
  ['*.ts', 'a.ts', true], ['*.ts', 'a/b.ts', false], ['**/*.ts', 'a/b.ts', true], ['**/*.ts', 'b.ts', true], ['**/*.ts', 'a/b.js', false],
  // a leading `**/` is none or more whole names, and a name cannot end it halfway
  ['**/foo', 'foo', true], ['**/foo', 'a/foo', true], ['**/foo', 'a/b/foo', true],
  ['**/foo', 'xfoo', false], ['**/foo', 'a/b/xfoo', false], ['**/foo', 'foox', false], ['**/foo', 'foo/bar', false],
  ['**/dist', 'dist', true], ['**/dist', 'x/dist', true], ['**/dist', 'xdist', false], ['**/build', 'a/build', true], ['**/build', 'abuild', false],
  // `**/` between names
  ['a/**/b', 'a/b', true], ['a/**/b', 'a/x/b', true], ['a/**/b', 'a/x/y/b', true],
  ['a/**/b', 'a/xb', false], ['a/**/b', 'axb', false], ['a/**/b', 'a/x/yb', false],
  ['dir/**/ab', 'dir/ab', true], ['dir/**/ab', 'dir/z/ab', true], ['dir/**/ab', 'dir/zab', false],
  ['src/**/test', 'src/test', true], ['src/**/test', 'src/a/test', true], ['src/**/test', 'src/xtest', false], ['src/**/test', 'src/a/xtest', false],
  ['**/**/foo', 'a/foo', true], ['**/**/foo', 'xfoo', false], ['a/**/**/b', 'a/x/y/b', true], ['a/**/**/b', 'a/xb', false],
  ['**/a/**/b', 'x/a/y/b', true], ['**/a/**/b', 'a/b', true], ['**/a/**/b', 'x/xa/y/b', false], ['**/a/**/b', 'xa/b', false],
  // `**` alone, at the end, and beside other characters
  ['**', 'a/b/c', true], ['a/**', 'a/x/y', true], ['a/**', 'a', false], ['**/dist/**', 'a/dist/b/c', true], ['**/dist/**', 'adist/b', false],
  ['a**b', 'a/b', false], ['a**b', 'axb', true],
  // braces
  ['*.{ts,tsx}', 'a.tsx', true], ['*.{ts,tsx}', 'a.js', false], ['{a,b}.txt', 'a.txt', true], ['{a,b}.txt', 'c.txt', false],
  ['{a,b}/{c,d}', 'b/c', true], ['{a,b}/{c,d}', 'c/a', false], ['{solo}', '{solo}', true],
  // classes
  ['[abc].txt', 'b.txt', true], ['[!abc].txt', 'b.txt', false], ['[!abc].txt', 'd.txt', true], ['[a-c]x', 'bx', true], ['[a-c]x', 'dx', false],
  ['[!x]oo', 'foo', true], ['[!x]oo', 'xoo', false], ['[^x]oo', 'xoo', false], ['[]]x', ']x', true], ['[unclosed', '[unclosed', true],
  // case is kept, and a backslash escapes
  ['build', 'Build', false, 'node:path matchesGlob ignores case on Windows and macOS'], ['\\*lit', '*lit', true, 'node:path matchesGlob does not read the backslash as an escape'], ['\\*lit', 'xlit', false],
]

describe('the glob matcher', () => {
  it('keeps case and reads a backslash as an escape, on every platform', () => {
    expect(passesGlob('*.md', 'README.MD')).toBe(false)
    expect(passesGlob('*.md', 'docs/readme.md')).toBe(true)
    expect(matchesPattern('Build', 'build')).toBe(false)
    expect(matchesPattern('x/a.txt', 'x\\*.txt')).toBe(false)
    expect(matchesPattern('x*.txt', 'x\\*.txt')).toBe(true)
    expect(matchesPattern('xa.txt', 'x\\*.txt')).toBe(false)
  })

  it.each(GLOB_CASES.map(([pattern, subject, expected]) => [pattern, subject, expected] as const))('reads %s against %s as %s', (pattern, subject, expected) => {
    expect(matchesPattern(subject, pattern)).toBe(expected)
  })

  const nodeMatchesGlob = (nodePath as { matchesGlob?: (path: string, pattern: string) => boolean }).matchesGlob
  it.skipIf(typeof nodeMatchesGlob !== 'function')('answers as node:path matchesGlob does on every case but the documented differences', () => {
    const disagreements = GLOB_CASES
      .filter(([, , , difference]) => difference === undefined)
      .filter(([pattern, subject]) => nodeMatchesGlob!(subject, pattern) !== matchesPattern(subject, pattern))
      .map(([pattern, subject, expected]) => `${pattern} against ${subject}: expected ${expected}`)
    expect(disagreements).toEqual([])
  })

  it('answers a pattern of many stars on a long text under 2,000 ms of CPU, where a backtracking matcher would not', () => {
    const { milliseconds } = processorTime(() => expect(matchesPattern('a'.repeat(3_000), `${'*a'.repeat(30)}*b`)).toBe(false))
    expect(milliseconds).toBeLessThan(2_000)
  })

  it('matches nothing for a pattern too long or with too many choices, rather than fail', () => {
    expect(matchesPattern('a', 'a'.repeat(2_000))).toBe(false)
    expect(matchesPattern('a', `${'{a,b}'.repeat(7)}`)).toBe(false)
  })

  it('leaves a name out of the search by an ignore rule and a glob that keep case', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-search-case-'))
    roots.push(root)
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'Build'))
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, '.gitignore'), 'Build/\n')
    writeFileSync(join(root, 'Build/a.txt'), 'hit\n')
    writeFileSync(join(root, 'build/b.txt'), 'hit\n')
    writeFileSync(join(root, 'c.MD'), 'hit\n')
    writeFileSync(join(root, 'd.md'), 'hit\n')
    expect(sorted(await builtin(root, { pattern: 'hit' })).map(match => match.path)).toEqual(['./build/b.txt', './c.MD', './d.md'])
    expect(sorted(await builtin(root, { pattern: 'hit', glob: '*.md' })).map(match => match.path)).toEqual(['./d.md'])
  })
})

describe('the glob matcher on supplementary characters', () => {
  // A pattern and a name are read in code points, as ripgrep reads them: 📄 is one character, not the two UTF-16 units it is stored in.
  it.each([
    ['a literal', '📄.txt', '📄.txt', true],
    ['a literal against a character that shares its first unit', '📄.txt', '📃.txt', false],
    ['a literal among others', 'a📄b', 'a📄b', true],
    ['a literal after a star', '*📄', 'note📄', true],
    ['a literal after a star, not matching', '*📄', 'note📃', false],
    ['one ? for one character', '?.txt', '📄.txt', true],
    ['two ? for one character', '??.txt', '📄.txt', false],
    ['an escaped literal', '\\📄.txt', '📄.txt', true],
    ['an escaped literal, not matching', '\\📄.txt', '📃.txt', false],
    ['an escaped literal beside an escaped star', '\\📄\\*', '📄*', true],
    ['a literal in a choice', '{📄,📃}.txt', '📃.txt', true],
    ['a class holding it', '[📄a].txt', '📄.txt', true],
    ['a class holding another', '[📄a].txt', '📃.txt', false],
    ['a negated class', '[!📄].txt', '📃.txt', true],
    ['a negated class, holding it', '[!📄].txt', '📄.txt', false],
    ['a caret class', '[^📄]', '📄', false],
    ['a class with an escaped member', '[\\📄].txt', '📄.txt', true],
    ['a range of them, inside', '[📀-📅].txt', '📄.txt', true],
    ['a range of them, below', '[📀-📅].txt', '📿.txt', false],
    ['a range of them, above', '[📄-📅].txt', '📃.txt', false],
    ['a range from the basic plane up, inside', '[a-📄].txt', '📃.txt', true],
    ['a range from the basic plane up, beyond', '[a-📄].txt', '📅.txt', false],
    ['a range across the surrogate range of code units', '[Ａ-😀].txt', '🌀.txt', true],
    ['a range of escaped ends', '[\\📀-\\📅]', '📄', true],
    ['a class and a literal in one name', '[📄]📄', '📄📄', true],
    ['a class on a name of units', '[a-z]', 'm', true],
    ['a path with one', '📁/📄.txt', '📁/📄.txt', true],
    ['a globstar over one', '**/📄.txt', '📁/sub/📄.txt', true],
  ])('reads %s: %s against %s as %s', (_name, pattern, subject, expected) => {
    expect(matchesPattern(subject, pattern)).toBe(expected)
  })

  it('leaves out and keeps a name by an ignore rule and the call glob', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-search-emoji-'))
    roots.push(root)
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.gitignore'), '📃.txt\n')
    writeFileSync(join(root, '📄.txt'), 'marker\n')
    writeFileSync(join(root, '📃.txt'), 'marker\n')
    writeFileSync(join(root, 'plain.txt'), 'marker\n')
    expect(sorted(await builtin(root, { pattern: 'marker', glob: '📄.txt' })).map(match => match.path)).toEqual(['./📄.txt'])
    expect(sorted(await builtin(root, { pattern: 'marker', glob: '[📀-📅].txt' })).map(match => match.path)).toEqual(['./📄.txt'])
    expect(sorted(await builtin(root, { pattern: 'marker', glob: '!📄.txt' })).map(match => match.path)).toEqual(['./plain.txt'])
    expect(sorted(await builtin(root, { pattern: 'marker' })).map(match => match.path)).toEqual(['./📄.txt', './plain.txt'])
  })
})

describe('a search that cannot stall the node', () => {
  it('leaves out a file a pattern that backtracks without end runs past its limit on, and leaves the node free to answer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-search-redos-'))
    roots.push(root)
    writeFileSync(join(root, 'bad.txt'), `${'a'.repeat(60)}b\n`)
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 10)
    const started = performance.now()
    try {
      expect(await builtin(root, { pattern: '(a+)+$' }, { matchTimeoutMs: 300 })).toMatchObject({ matches: [], truncated: false, skipped: [{ path: './bad.txt', reason: 'timeout' }] })
    } finally { clearInterval(timer) }
    expect(performance.now() - started).toBeLessThan(3_000)
    // The node's thread was not held while the pattern ran, so its timers kept firing.
    expect(ticks).toBeGreaterThan(10)
  })

  it('ends at once when the call is cancelled while the pattern runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-search-cancel-'))
    roots.push(root)
    writeFileSync(join(root, 'bad.txt'), `${'a'.repeat(60)}b\n`)
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 100)
    await expect(builtin(root, { pattern: '(a+)+$' }, { signal: controller.signal })).rejects.toThrow('cancelled')
  })

  it('gives the cancel a turn while it walks folders that hold nothing it searches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-search-walk-'))
    roots.push(root)
    for (let index = 0; index < 600; index++) mkdirSync(join(root, `dir${String(index).padStart(3, '0')}`))
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 1)
    await expect(builtin(root, { pattern: 'x', glob: '*.none' }, { signal: controller.signal })).rejects.toThrow('cancelled')
  })

  it('still finds what a plain pattern matches, with byte ranges and a limit, through the worker', async () => {
    const root = fixture()
    expect(sorted(await builtin(root, { pattern: 'h.llo', limit: 2 }))).toHaveLength(2)
    expect(sorted(await builtin(root, { pattern: 'w.rld', glob: '*.md' }))).toEqual([{ path: './unicode.md', line: 1, text: 'héllo hello wörld hello', ranges: [{ start: 13, end: 19 }] }])
  })
})

describe('an empty match beside a supplementary character', () => {
  // A match of no width steps the search on by one code point: past a pair of UTF-16 units whole, so a Unicode pattern is
  // not brought back to the same boundary and matched again until the file's time runs out.
  const emptyMatches = async (lines: string[], pattern: string, extra: Record<string, unknown> = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-search-empty-'))
    roots.push(root)
    writeFileSync(join(root, 'lines.txt'), `${lines.join('\n')}\n`)
    const found = await builtin(root, { pattern, glob: 'lines.txt', ...extra }, { matchTimeoutMs: 2_000 }) as { matches: Array<{ line: number; ranges: Array<{ start: number; end: number }> }>; skipped?: unknown[] }
    expect(found.skipped ?? []).toEqual([])
    return found.matches.map(match => ({ line: match.line, ranges: match.ranges.map(range => [range.start, range.end]) }))
  }

  it('finds ^ on a line that starts with an emoji', async () => {
    expect(await emptyMatches(['😀 ordinary text', 'plain'], '^')).toEqual([{ line: 1, ranges: [[0, 0]] }, { line: 2, ranges: [[0, 0]] }])
  })

  it('finds $ on a line that ends with an emoji, in bytes', async () => {
    expect(await emptyMatches(['text 😀', '😀'], '$')).toEqual([{ line: 1, ranges: [[9, 9]] }, { line: 2, ranges: [[4, 4]] }])
  })

  it('finds \\b around words that sit beside emoji, and none on emoji alone', async () => {
    expect(await emptyMatches(['😀 ab 😀', '😀😀'], '\\b')).toEqual([{ line: 1, ranges: [[5, 5], [7, 7]] }])
  })

  it('finds an empty match at every code point boundary and none inside a pair', async () => {
    expect(await emptyMatches(['a😀b', '😀😀'], '(?:)')).toEqual([
      { line: 1, ranges: [[0, 0], [1, 1], [5, 5], [6, 6]] },
      { line: 2, ranges: [[0, 0], [4, 4], [8, 8]] },
    ])
  })

  it('finds both the empty and the filled branch of an alternation with an empty side', async () => {
    expect(await emptyMatches(['😀x😀'], 'x|')).toEqual([{ line: 1, ranges: [[0, 0], [4, 5], [5, 5], [9, 9]] }])
    expect(await emptyMatches(['😀x😀'], 'X|', { caseSensitive: false })).toEqual([{ line: 1, ranges: [[0, 0], [4, 5], [5, 5], [9, 9]] }])
  })

  it('steps one unit at a time over ASCII and control characters', async () => {
    expect(await emptyMatches(['\ta\u0001b\t'], '(?:)')).toEqual([{ line: 1, ranges: [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]] }])
    expect(await emptyMatches(['\t\u0001', 'ab'], '^')).toEqual([{ line: 1, ranges: [[0, 0]] }, { line: 2, ranges: [[0, 0]] }])
    expect(await emptyMatches(['ab\u0007'], '$')).toEqual([{ line: 1, ranges: [[3, 3]] }])
    expect(await emptyMatches(['a b'], '\\b')).toEqual([{ line: 1, ranges: [[0, 0], [1, 1], [2, 2], [3, 3]] }])
  })

  it('still ends, and matches the line, for a pattern read without the Unicode flag', async () => {
    // `\-` is not valid in Unicode mode, so this pattern is run as plain code units.
    const found = await emptyMatches(['😀 text'], '\\-?')
    expect(found).toHaveLength(1)
    expect(found[0]!.line).toBe(1)
  })
})

describe('fs_search_content on a node', () => {
  it('is offered with the fs pack, and the manifest names what runs it', async () => {
    const root = fixture()
    const state = mkdtempSync(join(tmpdir(), 'buckle-search-state-'))
    roots.push(state)
    const runtime = await createRuntime({ config: configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '1' }) })
    runtimes.push(runtime)
    expect(runtime.registry().capabilities().map(tool => tool.name)).toContain('fs_search_content')
    const manifest = HarnessManifestSchema.parse(runtime.manifest())
    expect(manifest.limits.searcher).toBe(rgPath === null ? 'builtin' : 'rg')
    const response = await runtime.invoke({ request: { requestId: 'search-1', tool: 'fs_search_content', args: { pattern: 'nested' }, approvalTokens: [] }, sessionId: 'agent' })
    expect(response).toMatchObject({ outcome: 'ok', output: { matches: [{ path: './sub/b.txt', line: 1, text: 'nested hello' }] } })
    // A match is a read: the session may now empty that file without a person asking.
    await runtime.grants.grant({ sessionId: 'agent', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
    expect(await runtime.invoke({ request: { requestId: 'write-1', tool: 'fs_write', args: { path: 'sub/b.txt', content: '' }, approvalTokens: [] }, sessionId: 'agent' })).toMatchObject({ outcome: 'ok' })
  })
})
