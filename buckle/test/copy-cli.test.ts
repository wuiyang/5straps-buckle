import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { open as openHandle } from 'node:fs/promises'
import { copyCommand, COPY_USAGE, type CopyOptions } from '../cli/copy.js'

// `buckle cp` against a node that answers as Buckle's files face does (the copy-verb brief): its success line and exit
// codes, the wait for a person with the node's instruction and the same requestId sent again, the message for a node
// from before the files face, and a token that never shows.

const TOKEN = 'copy-cli-agent-token-fixture'
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

interface Seen { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: Buffer }
type Answer = (seen: Seen, response: ServerResponse) => void

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
})

/** A node whose files face answers each request with the next of `answers`, and the last once they run out. */
async function fakeNode(answers: Answer[]): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    const parts: Buffer[] = []
    request.on('data', (chunk: Buffer) => parts.push(chunk))
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://node.test')
      const item = { method: request.method ?? '', path: url.pathname, query: url.searchParams, headers: request.headers, body: Buffer.concat(parts) }
      seen.push(item)
      ;(answers[seen.length - 1] ?? answers.at(-1)!)(item, response)
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

function json(status: number, body: unknown): Answer {
  return (_seen, response) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
}

const ok = (seen: Seen) => ({ requestId: String(seen.headers['x-buckle-request-id']), outcome: 'ok', output: { path: seen.query.get('path'), size: seen.body.byteLength, sha256: sha256(seen.body) }, meta: { durationMs: 1, truncated: false } })
const received: Answer = (seen, response) => json(200, ok(seen))(seen, response)
const asked = (expiresInMs = 600_000): Answer => (seen, response) => json(200, {
  requestId: seen.headers['x-buckle-request-id'], outcome: 'approval_required',
  approvals: [{ token: '3f6c1a2b-0000-4000-8000-000000000000', rule: 'write_scope', subject: '/srv/site', reason: 'Writing to /workspace is not yet approved', tool: 'fs_receive', offeredScopes: ['once', 'session', 'always'], expiresAt: new Date(Date.now() + expiresInMs).toISOString() }],
})(seen, response)

function sent(content: Buffer): Answer {
  return (_seen, response) => { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(content.byteLength), 'x-buckle-sha256': sha256(content) }); response.end(content) }
}

/** `buckle cp` with its output kept, against `url`, with the token in the environment unless the test names another. */
async function cp(argv: string[], environment: NodeJS.ProcessEnv = {}, platform?: NodeJS.Platform, extra: CopyOptions = {}) {
  let out = ''
  let err = ''
  const result = await copyCommand(argv, { BUCKLE_AUTH_TOKEN: TOKEN, ...environment }, { stdout: { write: text => { out += text } }, stderr: { write: text => { err += text } }, pollMs: 5, running: async () => null, ...(platform ? { platform } : {}), ...extra })
  expect(out + err).not.toContain(TOKEN)
  return { ...result, out, err }
}

function local(): { folder: string; file: string; content: Buffer } {
  const folder = mkdtempSync(join(tmpdir(), 'copy-cli-'))
  const content = Buffer.from('a release tarball, or near enough\n'.repeat(4000))
  const file = join(folder, 'app.tgz')
  writeFileSync(file, content)
  return { folder, file, content }
}

