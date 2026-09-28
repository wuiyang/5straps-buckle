import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeError } from '@5straps/runtime'
import { acquireFileLock, SqliteErrorCode } from '@5straps/runtime/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { runCli } from '../cli/main.js'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createJsonFileStore, StateBusyError } from '../common/adapters/json-file-store.js'
import { loadConfig } from '../common/runtime/config.js'
import { HistoryBusyError, openChangeHistory, type ChangeHistory } from '../common/services/history/journal.js'
import { createShellWorkspaceRecovery } from '../common/services/shell/isolated-shell.js'
import { createWorkbenchStorage } from '../common/services/workbench/storage.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { holdLockInProcess, killHolder } from './support/lock-holder.js'

const holders: ChildProcess[] = []
const histories: ChangeHistory[] = []
afterEach(async () => {
  for (const holder of holders.splice(0)) if (holder.exitCode === null && holder.signalCode === null) await killHolder(holder)
  for (const history of histories.splice(0)) await history.close()
})

function directory(): string {
  return mkdtempSync(join(tmpdir(), 'buckle-locks-'))
}

async function holder(path: string): Promise<ChildProcess> {
  const child = await holdLockInProcess(path)
  holders.push(child)
  return child
}

async function history(root: string, lockDeadlineMs = 200): Promise<ChangeHistory> {
  const opened = await openChangeHistory({ directory: join(root, 'history'), excluded: [], maxBytes: 1_000_000, retentionDays: 30, lockDeadlineMs })
  histories.push(opened)
  return opened
}

describe('JSON state files (json-file-store)', () => {
  const schema = z.object({ count: z.number() })

  it('answers StateBusyError once another process holds the file past the wait, without blocking the event loop', async () => {
    const filePath = join(directory(), 'state.json')
    const store = createJsonFileStore({ filePath, schema, fallback: { count: 0 }, lockDeadlineMs: 300 })
    await holder(`${filePath}.lock.sqlite`)
    let ticks = 0
    const ticking = setInterval(() => { ticks += 1 }, 20)
    const started = performance.now()
    try {
      await expect(store.update(state => { state.count += 1 })).rejects.toBeInstanceOf(StateBusyError)
    } finally {
      clearInterval(ticking)
    }
    expect(performance.now() - started).toBeGreaterThanOrEqual(290)
    expect(ticks).toBeGreaterThan(5)
    expect(store.read()).toEqual({ count: 0 })
  })

  it('writes at once after the process holding the lock is killed', async () => {
    const filePath = join(directory(), 'state.json')
    const store = createJsonFileStore({ filePath, schema, fallback: { count: 0 }, lockDeadlineMs: 300 })
    await killHolder(await holder(`${filePath}.lock.sqlite`))
    await store.update(state => { state.count += 1 })
    expect(store.read()).toEqual({ count: 1 })
  })

  it('waits for a holder that lets go inside the wait, then writes', async () => {
    const filePath = join(directory(), 'state.json')
    const store = createJsonFileStore({ filePath, schema, fallback: { count: 0 } })
    const held = await acquireFileLock({ path: `${filePath}.lock.sqlite`, wait: 'none' })
    const writing = store.update(state => { state.count += 1 })
    setTimeout(() => { void held.release() }, 150)
    await writing
    expect(store.read()).toEqual({ count: 1 })
  })
})

describe('workbench ownership (workbench storage)', () => {
  it('refuses ownership while another process owns the working copies, and takes it once that process is killed', async () => {
    const root = directory()
    const storage = createWorkbenchStorage(root)
    const other = await holder(join(root, 'manager.lock.sqlite'))
    await expect(storage.own()).rejects.toThrow('Workbench execution is owned by another Buckle process')
    await killHolder(other)
    expect(await storage.own()).toBe(true)
    expect(await storage.own()).toBe(false)
    await storage.close()
  })
})

