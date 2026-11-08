import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuditUnavailableError, createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import { withRegistryAudit, withSetupAudit } from '../layers/admin/server/utils/audit.js'
import { withTransportAudit } from '../layers/common/server/utils/audit.js'

// APPROVAL-16's working choice, reversed by its one constant: the owner's own change waits for its attempt's record, so a
// broken log stops it before it runs, as it stops an agent's call.
vi.mock('../common/runtime/log-budget.js', async importOriginal => ({ ...await importOriginal<typeof import('../common/runtime/log-budget.js')>(), OWNER_RECORDS_WAIT: true }))

afterEach(() => { vi.restoreAllMocks() })

/** A log whose file is a directory, so every write fails, as on a full or read-only disk. */
function brokenLog() {
  const path = join(mkdtempSync(join(tmpdir(), 'buckle-owner-wait-')), 'actions.jsonl')
  mkdirSync(path)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  return createFileActionLog(path)
}

// withSetupAudit reads the request's method alone.
const setupPost = { req: new Request('http://node.test/setup/policy', { method: 'POST' }) } as unknown as H3Event

describe('the owner\'s records, set to wait for the disk', () => {
  it('stop a CLI command, a setup change, a registry change, and the registry\'s transport on a broken log before they run', async () => {
    const actions = brokenLog()
    const change = vi.fn(async () => 'changed')

    await expect(auditOperation({ actions, workspaceId: 'node', tool: 'cli_grants', sessionId: 'local-owner', operation: change })).rejects.toBeInstanceOf(AuditUnavailableError)
    await expect(withSetupAudit(setupPost, { actions, workspaceId: 'w-1', resource: 'policy', actorId: 'admin:w-1' }, change)).rejects.toBeInstanceOf(AuditUnavailableError)
    await expect(withRegistryAudit(actions, { tool: 'workspace_register', workspaceId: 'node', actorId: 'admin:node' }, change)).rejects.toBeInstanceOf(AuditUnavailableError)
    await expect(withTransportAudit(actions, { tool: 'http_workspace_registry_post', workspaceId: 'node', attempt: 'owner' }, change)).rejects.toBeInstanceOf(AuditUnavailableError)
    expect(change).not.toHaveBeenCalled()
  })
})
