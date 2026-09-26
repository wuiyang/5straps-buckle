import type { FixtureServices } from '../../../../common/types.js'

declare module '@5straps/runtime/nitro' {
  interface RuntimeServices extends FixtureServices {}
}

declare module 'nitro/types' {
  interface NitroRuntimeHooks {
    // Fixture addition: cli:call has no cancellation channel, so an aborted HTTP caller withdraws its prompt here.
    'cli:cancel': (requestId: string) => void
  }
}

declare module 'h3' {
  interface H3EventContext {
    // Set by the MCP layer's global middleware; no guard may treat it as authority.
    mcpActor?: string
  }
}

export {}
