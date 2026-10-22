import { createCliConsumerSlot, createCliRequester, type CliConsumerSlot, type RequestCli } from '@5straps/runtime'
import { approvalPending, nodeApprovalPending } from '../common/services/approvals/interaction.js'
import { createTerminalConsumer, interruptSelf, type TerminalConsumer, type TerminalOptions } from './terminal-consumer.js'

export interface CliSetup {
  /** The process's one requester: questions queue here and reach the terminal one at a time. */
  readonly requestCli: RequestCli
  /** Holds the terminal consumer; a second one is refused. */
  readonly slot: CliConsumerSlot
  /** Settles every question still waiting as unavailable; the asks stay in the durable queue. */
  close(): Promise<void>
}

/**
 * Main owns this (nitro/coordination.md): one requester per process, with the terminal attached only
 * when there is one. Under `buckle mcp` stdin carries the protocol, so no terminal is attached there.
 * `logPending`: a node logs each question nobody can be asked (C5); a one-shot command relays the ask itself.
 */
export function setupCli(input: { terminal: TerminalOptions | null; logPending?: boolean }): CliSetup {
  const slot = createCliConsumerSlot()
  let consumer: TerminalConsumer | undefined
  if (input.terminal) {
    const { onInterrupt = () => interruptSelf() } = input.terminal
    // Ctrl-C detaches the terminal first, which drops every queued question, then stops the process.
    const terminal = createTerminalConsumer({ ...input.terminal, onInterrupt: () => { detach(); onInterrupt() } })
    const detach = slot.attach(terminal)
    consumer = terminal
  }
  const requester = createCliRequester({ slot, onUnavailable: input.logPending ? nodeApprovalPending : approvalPending })
  // A question still on screen as the process stops says so on its row (the CLI display slice, C4).
  return { requestCli: requester.requestCli, slot, close: () => { consumer?.stopping(); return requester.close() } }
}
