/** Ranked low to high. `BUCKLE-D14`: only `local` and above decide for longer than the call. */
export const ASSURANCE_ORDER = ['relayed', 'local', 'key', 'idp'] as const
export type Assurance = (typeof ASSURANCE_ORDER)[number]

/** The routes core holds; each is its own kind, and no configured backend may take its id. */
export const BUILT_IN_SOURCES = ['terminal', 'cli', 'forms', 'http-forms', 'devices', 'judge', 'sealed'] as const
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
  /** Form answers over HTTP MCP, which anything holding the agent's token can send. */
  'http-forms': { id: 'http-forms', kind: 'http-forms' },
  /** A decision a person's enrolled key signed, on the setup route. */
  devices: { id: 'devices', kind: 'devices' },
  /** `--approve-if-safe`: the decision AI's thorough stage, for one call. */
  judge: { id: 'judge', kind: 'judge' },
  /** The decision in the envelope the setup route opens: it only denies. */
  sealed: { id: 'sealed', kind: 'sealed' },
} as const satisfies Record<string, ApprovalSource>

/** The source each MCP face's form answers come in under. */
export const FORMS_SOURCES = { stdio: SOURCES.forms, http: SOURCES['http-forms'] } as const satisfies Record<string, ApprovalSource>
export type FormsFace = keyof typeof FORMS_SOURCES
