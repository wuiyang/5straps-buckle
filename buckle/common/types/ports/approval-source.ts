/**
 * Where an answer came from. Each route that reaches the approval service names its own, and the decision guard rates
 * it (assuranceOf), never a rating the route hands in.
 */
export type ApprovalSource =
  /** The serve terminal and the one-shot prompt: a person at the node. */
  | 'terminal'
  /** `buckle approve` and `buckle approvals --watch`: a person at the node. */
  | 'cli'
  /** A stdio MCP host's form answers. */
  | 'forms'
  /** A decision a person's enrolled key signed, on the setup route. */
  | 'devices'
  /** A decision in the envelope the setup route opens, which the service lets deny alone. */
  | 'sealed'
  /** `--approve-if-safe`: the decision AI's thorough stage, for one call. */
  | 'judge'
