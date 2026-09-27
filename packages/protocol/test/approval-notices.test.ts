import { describe, expect, it } from 'vitest'
import { ApprovalNoticesSchema, InvokeRequestSchema } from '../src/index.js'

describe('the approval wait hint on an invocation', () => {
  it('is optional, so an invocation without one parses as before', () => {
    expect(InvokeRequestSchema.parse({ requestId: 'r1', tool: 'fs_read', args: {}, context: { sessionId: 's1' } }).context?.approvalWait).toBeUndefined()
  })

  it('takes none or a finite wait in milliseconds, and refuses anything else', () => {
    const parse = (approvalWait: unknown) => InvokeRequestSchema.safeParse({ requestId: 'r1', tool: 'fs_read', args: {}, context: { approvalWait } }).success
    expect(parse({ mode: 'none' })).toBe(true)
    expect(parse({ mode: 'finite', ms: 30_000 })).toBe(true)
    expect(parse({ mode: 'finite', ms: 0 })).toBe(false)
    expect(parse({ mode: 'finite', ms: 2_147_483_648 })).toBe(false)
    expect(parse({ mode: 'indefinite' })).toBe(false)
  })
})

describe('approval lifecycle notices', () => {
  it('names the event, the recorded scope or the reason a call stopped waiting', () => {
    const at = new Date().toISOString()
    expect(ApprovalNoticesSchema.parse({ serverId: 'node-1', workspaceId: 'default', notices: [
      { token: 't1', event: 'answered', at, scope: 'session' },
      { token: 't2', event: 'skipped', at, reason: 'caller_declined_wait' },
      { token: 't3', event: 'expired', at },
    ] }).notices).toHaveLength(3)
    expect(ApprovalNoticesSchema.safeParse({ serverId: 'node-1', workspaceId: 'default', notices: [{ token: 't1', event: 'approved', at }] }).success).toBe(false)
    expect(ApprovalNoticesSchema.safeParse({ serverId: 'node-1', workspaceId: 'default', notices: [] }).success).toBe(false)
  })
})
