import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ApprovalRequest } from '@5straps/protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebhookNotifier } from '../common/adapters/approval/webhook-notifier.js'

let server: Server
let url: string
const received: Array<{ authorization: string | undefined; body: Record<string, unknown> }> = []

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      received.push({ authorization: request.headers.authorization, body: JSON.parse(body) as Record<string, unknown> })
      response.end('ok')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/approvals`
})

afterAll(() => {
  server.close()
})

const request: ApprovalRequest = {
  token: 'tok-1',
  rule: 'read_scope',
  subject: '/etc',
  reason: '/etc/hostname is outside the sandbox',
  tool: 'fs_read',
  offeredScopes: ['once', 'session', 'always'],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}

describe('what the approval webhook carries', () => {
  it('names the node and presents its credential, so Rings can answer the right Buckle', async () => {
    await createWebhookNotifier({ url, serverId: 'linux-dev', workspaceId: 'default', token: 'report-secret' })([request])
    const last = received.at(-1)
    expect(last?.authorization).toBe('Bearer report-secret')
    expect(last?.body.serverId).toBe('linux-dev')
    const approvals = last?.body.approvals as Array<Record<string, unknown>>
    expect(approvals[0]).toMatchObject({ token: 'tok-1', tool: 'fs_read', rule: 'read_scope', subject: '/etc' })
    expect(approvals[0]?.approveCommand).toBe('buckle approve tok-1 --scope session')
  })

  it('names the workspace a child runtime is waiting in, and the command that answers it there', async () => {
    await createWebhookNotifier({ url, serverId: 'linux-dev', workspaceId: 'photos', token: 'report-secret' })([request])
    const last = received.at(-1)
    expect(last?.body.workspaceId).toBe('photos')
    const approvals = last?.body.approvals as Array<Record<string, unknown>>
    expect(approvals[0]).toMatchObject({ workspaceId: 'photos', approveCommand: 'buckle approve tok-1 --scope session --workspace photos' })
  })

  it('sends no credential when the node has none configured', async () => {
    await createWebhookNotifier({ url, serverId: 'laptop', workspaceId: 'default' })([request])
    expect(received.at(-1)?.authorization).toBeUndefined()
  })
})
