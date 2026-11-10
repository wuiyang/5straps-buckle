import type { JudgeAudit } from '../common/types/ports/action-log.js'

export interface CliResult {
  exitCode: number
  detail?: string
  /** For the command's audit entry: what the decision AI said at the owner's request (D91). */
  judge?: JudgeAudit
  /** For the command's audit entry: the decision applied though its grant did not save, so an exit of 5 still reads ok. */
  applied?: true
}
