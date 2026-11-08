/** The tool of each approval decision's entries. */
export const DECISION_TOOL = 'approval_decision'

/** The tool of the entry that says how many of a log's entries were dropped unwritten, and over what time. */
export const LOG_DROPPED_TOOL = 'log_dropped'

/** The tool of the entry each session's end writes: its cause, and what it withdrew, dropped, and removed. */
export const SESSION_END_TOOL = 'approval_session_ended'

/** The prefixes of the owner's own changes (CLI commands, setup and registry changes, and the dangerously-allow switch), and the switch's uses. */
const OWNER_PREFIXES = ['cli_', 'setup_', 'workspace_', 'policy_'] as const
const OWNER_TOOLS = new RegExp(`^(?:${OWNER_PREFIXES.join('|')})`)

/** What an agent's call left without its result may have done: anything. */
const CALL_INTERRUPTED = 'Owner process stopped before recording an outcome; effects are unknown'

/** A decision or the owner's own change applied, or not, in state Buckle keeps, so its reader is sent there. */
const INTERRUPTED_DETAILS: ReadonlyArray<{ tools: RegExp; detail: string }> = [
  { tools: new RegExp(`^${DECISION_TOOL}$`), detail: 'Owner process stopped before recording the decision\'s outcome; the approvals ledger holds what applied' },
  { tools: OWNER_TOOLS, detail: 'Owner process stopped before recording the change\'s outcome; the grants, settings, or registry it changed hold what applied' },
]

/** Names no tool may take, since Buckle writes its own records under them: an agent's call under one would read as one. */
export function isRecordTool(tool: string): boolean {
  return tool === DECISION_TOOL || tool === LOG_DROPPED_TOOL || tool === SESSION_END_TOOL || OWNER_TOOLS.test(tool)
}

/** Why a tool may not take this name, naming every name kept, so a plugin's author reads what to rename it from. */
export function recordToolRefusal(tool: string): string {
  const prefixes = `${OWNER_PREFIXES.slice(0, -1).join(', ')}, or ${OWNER_PREFIXES.at(-1)}`
  return `Tool name ${tool} is reserved for Buckle's own records (${DECISION_TOOL}, ${LOG_DROPPED_TOOL}, ${SESSION_END_TOOL}, and every name starting ${prefixes}); rename the tool`
}

/** The detail of the interrupted result recovery writes for an attempt of this tool whose own result never landed. */
export function interruptedDetail(tool: string): string {
  return INTERRUPTED_DETAILS.find(row => row.tools.test(tool))?.detail ?? CALL_INTERRUPTED
}
