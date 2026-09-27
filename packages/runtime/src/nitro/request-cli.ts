import type { NitroApp, NitroRuntimeHooks } from 'nitro/types'
import { RuntimeError } from '../errors.js'
import { CliListenerUnavailableError, createHookRequestCli, type CliCallOptions, type CliRespond, type HookRequestCliOptions } from '../interaction/hook.js'
import type { CliRequest, RequestCli } from '../interaction/types.js'
import { NitroErrorCode, useHost } from './host.js'

type CliCallListener = NitroRuntimeHooks['cli:call']
type CliCallHooks = NonNullable<NitroApp['hooks']>

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

export function createRequestCli(nitroApp: NitroApp, options: Pick<HookRequestCliOptions, 'onUnavailable'> = {}): RequestCli {
  return createHookRequestCli({
    ...options,
    hasListener: () => registeredEntry(nitroApp) !== undefined,
    dispatch: (request, respond, callOptions) => dispatchToListener({ nitroApp, request, respond, callOptions }),
  })
}

function registeredEntry(nitroApp: NitroApp): ListenerEntry | undefined {
  return nitroApp.hooks ? (nitroApp as NitroApp & ListenerSlot)[CLI_LISTENER_SLOT] : undefined
}

function dispatchToListener(input: { nitroApp: NitroApp; request: CliRequest; respond: CliRespond; callOptions?: CliCallOptions }): Promise<void> {
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
// answer, fail nor rewrite it. Each runs on its own, so one that throws or hangs never silences the rest.
function notifyObservers(input: { nitroApp: NitroApp; request: CliRequest; callOptions?: CliCallOptions }): void {
  const { nitroApp, request } = input
  const hooks = nitroApp.hooks
  if (!hooks) return
  const observed = deepFreeze(structuredClone(request))
  let ignoredLogged = false
  const ignoredRespond: CliRespond = () => {
    if (ignoredLogged) return
    ignoredLogged = true
    useHost(nitroApp)?.logger.warn('cli:call observer response ignored', { requestId: request.id })
  }
  for (const observer of cliCallObservers(hooks)) {
    Promise.resolve()
      .then(() => observer(observed, ignoredRespond, input.callOptions))
      .catch((error: unknown) => useHost(nitroApp)?.logger.warn('cli:call observer failed', { requestId: request.id, error }))
  }
}

// Nitro's HookableCore only calls a hook's listeners in series and stops at the first failure, so the
// observers are read from its listener table (protected in hookable 6.1.1's types, a plain field at run time).
function cliCallObservers(hooks: CliCallHooks): CliCallListener[] {
  const table = (hooks as unknown as { _hooks: Record<string, CliCallListener[] | undefined> })._hooks
  return [...(table['cli:call'] ?? [])]
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
