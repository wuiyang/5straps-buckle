import type { NitroApp, NitroRuntimeHooks } from 'nitro/types'
import { RuntimeError } from '../errors.js'
import { CliListenerUnavailableError, createHookRequestCli, type CliCallOptions, type CliRespond, type HookRequestCliOptions } from '../interaction/hook.js'
import type { CliRequest, RequestCli } from '../interaction/types.js'
import type { Logger } from '../logger/types.js'
import { NitroErrorCode, useHost } from './host.js'

type CliCallListener = NitroRuntimeHooks['cli:call']
type Warn = Logger['warn']

// The one interactive listener lives in this slot, not in the hook list: only it receives the
// respond that settles a request. Raw hooks.hook('cli:call') listeners are observers.
const CLI_LISTENER_SLOT = Symbol.for('@5straps/runtime/cli-listener')
interface ListenerEntry {
  listener: CliCallListener
  // Settles each request the listener still holds when it is removed.
  inFlight: Set<() => void>
}
type ListenerSlot = { [CLI_LISTENER_SLOT]?: ListenerEntry }

export function registerCliListener(nitroApp: NitroApp, listener: CliCallListener): () => void {
  if (!nitroApp.hooks) throw new RuntimeError(NitroErrorCode.hooksUnavailable, 'This Nitro app has no runtime hooks; add the runtime context plugin to the build')
  const slot = nitroApp as NitroApp & ListenerSlot
  if (slot[CLI_LISTENER_SLOT]) throw new RuntimeError(NitroErrorCode.cliListenerRegistered, 'A cli:call listener is already registered; exactly one interactive consumer is allowed')
  const entry: ListenerEntry = { listener, inFlight: new Set() }
  slot[CLI_LISTENER_SLOT] = entry
  return () => {
    if (slot[CLI_LISTENER_SLOT] !== entry) return
    delete slot[CLI_LISTENER_SLOT]
    for (const release of [...entry.inFlight]) release()
  }
}

export interface RequestCliOptions extends Pick<HookRequestCliOptions, 'onUnavailable'> {
  // Observer warnings go to the bound host's logger; this one takes them until a host is bound.
  logger?: Pick<Logger, 'warn'>
}

export function createRequestCli(nitroApp: NitroApp, options: RequestCliOptions = {}): RequestCli {
  const warn = warnFor(nitroApp, options.logger)
  return createHookRequestCli({
    // Observers also hear of a request no listener could take, before its durable write.
    onUnavailable: (request, reason) => {
      if (reason === 'no_listener') notifyObservers({ nitroApp, request, warn, callOptions: { signal: AbortSignal.abort(reason) } })
      return options.onUnavailable?.(request, reason) ?? Promise.resolve(undefined)
    },
    hasListener: () => registeredEntry(nitroApp) !== undefined,
    dispatch: (request, respond, callOptions) => dispatchToListener({ nitroApp, request, respond, callOptions, warn }),
  })
}

function registeredEntry(nitroApp: NitroApp): ListenerEntry | undefined {
  return nitroApp.hooks ? (nitroApp as NitroApp & ListenerSlot)[CLI_LISTENER_SLOT] : undefined
}

function dispatchToListener(input: { nitroApp: NitroApp; request: CliRequest; respond: CliRespond; callOptions?: CliCallOptions; warn: Warn }): Promise<void> {
  const entry = registeredEntry(input.nitroApp)
  if (!entry) return Promise.reject(new CliListenerUnavailableError('no_listener', `The cli:call listener was removed before request ${input.request.id} was dispatched`))
  notifyObservers(input)
  return runListener({ entry, ...input })
}

// Removing the listener leaves the request unavailable (queued durably by onUnavailable), never pending forever.
function runListener(input: { entry: ListenerEntry; request: CliRequest; respond: CliRespond; callOptions?: CliCallOptions }): Promise<void> {
  const removed = Promise.withResolvers<never>()
  const release = () => removed.reject(new CliListenerUnavailableError('closed', `The cli:call listener was removed while request ${input.request.id} waited`))
  input.entry.inFlight.add(release)
  const answered = Promise.resolve().then(() => input.entry.listener(input.request, input.respond, input.callOptions))
  return Promise.race([answered, removed.promise]).finally(() => input.entry.inFlight.delete(release))
}

// Observers see a frozen copy of the request and the settle signal, never the real respond: they can neither
// answer, fail nor rewrite it. They run through hookable's public callHook, which calls them in series and stops
// at the first failure; the listener never waits for them, so none can delay or change the answer.
function notifyObservers(input: { nitroApp: NitroApp; request: CliRequest; callOptions?: CliCallOptions; warn: Warn }): void {
  const { nitroApp, request, warn } = input
  const hooks = nitroApp.hooks
  if (!hooks) return
  const observed = deepFreeze(structuredClone(request))
  let ignoredLogged = false
  const ignoredRespond: CliRespond = () => {
    if (ignoredLogged) return
    ignoredLogged = true
    warn('cli:call observer response ignored', { requestId: request.id })
  }
  Promise.resolve()
    .then(() => hooks.callHook('cli:call', observed, ignoredRespond, input.callOptions))
    .catch((error: unknown) => warn('cli:call observer failed', { requestId: request.id, error }))
}

// The host's logger once main binds it; before that the caller's, or a process warning, so nothing is dropped.
function warnFor(nitroApp: NitroApp, fallback: Pick<Logger, 'warn'> | undefined): Warn {
  return (message, fields) => {
    const logger = useHost(nitroApp)?.logger ?? fallback
    if (logger) logger.warn(message, fields)
    else process.emitWarning(`${message} (request ${String(fields?.requestId)})`, { code: 'CLI_CALL_OBSERVER' })
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
