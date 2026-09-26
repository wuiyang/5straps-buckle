import { createCliConsumerSlot, createCliRequester, isRuntimeError, type CliRequester } from '@5straps/runtime'
import type { FixtureRuntime } from '../common/runtime.js'
import { connectTerminal } from './terminal.js'

export interface CliAdapter {
  requester: CliRequester
}

// Owns the interactive terminal slot and the requester queue main injects into HTTP and MCP.
export async function setupCli(input: { runtime: FixtureRuntime; terminalPath?: string; secondTerminalPath?: string }): Promise<CliAdapter> {
  const { runtime } = input
  const slot = createCliConsumerSlot()
  const requester = createCliRequester({
    slot,
    onUnavailable: async request => (await runtime.services.getApprovals()).persist(request),
  })
  runtime.onClose('waiters', 'cli requester', () => requester.close())
  for (const path of [input.terminalPath, input.secondTerminalPath]) {
    if (path) await attachTerminal({ runtime, slot, path })
  }
  return { requester }
}

async function attachTerminal(input: { runtime: FixtureRuntime; slot: ReturnType<typeof createCliConsumerSlot>; path: string }): Promise<void> {
  const terminal = await connectTerminal(input.path)
  try {
    const detach = input.slot.attach(terminal.consumer)
    terminal.onDisconnect(() => {
      input.runtime.logger.info('terminal detached', { path: input.path })
      detach()
    })
    input.runtime.onClose('waiters', 'terminal', () => terminal.close())
    input.runtime.logger.info('terminal attached', { path: input.path })
  } catch (error) {
    // F11: exactly one interactive consumer; a second terminal is refused, not raced.
    if (!isRuntimeError(error)) throw error
    input.runtime.logger.warn('terminal refused', { path: input.path, code: error.code })
    await terminal.close()
  }
}
