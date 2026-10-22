import type { LogEvent } from '@5straps/runtime'
import { printable } from '../domain/approval-instruction.js'
import { localTime } from '../domain/local-time.js'

/**
 * One log event as the lines a person reads at a terminal (the CLI display slice, C1): `22:22:00 [info] message`, in
 * this device's local time, with the text escaped as every rendering of agent-reachable text is. The JSON line a
 * machine reads is the event itself, unchanged.
 */
export function renderEvent(event: LogEvent): string[] {
  return [`${localTime(new Date(event.timestamp))} [${event.level}] ${printable(event.message)}`]
}
