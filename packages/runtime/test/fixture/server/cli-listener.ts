import type { RequestCli } from '@5straps/runtime'
import { registerCliListener } from '@5straps/runtime/nitro'
import type { NitroApp, NitroRuntimeHooks } from 'nitro/types'

// Test-only listener behaviours for F08 to F10; 'terminal' is the real wiring.
export type CliListenerMode = 'terminal' | 'off' | 'double' | 'silent' | 'reject'

type Listener = NitroRuntimeHooks['cli:call']

// Registers the one cli:call listener. Its signal aborts when the HTTP caller settles (answer,
// timeout or abort), which withdraws the terminal prompt through the requester.
export function wireCliListener(input: { nitroApp: NitroApp; requestCli: RequestCli; mode: CliListenerMode }): () => void {
  if (input.mode === 'off') return () => {}
  return registerCliListener(input.nitroApp, listenerFor({ mode: input.mode, requestCli: input.requestCli }))
}

function listenerFor(input: { mode: Exclude<CliListenerMode, 'off'>; requestCli: RequestCli }): Listener {
  if (input.mode === 'silent') return async () => {}
  if (input.mode === 'reject') return async () => { throw new Error('Injected cli:call listener failure') }
  return async (request, respond, options) => {
    respond(await input.requestCli(request, { signal: options?.signal }))
    if (input.mode === 'double') respond({ status: 'denied', requestId: request.id, reason: 'second respond must be ignored' })
  }
}

// Test-only (FIXTURE_CLI_OBSERVER=respond): a raw hook observer that tries to deny every request.
// Registered before the listener so it would win if observers could answer.
export function wireRespondingObserver(nitroApp: NitroApp): () => void {
  if (!nitroApp.hooks) throw new TypeError('The fixture build has no runtime hooks')
  return nitroApp.hooks.hook('cli:call', async (request, respond) => {
    respond({ status: 'denied', requestId: request.id, reason: 'observers must not answer' })
  })
}
