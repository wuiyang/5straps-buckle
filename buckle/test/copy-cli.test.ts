import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyCommand, COPY_USAGE } from '../cli/copy.js'

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
async function cp(argv: string[], environment: NodeJS.ProcessEnv = {}, platform?: NodeJS.Platform) {
  let out = ''
  let err = ''
  const result = await copyCommand(argv, { BUCKLE_AUTH_TOKEN: TOKEN, ...environment }, { stdout: { write: text => { out += text } }, stderr: { write: text => { err += text } }, pollMs: 5, running: async () => null, ...(platform ? { platform } : {}) })
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
    expect(put!.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'content-length': String(content.byteLength), 'x-buckle-sha256': sha256(content), 'x-buckle-session': 'buckle-cp', 'x-buckle-request-id': expect.stringMatching(/^[0-9a-f-]{36}$/) })
  })

  it('prints the node\'s instruction once, waits, and sends the same request again under its requestId until it is approved', async () => {
    const node = await fakeNode([asked(), asked(), received])
    const { file, content } = local()
    const result = await cp([file, 'site:', '--node', node.url])
    expect(result.exitCode).toBe(0)
    expect(result.err).toContain('This copy needs a person to approve it at the node, with these commands there:')
    expect(result.err).toContain(`  waiting on node ${node.url}, workspace site\n`)
    expect(result.err).toContain('  then approve with: buckle approve 3f6c1a2b-0000-4000-8000-000000000000 --scope session --workspace site')
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

