import { parseArgs } from 'node:util'
import { relative } from 'pathe'
import { printable } from '../common/domain/approval-instruction.js'
import { isInside } from '../common/domain/paths.js'
import { RECENT_CHECKPOINTS_MAX, type CheckpointSummary } from '../common/services/history/journal.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

export interface CliResult {
  exitCode: number
}

const USAGE = 'Usage: buckle history list [--last <n>] | restore <id> | restore-stage <stage> <session> | recover <id> | prune'
/** How many files `list --last` names for one checkpoint before it counts the rest. */
const SHOWN_FILES = 10

/** `buckle history`: the owner's view of the workspace's change history, and the owner's own restores. */
export async function historyCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [command = 'list', id] = argv
  if (command === 'list') return listCommand(runtime, argv.slice(1))
  if (command === 'prune') return print(await runtime.history.prune())
  if (command === 'restore-stage' && id && argv[2]) return print(await runtime.history.restoreStage(id, argv[2]))
  if (command === 'restore' && id) return print(await runtime.history.restore(id))
  if (command === 'recover' && id) return print(await runtime.history.recover(id))
  return fail(USAGE)
}

/** Every checkpoint as JSON, oldest first, or with `--last <n>` the n back from the current state, as text. */
async function listCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  let values: { last?: string | undefined }
  try {
    values = parseArgs({ args: argv, options: { last: { type: 'string' } }, allowPositionals: false }).values
  } catch { return fail(USAGE) }
  if (values.last === undefined) return print((await runtime.history.list()).map(printableCheckpoint))
  const last = Number(values.last)
  if (!/^\d+$/.test(values.last) || last < 1 || last > RECENT_CHECKPOINTS_MAX) return fail(`--last takes a count of checkpoints, 1 to ${RECENT_CHECKPOINTS_MAX}`)
  const recent = await runtime.history.recent(last)
  process.stdout.write(recentText({ ...recent, root: runtime.paths().root }))
  return { exitCode: 0 }
}

/**
 * The newest checkpoints as a person reads them, newest first: each one's id and time, `*` and `current` on the one the
 * workspace stands at, the call that made it, and its files, relative to the workspace's folder where they lie in it.
 * What an agent chose is escaped (printable).
 */
function recentText(input: { checkpoints: Array<CheckpointSummary & { current: boolean }>; more: boolean; root: string }): string {
  if (input.checkpoints.length === 0) return 'The change history holds no checkpoint yet.\n'
  const count = input.checkpoints.length
  const lines = [`The newest ${count === 1 ? 'checkpoint' : `${count} checkpoints`}, from the current state back:`, '']
  for (const checkpoint of input.checkpoints) {
    const state = checkpoint.current ? 'current' : checkpoint.status === 'complete' ? '' : checkpoint.status
    lines.push(`${checkpoint.current ? '*' : ' '} ${checkpoint.id}  ${checkpoint.createdAt}${state ? `  ${state}` : ''}`)
    lines.push(`    ${callText(checkpoint)}`)
    for (const change of checkpoint.changes.slice(0, SHOWN_FILES)) lines.push(`    ${change.kind.padEnd(10)}${printable(ownerPath(change.path, input.root))}`)
    const more = checkpoint.changes.length - SHOWN_FILES
    if (more > 0) lines.push(`    and ${more} more ${more === 1 ? 'file' : 'files'}`)
  }
  if (input.more) lines.push('', 'Older checkpoints are kept: buckle history list prints every one.')
  return `${lines.join('\n')}\n`
}

/** The call that made a checkpoint: its tool, session, and request, and for a restore, what it undid. */
function callText(checkpoint: CheckpointSummary): string {
  const request = checkpoint.requestId === undefined ? '' : `, request ${printable(checkpoint.requestId)}`
  const undid = checkpoint.restores === undefined ? '' : `, undid ${printable(checkpoint.restores)}${(checkpoint.undoes ?? 1) > 1 ? ` and the ${checkpoint.undoes! - 1} after it` : ''}`
  return `${printable(checkpoint.tool)}, session ${printable(checkpoint.sessionId)}${request}${undid}`
}

/** A checkpoint's path as the owner reads it: relative to the workspace's folder inside it, else as it is on the disk. */
function ownerPath(path: string, root: string): string {
  return isInside(root, path) ? relative(root, path) || '.' : path
}

/**
 * A checkpoint as a person reads it: the session, stage and paths an agent chose, escaped as every
 * other rendering of agent text is (review L8 of B15-B17).
 */
function printableCheckpoint(checkpoint: CheckpointSummary): CheckpointSummary {
  return {
    ...checkpoint,
    sessionId: printable(checkpoint.sessionId),
    stageId: printable(checkpoint.stageId),
    tool: printable(checkpoint.tool),
    ...(checkpoint.requestId === undefined ? {} : { requestId: printable(checkpoint.requestId) }),
    paths: checkpoint.paths.map(printable),
    changes: checkpoint.changes.map(change => ({ ...change, path: printable(change.path) })),
    notRestorable: checkpoint.notRestorable.map(printable),
  }
}

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  return { exitCode: 0 }
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
