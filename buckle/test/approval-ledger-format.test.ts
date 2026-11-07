import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { FLOOR_WARNING } from '../common/domain/approval-instruction.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'

// The ledger's format is its own: an approvals file an earlier build wrote reads whole whatever the display words.

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const WORKSPACE = 'ws-ledger-format'
const SUBJECT = 'rm -rf build'
// What a floor ask's judge note carried when this ledger was written.
const RECORDED_WARNING = 'a command at the destructive floor always needs a person'

function ledgerWrittenEarlier(): { filePath: string; grantsPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'buckle-ledger-format-'))
  roots.push(root)
  const filePath = join(root, 'approvals.json')
  writeFileSync(filePath, JSON.stringify({
    version: 1,
    pending: [{
      request: { token: 'tok-floor', rule: 'destructive_command', subject: SUBJECT, reason: 'A destructive command needs a person', tool: 'shell_run', offeredScopes: ['once', 'session'], expiresAt: new Date(Date.now() + 600_000).toISOString() },
      sessionId: 's', workspace: WORKSPACE, requestId: 'r',
      call: { arguments: { command: SUBJECT }, cwd: '/w', description: null, complete: true, judge: [{ subject: SUBJECT, onRequest: true, warning: RECORDED_WARNING }] },
    }],
    once: [], resolved: [],
  }))
  return { filePath, grantsPath: join(root, 'grants.json') }
}

describe('the ledger format', () => {
  it('reads a floor ask an earlier build recorded, its judge note warning and all', () => {
    const { filePath, grantsPath } = ledgerWrittenEarlier()
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: grantsPath, workspace: WORKSPACE }), filePath)
    const [ask] = registry.waiting()
    expect(ask?.request.token).toBe('tok-floor')
    expect(ask?.call?.judge).toEqual([{ subject: SUBJECT, onRequest: true, warning: RECORDED_WARNING }])
    expect({ floor: ask?.floor, destructive: ask?.destructive }).toEqual({ floor: true, destructive: true })
  })

  it('keeps the warning the decision AI writes today readable', () => {
    expect(FLOOR_WARNING).toBe(RECORDED_WARNING)
  })
})
