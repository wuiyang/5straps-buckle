import { createLogQueue, settleWithin, type LogDropNotice, type LogFields, type LogQueue, type LogQueueOptions } from '@5straps/runtime'
import { PROCESS_LOG_QUEUE } from '../../runtime/log-budget.js'
import type { ActionLogEntry } from '../../types/ports/action-log.js'
import type { LogDestination, LogService } from '../../types/ports/log-service.js'

/** How each log's queue holds and retries its entries: under the process's one budget unless a test hands in its own. */
export type LogQueueSettings = Pick<LogQueueOptions<ActionLogEntry>, 'retryDelaysMs' | 'writeDeadlineMs' | 'maxBatch'> & Required<Pick<LogQueueOptions<ActionLogEntry>, 'budget'>>

/** `writing`: the log's last write handed to its destination. */
interface HeldLog { queue: LogQueue<ActionLogEntry>; destination: LogDestination; writing?: Promise<void> }

let processService: LogService | undefined

/** The service every action log of this process hands its unawaited entries to. */
export function logService(): LogService {
  processService ??= createLogService()
  return processService
}

/** A close step of the process: its queued entries get until the deadline. */
export function closeLogService(options: { deadlineMs: number }): Promise<{ left: number }> {
  return processService ? processService.close(options) : Promise.resolve({ left: 0 })
}

export function createLogService(settings: LogQueueSettings = PROCESS_LOG_QUEUE): LogService {
  const logs = new Map<string, HeldLog>()

  function heldFor(destination: LogDestination): HeldLog {
    const known = logs.get(destination.name)
    if (known) {
      known.destination = destination
      return known
    }
    const opened: HeldLog = {
      destination,
      queue: createLogQueue<ActionLogEntry>({
        ...settings,
        destination: destination.name,
        write: batch => (opened.writing = opened.destination.write(batch)),
        summarize: drops => opened.destination.dropped(drops),
        onDropping: warnDropping,
      }),
    }
    logs.set(destination.name, opened)
    return opened
  }

  return {
    append: (destination, entry, options) => heldFor(destination).queue.push(entry, { expendable: options?.untrusted === true }),
    async flush() {
      await Promise.all([...logs.values()].map(({ queue }) => queue.flush()))
    },
    // Taken out first, so an entry appended while they close starts a queue of its own instead of dropping.
    async close({ deadlineMs }) {
      const closing = [...logs.values()]
      logs.clear()
      const results = await Promise.all(closing.map(({ queue }) => queue.close({ deadlineMs })))
      const left = results.reduce((sum, result) => sum + result.left, 0)
      if (left > 0) warnOnStderr('Audit log entries left unwritten at close', { left })
      return { left }
    },
    async discard(name) {
      const held = logs.get(name)
      if (!held) return
      logs.delete(name)
      await held.queue.close({ deadlineMs: 0 })
      if (held.writing) await settleWithin([held.writing], settings.writeDeadlineMs ?? 0)
    },
    release(name) {
      const held = logs.get(name)
      if (!held) return
      // In the background: a stalled log drains on its own time, and an entry appended meanwhile keeps the queue.
      void held.queue.flush().then(() => {
        if (logs.get(name) !== held || held.queue.stats().held > 0) return
        logs.delete(name)
        return held.queue.close()
      })
    },
    stats: () => ({ held: settings.budget.held(), logs: Object.fromEntries([...logs].map(([name, { queue }]) => [name, queue.stats()])) }),
  }
}

function warnDropping(notice: LogDropNotice): void {
  warnOnStderr('Audit log entries dropped', { ...notice })
}

// On stderr at once, as the node logger's own drop warning is: the logger shares the budget that is full.
function warnOnStderr(message: string, fields: LogFields): void {
  try {
    process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: 'warn', component: 'buckle', message, fields })}\n`)
  } catch {
    // stderr itself is gone; nothing is left to report to.
  }
}
