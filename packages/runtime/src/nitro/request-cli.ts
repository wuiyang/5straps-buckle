import type { NitroApp, NitroRuntimeHooks } from 'nitro/types'
import { RuntimeError } from '../errors.js'
import { createHookRequestCli, type CliCallOptions, type CliRespond, type HookRequestCliOptions } from '../interaction/hook.js'
import type { CliRequest, RequestCli } from '../interaction/types.js'
import { NitroErrorCode, useHost } from './host.js'

type CliCallListener = NitroRuntimeHooks['cli:call']

// The one interactive listener lives in this slot, not in the hook list: only it receives the
// respond that settles a request. Raw hooks.hook('cli:call') listeners are observers.
const CLI_LISTENER_SLOT = Symbol.for('@5straps/runtime/cli-listener')
type ListenerSlot = { [CLI_LISTENER_SLOT]?: CliCallListener }

export function registerCliListener(nitroApp: NitroApp, listener: CliCallListener): () => void {
  if (!nitroApp.hooks) throw new RuntimeError(NitroErrorCode.hooksUnavailable, 'This Nitro app has no runtime hooks; add the runtime context plugin to the build')
  const slot = nitroApp as NitroApp & ListenerSlot
  if (slot[CLI_LISTENER_SLOT]) throw new RuntimeError(NitroErrorCode.cliListenerRegistered, 'A cli:call listener is already registered; exactly one interactive consumer is allowed')
  slot[CLI_LISTENER_SLOT] = listener
  return () => { if (slot[CLI_LISTENER_SLOT] === listener) delete slot[CLI_LISTENER_SLOT] }
}

export function createRequestCli(nitroApp: NitroApp, options: Pick<HookRequestCliOptions, 'onUnavailable'> = {}): RequestCli {
  return createHookRequestCli({
    ...options,
    hasListener: () => registeredListener(nitroApp) !== undefined,
    dispatch: (request, respond, callOptions) => dispatchToListener({ nitroApp, request, respond, callOptions }),
  })
}

function registeredListener(nitroApp: NitroApp): CliCallListener | undefined {
  return nitroApp.hooks ? (nitroApp as NitroApp & ListenerSlot)[CLI_LISTENER_SLOT] : undefined
}

function dispatchToListener(input: { nitroApp: NitroApp; request: CliRequest; respond: CliRespond; callOptions?: CliCallOptions }): Promise<void> {
  const listener = registeredListener(input.nitroApp)
  if (!listener) return Promise.reject(new RuntimeError(NitroErrorCode.cliListenerMissing, `The cli:call listener was removed before request ${input.request.id} was dispatched`))
  notifyObservers(input)
  return listener(input.request, input.respond, input.callOptions)
}

// Observers see the request and the settle signal, never the real respond: they can neither answer nor fail it.
function notifyObservers(input: { nitroApp: NitroApp; request: CliRequest; callOptions?: CliCallOptions }): void {
  const { nitroApp, request } = input
  let ignoredLogged = false
  const ignoredRespond: CliRespond = () => {
    if (ignoredLogged) return
    ignoredLogged = true
    useHost(nitroApp)?.logger.warn('cli:call observer response ignored', { requestId: request.id })
  }
  Promise.resolve()
    .then(() => nitroApp.hooks?.callHook('cli:call', request, ignoredRespond, input.callOptions))
    .catch((error: unknown) => useHost(nitroApp)?.logger.warn('cli:call observer failed', { requestId: request.id, error }))
}
