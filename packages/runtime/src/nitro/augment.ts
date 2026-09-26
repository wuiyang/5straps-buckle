// Type-only augmentation; importing @5straps/runtime/nitro applies it. Verified against nitro 3.0.260903-beta and h3 2.0.1-rc.32.
import type { CliCallOptions } from '../interaction/hook.js'
import type { CliOutcome, CliRequest, RequestCli } from '../interaction/types.js'
import type { RuntimeOwner } from '../lifecycle/owner.js'
import type { Logger } from '../logger/types.js'
import type { OperationScope } from '../scope/als.js'
import type { RuntimeServices } from './host.js'

declare module 'nitro/types' {
  interface NitroRuntimeHooks {
    // The one interactive listener must be async and call respond exactly once; options.signal aborts when the caller settles.
    'cli:call': (request: CliRequest, respond: (outcome: CliOutcome) => void, options?: CliCallOptions) => Promise<void>
  }
}

declare module 'h3' {
  // Optional on purpose: a failed request hook leaves them unset and guards must fail closed.
  interface H3EventContext {
    runtime?: RuntimeOwner
    services?: RuntimeServices
    requestCli?: RequestCli
    logger?: Logger
    scope?: OperationScope
  }
}

export {}
