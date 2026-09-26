import type { NitroApp, NitroRuntimeHooks } from 'nitro/types'
import { RuntimeError } from '../errors.js'
import { createHookRequestCli } from '../interaction/hook.js'
import type { RequestCli } from '../interaction/types.js'
import { NitroErrorCode } from './host.js'

type CliCallListener = NitroRuntimeHooks['cli:call']

// hookable's callHook cannot tell "no listener" from "sync listener that never responded"
// (both return undefined), so the single interactive listener registers through here.
const CLI_LISTENER_SLOT = Symbol.for('@5straps/runtime/cli-listener')
type ListenerSlot = { [CLI_LISTENER_SLOT]?: CliCallListener }

export function registerCliListener(nitroApp: NitroApp, listener: CliCallListener): () => void {
  const hooks = nitroApp.hooks
  if (!hooks) throw new RuntimeError(NitroErrorCode.hooksUnavailable, 'This Nitro app has no runtime hooks; add the runtime context plugin to the build')
  const slot = nitroApp as NitroApp & ListenerSlot
  if (slot[CLI_LISTENER_SLOT]) throw new RuntimeError(NitroErrorCode.cliListenerRegistered, 'A cli:call listener is already registered; exactly one interactive consumer is allowed')
  slot[CLI_LISTENER_SLOT] = listener
  const unhook = hooks.hook('cli:call', listener)
  return () => {
    unhook()
    if (slot[CLI_LISTENER_SLOT] === listener) delete slot[CLI_LISTENER_SLOT]
  }
}

export function createRequestCli(nitroApp: NitroApp): RequestCli {
  return createHookRequestCli({
    hasListener: () => nitroApp.hooks !== undefined && (nitroApp as NitroApp & ListenerSlot)[CLI_LISTENER_SLOT] !== undefined,
    dispatch: (request, respond) => Promise.resolve(nitroApp.hooks?.callHook('cli:call', request, respond)),
  })
}
