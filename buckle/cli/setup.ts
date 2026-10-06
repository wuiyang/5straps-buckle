import { createCliConsumerSlot, createCliRequester, type CliConsumerSlot, type RequestCli } from '@5straps/runtime'
import { approvalPending } from '../common/services/approvals/interaction.js'
import { createTerminalConsumer, interruptSelf, type TerminalOptions } from './terminal-consumer.js'

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
 */
export function setupCli(input: { terminal: TerminalOptions | null }): CliSetup {
  const slot = createCliConsumerSlot()
  if (input.terminal) {
    const { onInterrupt = () => interruptSelf() } = input.terminal
    // Ctrl-C detaches the terminal first, which drops every queued question, then stops the process.
    const detach = slot.attach(createTerminalConsumer({ ...input.terminal, onInterrupt: () => { detach(); onInterrupt() } }))
  }
  const requester = createCliRequester({ slot, onUnavailable: approvalPending })
  return { requestCli: requester.requestCli, slot, close: () => requester.close() }
}