describe('buckle cp into a workspace', () => {
  it('sends the file with its length, digest, requestId, session, and the token as a bearer, and prints one line', async () => {
    const node = await fakeNode([received])
    const { file, content } = local()
    const result = await cp([file, 'site:dist/app.tgz', '--node', node.url])
    expect(result).toMatchObject({ exitCode: 0, out: `Copied ${content.byteLength} bytes to site:dist/app.tgz (sha256 ${sha256(content)})\n`, err: '' })
    const [put] = node.seen
    expect(put).toMatchObject({ method: 'PUT', path: '/workspaces/site/v1/files', body: content })
    expect(put!.query.get('path')).toBe('dist/app.tgz')
    expect(put!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'content-length': String(content.byteLength), 'x-buckle-sha256': sha256(content), 'x-buckle-session': expect.stringMatching(/^buckle-cp-[0-9a-f-]{36}$/), 'x-buckle-request-id': expect.stringMatching(/^[0-9a-f-]{36}$/) })
  })

  it('names a session of its own for each copy, so a session grant made for one covers no other caller', async () => {
    const node = await fakeNode([received])
    const { file } = local()
    await cp([file, 'site:a.tgz', '--node', node.url])
    await cp([file, 'site:b.tgz', '--node', node.url])
    const sessions = node.seen.map(seen => seen.headers['x-buckle-session'])
    expect(sessions).toHaveLength(2)
    expect(sessions[0]).not.toBe(sessions[1])
    expect(sessions.every(session => /^buckle-cp-[0-9a-f-]{36}$/.test(String(session)))).toBe(true)
  })

  it('prints the node\'s instruction once, waits, and sends the same request again under its requestId until it is approved', async () => {
    const node = await fakeNode([asked(), asked(), received])
    const { file, content } = local()
    const result = await cp([file, 'site:', '--node', node.url])
    expect(result.exitCode).toBe(0)
    expect(result.err).toContain('This copy needs a person to approve it at the node, with these commands there:')
    expect(result.err).toContain(`  waiting on node ${node.url}, workspace site\n`)
    expect(result.err).toContain('  then approve with: buckle approve 3f6c1a2b-0000-4000-8000-000000000000 --scope once --workspace site')
    expect(result.err.match(/Waiting for the approval\.\.\./g)).toHaveLength(1)
    expect(node.seen).toHaveLength(3)
    expect(new Set(node.seen.map(seen => seen.headers['x-buckle-request-id'])).size).toBe(1)
    expect(node.seen.every(seen => seen.query.get('path') === '.')).toBe(true)
    expect(node.seen[2]!.body).toEqual(content)
  })

  it('names the file after the source inside a folder the node says the target is, under a call of its own', async () => {
    const folder = json(422, { requestId: 'x', outcome: 'error', error: { code: 'TARGET_IS_DIRECTORY', message: 'dist is a folder', retryable: false } })
    const node = await fakeNode([folder, received])
    const { file, content } = local()
    const result = await cp([file, 'site:dist/', '--node', node.url])
    expect(result.out).toBe(`Copied ${content.byteLength} bytes to site:dist/app.tgz (sha256 ${sha256(content)})\n`)
    expect(node.seen.map(seen => seen.query.get('path'))).toEqual(['dist/', 'dist/app.tgz'])
    expect(node.seen[0]!.headers['x-buckle-request-id']).not.toBe(node.seen[1]!.headers['x-buckle-request-id'])
  })

  it('names the file in the folder too where the node learns it is one only after the ask was approved', async () => {
    const folder = json(422, { requestId: 'x', outcome: 'error', error: { code: 'TARGET_IS_DIRECTORY', message: '/srv/releases is a folder', retryable: false } })
    const node = await fakeNode([asked(), folder, received])
    const { file, content } = local()
    const result = await cp([file, 'site:/srv/releases', '--node', node.url])
    expect(result).toMatchObject({ exitCode: 0, out: `Copied ${content.byteLength} bytes to site:/srv/releases/app.tgz (sha256 ${sha256(content)})\n` })
    expect(node.seen.map(seen => seen.query.get('path'))).toEqual(['/srv/releases', '/srv/releases', '/srv/releases/app.tgz'])
  })

  it('exits 1 with the node\'s words on a denial, a refusal, and an ask that expired unanswered', async () => {
    const { file } = local()
    const denied = await cp([file, 'site:a.tgz', '--node', (await fakeNode([json(422, { requestId: 'x', outcome: 'error', error: { code: 'PERMISSION_DENIED', message: 'Approval was declined', retryable: false } })])).url])
    expect(denied).toMatchObject({ exitCode: 1, out: '', err: 'PERMISSION_DENIED: Approval was declined\n' })
    const tooLarge = await cp([file, 'site:a.tgz', '--node', (await fakeNode([json(413, { error: 'The file is too large' })])).url])
    expect(tooLarge).toMatchObject({ exitCode: 1, err: 'The node answered HTTP 413: The file is too large\n' })
    const expired = await cp([file, 'site:a.tgz', '--node', (await fakeNode([asked(-1)])).url])
    expect(expired.exitCode).toBe(1)
    expect(expired.err).toContain('The approval expired before anyone answered it, so nothing was copied')
  })

  it.each([404, 405])('says a node answering %i on the files route needs 0.1.8 or later', async (status) => {
    const node = await fakeNode([json(status, { statusCode: status, message: 'Not Found' })])
    const { file } = local()
    const result = await cp([file, 'empty-test:/workspace', '--node', node.url])
    expect(result).toMatchObject({ exitCode: 1, err: `This node's Buckle offers no file copy; it needs 0.1.8 or later (${node.url} answered HTTP ${status})\n` })
  })

  it('names where the token came from, never the token, when the node refuses it, and reads it from an owner-only --token-file', async () => {
    const node = await fakeNode([json(401, { statusCode: 401, message: 'Unauthorized' })])
    const { folder, file } = local()
    const tokenFile = join(folder, 'token.env')
    writeFileSync(tokenFile, `BUCKLE_AUTH_TOKEN=${TOKEN}\n`, { mode: 0o600 })
    chmodSync(tokenFile, 0o600)
    const result = await cp([file, 'site:a.tgz', '--node', node.url, '--token-file', tokenFile], { BUCKLE_AUTH_TOKEN: '' })
    expect(result).toMatchObject({ exitCode: 1, err: `The node refused the token from ${tokenFile} (HTTP 401): it is no agent token of workspace site on ${node.url}\n` })
    expect(node.seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('exits 1 where no node answers', async () => {
    const node = await fakeNode([received])
    await new Promise(resolve => servers.pop()!.close(resolve))
    const { file } = local()
    const result = await cp([file, 'site:a.tgz', '--node', node.url])
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain(`The node at ${node.url} could not be reached, or closed the connection before it answered (ECONNREFUSED)`)
  })
})

describe('buckle cp out of a workspace', () => {
  it('writes the bytes here once their digest matches, into a folder by the source\'s name', async () => {
    const content = Buffer.from('from the node\n'.repeat(500))
    const node = await fakeNode([sent(content)])
    const { folder } = local()
    const result = await cp(['site:/workspace/dist/out.bin', folder, '--node', node.url])
    expect(result).toMatchObject({ exitCode: 0, out: `Copied ${content.byteLength} bytes to ${join(folder, 'out.bin')} (sha256 ${sha256(content)})\n` })
    expect(readFileSync(join(folder, 'out.bin'))).toEqual(content)
    expect(node.seen[0]).toMatchObject({ method: 'GET', path: '/workspaces/site/v1/files' })
    expect(node.seen[0]!.query.get('path')).toBe('/workspace/dist/out.bin')
  })

  it('waits for an ask as a send does, then takes the bytes', async () => {
    const content = Buffer.from('asked first')
    const node = await fakeNode([asked(), sent(content)])
    const { folder } = local()
    const result = await cp(['site:.env', join(folder, 'copy.env'), '--node', node.url])
    expect(result.exitCode).toBe(0)
    expect(result.err).toContain('Waiting for the approval...')
    expect(readFileSync(join(folder, 'copy.env'))).toEqual(content)
    expect(node.seen[0]!.headers['x-buckle-request-id']).toBe(node.seen[1]!.headers['x-buckle-request-id'])
  })

  it('writes nothing where the bytes do not match the digest the node named', async () => {
    const node = await fakeNode([(_seen, response) => { response.writeHead(200, { 'content-length': '5', 'x-buckle-sha256': sha256(Buffer.from('other')) }); response.end('bytes') }])
    const { folder } = local()
    const result = await cp(['site:a.txt', join(folder, 'a.txt'), '--node', node.url])
    expect(result).toMatchObject({ exitCode: 1, err: 'The bytes that arrived do not hash to the sha256 the node named, so nothing was written\n' })
    expect(readdirSync(folder)).toEqual(['app.tgz'])
  })

  it('refuses a target whose folder does not exist before it asks the node for anything', async () => {
    const node = await fakeNode([sent(Buffer.from('x'))])
    const { folder } = local()
    const result = await cp(['site:a.txt', join(folder, 'missing', 'a.txt'), '--node', node.url])
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain(`The folder ${join(folder, 'missing')} does not exist, and buckle cp makes no folder`)
    expect(node.seen).toEqual([])
  })
})

describe('buckle cp between two workspaces', () => {
  it('exits 2 before it asks the node anything: a token opens one workspace, so the file goes out here and in again', async () => {
    const node = await fakeNode([sent(Buffer.from('between workspaces')), received])
    const result = await cp(['one:notes/a.md', 'two:b.md', '--node', node.url])
    expect(result.exitCode).toBe(2)
    expect(result.err).toMatch(/^Both ends are workspaces: a token opens one workspace, so copy the file out to this machine first, then into the other\n/)
    expect(result.err).toContain(COPY_USAGE)
    expect(result.out).toBe('')
    expect(node.seen).toEqual([])
    expect(COPY_USAGE).not.toContain('between two workspaces on one node')
  })
})

/** Runs `body` under a umask of its own, and puts the process's back. */
async function underUmask<T>(mask: number, body: () => Promise<T>): Promise<T> {
  const before = process.umask(mask)
  try { return await body() } finally { process.umask(before) }
}

const modeOf = (path: string) => lstatSync(path).mode & 0o777

describe('buckle cp out of a workspace, onto what is here', () => {
  it('keeps the mode of the file it replaces exactly, so a private file does not become one others read', async () => {
    const content = Buffer.from('KEY=from the workspace\n')
    const { folder } = local()
    const closed = join(folder, 'closed.env')
    const open = join(folder, 'open.env')
    writeFileSync(closed, 'old', { mode: 0o600 })
    writeFileSync(open, 'old', { mode: 0o644 })
    chmodSync(closed, 0o600)
    chmodSync(open, 0o644)
    await underUmask(0o022, async () => {
      expect((await cp(['site:.env', closed, '--node', (await fakeNode([sent(content)])).url])).exitCode).toBe(0)
    })
    await underUmask(0o077, async () => {
      expect((await cp(['site:.env', open, '--node', (await fakeNode([sent(content)])).url])).exitCode).toBe(0)
    })
    expect([readFileSync(closed), readFileSync(open)]).toEqual([content, content])
    expect([modeOf(closed), modeOf(open)]).toEqual([0o600, 0o644])
    expect(readdirSync(folder).sort()).toEqual(['app.tgz', 'closed.env', 'open.env'])
  })

  it.each([
    { umask: '022', shown: '644', mask: 0o022, expected: 0o644 },
    { umask: '077', shown: '600', mask: 0o077, expected: 0o600 },
    { umask: '000', shown: '666', mask: 0o000, expected: 0o666 },
  ])('a new file takes the folder\'s ordinary mode: under umask $umask it is $shown', async ({ mask, expected }) => {
    const content = Buffer.from('a new file')
    const { folder } = local()
    const target = join(folder, 'new.bin')
    await underUmask(mask, async () => {
      expect((await cp(['site:new.bin', target, '--node', (await fakeNode([sent(content)])).url])).exitCode).toBe(0)
    })
    expect(readFileSync(target)).toEqual(content)
    expect(modeOf(target)).toBe(expected)
    expect(readdirSync(folder).sort()).toEqual(['app.tgz', 'new.bin'])
  })

  it('still replaces a file on a folder that holds no modes, where the call that sets the mode is refused, no wider than it was', async () => {
    const content = Buffer.from('on a mount without modes')
    const { folder } = local()
    const target = join(folder, 'fat.bin')
    writeFileSync(target, 'old', { mode: 0o600 })
    chmodSync(target, 0o600)
    const handle = await openHandle(target)
    const prototype = Object.getPrototypeOf(handle) as { chmod(mode: number): Promise<void> }
    await handle.close()
    const refused = vi.spyOn(prototype, 'chmod').mockRejectedValue(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
    try {
      await underUmask(0o022, async () => {
        expect((await cp(['site:a.bin', target, '--node', (await fakeNode([sent(content)])).url])).exitCode).toBe(0)
      })
      expect(refused).toHaveBeenCalledWith(0o600)
    } finally { refused.mockRestore() }
    expect(readFileSync(target)).toEqual(content)
    expect(modeOf(target)).toBe(0o600)
  })

  it('writes through a link to a file as cp does, leaving the link and the file\'s mode', async () => {
    const content = Buffer.from('through the link')
    const { folder } = local()
    const real = join(folder, 'real.txt')
    const link = join(folder, 'link.txt')
    writeFileSync(real, 'old', { mode: 0o600 })
    chmodSync(real, 0o600)
    symlinkSync(real, link)
    const result = await cp(['site:a.txt', link, '--node', (await fakeNode([sent(content)])).url])
    expect(result).toMatchObject({ exitCode: 0, out: `Copied ${content.byteLength} bytes to ${real} (sha256 ${sha256(content)})\n` })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real)).toEqual(content)
    expect(modeOf(real)).toBe(0o600)
  })

  it('refuses a link that points at nothing, a folder where the file would go, and a trailing slash on a folder that is not there, before it asks the node', async () => {
    const node = await fakeNode([sent(Buffer.from('x'))])
    const { folder } = local()
    symlinkSync(join(folder, 'nowhere'), join(folder, 'dangling'))
    mkdirSync(join(folder, 'dest', 'a.txt'), { recursive: true })
    const dangling = await cp(['site:a.txt', join(folder, 'dangling'), '--node', node.url])
    expect(dangling).toMatchObject({ exitCode: 1, err: `${join(folder, 'dangling')} is a link to a file that does not exist, so nothing was written; name the file itself\n` })
    const inFolder = await cp(['site:a.txt', join(folder, 'dest'), '--node', node.url])
    expect(inFolder).toMatchObject({ exitCode: 1, err: `${join(folder, 'dest', 'a.txt')} is not a regular file, so nothing was written\n` })
    const missing = await cp(['site:a.txt', `${join(folder, 'out')}/`, '--node', node.url])
    expect(missing).toMatchObject({ exitCode: 1, err: expect.stringContaining(`The folder ${join(folder, 'out')} does not exist, and buckle cp makes no folder`) })
    const file = await cp(['site:a.txt', `${join(folder, 'app.tgz')}/`, '--node', node.url])
    expect(file).toMatchObject({ exitCode: 1, err: `${join(folder, 'app.tgz')} is a file, not a folder, so nothing was written\n` })
    expect(node.seen).toEqual([])
    expect(readdirSync(folder).sort()).toEqual(['app.tgz', 'dangling', 'dest'])
  })

  it('says the node cut the file short, and to run the copy again, where the bytes stop before the length it declared', async () => {
    const cut: Answer = (_seen, response) => { response.writeHead(200, { 'content-length': '100', 'x-buckle-sha256': 'a'.repeat(64) }); response.write('half'); setTimeout(() => response.destroy(), 10) }
    const { folder } = local()
    const result = await cp(['site:a.txt', join(folder, 'a.txt'), '--node', (await fakeNode([cut])).url])
    expect(result.exitCode).toBe(1)
    expect(result.err).toBe('The node cut the file short (ECONNRESET); it does so when a file changes while it is sent, so run buckle cp again. Nothing was written\n')
    expect(readdirSync(folder)).toEqual(['app.tgz'])
  })

  it('tries the rename again where Windows holds the target open, and says the target is in use where it stays held', async () => {
    const content = Buffer.from('replaced after two tries')
    const { folder } = local()
    const target = join(folder, 'held.bin')
    writeFileSync(target, 'old')
    const held = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    let attempts = 0
    const pauses: number[] = []
    const eventually = { rename: (from: string, to: string) => { if (++attempts < 3) throw held(); renameSync(from, to) }, pause: async (ms: number) => { pauses.push(ms) } }
    expect((await cp(['site:a.txt', target, '--node', (await fakeNode([sent(content)])).url], {}, undefined, { renameIo: eventually })).exitCode).toBe(0)
    expect(readFileSync(target)).toEqual(content)
    expect(pauses).toHaveLength(2)

    const never = { rename: () => { throw held() }, pause: async () => {} }
    const result = await cp(['site:a.txt', target, '--node', (await fakeNode([sent(Buffer.from('other'))])).url], {}, undefined, { renameIo: never })
    expect(result).toMatchObject({ exitCode: 1, err: `${target} is held open by another program (EPERM), so it was not replaced; close it and run buckle cp again\n` })
    expect(readFileSync(target)).toEqual(content)
    expect(readdirSync(folder).sort()).toEqual(['app.tgz', 'held.bin'])
  })
})

describe('buckle cp stopped by a signal', () => {
  const signals = () => Object.assign(new EventEmitter(), { exit: vi.fn() })

  /** A download that has 50 of 1000 bytes and stalls; resolves once its new file holds the 50, with the copy still running. */
  async function stalledDownload(options: CopyOptions): Promise<{ folder: string; copying: ReturnType<typeof cp> }> {
    const stalled: Answer = (_seen, response) => { response.writeHead(200, { 'content-length': '1000', 'x-buckle-sha256': 'a'.repeat(64) }); response.write(Buffer.alloc(50, 1)) }
    const node = await fakeNode([stalled])
    const { folder } = local()
    const copying = cp(['site:a.bin', join(folder, 'a.bin'), '--node', node.url], {}, undefined, options)
    const deadline = Date.now() + 10_000
    const partial = () => readdirSync(folder).find(name => name.startsWith('.buckle-cp-') && statSync(join(folder, name)).size === 50)
    while (partial() === undefined) {
      if (Date.now() > deadline) throw new Error('The download never began')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return { folder, copying }
  }

  it.each(['SIGINT', 'SIGTERM'] as const)('removes the new file of a download %s cut short, exits with the signal\'s code, and leaves no listener', async (signal) => {
    const host = signals()
    const { folder, copying } = await stalledDownload({ signals: host })
    expect(host.eventNames()).toEqual(['SIGINT', 'SIGTERM'])
    host.emit(signal)
    expect(host.exit).toHaveBeenCalledWith({ SIGINT: 130, SIGTERM: 143 }[signal])
    expect(readdirSync(folder)).toEqual(['app.tgz'])
    servers.at(-1)!.closeAllConnections()
    await copying
    expect(host.eventNames()).toEqual([])
  })

  it('installs no SIGHUP listener while a copy runs, as Node would end a nohup copy on the hangup it was set to ignore', async () => {
    const before = { hangup: process.listenerCount('SIGHUP'), interrupt: process.listenerCount('SIGINT') }
    const { copying } = await stalledDownload({})
    expect(process.listenerCount('SIGINT')).toBe(before.interrupt + 1)
    expect(process.listenerCount('SIGHUP')).toBe(before.hangup)
    servers.at(-1)!.closeAllConnections()
    await copying
    expect(process.listenerCount('SIGINT')).toBe(before.interrupt)
    expect(process.listenerCount('SIGHUP')).toBe(before.hangup)
  })

  it('takes its listeners off once a copy ends, whether it copied or was refused', async () => {
    const host = signals()
    const { file } = local()
    await cp([file, 'site:a.tgz', '--node', (await fakeNode([received])).url], {}, undefined, { signals: host })
    await cp([file, 'site:a.tgz', '--node', (await fakeNode([json(422, { requestId: 'x', outcome: 'error', error: { code: 'PERMISSION_DENIED', message: 'declined', retryable: false } })])).url], {}, undefined, { signals: host })
    expect(host.eventNames()).toEqual([])
  })
})

describe('the command line of buckle cp', () => {
  it.each([
    [['only-one-end']],
    [['a.txt', 'b.txt']],
    [['a.txt', ':b.txt']],
    [['a.txt', 'site:b', '--unknown']],
    [['--token', TOKEN, 'a.txt', 'site:b']],
    [[]],
  ])('exits 2 with the usage for %j, sending nothing', async (argv) => {
    const node = await fakeNode([received])
    const result = await cp([...argv, '--node', node.url])
    expect(result.exitCode).toBe(2)
    expect(result.err).toContain(COPY_USAGE)
    expect(node.seen).toEqual([])
  })

  it('says to use cp where both ends are here, and prints its usage to stdout on --help', async () => {
    expect((await cp(['a.txt', 'local:b.txt'])).err).toMatch(/^Both ends are files on this machine: use cp\n/)
    expect(await cp(['--help'])).toMatchObject({ exitCode: 0, out: COPY_USAGE, err: '' })
    expect(COPY_USAGE).toContain('a workspace named with one letter is written by its id')
    expect(COPY_USAGE).toContain('Workspaces on two nodes: not yet')
  })

  it('refuses with the hint to pass --node where nothing names a node and none serves here', async () => {
    const { file } = local()
    const result = await cp([file, 'site:a.tgz'])
    expect(result).toMatchObject({ exitCode: 1, err: expect.stringContaining('pass --node <url>, or set BUCKLE_NODE_URL') })
  })

  it('reads C:\\ as a drive on Windows, so the file is looked for here', async () => {
    const node = await fakeNode([received])
    const result = await cp(['C:\\work\\app.tgz', 'site:', '--node', node.url], {}, 'win32')
    expect(result.exitCode).toBe(1)
    expect(result.err).toContain('C:\\work\\app.tgz could not be opened')
    expect(node.seen).toEqual([])
  })

  it('exits 1 where no token is set, naming both ways to give one', async () => {
    const { file } = local()
    const result = await cp([file, 'site:a.tgz', '--node', 'http://127.0.0.1:1'], { BUCKLE_AUTH_TOKEN: '' })
    expect(result).toMatchObject({ exitCode: 1, err: expect.stringContaining('set BUCKLE_AUTH_TOKEN') })
  })
})

