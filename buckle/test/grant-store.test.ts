import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'

const WORKSPACE = '/work/project'

function storePair() {
  const filePath = join(mkdtempSync(join(tmpdir(), 'buckle-grants-')), 'grants.json')
  return {
    // Two stores over one file stand in for two processes: `buckle approve` in a terminal and a
    // `buckle serve` that was already running when the person approved.
    approver: createFileGrantStore({ filePath, workspace: WORKSPACE }),
    server: createFileGrantStore({ filePath, workspace: WORKSPACE }),
  }
}

describe('a grant made while a server is already running', () => {
  it('reaches the running server, which is the whole point of buckle approve', async () => {
    const { approver, server } = storePair()
    expect(server.activeSubjects({ sessionId: 'mcp', rule: 'read_scope' })).toEqual([])

    await approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'session' })

    expect(server.activeSubjects({ sessionId: 'mcp', rule: 'read_scope' })).toEqual(['/shots'])
  })

  it('applies to the session it was granted for and no other', async () => {
    const { approver, server } = storePair()
    await approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'session' })

    expect(server.activeSubjects({ sessionId: 'other', rule: 'read_scope' })).toEqual([])
  })

  it('applies to every session when granted always', async () => {
    const { approver, server } = storePair()
    await approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'always' })

    expect(server.activeSubjects({ sessionId: 'a-different-session', rule: 'read_scope' })).toEqual(['/shots'])
  })

  it('does not leak across rules', async () => {
    const { approver, server } = storePair()
    await approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'always' })

    expect(server.activeSubjects({ sessionId: 'mcp', rule: 'write_scope' })).toEqual([])
  })

  it('lets a revoke from one process take effect in the other', async () => {
    const { approver, server } = storePair()
    const record = await approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'always' })

    expect(await server.revoke(record.id)).toBe(true)
    expect(approver.activeSubjects({ sessionId: 'mcp', rule: 'read_scope' })).toEqual([])
  })

  it('keeps a standing grant separate from a session grant', async () => {
    const { approver, server } = storePair()
    await approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'session' })
    await server.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'always' })

    expect(approver.list()).toHaveLength(2)
    expect(approver.list().map(grant => grant.scope).sort()).toEqual(['always', 'session'])
  })

  it('keeps one process from clobbering a grant the other made', async () => {
    const { approver, server } = storePair()
    await approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'always' })
    await server.grant({ sessionId: 'mcp', rule: 'write_scope', subject: '/out', scope: 'always' })

    expect(approver.list().map(grant => grant.subject).sort()).toEqual(['/out', '/shots'])
  })
})

describe('the actor a grant names', () => {
  it('is null for an always grant and for a grant kept before actors were, and names the caller of a session grant', async () => {
    const filePath = join(mkdtempSync(join(tmpdir(), 'buckle-grants-')), 'grants.json')
    writeFileSync(filePath, JSON.stringify({ version: 1, grants: [{ id: 'earlier', workspace: WORKSPACE, rule: 'read_scope', subject: '/earlier', scope: 'session', sessionId: 'mcp', createdAt: new Date().toISOString(), expiresAt: null }] }))
    const store = createFileGrantStore({ filePath, workspace: WORKSPACE })
    await store.grant({ sessionId: 'mcp', actor: 'agent:one', rule: 'read_scope', subject: '/always', scope: 'always' })
    await store.grant({ sessionId: 'mcp', actor: 'agent:one', rule: 'read_scope', subject: '/session', scope: 'session' })

    expect(store.list().map(grant => [grant.subject, grant.actor])).toEqual([['/earlier', null], ['/always', null], ['/session', 'agent:one']])
    expect(store.activeSubjects({ sessionId: 'mcp', rule: 'read_scope' })).toEqual(['/earlier', '/always'])
    expect(store.activeSubjects({ sessionId: 'mcp', actor: 'agent:one', rule: 'read_scope' })).toEqual(['/always', '/session'])
  })
})
