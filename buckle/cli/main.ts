import { answerWithoutConfiguration } from './help.js'
export { answerWithoutConfiguration } from './help.js'
export { runInitCommand } from './init.js'
export { runSettingsCommand } from './settings.js'
export { runServiceCommand } from './service.js'
export type { ChooseSave, Confirm } from './terminal-consumer.js'
export type { CliResult } from './result.js'
import { OwnerRecordError } from '../common/adapters/action-log/file-action-log.js'
import type { NodeConfig } from '../common/runtime/config.js'
import { NODE_SCOPE } from '../common/types/ports/client-keys.js'
import { auditOperation } from '../common/services/audit/audit-operation.js'
import { askAtTerminal } from './ask.js'
import type { WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { WorkspaceError } from '../common/domain/workspace-error.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { initializeCommon, type BuckleCommon } from '../common/runtime/initialize.js'
import { withOperationScope } from '@5straps/runtime'
import { logger } from '../common/runtime/log.js'
import { setupCli } from './setup.js'
import { isStateBusy } from '../common/services/state-busy.js'
import { ignoreWarningRefused, stoppedForRecord, type OwnerChoice } from './ignore-warning.js'
import { terminalChooseSave, terminalConfirm, type ChooseSave, type Confirm } from './terminal-consumer.js'
import { loadCliCommand, selectCommand } from './commands.js'
import type { LoadedCommand, LoadedNodeCommand, LoadedRuntimeCommand, OwnerPrompts } from './command.js'
import type { CliResult } from './result.js'
import { fail } from './output.js'

/** `cwd`: the directory the command means where it names no workspace (D83 (4)); the process's own by default. */
export async function runCli(input: { argv: string[]; config: NodeConfig; confirm?: Confirm | null; chooseSave?: ChooseSave | null; cwd?: string; prepared?: LoadedCommand } & OwnerChoice): Promise<CliResult> {
  const answered = answerWithoutConfiguration(input.argv)
  if (answered) return answered
  const selected = input.prepared ?? selectCommand(input.argv)
  const ignoreWarning = input.ignoreWarning === true
  if (ignoreWarning && selected.definition.runsTool) return fail(ignoreWarningRefused(selected.command))
  const loaded = input.prepared ?? await loadCliCommand(selected)
  const terminal = { input: process.stdin, output: process.stdout }
  const prompts: OwnerPrompts = {
    confirm: input.confirm !== undefined ? input.confirm : terminalConfirm(terminal),
    chooseSave: input.chooseSave !== undefined ? input.chooseSave : terminalChooseSave(terminal),
  }

  // One command is one process owner: its common runtime closes when the command ends. At a terminal, the move onto
  // workspaces may ask for a name (D85, Q15), on stderr, where its questions go.
  const common = initializeCommon({ config: input.config, role: 'cli', ...(process.stdin.isTTY && process.stderr.isTTY ? { askName: question => askAtTerminal(question) } : {}) })
  // A terminal answers a gated call in place; without one the call reports back at once (exit 3). The question is
  // shown on stderr, so both ends must be a terminal: with stderr redirected a key would answer an unseen action
  // (review L2 of the continuation review).
  const cli = setupCli({ terminal: process.stdin.isTTY && process.stderr.isTTY ? { input: process.stdin, output: process.stderr } : null })
  common.bindRequester(cli.requestCli)
  common.owner.onClose('waiters', 'terminal questions', () => cli.close())
  try {
    return await runCliCommand({ common, config: input.config, loaded, prompts, cwd: input.cwd ?? process.cwd(), ignoreWarning })
  } catch (error) {
    if (isStateBusy(error)) return fail(error.message)
    if (error instanceof OwnerRecordError) return stoppedForRecord(error)
    throw error
  } finally {
    await common.owner.close().catch((error: unknown) => {
      logger.error('Buckle closed with errors', { error })
    })
  }
}

interface CommandRun {
  config: NodeConfig
  loaded: LoadedCommand
  prompts: OwnerPrompts
  cwd: string
  ignoreWarning: boolean
}

async function runCliCommand(input: CommandRun & { common: BuckleCommon }): Promise<CliResult> {
  const { common, loaded } = input
  try {
    await common.start()
  } catch (error) {
    // check-url's exit 1 means denied, so a node it cannot read must not look like one.
    if (loaded.targetKind !== 'node' && loaded.handler.unreadable) return loaded.handler.unreadable(error)
    throw error
  }
  const workspaces = await common.services.getWorkspaces()
  const scope = common.owner.registry.createScope({ context: { actor: 'local-owner' } })
  return withOperationScope(scope, async () => {
    (await common.services.getInteraction(scope)).bind('prompt')
    if (loaded.targetKind === 'node') return runNodeCommand({ ...input, loaded, workspaces })
    const targetError = loaded.targetError
    if (targetError) {
      // An owner's command the log keeps is refused before any workspace's log is known: the node's records it.
      return loaded.definition.audit?.refusals ? nodeAudited({ ...input, loaded, workspaces }, () => refused(loaded, targetError.message)) : fail(targetError.message)
    }
    // Q9 (Phase 1b item 4): an approver's command defaults to the workspace holding the current directory; --all widens to every online one.
    const named = loaded.target.workspace !== undefined || loaded.target.dir !== undefined
    // --all widens an approver's command over every online workspace, so it cannot also name one (fix brief 4, finding 33).
    if (loaded.targetKind === 'approver' && named && loaded.argv.includes('--all')) {
      return nodeAudited({ ...input, loaded, workspaces }, () => fail('Name one workspace with --workspace or --dir, or pass --all, not both'))
    }
    if (loaded.targetKind === 'approver' && !named) {
      if (loaded.argv.includes('--all')) {
        const across = { ...loaded, argv: loaded.argv.filter(word => word !== '--all') }
        return across.handler.across({ config: input.config, workspaces, command: across.command, argv: across.argv, runOnWorkspace: runtime => runOnWorkspace({ ...input, loaded: across, workspaces, runtime }), nodeAudited: operation => nodeAudited({ ...input, loaded: across, workspaces }, operation) })
      }
      if (!holdsCurrentDirectory(workspaces, input.cwd)) {
        return nodeAudited({ ...input, loaded, workspaces }, () => fail('No workspace holds the current directory. Name one with --workspace <name>, or pass --all to answer every online workspace.'))
      }
    }
    return runWorkspaceCommand({ ...input, loaded, workspaces })
  })
}

/** A refusal before a workspace answers: exit 1, except that check-url's 1 means denied, so its own refusals take its bad-input code. */
function refused(loaded: LoadedRuntimeCommand, message: string): CliResult {
  return loaded.handler.refuse?.(message) ?? fail(message)
}

/** Whether a workspace holds the current directory, read without throwing, so an approver command can default to it (Q9). */
function holdsCurrentDirectory(workspaces: WorkspaceManager, cwd: string): boolean {
  try { workspaces.target({ cwd }); return true } catch { return false }
}

async function runNodeCommand(input: CommandRun & { loaded: LoadedNodeCommand; workspaces: WorkspaceManager }): Promise<CliResult> {
  const { workspaces, loaded } = input
  return auditOperation({ actions: workspaces.nodeActions, workspaceId: NODE_SCOPE, tool: loaded.definition.audit.tool, sessionId: 'local-owner', ignoreWarning: input.ignoreWarning, isSuccessful: loaded.definition.audit.isSuccessful, describe: result => result.detail,
    operation: () => loaded.handler.execute({ config: input.config, workspaces, argv: loaded.argv, cwd: input.cwd }),
  })
}

/**
 * A command on the workspace it targets (D83 (4)): `--workspace <name>`, else `--dir <path>`, else the directory it runs
 * in. `buckle policy` opens an offline workspace too, so its owner can set it up before it serves.
 */
async function runWorkspaceCommand(input: CommandRun & { loaded: LoadedRuntimeCommand; workspaces: WorkspaceManager }): Promise<CliResult> {
  const { workspaces, loaded } = input
  let runtime: BuckleRuntime
  try {
    const id = workspaces.target({ ...loaded.target, cwd: input.cwd })
    // A workspace taken offline may still have browsers its agents left, which buckle browser close ends.
    runtime = (await workspaces.resolve(id, { setup: loaded.definition.offline })).runtime
  } catch (error) {
    // A node whose state cannot be read reports no verdict; a workspace that was not named, or is not served, is a refusal like any other (fix brief 4, finding 31).
    if (loaded.handler.unreadable && !(error instanceof WorkspaceError)) return loaded.handler.unreadable(error)
    const repaired = loaded.handler.repair?.({ workspaces, target: loaded.target, cwd: input.cwd, argv: loaded.argv, failure: error, ignoreWarning: input.ignoreWarning })
    if (repaired != null) return repaired
    // An owner's command the log keeps is refused before any workspace's log is known: the node's records it (finding 31).
    if (error instanceof WorkspaceError) return loaded.definition.audit?.refusals ? nodeAudited(input, () => refused(loaded, error.message)) : fail(error.message)
    throw error
  }
  return runOnWorkspace({ ...input, runtime })
}

function nodeAudited(input: { workspaces: WorkspaceManager; loaded: LoadedRuntimeCommand; ignoreWarning: boolean }, operation: () => CliResult | Promise<CliResult>): Promise<CliResult> {
  return auditOperation({ actions: input.workspaces.nodeActions, workspaceId: NODE_SCOPE, tool: input.loaded.definition.audit?.tool ?? `cli_${input.loaded.command}`, sessionId: 'local-owner', ignoreWarning: input.ignoreWarning, isSuccessful: result => result.exitCode === 0, operation })
}

async function runOnWorkspace(input: Pick<CommandRun, 'config' | 'prompts' | 'ignoreWarning'> & { loaded: LoadedRuntimeCommand; runtime: BuckleRuntime; workspaces: WorkspaceManager }): Promise<CliResult> {
  const { runtime, workspaces, loaded } = input
  const execute = () => loaded.handler.execute({ config: input.config, runtime, workspaces, command: loaded.command, argv: loaded.argv, prompts: input.prompts, ignoreWarning: input.ignoreWarning })
  try {
    const audit = loaded.definition.audit
    if (!audit) return await execute()
    return await auditOperation({ actions: runtime.actions, workspaceId: runtime.workspaceId, tool: audit.tool, sessionId: 'local-owner', ignoreWarning: input.ignoreWarning, isSuccessful: audit.isSuccessful, describe: result => result.detail, annotate: result => (result.judge ? { judge: result.judge } : undefined),
      operation: execute,
    })
  } finally {
    // One command is one process, and the batch timer is unreferenced so it never holds the
    // process open: without this the entry a CLI call recorded reached Rings for no call at all.
    await runtime.reporter.flush()
  }
}
