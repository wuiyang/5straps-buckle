import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileGrantStore } from '../src/adapters/grant-store/file-grant-store.js'

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
  it('reaches the running server, which is the whole point of buckle approve', () => {
    const { approver, server } = storePair()
    expect(server.activeSubjects({ sessionId: 'mcp', rule: 'read_scope' })).toEqual([])

    approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'session' })

    expect(server.activeSubjects({ sessionId: 'mcp', rule: 'read_scope' })).toEqual(['/shots'])
  })

  it('applies to the session it was granted for and no other', () => {
    const { approver, server } = storePair()
    approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'session' })

    expect(server.activeSubjects({ sessionId: 'other', rule: 'read_scope' })).toEqual([])
  })

  it('applies to every session when granted always', () => {
    const { approver, server } = storePair()
    approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'always' })

    expect(server.activeSubjects({ sessionId: 'a-different-session', rule: 'read_scope' })).toEqual(['/shots'])
  })

  it('does not leak across rules', () => {
    const { approver, server } = storePair()
    approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'always' })

    expect(server.activeSubjects({ sessionId: 'mcp', rule: 'write_scope' })).toEqual([])
  })

  it('lets a revoke from one process take effect in the other', () => {
    const { approver, server } = storePair()
    const record = approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'always' })

    expect(server.revoke(record.id)).toBe(true)
    expect(approver.activeSubjects({ sessionId: 'mcp', rule: 'read_scope' })).toEqual([])
  })

  it('replaces rather than duplicates when the same subject is granted twice', () => {
    const { approver, server } = storePair()
    approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'session' })
    server.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'always' })

    expect(approver.list()).toHaveLength(1)
    expect(approver.list()[0]?.scope).toBe('always')
  })

  it('keeps one process from clobbering a grant the other made', () => {
    const { approver, server } = storePair()
    approver.grant({ sessionId: 'mcp', rule: 'read_scope', subject: '/shots', scope: 'always' })
    server.grant({ sessionId: 'mcp', rule: 'write_scope', subject: '/out', scope: 'always' })

    expect(approver.list().map(grant => grant.subject).sort()).toEqual(['/out', '/shots'])
  })
})
