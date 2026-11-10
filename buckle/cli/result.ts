import type { JudgeAudit } from '../common/types/ports/action-log.js'

export interface CliResult {
  exitCode: number
  /**
   * Workspace: For the audit entry: what changed, never a token or a variable's value.
   * Keys: For the audit entry: the verb and the key's fingerprint, never the key.
   * Policy: For the audit entry: the tool a switch names. Other policy arguments stay out of the log.
   */
  detail?: string
  /** For the command's audit entry: what the decision AI said at the owner's request (D91). */
  judge?: JudgeAudit
  /** For the command's audit entry: the decision applied though its grant did not save, so an exit of 5 still reads ok. */
  applied?: true
}
