import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyNode, copyToken, CopyRefusal, CopyUsageError, parseEnd, refuseTokenArgument } from '../cli/copy-ends.js'
import { OwnerOnlyError } from '../common/adapters/file-modes.js'

// `buckle cp` (the copy-verb brief): its two ends read as scp reads a host, its token from the environment or an
// owner-only file and never the command line, and its node from --node, BUCKLE_NODE_URL, or the local serve record.

const TOKEN = 'copy-ends-agent-token-fixture'
const WORKSPACE_ID = 'a9f9e5a2-52ac-5720-bc81-771fd12913c6'

describe('an end of buckle cp', () => {
  it.each([
    ['dist/app.tgz', 'linux', { kind: 'local', path: 'dist/app.tgz' }],
    ['/tmp/app.tgz', 'linux', { kind: 'local', path: '/tmp/app.tgz' }],
    ['app.tgz', 'linux', { kind: 'local', path: 'app.tgz' }],
    // A slash before the first colon makes the end a path here, as scp reads it.
    ['./notes:2026.txt', 'linux', { kind: 'local', path: './notes:2026.txt' }],
    ['sub/dir:x', 'linux', { kind: 'local', path: 'sub/dir:x' }],
    ['local:notes:2026.txt', 'linux', { kind: 'local', path: 'notes:2026.txt' }],
    ['local:./app.tgz', 'linux', { kind: 'local', path: './app.tgz' }],
  ] as const)('reads %j on %s as a file here', (text, platform, end) => {
    expect(parseEnd(text, platform)).toEqual(end)
  })

  it.each([
    ['empty-test:/workspace/app.tgz', 'linux', { kind: 'workspace', workspace: 'empty-test', path: '/workspace/app.tgz' }],
    ['empty-test:dist/app.tgz', 'win32', { kind: 'workspace', workspace: 'empty-test', path: 'dist/app.tgz' }],
    ['The site:notes.md', 'linux', { kind: 'workspace', workspace: 'The site', path: 'notes.md' }],
    [`${WORKSPACE_ID}:notes.md`, 'win32', { kind: 'workspace', workspace: WORKSPACE_ID, path: 'notes.md' }],
    // `<workspace>:` alone is the workspace's folder, as scp's `host:` is the home folder.
    ['empty-test:', 'linux', { kind: 'workspace', workspace: 'empty-test', path: '.' }],
    // Only the first colon splits: the path keeps the rest.
    ['site:a:b.txt', 'linux', { kind: 'workspace', workspace: 'site', path: 'a:b.txt' }],
  ] as const)('reads %j on %s as a file in a workspace', (text, platform, end) => {
    expect(parseEnd(text, platform)).toEqual(end)
  })

  it.each([
    ['C:\\work\\app.tgz', { kind: 'local', path: 'C:\\work\\app.tgz' }],
    ['C:/work/app.tgz', { kind: 'local', path: 'C:/work/app.tgz' }],
    ['d:\\app.tgz', { kind: 'local', path: 'd:\\app.tgz' }],
  ] as const)('reads the Windows drive path %j as a file here on Windows', (text, end) => {
    expect(parseEnd(text, 'win32')).toEqual(end)
  })

  it('reads a one-letter workspace on Linux and macOS, where no path names a drive, and on Windows only where no slash follows its colon', () => {
    expect(parseEnd('C:/workspace/app.tgz', 'linux')).toEqual({ kind: 'workspace', workspace: 'C', path: '/workspace/app.tgz' })
    expect(parseEnd('C:/workspace/app.tgz', 'darwin')).toEqual({ kind: 'workspace', workspace: 'C', path: '/workspace/app.tgz' })
    expect(parseEnd('a:notes.md', 'win32')).toEqual({ kind: 'workspace', workspace: 'a', path: 'notes.md' })
    // Written by its id, such a workspace is reached on Windows too.
    expect(parseEnd(`${WORKSPACE_ID}:/workspace/app.tgz`, 'win32')).toEqual({ kind: 'workspace', workspace: WORKSPACE_ID, path: '/workspace/app.tgz' })
  })

  it.each(['', ':app.tgz', 'local:'])('refuses %j as usage', (text) => {
    expect(() => parseEnd(text, 'linux')).toThrow(CopyUsageError)
  })
})

