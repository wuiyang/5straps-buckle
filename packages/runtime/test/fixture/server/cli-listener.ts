import type { RequestCli } from '@5straps/runtime'
import { registerCliListener } from '@5straps/runtime/nitro'
import type { NitroApp, NitroRuntimeHooks } from 'nitro/types'

// Test-only listener behaviours for F08 to F10; 'terminal' is the real wiring.
export type CliListenerMode = 'terminal' | 'off' | 'double' | 'silent' | 'reject'

type Listener = NitroRuntimeHooks['cli:call']

// Registers the one cli:call listener and the cli:cancel companion that withdraws an abandoned prompt.
export function wireCliListener(input: { nitroApp: NitroApp; requestCli: RequestCli; mode: CliListenerMode }): () => void {
  if (input.mode === 'off') return () => {}
  const inFlight = new Map<string, AbortController>()
  const unregister = registerCliListener(input.nitroApp, listenerFor({ mode: input.mode, requestCli: input.requestCli, inFlight }))
  const unhookCancel = input.nitroApp.hooks!.hook('cli:cancel', (requestId) => { inFlight.get(requestId)?.abort('HTTP caller went away') })
  return () => {
    unhookCancel()
    unregister()
  }
}

function listenerFor(input: { mode: Exclude<CliListenerMode, 'off'>; requestCli: RequestCli; inFlight: Map<string, AbortController> }): Listener {
  if (input.mode === 'silent') return async () => {}
  if (input.mode === 'reject') return async () => { throw new Error('Injected cli:call listener failure') }
  return async (request, respond) => {
    const controller = new AbortController()
    input.inFlight.set(request.id, controller)
    try {
      const outcome = await input.requestCli(request, { signal: controller.signal })
      respond(outcome)
      if (input.mode === 'double') respond({ status: 'denied', requestId: request.id, reason: 'second respond must be ignored' })
    } finally {
      input.inFlight.delete(request.id)
    }
  }
}
