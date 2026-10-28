import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { copyCommand } from '../../cli/copy.js'
import { createBuckleHttp } from '../support/buckle-http.js'
import { nodeEnvironment } from '../support/node-environment.js'

it('PUT and buckle cp carry the history warning from real writes without host git', async () => {
  const token = randomUUID()
  const node = nodeEnvironment('history-notice-http-', { BUCKLE_AUTH_TOKEN: token, BUCKLE_ALLOW_HOST_GIT: 'false', BUCKLE_PACKS: 'fs' })
  const buckle = await createBuckleHttp({ environment: node.environment })
  const local = mkdtempSync(join(tmpdir(), 'history-notice-copy-'))
  try {
    await buckle.runtime.grants.grant({ sessionId: 'rpc', rule: 'write_scope', subject: buckle.runtime.paths().root, scope: 'always' })
    const content = Buffer.from('hello')
    const response = await buckle.request('/v1/files?path=put.txt', { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-length': String(content.length), 'x-buckle-sha256': createHash('sha256').update(content).digest('hex'), 'x-buckle-request-id': 'put-notice' }, body: content })
    const answer = await response.json() as { outcome: string; meta?: { history?: { restorable: boolean; checkpoint: string } } }
    expect(answer).toMatchObject({ outcome: 'ok', meta: { history: { restorable: false, checkpoint: expect.stringMatching(/^change-/) } } })
    const file = join(local, 'source.txt'); writeFileSync(file, content)
    let out = ''; let err = ''
    const result = await copyCommand([file, `${buckle.runtime.workspaceName()}:copy.txt`, '--node', await buckle.listen()], { BUCKLE_AUTH_TOKEN: token }, { stdout: { write: text => { out += text } }, stderr: { write: text => { err += text } }, pollMs: 10 })
    expect(result.exitCode).toBe(0)
    expect(out).toMatch(/^Copied /)
    expect(err).toMatch(/history.*(restore|restorable)/i)
    expect(readFileSync(join(node.workspace, 'copy.txt'))).toEqual(content)
  } finally { await buckle.close(); rmSync(local, { recursive: true, force: true }); rmSync(node.root, { recursive: true, force: true }) }
})
