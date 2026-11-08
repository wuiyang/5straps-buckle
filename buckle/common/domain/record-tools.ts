/** The tool of each approval decision's entries. */
export const DECISION_TOOL = 'approval_decision'

/** The owner's own changes: CLI commands, setup and registry changes, and the dangerously-allow switch. */
const OWNER_TOOLS = /^(?:cli|setup|workspace|policy)_/

/** What an agent's call left without its result may have done: anything. */
const CALL_INTERRUPTED = 'Owner process stopped before recording an outcome; effects are unknown'

/** A decision or the owner's own change applied, or not, in state Buckle keeps, so its reader is sent there. */
const INTERRUPTED_DETAILS: ReadonlyArray<{ tools: RegExp; detail: string }> = [
  { tools: new RegExp(`^${DECISION_TOOL}$`), detail: 'Owner process stopped before recording the decision\'s outcome; the approvals ledger holds what applied' },
  { tools: OWNER_TOOLS, detail: 'Owner process stopped before recording the change\'s outcome; the grants, settings, or registry it changed hold what applied' },
]

/** The detail of the interrupted result recovery writes for an attempt of this tool whose own result never landed. */
export function interruptedDetail(tool: string): string {
  return INTERRUPTED_DETAILS.find(row => row.tools.test(tool))?.detail ?? CALL_INTERRUPTED
}