describe('isolated shell workspaces (try-lock)', () => {
  it('reports an active workspace at once while another process holds it', async () => {
    const root = directory()
    const shells = join(root, 'isolated-shell')
    mkdirSync(shells)
    const id = `shell-${randomUUID()}`
    await holder(join(`${shells}.locks`, `${id}.sqlite`))
    const recovery = createShellWorkspaceRecovery({ directory: shells, maxBytes: 1_000_000, history: await history(root), sourceRoot: root, retentionDays: 30 })
    const started = performance.now()
    await expect(recovery.inspect(id)).rejects.toThrow('Shell workspace is active; wait for execution or recovery to finish')
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('interrupted audit recovery (pending audit)', () => {
  it('recovers nothing while another process recovers the same log, and the interrupted call once it is killed', async () => {
    const path = join(directory(), 'actions.jsonl')
    await createFileActionLog(path).record({ auditId: 'stopped', event: 'attempt', at: new Date().toISOString(), requestId: 'stopped', sessionId: 's', tool: 'fs_write', outcome: 'started', durationMs: 0, effects: [], args: {} })
    const pending = JSON.parse(readFileSync(`${path}.pending.json`, 'utf8')) as { pending: Record<string, { processId: number; processInstanceId: string }> }
    for (const record of Object.values(pending.pending)) Object.assign(record, { processId: 2_000_000_000, processInstanceId: 'terminated-fixture-process' })
    writeFileSync(`${path}.pending.json`, JSON.stringify(pending))

    const recovering = await holder(`${path}.recovery.sqlite`)
    expect(await createFileActionLog(path).recoverInterrupted()).toBe(0)
    await killHolder(recovering)
    expect(await createFileActionLog(path).recoverInterrupted()).toBe(1)
  })
})

describe('history execution lock', () => {
  it('answers HistoryBusyError past its deadline while another process executes, and runs once that process is killed', async () => {
    const root = directory()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const changes = await history(root)
    const other = await holder(join(root, 'history', 'execution.lock.sqlite'))
    const details = { sessionId: 's', stageId: 'stage', tool: 'test', roots: [workspace] }
    let ran = false
    await expect(changes.run(details, async () => { ran = true })).rejects.toBeInstanceOf(HistoryBusyError)
    expect(ran).toBe(false)
    await killHolder(other)
    await changes.run(details, async () => { writeFileSync(join(workspace, 'file'), 'written') })
    expect(await changes.list()).toHaveLength(1)
  })

  it('stops waiting when the invocation is cancelled', async () => {
    const root = directory()
    const changes = await history(root, 60_000)
    await holder(join(root, 'history', 'execution.lock.sqlite'))
    const controller = new AbortController()
    const waiting = changes.run({ sessionId: 's', stageId: 'stage', tool: 'test', roots: [root] }, async () => undefined, controller.signal)
    setTimeout(() => controller.abort(new Error('caller left')), 100)
    await expect(waiting).rejects.toMatchObject({ code: 'LockAbortedError' })
  })

  it('refuses history operations after close', async () => {
    const changes = await history(directory())
    await changes.close()
    await expect(changes.list()).rejects.toMatchObject({ code: 'ConnectionOwnerClosedError' })
  })
})

describe('a state file busy past the wait, at the faces', () => {
  // A short wait, so the busy answers are tested without the real five seconds.
  async function busyNode(file = 'grants.json') {
    const root = directory()
    mkdirSync(join(root, 'workspace'))
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const config = { ...loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'busy-agent-token-fixture', BUCKLE_ADMIN_TOKEN: 'busy-admin-token-fixture', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' }), stateLockDeadlineMs: 300 }
    const runtime = await createRuntime({ config })
    const grant = await runtime.grants.grant({ sessionId: 's', rule: 'read_scope', subject: '/shots', scope: 'always' })
    await holder(join(root, 'state', `${file}.lock.sqlite`))
    return { config, runtime, grant }
  }

  async function captureStderr(run: () => Promise<{ exitCode: number }>): Promise<{ exitCode: number; stderr: string }> {
    let stderr = ''
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true }) as typeof process.stderr.write
    try {
      return { exitCode: (await run()).exitCode, stderr }
    } finally {
      process.stderr.write = write
    }
  }

  // Over HTTP: test/http/locks-http.test.ts, on the harness.

  it('exits 1 with the reason from the CLI', async () => {
    const { config, runtime, grant } = await busyNode()
    await runtime.history.close()
    const result = await captureStderr(() => runCli({ argv: ['grants', 'revoke', grant.id], config }))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('is busy in another Buckle process')
  })

  it('answers a tool call with a retryable STATE_BUSY that names no path', async () => {
    const { config, runtime } = await busyNode('approvals.json')
    const response = await runtime.invoke({ sessionId: 's', request: { requestId: 'busy-read', tool: 'fs_list', args: { path: '.' }, approvalTokens: [] } })
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'STATE_BUSY', message: 'Buckle state is busy in another process; retry shortly', retryable: true } })
    expect(JSON.stringify(response)).not.toContain(config.stateDirectory)
    await runtime.history.close()
  })

  it('exits 1 from a CLI tool call with the STATE_BUSY reason', async () => {
    const { config, runtime } = await busyNode('approvals.json')
    await runtime.history.close()
    const result = await captureStderr(() => runCli({ argv: ['call', 'fs_list', '--json', '{"path":"."}'], config }))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('STATE_BUSY: Buckle state is busy in another process; retry shortly')
  })

  it('answers STATE_BUSY when the history connection stays busy past its section wait', async () => {
    const root = directory()
    mkdirSync(join(root, 'workspace'))
    // A scratch root takes writes without asking, so the call reaches its history section.
    const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_SCRATCH_ROOTS: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    const runtime = await createRuntime({ config })
    runtime.history.run = async () => { throw new RuntimeError(SqliteErrorCode.sectionWaitTimeout, 'Waited 5000 ms for connection history:default while another flow held it') }
    const response = await runtime.invoke({ sessionId: 's', request: { requestId: 'section-wait', tool: 'fs_write', args: { path: 'note.txt', content: 'x' }, approvalTokens: [] } })
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'STATE_BUSY', retryable: true } })
    await runtime.history.close()
  })
})
