import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkbenchTerminal, WorkbenchTerminalEvent, WorkbenchTerminalEvents } from '@5straps/protocol'
import type { PtyProcess, PtySpawner, PtySpawnRequest } from '../../ports/pty-process.js'
import { logger } from '../../logger.js'
import { WorkbenchError, writeWorkbenchJson, type StoredWorkbench } from './storage.js'

const OUTPUT_BYTES = 1_048_576
const LEASE_MS = 60_000
const IDLE_MS = 30 * 60_000
const LIFETIME_MS = 8 * 60 * 60_000
interface RunningTerminal {
  process: PtyProcess; output: WorkbenchTerminalEvent[]; sequence: number; bytes: number
  lastActivity: number; createdAt: number; auditId: string
  flush?: ReturnType<typeof setTimeout>; limit?: ReturnType<typeof setInterval>
}
export interface TerminalManagerOptions {
  directory: string
  spawn: PtySpawner
  save(record: StoredWorkbench): void
  audit(record: StoredWorkbench, tool: string, actorId: string, args: Record<string, string | number>, event: 'attempt' | 'result', auditId?: string, outcome?: 'ok' | 'error' | 'started' | 'interrupted'): string
  checkBudget(record: StoredWorkbench): void
  now?: () => number
}
export function createWorkbenchTerminals(options: TerminalManagerOptions) {
  const running = new Map<string, RunningTerminal>()
  const now = options.now ?? Date.now
  function find(record: StoredWorkbench, id: string): WorkbenchTerminal {
    const terminal = record.terminals.find(item => item.id === id)
    if (!terminal) throw new WorkbenchError('Terminal not found', 404)
    return terminal
  }
  function outputPath(record: StoredWorkbench, id: string): string { return join(options.directory, record.id, id + '.output.json') }
  function flush(record: StoredWorkbench, terminal: WorkbenchTerminal, state: RunningTerminal): void {
    clearTimeout(state.flush); state.flush = undefined
    writeWorkbenchJson(outputPath(record, terminal.id), state.output)
  }
  function append(record: StoredWorkbench, terminal: WorkbenchTerminal, event: Omit<WorkbenchTerminalEvent, 'sequence' | 'at'>): void {
    const state = running.get(terminal.id)
    if (!state) return
    state.output.push({ ...event, sequence: ++state.sequence, at: new Date(now()).toISOString() })
    state.bytes += Buffer.byteLength(event.data ?? '') + 128
    while (state.output.length > 4096 || state.bytes > OUTPUT_BYTES) {
      const removed = state.output.shift()
      state.bytes -= Buffer.byteLength(removed?.data ?? '') + 128
    }
    state.lastActivity = now()
    state.flush ??= setTimeout(() => {
      try { flush(record, terminal, state) } catch (error) {
        logger.error('Terminal output persistence failed', { terminalId: terminal.id, message: error instanceof Error ? error.message : 'Unknown error' })
        void stop(record, terminal.id).catch(failure => logger.error('Failed to stop terminal after output error', { terminalId: terminal.id, message: failure instanceof Error ? failure.message : 'Unknown error' }))
      }
    }, 100)
    state.flush.unref()
  }
  function requireController(terminal: WorkbenchTerminal, actorId: string, generation: number): RunningTerminal {
    if (terminal.status !== 'running' || terminal.controllerId !== actorId || terminal.generation !== generation || !terminal.leaseExpiresAt || Date.parse(terminal.leaseExpiresAt) <= now()) throw new WorkbenchError('Terminal input control expired or belongs to another user', 403)
    const state = running.get(terminal.id)
    if (!state) throw new WorkbenchError('Terminal process is unavailable', 409)
    return state
  }
  async function stop(record: StoredWorkbench, id: string): Promise<WorkbenchTerminal> {
    const terminal = find(record, id)
    const state = running.get(id)
    if (!state) return terminal
    terminal.status = 'stopping'; terminal.controllerId = null; terminal.leaseExpiresAt = null; terminal.generation++
    options.save(record)
    await state.process.stop()
    return terminal
  }
  function onExit(record: StoredWorkbench, terminal: WorkbenchTerminal, exitCode: number): void {
    const state = running.get(terminal.id)
    if (!state) return
    append(record, terminal, { type: 'exit', exitCode })
    clearInterval(state.limit)
    terminal.status = 'exited'; terminal.exitedAt = new Date(now()).toISOString(); terminal.exitCode = exitCode
    terminal.controllerId = null; terminal.leaseExpiresAt = null; terminal.generation++
    record.revision++; record.reviewId = null
    try {
      flush(record, terminal, state)
      options.save(record)
      options.audit(record, 'terminal_lifetime', 'terminal-process', { terminalId: terminal.id, exitCode }, 'result', state.auditId, 'ok')
    } catch (error) {
      logger.error('Terminal exit persistence failed', { terminalId: terminal.id, message: error instanceof Error ? error.message : 'Unknown error' })
    } finally { running.delete(terminal.id) }
  }
  return {
    find, stop,
    isRunning: (record: StoredWorkbench) => record.terminals.some(terminal => ['running', 'stopping'].includes(terminal.status)),
    async start(record: StoredWorkbench, actorId: string, request: PtySpawnRequest): Promise<WorkbenchTerminal> {
      options.checkBudget(record)
      if (record.terminals.filter(item => ['running', 'stopping'].includes(item.status)).length >= 4) throw new WorkbenchError('At most four terminals can run in one workbench')
      const terminal: WorkbenchTerminal = { id: randomUUID(), status: 'running', createdAt: new Date(now()).toISOString(), exitedAt: null, exitCode: null,
        controllerId: actorId, generation: 1, leaseExpiresAt: new Date(now() + LEASE_MS).toISOString(), cols: request.cols, rows: request.rows, lastSequence: 0 }
      const auditId = options.audit(record, 'terminal_lifetime', actorId, { terminalId: terminal.id }, 'attempt')
      let process: PtyProcess
      try { process = await options.spawn(request) }
      catch (error) { options.audit(record, 'terminal_lifetime', actorId, { terminalId: terminal.id }, 'result', auditId, 'error'); throw error }
      record.terminals.push(terminal); record.revision++; record.reviewId = null; record.status = 'open'
      const state: RunningTerminal = { process, output: [], sequence: 0, bytes: 0, lastActivity: now(), createdAt: now(), auditId }
      running.set(terminal.id, state)
      process.onData(data => {
        for (let index = 0; index < data.length; index += 16_384) append(record, terminal, { type: 'output', data: data.slice(index, index + 16_384) })
      })
      process.onExit(exitCode => onExit(record, terminal, exitCode))
      state.limit = setInterval(() => {
        try { options.checkBudget(record) } catch (error) {
          logger.error('Terminal workspace budget check failed', { terminalId: terminal.id, message: error instanceof Error ? error.message : 'Unknown error' })
          void stop(record, terminal.id).catch(failure => logger.error('Failed to stop oversized workbench terminal', { terminalId: terminal.id, message: failure instanceof Error ? failure.message : 'Unknown error' }))
          return
        }
        if (terminal.leaseExpiresAt && Date.parse(terminal.leaseExpiresAt) <= now()) {
          terminal.controllerId = null; terminal.leaseExpiresAt = null; terminal.generation++
          try { options.save(record) } catch (error) { logger.error('Terminal lease persistence failed', { terminalId: terminal.id, message: error instanceof Error ? error.message : 'Unknown error' }) }
        }
        if (now() - state.lastActivity >= IDLE_MS || now() - state.createdAt >= LIFETIME_MS) void stop(record, terminal.id).catch(error => logger.error('Terminal expiry failed', { terminalId: terminal.id, message: error instanceof Error ? error.message : 'Unknown error' }))
      }, 10_000)
      state.limit.unref()
      try { options.save(record) } catch (error) { await process.stop(); throw error }
      return terminal
    },
    control(record: StoredWorkbench, id: string, input: { actorId: string; action: 'acquire' | 'renew' | 'release' | 'handoff'; generation?: number; nextActorId?: string }): WorkbenchTerminal {
      const terminal = find(record, id)
      if (terminal.status !== 'running') throw new WorkbenchError('Terminal is not running')
      const expires = terminal.leaseExpiresAt ? Date.parse(terminal.leaseExpiresAt) : 0
      if (input.action === 'acquire' && (!terminal.controllerId || expires <= now())) {
        terminal.controllerId = input.actorId; terminal.generation++; terminal.lastSequence = 0
      } else {
        requireController(terminal, input.actorId, input.generation ?? -1)
        if (input.action === 'release') { terminal.controllerId = null; terminal.generation++; terminal.lastSequence = 0 }
        if (input.action === 'handoff') {
          if (!input.nextActorId) throw new WorkbenchError('A handoff recipient is required', 400)
          terminal.controllerId = input.nextActorId; terminal.generation++; terminal.lastSequence = 0
        }
      }
      terminal.leaseExpiresAt = terminal.controllerId ? new Date(now() + LEASE_MS).toISOString() : null
      options.save(record)
      return terminal
    },
    input(record: StoredWorkbench, id: string, input: { actorId: string; generation: number; sequence: number; data: string }): WorkbenchTerminal {
      const terminal = find(record, id)
      const state = requireController(terminal, input.actorId, input.generation)
      if (input.sequence <= terminal.lastSequence) return terminal
      if (input.sequence !== terminal.lastSequence + 1) throw new WorkbenchError('Terminal input sequence has a gap')
      // Persist admission first: a network retry must never type the same command twice.
      terminal.lastSequence = input.sequence; options.save(record)
      state.process.write(input.data); state.lastActivity = now()
      return terminal
    },
    resize(record: StoredWorkbench, id: string, input: { actorId: string; generation: number; cols: number; rows: number }): WorkbenchTerminal {
      const terminal = find(record, id)
      requireController(terminal, input.actorId, input.generation).process.resize(input.cols, input.rows)
      terminal.cols = input.cols; terminal.rows = input.rows; options.save(record)
      return terminal
    },
    events(record: StoredWorkbench, id: string, after: number): WorkbenchTerminalEvents {
      const terminal = find(record, id)
      const state = running.get(id)
      const source: WorkbenchTerminalEvent[] = state?.output ?? (existsSync(outputPath(record, id)) ? JSON.parse(readFileSync(outputPath(record, id), 'utf8')) as WorkbenchTerminalEvent[] : [])
      const events: WorkbenchTerminalEvent[] = []
      let bytes = 0
      for (const event of source) {
        if (event.sequence <= after) continue
        const size = Buffer.byteLength(event.data ?? '') + 128
        if (bytes + size > 262_144 || events.length >= 200) break
        events.push(event); bytes += size
      }
      return { events, nextSequence: events.at(-1)?.sequence ?? after, truncated: Boolean(source[0] && source[0].sequence > after + 1), terminal: structuredClone(terminal) }
    },
    async stopAll(record: StoredWorkbench) {
      await Promise.all(record.terminals.map(terminal => stop(record, terminal.id)))
    },
  }
}
export type WorkbenchTerminals = ReturnType<typeof createWorkbenchTerminals>
