import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../src/adapters/grant-store/file-grant-store.js'
import { createApprovalRegistry } from '../src/services/approval-registry.js'
import type { PermissionOutcome } from '../src/domain/permission/engine.js'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function registry() {
  const root = mkdtempSync('/tmp/buckle-once-'); roots.push(root)
  return createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: '/workspace' }), join(root, 'approvals.json'))
}

describe('once approval consumption', () => {
  it('retains partial grants and consumes them exactly when every gate allows', () => {
    const approvals = registry()
    const issued = approvals.issue({ tool: 'fs_read', sessionId: 'reader', asks: [
      { kind: 'ask', rule: 'read_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] },
      { kind: 'ask', rule: 'sensitive_path', subject: '/outside/credentials.json', reason: 'sensitive', offeredScopes: ['once'] },
    ] })
    const check = (subjects: unknown[]): PermissionOutcome => subjects.length === 2 ? { kind: 'allow', allowedBy: [] } : { kind: 'ask', asks: [] }
    approvals.resolve({ token: issued[0]!.token, approved: true, scope: 'once' })
    expect(approvals.evaluate({ tokens: issued.map(item => item.token), sessionId: 'reader', tool: 'fs_read', check }).kind).toBe('ask')
    approvals.resolve({ token: issued[1]!.token, approved: true, scope: 'once' })
    expect(approvals.evaluate({ tokens: issued.map(item => item.token), sessionId: 'reader', tool: 'fs_read', check }).kind).toBe('allow')
    expect(approvals.evaluate({ tokens: issued.map(item => item.token), sessionId: 'reader', tool: 'fs_read', check }).kind).toBe('ask')
  })

  it('binds once grants to the issuing session and tool and expires pending tokens', () => {
    vi.useFakeTimers()
    const approvals = registry()
    const [request] = approvals.issue({ tool: 'fs_read', sessionId: 'reader', asks: [{ kind: 'ask', rule: 'read_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }] })
    const decision = { token: request!.token, approved: true, scope: 'once' as const }
    expect(approvals.resolve(decision).ok).toBe(true)
    expect(approvals.resolve(decision).ok).toBe(true)
    const check = (subjects: unknown[]): PermissionOutcome => subjects.length ? { kind: 'allow', allowedBy: [] } : { kind: 'ask', asks: [] }
    expect(approvals.evaluate({ tokens: [request!.token], sessionId: 'other-reader', tool: 'fs_read', check }).kind).toBe('ask')
    expect(approvals.evaluate({ tokens: [request!.token], sessionId: 'reader', tool: 'fs_write', check }).kind).toBe('ask')
    vi.advanceTimersByTime(11 * 60_000)
    expect(approvals.pending()).toEqual([])
    expect(approvals.evaluate({ tokens: [request!.token], sessionId: 'reader', tool: 'fs_read', check }).kind).toBe('ask')
  })
})

 it('isolates approvals between workspaces sharing the same state directory', () => {
  const root = mkdtempSync('/tmp/buckle-workspace-'); roots.push(root)
  const create = (workspace: string) => createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace }), join(root, 'approvals.json'), workspace)
  const first = create('/first'); const second = create('/second')
  const [request] = first.issue({ tool: 'fs_read', sessionId: 'shared', asks: [{ kind: 'ask', rule: 'read_scope', subject: '/outside', reason: 'outside', offeredScopes: ['once'] }] })
  const decision = { token: request!.token, approved: true, scope: 'once' as const }
  expect(second.pending()).toEqual([])
  expect(second.resolve(decision).ok).toBe(false)
  expect(first.resolve(decision).ok).toBe(true)
  second.evaluate({ tokens: [request!.token], sessionId: 'shared', tool: 'fs_read', check: subjects => { expect(subjects).toEqual([]); return { kind: 'allow', allowedBy: [] } } })
  create('/first').evaluate({ tokens: [request!.token], sessionId: 'shared', tool: 'fs_read', check: subjects => { expect(subjects).toHaveLength(1); return { kind: 'allow', allowedBy: [] } } })
})