describe('the token buckle cp presents', () => {
  const ownerOnlyFile = (text: string, mode = 0o600) => {
    const file = join(mkdtempSync(join(tmpdir(), 'copy-token-')), 'token.env')
    writeFileSync(file, text, { mode })
    chmodSync(file, mode)
    return file
  }

  it('is BUCKLE_AUTH_TOKEN from the environment', () => {
    expect(copyToken({ environment: { BUCKLE_AUTH_TOKEN: TOKEN } })).toEqual({ token: TOKEN, source: 'BUCKLE_AUTH_TOKEN' })
  })

  it('is the BUCKLE_AUTH_TOKEN line of an owner-only --token-file, in the buckle.env shape, over the environment', () => {
    const file = ownerOnlyFile(`# a token file\nBUCKLE_NODE_URL=http://example.test:4320\nBUCKLE_AUTH_TOKEN=${TOKEN}\n`)
    expect(copyToken({ environment: { BUCKLE_AUTH_TOKEN: 'from-the-shell' }, tokenFile: file })).toEqual({ token: TOKEN, source: file })
  })

  it.runIf(process.platform !== 'win32')('refuses a --token-file other users can read, naming the file and never the token', () => {
    const file = ownerOnlyFile(`BUCKLE_AUTH_TOKEN=${TOKEN}\n`, 0o644)
    const refused = (() => { try { copyToken({ environment: {}, tokenFile: file, ownerOnly: { skip: false } }); return null } catch (error) { return error } })()
    expect(refused).toBeInstanceOf(OwnerOnlyError)
    expect(String(refused)).toContain(file)
    expect(String(refused)).not.toContain(TOKEN)
  })

  it('refuses a --token-file with no BUCKLE_AUTH_TOKEN line, or none at all, and no token, without a value in either message', () => {
    const file = ownerOnlyFile('BUCKLE_ADMIN_TOKEN=not-this-one\n')
    expect(() => copyToken({ environment: {}, tokenFile: file })).toThrow(new CopyRefusal(`${file} holds no BUCKLE_AUTH_TOKEN=<token> line`))
    expect(() => copyToken({ environment: {}, tokenFile: join(tmpdir(), 'copy-token-missing', 'token.env') })).toThrow(/could not be read \(ENOENT\)/)
    expect(() => copyToken({ environment: {} })).toThrow(CopyRefusal)
    expect(() => copyToken({ environment: { BUCKLE_AUTH_TOKEN: '  ' } })).toThrow(/^No agent token/)
  })

  it.each([
    [['--token', TOKEN, 'app.tgz', 'site:']],
    [[`--token=${TOKEN}`, 'app.tgz', 'site:']],
    [['app.tgz', 'site:', '--auth-token', TOKEN]],
    [['app.tgz', 'site:', `--bearer=${TOKEN}`]],
  ])('refuses a token on the command line, %j, as usage, never repeating it', (argv) => {
    const refused = (() => { try { refuseTokenArgument(argv); return null } catch (error) { return error } })()
    expect(refused).toBeInstanceOf(CopyUsageError)
    expect(String(refused)).not.toContain(TOKEN)
  })

  it('reads every word after -- as an end, never a flag', () => {
    expect(() => refuseTokenArgument(['--', '--token=file-named-so', 'site:'])).not.toThrow()
    expect(() => refuseTokenArgument(['--token-file', '/x/token.env', 'app.tgz', 'site:'])).not.toThrow()
  })
})

describe('the node buckle cp copies with', () => {
  const none = async () => null
  const serving = (host: string, port = 4320) => async () => ({ record: { pid: 1, manager: 'terminal' as const, version: '0.1.8', host, port, startedAt: new Date().toISOString() } })

  it('is --node, then BUCKLE_NODE_URL, by origin', async () => {
    expect((await copyNode({ flag: 'http://10.0.0.5:4320/ignored/path', environment: { BUCKLE_NODE_URL: 'http://other.test:1' }, running: none })).href).toBe('http://10.0.0.5:4320/')
    expect((await copyNode({ environment: { BUCKLE_NODE_URL: 'https://node.example.test' }, running: none })).href).toBe('https://node.example.test/')
  })

  it('is the node buckle serve runs on this machine where neither names one, a wildcard address read as the loopback', async () => {
    expect((await copyNode({ environment: {}, running: serving('127.0.0.1') })).href).toBe('http://127.0.0.1:4320/')
    expect((await copyNode({ environment: {}, running: serving('0.0.0.0', 5000) })).href).toBe('http://127.0.0.1:5000/')
    expect((await copyNode({ environment: {}, running: serving('::') })).href).toBe('http://[::1]:4320/')
    expect((await copyNode({ environment: {}, running: serving('fe80::1') })).href).toBe('http://[fe80::1]:4320/')
  })

  it('refuses with the hint to pass --node where nothing names one and nothing serves here', async () => {
    await expect(copyNode({ environment: {}, running: none })).rejects.toThrow(/pass --node <url>, or set BUCKLE_NODE_URL/)
    await expect(copyNode({ environment: {}, running: async () => ({ record: null }) })).rejects.toThrow(CopyRefusal)
  })

  it.each(['not a url', 'ftp://node.test', 'http://user:secret@node.test:4320'])('refuses %j as usage, repeating no credential', async (named) => {
    const refused = await copyNode({ flag: named, environment: {}, running: none }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(CopyUsageError)
    expect(String(refused)).not.toContain('secret')
  })
})
