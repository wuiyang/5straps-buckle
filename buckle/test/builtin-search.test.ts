import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject, JsonValue } from '@5straps/protocol'
import { HarnessManifestSchema } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../common/adapters/process-runner.js'
import { findExecutable } from '../common/domain/executable.js'
import { createPathView } from '../common/domain/path-view.js'
import { searchBuiltin, SCAN_BUDGET_BYTES } from '../common/services/packs/fs/builtin-search.js'
import { searchInput } from '../common/services/packs/fs/schemas.js'
import { searchContent } from '../common/services/packs/fs/search.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// fs_search_content without ripgrep (the fs-verbs brief): Buckle's own walker, with ripgrep's ignore rules, limits, read
// judgement, and output shape, offered wherever the fs pack is.

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
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
