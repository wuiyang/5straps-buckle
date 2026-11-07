/** The routes core holds; each is its own kind. */
export const BUILT_IN_SOURCES = ['terminal', 'cli', 'forms', 'devices', 'judge'] as const
export type BuiltInSource = (typeof BUILT_IN_SOURCES)[number]
/** A configured backend's kind is always `backend`. */
export type SourceKind = BuiltInSource | 'backend'

/**
 * Where an answer came from, as core records it: the decision guard rates the kind (rightsOf), never the id's spelling
 * nor a rating the route hands in.
 */
export interface ApprovalSource {
  readonly id: string
  readonly kind: SourceKind
}

export const SOURCES = {
  /** The serve terminal and the one-shot prompt: a person at the node. */
  terminal: { id: 'terminal', kind: 'terminal' },
  /** `buckle approve` and `buckle approvals --watch`: a person at the node. */
  cli: { id: 'cli', kind: 'cli' },
  /** A stdio MCP host's form answers. */
  forms: { id: 'forms', kind: 'forms' },
  /** A decision a person's enrolled key signed, on the setup route. */
  devices: { id: 'devices', kind: 'devices' },
  /** `--approve-if-safe`: the decision AI's thorough stage, for one call. */
  judge: { id: 'judge', kind: 'judge' },
  /** The decision in the envelope the setup route opens: a backend that only denies. */
  sealed: { id: 'sealed', kind: 'backend' },
} as const satisfies Record<string, ApprovalSource>
