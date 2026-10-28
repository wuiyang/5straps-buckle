import { parseArgs } from 'node:util'
import { relative } from 'pathe'
import { printable } from '../common/domain/approval-instruction.js'
import { isInside } from '../common/domain/paths.js'
import { SnapshotConflictError } from '../common/services/history/snapshot.js'
import { RECENT_CHECKPOINTS_MAX, RestoreRefusedError, withConflictPath, type CheckpointSummary } from '../common/services/history/journal.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

export interface CliResult {
  exitCode: number
}

export const USAGE = 'Usage: buckle history list [--last <n>] | restore <id> | restore-stage <stage> <session> | recover <id> | prune [--legacy] [--force]'
/** How many files `list --last` names for one checkpoint before it counts the rest. */
const SHOWN_FILES = 10

/** `buckle history`: the owner's view of the workspace's change history, and the owner's own restores. */
export async function historyCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  const [command = 'list', id] = argv
  if (command === 'list') return listCommand(runtime, argv.slice(1))
  const force = argv.includes('--force')
  if (command === 'prune') return print(await runtime.history.prune({ force, legacy: argv.includes('--legacy') }))
  if (command === 'restore-stage' && id && argv[2]) return restored(runtime, () => runtime.history.restoreStage(id, argv[2]!, { force }))
  if (command === 'restore' && id) return restored(runtime, () => runtime.history.restore(id, { force }))
  if (command === 'recover' && id) return print(await runtime.history.recover(id, { force }))
  return fail(USAGE)
}

/** A restore's result, or its refusal as a conflict: the path in conflict named as it lies in the workspace's folder. Any other failure is the caller's. */
async function restored(runtime: BuckleRuntime, restore: () => Promise<unknown>): Promise<CliResult> {
  try {
    return print(await restore())
  } catch (error) {
    if (!(error instanceof SnapshotConflictError || error instanceof RestoreRefusedError) || error.path === undefined) throw error
    return fail(withConflictPath(error, printable(ownerPath(error.path, runtime.paths().root))))
  }
}

/** Every checkpoint as JSON, oldest first, or with `--last <n>` the n back from the current state, as text. */
async function listCommand(runtime: BuckleRuntime, argv: string[]): Promise<CliResult> {
  let values: { last?: string | undefined }
  try {
    values = parseArgs({ args: argv, options: { last: { type: 'string' } }, allowPositionals: false }).values
  } catch { return fail(USAGE) }
  if (values.last === undefined) return print(await runtime.history.list())
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
  let turn: string | undefined
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.turnId !== turn) { turn = checkpoint.turnId; lines.push(`Turn ${printable(turn)}`) }
    const state = checkpoint.current ? 'current' : checkpoint.status === 'complete' ? '' : checkpoint.status
    lines.push(`${checkpoint.current ? '*' : ' '} ${checkpoint.id}  ${checkpoint.createdAt}${state ? `  ${state}` : ''}`)
    lines.push(`    ${callText(checkpoint)}`)
    for (const change of checkpoint.changes.slice(0, SHOWN_FILES)) lines.push(`    ${change.kind.padEnd(10)}${printable(ownerPath(change.path, input.root))}`)
    for (const path of checkpoint.notRestorable.slice(0, SHOWN_FILES)) lines.push(`    not restorable  ${printable(ownerPath(path, input.root))}`)
    const skipped = checkpoint.notRestorable.length - SHOWN_FILES
    if (skipped > 0) lines.push(`    and ${skipped} more not-restorable ${skipped === 1 ? 'file' : 'files'}`)
    if (!checkpoint.restorable && checkpoint.reason) lines.push(`    ${printable(checkpoint.reason)}`)
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

function print(value: unknown): CliResult {
  process.stdout.write(`${JSON.stringify(value, (_key, field: unknown) => typeof field === 'string' ? printable(field) : field, 2)}\n`)
  return { exitCode: 0 }
}

function fail(message: string): CliResult {
  process.stderr.write(`${message}\n`)
  return { exitCode: 1 }
}
