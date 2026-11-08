import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileActionLog, OWNER_RECORD_UNAVAILABLE, OwnerRecordError } from '../common/adapters/action-log/file-action-log.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import { ignoresWarning, withRegistryAudit, withSetupAudit } from '../layers/admin/server/utils/audit.js'
import { withTransportAudit } from '../layers/common/server/utils/audit.js'
import { toHttpError } from '../layers/common/server/utils/errors.js'

// APPROVAL-16: the owner's own change waits for its attempt's record, so a broken log stops it before it runs, unless the
// owner ignores the warning, which runs it and hands its record to the log service.

afterEach(() => { vi.restoreAllMocks() })

/** A log whose file is a directory, so every write fails, as on a full or read-only disk. */
function brokenLog() {
  const path = join(mkdtempSync(join(tmpdir(), 'buckle-owner-wait-')), 'actions.jsonl')
  mkdirSync(path)
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  return createFileActionLog(path)
}

// withSetupAudit reads the request's method and its query alone.
function setupPost(query = ''): H3Event {
  const url = `http://node.test/setup/policy${query}`
  return { req: new Request(url, { method: 'POST' }), url: new URL(url) } as unknown as H3Event
}

describe('the owner\'s records on a broken log', () => {
  it('stop a CLI command, a setup change, a registry change, and the registry\'s transport before they run', async () => {
    const actions = brokenLog()
    const change = vi.fn(async () => 'changed')
    const stopped = { code: OWNER_RECORD_UNAVAILABLE, status: 503 }

    await expect(auditOperation({ actions, workspaceId: 'node', tool: 'cli_grants', sessionId: 'local-owner', ignoreWarning: false, operation: change })).rejects.toMatchObject(stopped)
    await expect(withSetupAudit(setupPost(), { actions, workspaceId: 'w-1', resource: 'policy', actorId: 'admin:w-1' }, change)).rejects.toMatchObject(stopped)
    await expect(withRegistryAudit(actions, { tool: 'workspace_register', workspaceId: 'node', actorId: 'admin:node', ignoreWarning: false }, change)).rejects.toMatchObject(stopped)
    await expect(withTransportAudit(actions, { tool: 'http_workspace_registry_post', workspaceId: 'node', attempt: 'owner' }, change)).rejects.toMatchObject(stopped)
    expect(change).not.toHaveBeenCalled()
  })

  it('name the write\'s own error as the cause, so the command can show it', async () => {
    const actions = brokenLog()
    const failure = await auditOperation({ actions, workspaceId: 'node', tool: 'cli_grants', sessionId: 'local-owner', ignoreWarning: false, operation: async () => 'changed' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OwnerRecordError)
    expect(String((failure as OwnerRecordError).cause)).toMatch(/EISDIR|directory/)
  })

  it('answer a setup request 503, naming the query that makes the change anyway', async () => {
    const actions = brokenLog()
    const failure = await withSetupAudit(setupPost(), { actions, workspaceId: 'w-1', resource: 'policy', actorId: 'admin:w-1' }, async () => 'changed').catch((error: unknown) => error)
    expect(toHttpError(failure)).toMatchObject({ status: 503, message: expect.stringContaining('ignoreWarning=true'), body: { code: OWNER_RECORD_UNAVAILABLE, recordError: 'system error EISDIR' } })
  })

  it('run each change the owner ignores the warning for, its attempt handed to the log service', async () => {
    const actions = brokenLog()
    const appended = vi.spyOn(actions, 'append')
    const change = vi.fn(async () => 'changed')

    await expect(auditOperation({ actions, workspaceId: 'node', tool: 'cli_grants', sessionId: 'local-owner', ignoreWarning: true, operation: change })).resolves.toBe('changed')
    await expect(withSetupAudit(setupPost('?ignoreWarning=true'), { actions, workspaceId: 'w-1', resource: 'policy', actorId: 'admin:w-1' }, change)).resolves.toBe('changed')
    await expect(withRegistryAudit(actions, { tool: 'workspace_register', workspaceId: 'node', actorId: 'admin:node', ignoreWarning: true }, change)).resolves.toBe('changed')
    expect(change).toHaveBeenCalledTimes(3)
    const attempts = appended.mock.calls.map(([entry]) => entry).filter(entry => entry.event === 'attempt')
    expect(attempts.map(entry => entry.tool)).toEqual(['cli_grants', 'setup_post_policy', 'workspace_register'])
  })
})

describe('the choice a setup request makes', () => {
  it('is ignoreWarning=true in its query alone', () => {
    expect(ignoresWarning(setupPost('?ignoreWarning=true'))).toBe(true)
    for (const query of ['', '?ignoreWarning=false', '?ignoreWarning=1', '?ignoreWarning=yes', '?ignorewarning=true']) expect(ignoresWarning(setupPost(query))).toBe(false)
  })
})
