/** The tool of each approval decision's entries. */
export const DECISION_TOOL = 'approval_decision'

/** The tool of the entry that says how many of a log's entries were dropped unwritten, and over what time. */
export const LOG_DROPPED_TOOL = 'log_dropped'

/** The owner's own changes (CLI commands, setup and registry changes, and the dangerously-allow switch), and the switch's uses. */
const OWNER_TOOLS = /^(?:cli|setup|workspace|policy)_/

/** What an agent's call left without its result may have done: anything. */
const CALL_INTERRUPTED = 'Owner process stopped before recording an outcome; effects are unknown'

/** A decision or the owner's own change applied, or not, in state Buckle keeps, so its reader is sent there. */
const INTERRUPTED_DETAILS: ReadonlyArray<{ tools: RegExp; detail: string }> = [
  { tools: new RegExp(`^${DECISION_TOOL}$`), detail: 'Owner process stopped before recording the decision\'s outcome; the approvals ledger holds what applied' },
  { tools: OWNER_TOOLS, detail: 'Owner process stopped before recording the change\'s outcome; the grants, settings, or registry it changed hold what applied' },
]

/** Names no tool may take, since Buckle writes its own records under them: an agent's call under one would read as one. */
export function isRecordTool(tool: string): boolean {
  return tool === DECISION_TOOL || tool === LOG_DROPPED_TOOL || OWNER_TOOLS.test(tool)
}

/** The detail of the interrupted result recovery writes for an attempt of this tool whose own result never landed. */
export function interruptedDetail(tool: string): string {
  return INTERRUPTED_DETAILS.find(row => row.tools.test(tool))?.detail ?? CALL_INTERRUPTED
}
