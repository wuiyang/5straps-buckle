import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../../runtime/log.js'
import { z } from 'zod'
import {
  WorkbenchApplySchema, WorkbenchControlSchema, WorkbenchInvokeSchema, WorkbenchProvisionSchema,
  WorkbenchTerminalInputSchema, WorkbenchTerminalResizeSchema, WorkbenchTerminalStartSchema,
  type WorkbenchProvision, type WorkbenchRecord, type WorkbenchReview,
} from '@5straps/protocol'
import type { ActionLog } from '../../types/ports/action-log.js'
import type { PtySpawner, PtySpawnRequest } from '../../types/ports/pty-process.js'
import type { ChangeHistory } from '../history/journal.js'
import { assertSnapshotMatches, changedPaths, snapshotSchema } from '../history/snapshot.js'
import { createWorkbenchFiles, type WorkbenchFileOptions } from './files.js'
import { createWorkbenchTerminals } from './terminals.js'
import { createWorkbenchStorage, publicWorkbench, StoredWorkbenchSchema, WorkbenchError, workbenchGrant, workbenchHash, writeWorkbenchJson, type StoredWorkbench } from './storage.js'

const reviewStorageSchema = z.object({ id: z.string().uuid(), workbenchId: z.string().uuid(), revision: z.number().int(), createdAt: z.string(), target: snapshotSchema })
const CLOSED = new Set(['applied', 'discarded'])
export interface WorkbenchManagerOptions extends WorkbenchFileOptions {
  workspaceId: string
  actions: ActionLog
  history: ChangeHistory
  spawnPty: PtySpawner
  policyHash(): string
  authorizeTool?(tool: string): boolean
  prepareTerminal(input: { root: string; cwd: string; cols: number; rows: number }): Promise<PtySpawnRequest>
  now?: () => number
}
export function createWorkbenchManager(options: WorkbenchManagerOptions) {
  const storage = createWorkbenchStorage(options.directory)
  const files = createWorkbenchFiles(options)
  const records = new Map<string, StoredWorkbench>()
  const active = new Set<string>()
  const now = options.now ?? Date.now
  const time = () => new Date(now()).toISOString()
  function save(record: StoredWorkbench): void { record.updatedAt = time(); storage.save(record) }
  async function audit(record: StoredWorkbench, tool: string, actorId: string, args: Record<string, string | number>, event: 'attempt' | 'result', auditId: string = randomUUID(), outcome: 'ok' | 'error' | 'started' | 'interrupted' = event === 'attempt' ? 'started' : 'ok'): Promise<string> {
    await options.actions.record({ auditId, event, workspaceId: options.workspaceId, requestId: auditId, at: time(),
      projectId: record.projectId, chatId: record.chatId, sessionId: record.chatId, stageId: record.id, actorId,
      tool: 'workbench_' + tool, outcome, durationMs: 0, effects: [], args })
    return auditId
  }
  const terminals = createWorkbenchTerminals({ directory: options.directory, spawn: options.spawnPty, save, audit, checkBudget: record => files.checkBudget(record.id), now })
  async function own(force = false): Promise<void> {
    if (!force && records.size === 0 && storage.list().length === 0) return
    if (!await storage.own()) return
    for (const record of storage.list()) {
      let recovered = false
      if (record.status === 'preparing' || record.status === 'applying') { record.status = record.status === 'applying' ? 'apply_uncertain' : 'interrupted'; recovered = true }
      for (const terminal of record.terminals) if (['running', 'stopping'].includes(terminal.status)) {
        terminal.status = 'interrupted'; terminal.controllerId = null; terminal.leaseExpiresAt = null; terminal.generation++; terminal.exitedAt = time()
        recovered = true
      }
      if (recovered) { record.reviewId = null; record.revision++; save(record); void audit(record, 'recover', 'buckle-recovery', {}, 'result', undefined, 'interrupted').catch(reportAuditFailure) }
      records.set(record.id, record)
    }
  }
  async function get(id: string): Promise<StoredWorkbench> {
    await own()
    const record = records.get(id)
    if (!record) throw new WorkbenchError('Workbench not found', 404)
    return record
  }
  function purge(record: StoredWorkbench): void {
    for (const name of readdirSync(storage.location(record.id))) if (name !== 'state.json') rmSync(join(storage.location(record.id), name), { recursive: true, force: true })
  }
  function assertTool(tool: string): void {
    if (options.authorizeTool && !options.authorizeTool(tool)) throw new WorkbenchError('Tool disabled by workspace policy', 403)
  }
  function assertOpen(record: StoredWorkbench): void {
    if (CLOSED.has(record.status) || ['preparing', 'applying', 'apply_uncertain'].includes(record.status)) throw new WorkbenchError('Workbench is not available for this operation')
    if (!existsSync(join(storage.location(record.id), 'base.json'))) throw new WorkbenchError('Interrupted preparation must be discarded before reopening')
  }
  function assertStopped(record: StoredWorkbench): void {
    assertOpen(record)
    if (terminals.isRunning(record)) throw new WorkbenchError('Stop all terminals before reviewing, applying or discarding')
  }
  async function operation<T>(id: string, tool: string, actorId: string, args: Record<string, string | number>, execute: (record: StoredWorkbench) => Promise<T> | T): Promise<T> {
    const record = await get(id)
    const auditId = await audit(record, tool, actorId, args, 'attempt')
    try {
      if (active.has(id)) throw new WorkbenchError('Another workbench operation is running')
      active.add(id)
      try {
        const result = await execute(record)
        await audit(record, tool, actorId, args, 'result', auditId)
        return result
      } finally { active.delete(id) }
    } catch (error) { await audit(record, tool, actorId, args, 'result', auditId, 'error'); throw error }
  }
  return {
    get: async (id: string) => publicWorkbench(await get(id)),
    async list() { await own(); return [...records.values()].map(publicWorkbench) },
    /**
     * Inspection, which mutates nothing (layers.md, Security boundaries): the records as stored, read
     * without taking ownership or recovering interrupted ones (review L4 of B15-B17). Recovery runs on
     * the first operation that owns the workbenches.
     */
    inspect(): WorkbenchRecord[] { return storage.list().map(publicWorkbench) },
    /** Whether inspection shows any workbench still open, read as inspect() reads. */
    inspectActive(): boolean { return storage.list().some(record => !CLOSED.has(record.status)) },
    async hasActiveWork() { await own(); return [...records.values()].some(record => !CLOSED.has(record.status)) },
    async authenticate(id: string, authorization: string | undefined): Promise<boolean> {
      const token = workbenchGrant(authorization)
      if (!token) return false
      try {
        const record = await get(id)
        return timingSafeEqual(Buffer.from(record.tokenHash, 'hex'), Buffer.from(workbenchHash(token), 'hex'))
      } catch (error) { if (error instanceof WorkbenchError && error.status === 404) return false; throw error }
    },
    async provision(input: WorkbenchProvision) {
      const parsed = WorkbenchProvisionSchema.parse(input)
      await own(true)
      const existing = records.get(parsed.id)
      if (existing) {
        if (existing.tokenHash !== workbenchHash(parsed.token) || existing.projectId !== parsed.projectId || existing.chatId !== parsed.chatId || existing.allowShell !== parsed.allowShell) throw new WorkbenchError('Workbench provision conflicts with its existing grant')
        return publicWorkbench(existing)
      }
      if ([...records.values()].some(record => record.chatId === parsed.chatId && !CLOSED.has(record.status))) throw new WorkbenchError('This chat already has an unresolved workbench on this workspace')
      const record: StoredWorkbench = StoredWorkbenchSchema.parse({
        id: parsed.id, workspaceId: options.workspaceId, projectId: parsed.projectId, chatId: parsed.chatId, status: 'preparing', revision: 0,
        createdAt: time(), updatedAt: time(), allowShell: parsed.allowShell, terminals: [], reviewId: null, tokenHash: workbenchHash(parsed.token), policyHash: options.policyHash(),
      })
      records.set(record.id, record); save(record)
      return operation(record.id, 'create', 'workspace-setup', {}, async () => {
        try { assertTool('fs_read'); files.prepare(record.id); record.status = 'open'; save(record); return publicWorkbench(record) }
        catch (error) { record.status = 'interrupted'; save(record); throw error }
      })
    },
    invoke(id: string, input: z.infer<typeof WorkbenchInvokeSchema>) {
      const parsed = WorkbenchInvokeSchema.parse(input)
      return operation(id, 'invoke', parsed.actorId, { tool: parsed.tool }, async record => {
        assertOpen(record)
        assertTool(parsed.tool)
        const result = await files.invoke(id, record.chatId, parsed.tool, parsed.args)
        if (parsed.tool === 'fs_write') { record.status = 'open'; record.reviewId = null; record.revision++; save(record) }
        return { result, workbench: publicWorkbench(record) }
      })
    },
    startTerminal(id: string, input: z.infer<typeof WorkbenchTerminalStartSchema>) {
      const parsed = WorkbenchTerminalStartSchema.parse(input)
      return operation(id, 'terminal_start', parsed.actorId, { cwd: parsed.cwd }, async record => {
        assertOpen(record)
        assertTool('shell_exec')
        if (!record.allowShell) throw new WorkbenchError('This workbench has no interactive shell authority', 403)
        if (record.policyHash !== options.policyHash()) throw new WorkbenchError('Workspace policy changed; apply or discard this workbench before opening a new terminal', 403)
        const cwd = await files.authorize(id, parsed.cwd, 'read')
        const request = await options.prepareTerminal({ root: files.root(id), cwd, cols: parsed.cols, rows: parsed.rows })
        const terminal = await terminals.start(record, parsed.actorId, request)
        return { terminal: structuredClone(terminal) }
      })
    },
    async terminalEvents(id: string, terminalId: string, after: number) {
      if (!Number.isSafeInteger(after) || after < 0) throw new WorkbenchError('Invalid terminal cursor', 400)
      return terminals.events(await get(id), terminalId, after)
    },
    controlTerminal(id: string, terminalId: string, input: z.infer<typeof WorkbenchControlSchema>) {
      const parsed = WorkbenchControlSchema.parse(input)
      return operation(id, 'terminal_control', parsed.actorId, { terminalId, action: parsed.action }, record => {
        assertOpen(record)
        return { terminal: structuredClone(terminals.control(record, terminalId, parsed)) }
      })
    },
    terminalInput(id: string, terminalId: string, input: z.infer<typeof WorkbenchTerminalInputSchema>) {
      const parsed = WorkbenchTerminalInputSchema.parse(input)
      return operation(id, 'terminal_input', parsed.actorId, { terminalId, generation: parsed.generation, sequence: parsed.sequence, bytes: Buffer.byteLength(parsed.data) }, record => {
        assertOpen(record)
        assertTool('shell_exec')
        return { terminal: structuredClone(terminals.input(record, terminalId, parsed)) }
      })
    },
    resizeTerminal(id: string, terminalId: string, input: z.infer<typeof WorkbenchTerminalResizeSchema>) {
      const parsed = WorkbenchTerminalResizeSchema.parse(input)
      return operation(id, 'terminal_resize', parsed.actorId, { terminalId, cols: parsed.cols, rows: parsed.rows }, record => {
        assertOpen(record)
        return { terminal: structuredClone(terminals.resize(record, terminalId, parsed)) }
      })
    },
    stopTerminal(id: string, terminalId: string, actorId: string) {
      return operation(id, 'terminal_stop', actorId, { terminalId }, async record => ({ terminal: structuredClone(await terminals.stop(record, terminalId)) }))
    },
    review(id: string, actorId: string) {
      return operation(id, 'review', actorId, {}, record => {
        assertStopped(record)
        assertTool('fs_read')
        const before = files.base(id)
        const target = files.capture(id)
        files.assertWritableChanges(before, target)
        const changes = files.describe(id, before, target)
        const review = { id: randomUUID(), workbenchId: id, revision: record.revision, createdAt: time(), target }
        writeWorkbenchJson(join(storage.location(id), 'review.json'), review)
        record.status = 'reviewing'; record.reviewId = review.id; save(record)
        const summary: WorkbenchReview = { id: review.id, workbenchId: id, revision: review.revision, createdAt: review.createdAt, changes }
        return { review: summary, workbench: publicWorkbench(record) }
      })
    },
    apply(id: string, input: z.infer<typeof WorkbenchApplySchema>) {
      const parsed = WorkbenchApplySchema.parse(input)
      return operation(id, 'apply', parsed.actorId, { reviewId: parsed.reviewId }, async record => {
        assertStopped(record)
        assertTool('fs_write')
        if (record.status !== 'reviewing' || record.reviewId !== parsed.reviewId) throw new WorkbenchError('Review is stale; review the current working copy before applying')
        const review = reviewStorageSchema.parse(JSON.parse(readFileSync(join(storage.location(id), 'review.json'), 'utf8')))
        const target = files.capture(id)
        if (review.revision !== record.revision || changedPaths(review.target, target).length) throw new WorkbenchError('Working files changed after review')
        const before = files.base(id)
        files.assertWritableChanges(before, target)
        try {
          const checkpoint = await options.history.promote({ sessionId: record.chatId, stageId: id, tool: 'workbench_apply', roots: [options.sourceRoot] },
            before, target, hash => files.object(id, hash), () => { record.status = 'applying'; save(record) })
          record.status = 'applied'; save(record); purge(record)
          return { workbench: publicWorkbench(record), checkpoint }
        } catch (error) {
          if ((record.status as string) === 'applying') { record.status = 'apply_uncertain'; record.reviewId = null; save(record) }
          if (error instanceof Error && error.message.startsWith('Promotion conflict:')) throw new WorkbenchError('Workspace changed since this workbench was created; staged changes were retained')
          throw error
        }
      })
    },
    discard(id: string, actorId: string) {
      return operation(id, 'discard', actorId, {}, record => {
        if (CLOSED.has(record.status)) return { workbench: publicWorkbench(record) }
        if (terminals.isRunning(record) || record.status === 'applying' || record.status === 'apply_uncertain') throw new WorkbenchError('Resolve running terminals or uncertain publication before discarding')
        record.status = 'discarded'; record.reviewId = null; record.revision++; save(record); purge(record)
        return { workbench: publicWorkbench(record) }
      })
    },
    recover(id: string) {
      return operation(id, 'recover_apply', 'workspace-setup', {}, async record => {
        if (!['apply_uncertain', 'applying'].includes(record.status)) throw new WorkbenchError('Only uncertain publication needs setup recovery')
        if (terminals.isRunning(record)) throw new WorkbenchError('Stop terminals before recovery')
        if ((await options.history.list()).some(checkpoint => checkpoint.stageId === id && checkpoint.status === 'pending')) throw new WorkbenchError('Recover the pending file-history checkpoint before reconciling this workbench')
        const review = reviewStorageSchema.parse(JSON.parse(readFileSync(join(storage.location(id), 'review.json'), 'utf8')))
        const before = files.base(id), current = files.current(id), paths = changedPaths(before, review.target)
        function matches(expected: typeof before): boolean {
          try { assertSnapshotMatches({ current, expected, target: expected, paths, operation: 'Promotion' }); return true }
          catch (error) { if (error instanceof Error && error.message.startsWith('Promotion conflict:')) return false; throw error }
        }
        if (matches(review.target)) { record.status = 'applied'; record.reviewId = null; save(record); purge(record) }
        else if (matches(before)) { record.status = 'open'; record.reviewId = null; record.revision++; save(record) }
        else throw new WorkbenchError('Publication is partial or conflicts with later edits; inspect file history and restore before reconciling')
        return { workbench: publicWorkbench(record) }
      })
    },
    async policyChanged() {
      await own()
      for (const record of records.values()) {
        await terminals.stopAll(record)
        if (!CLOSED.has(record.status) && record.status !== 'apply_uncertain') { record.status = 'interrupted'; record.reviewId = null; record.revision++; save(record) }
      }
    },
    /** Stops terminals and releases workbench ownership. */
    async close() {
      for (const record of records.values()) await terminals.stopAll(record)
      await storage.close()
    },
  }
}
export type WorkbenchManager = ReturnType<typeof createWorkbenchManager>

// A result record written after the work already happened cannot stop it; the failure is logged.
function reportAuditFailure(error: unknown): void {
  logger.error('Workbench audit record failed', { error })
}
