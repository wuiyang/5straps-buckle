import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { approvalKey, mintApprovalKey, open, SEALED_REPORT_PATHS } from '@5straps/protocol/envelope'
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

  it('leads with buckle approvals, which shows the whole action, and names buckle approve after it (owner decision D17)', async () => {
    await createWebhookNotifier({ url, serverId: 'linux-dev', workspaceId: 'photos' })([request])
    const approvals = received.at(-1)?.body.approvals as Array<Record<string, unknown>>
    expect(approvals[0]?.reviewCommand).toBe('buckle approvals --workspace photos')
    const keys = Object.keys(approvals[0]!)
    expect(keys.indexOf('reviewCommand')).toBeLessThan(keys.indexOf('approveCommand'))
  })

  it('keeps an unpaired webhook to the summary and approval instructions, without arguments or effects', async () => {
    const call = { arguments: { path: '/etc/hostname', content: 'private file contents' }, cwd: '/workspace', description: 'Write to "/etc/hostname"', effects: ['write /etc/hostname'], complete: true as const }
    await createWebhookNotifier({ url, serverId: 'linux-dev', workspaceId: 'default' })([request], call)
    const body = received.at(-1)!.body
    expect(body.description).toBe(call.description)
    expect(body).not.toHaveProperty('call')
    expect(JSON.stringify(body)).not.toContain('private file contents')
    expect(JSON.stringify(body)).not.toContain('"effects"')
    expect(body.approvals).toEqual([expect.objectContaining({ subject: request.subject, reason: request.reason, rule: request.rule, expiresAt: request.expiresAt, offeredScopes: request.offeredScopes, workspaceId: 'default', reviewCommand: 'buckle approvals', approveCommand: 'buckle approve tok-1 --scope session' })])
  })

  it('carries the whole call once only inside the envelope sealed to the paired Rings key', async () => {
    const key = approvalKey(mintApprovalKey())
    const notifier = createWebhookNotifier({ url, serverId: 'linux-dev', workspaceId: 'default', approvalKey: key })
    const call = { arguments: { path: '/etc/hostname' }, cwd: '/workspace', description: 'Read "/etc/hostname"', effects: ['read /etc/hostname'], complete: true as const }
    await notifier([request, { ...request, token: 'tok-2' }], call)
    const wire = received.at(-1)!.body
    expect(JSON.stringify(wire)).not.toContain('/etc/hostname')
    const body = open(key, wire, { method: 'POST', path: SEALED_REPORT_PATHS.approvals, now: Date.now(), seen: { claim: () => true } }) as Record<string, unknown>
    expect(body.call).toEqual({ arguments: call.arguments, cwd: call.cwd, description: call.description, effects: call.effects })
    expect(JSON.stringify(body.approvals)).not.toContain('"arguments"')
    await notifier([request], { arguments: { path: '/etc/ho...' }, cwd: '/workspace', description: null, truncated: true })
    const incomplete = open(key, received.at(-1)!.body, { method: 'POST', path: SEALED_REPORT_PATHS.approvals, now: Date.now(), seen: { claim: () => true } })
    expect(incomplete).not.toHaveProperty('call')
  })

  it('sends no credential when the node has none configured', async () => {
    await createWebhookNotifier({ url, serverId: 'laptop', workspaceId: 'default' })([request])
    expect(received.at(-1)?.authorization).toBeUndefined()
  })
})
