import type { CommandDefinition, LoadedCommand, SelectedCommand } from './command.js'
import type { CliResult } from './result.js'
import { CHECK_URL_BAD_INPUT } from './exit-codes.js'
import { asksForHelp } from './help-request.js'
import { takeTarget, TargetError } from './target.js'
import { print, reportWorkspaceErrors } from './output.js'
import { APPROVALS_USAGE, APPROVE_USAGE, BROWSER_CLOSE_USAGE, CHECK_URL_USAGE, GRANTS_USAGE, HISTORY_USAGE, KEYS_USAGE, PLUGIN_USAGE, POLICY_USAGE, WORKSPACES_USAGE, WORKSPACE_USAGE, isBrowserClose } from './usage.js'

const workspaceSucceeded = (result: CliResult) => result.exitCode === 0 || result.applied === true
const nodeSucceeded = (result: CliResult) => result.exitCode === 0

const COMMANDS: readonly CommandDefinition[] = [
  {
    name: 'workspace', target: 'node', runsTool: false, help: { usage: WORKSPACE_USAGE, word: true },
    audit: { tool: 'cli_workspace', refusals: false, isSuccessful: nodeSucceeded },
    load: async () => {
      const { workspaceRegistryCommand } = await import('./workspace.js')
      return { execute: input => workspaceRegistryCommand(input) }
    },
  },
  {
    name: 'keys', target: 'node', runsTool: false, help: { usage: KEYS_USAGE },
    audit: { tool: 'cli_keys', refusals: false, isSuccessful: nodeSucceeded },
    load: async () => {
      const { keysCommand } = await import('./keys.js')
      return { execute: input => keysCommand(input) }
    },
  },
  {
    name: 'approve', target: 'approver', offline: false, runsTool: false, help: { usage: APPROVE_USAGE },
    audit: { tool: 'cli_approve', refusals: true, isSuccessful: workspaceSucceeded },
    load: async () => {
      const { approve, runApproverCommand } = await import('./approvals.js')
      return { execute: input => reportWorkspaceErrors(() => approve({ config: input.config, runtime: input.runtime, argv: input.argv, ...input.prompts })), across: runApproverCommand }
    },
  },
  {
    name: 'approvals', target: 'approver', offline: false, runsTool: false, help: { usage: APPROVALS_USAGE },
    audit: { tool: 'cli_approvals', refusals: true, isSuccessful: workspaceSucceeded },
    load: async () => {
      const { approvals, runApproverCommand } = await import('./approvals.js')
      return { execute: input => reportWorkspaceErrors(() => approvals({ config: input.config, runtime: input.runtime, argv: input.argv })), across: runApproverCommand }
    },
  },
  {
    name: 'check-url', target: 'workspace', offline: false, runsTool: false, help: { usage: CHECK_URL_USAGE },
    // A check that answers denied or asks has still succeeded; only bad input failed.
    audit: { tool: 'cli_check-url', refusals: true, isSuccessful: result => result.exitCode !== CHECK_URL_BAD_INPUT },
    load: async () => {
      const { badInput, checkUrlCommand, checkUrlUnreadable } = await import('./check-url.js')
      return { execute: input => checkUrlCommand({ argv: input.argv, runtime: async () => input.runtime }), refuse: badInput, unreadable: checkUrlUnreadable }
    },
  },
  {
    name: 'grants', target: 'workspace', offline: false, runsTool: false, help: { usage: GRANTS_USAGE },
    audit: { tool: 'cli_grants', refusals: true, isSuccessful: workspaceSucceeded },
    load: async () => {
      const { grantsCommand } = await import('./grants.js')
      return { execute: input => grantsCommand(input.runtime, input.argv) }
    },
  },
  {
    name: 'workspaces', target: 'workspace', offline: false, runsTool: false, help: { usage: WORKSPACES_USAGE },
    audit: { tool: 'cli_workspaces', refusals: true, isSuccessful: workspaceSucceeded },
    load: async () => {
      const { shellWorkspacesCommand } = await import('./shell-workspaces.js')
      return { execute: input => shellWorkspacesCommand(input.runtime, input.argv) }
    },
  },
  {
    name: 'history', target: 'workspace', offline: false, runsTool: false, help: { usage: HISTORY_USAGE },
    audit: { tool: 'cli_history', refusals: true, isSuccessful: workspaceSucceeded },
    load: async () => {
      const { historyCommand } = await import('./history.js')
      return { execute: input => historyCommand(input.runtime, input.argv) }
    },
  },
  {
    name: 'plugin', target: 'workspace', offline: false, runsTool: false, help: { usage: PLUGIN_USAGE },
    audit: { tool: 'cli_plugin', refusals: true, isSuccessful: workspaceSucceeded },
    load: async () => {
      const { pluginCommand } = await import('./plugin.js')
      return { execute: input => pluginCommand(input.runtime, input.argv) }
    },
  },
  {
    name: 'policy', target: 'workspace', offline: true, runsTool: false, help: { usage: POLICY_USAGE, word: true },
    audit: { tool: 'cli_policy', refusals: true, isSuccessful: workspaceSucceeded },
    load: async () => {
      const { policyCommand, repairStoredPolicy } = await import('./policy.js')
      const { StoredPolicyError } = await import('../common/domain/policy.js')
      return {
        execute: input => policyCommand(input.runtime, input.argv, { ignoreWarning: input.ignoreWarning }),
        repair: input => input.failure instanceof StoredPolicyError ? repairStoredPolicy({ ...input, failure: input.failure }) : null,
      }
    },
  },
  {
    // `buckle browser` runs the browser's tools; only its `close` is the owner's own command.
    name: 'browser', target: 'workspace', offline: true, runsTool: false, matches: argv => isBrowserClose('browser', [...argv]), help: { usage: BROWSER_CLOSE_USAGE },
    audit: { tool: 'cli_browser_close', refusals: false, isSuccessful: workspaceSucceeded },
    load: async () => {
      const { browserCloseCommand } = await import('./browser.js')
      return { execute: input => reportWorkspaceErrors(() => browserCloseCommand(input.runtime, input.argv)) }
    },
  },
  {
    name: 'tools', target: 'workspace', offline: false, runsTool: false,
    load: async () => {
      const { printTools } = await import('./inspect.js')
      return { execute: input => printTools(input.runtime) }
    },
  },
  {
    name: 'manifest', target: 'workspace', offline: false, runsTool: false,
    load: async () => ({ execute: input => print(input.runtime.manifest()) }),
  },
  {
    name: 'skills', target: 'workspace', offline: false, runsTool: false,
    load: async () => {
      const { printSkills } = await import('./inspect.js')
      return { execute: input => printSkills(input.runtime, input.argv) }
    },
  },
  {
    name: 'log', target: 'workspace', offline: false, runsTool: false,
    load: async () => {
      const { logCommand } = await import('./log.js')
      return { execute: input => logCommand(input.runtime, input.argv) }
    },
  },
]

const TOOL_COMMAND: CommandDefinition = {
  name: '*', target: 'workspace', offline: false, runsTool: true,
  load: async () => {
    const { callByName, callByCommand } = await import('./call.js')
    return { execute: input => input.command === 'call' ? callByName(input.runtime, input.argv) : callByCommand(input.runtime, input.command, input.argv) }
  },
}

export function commandUsage(command: string, argv: readonly string[]): string | undefined {
  const definition = COMMANDS.find(definition => definition.name === command && (definition.matches?.(argv) ?? true))
  const help = definition?.help
  return help !== undefined && (asksForHelp(argv) || (help.word && argv[0] === 'help')) ? help.usage : undefined
}

export function ownerHoldsToolGroup(group: string): boolean {
  return COMMANDS.some(definition => definition.name === group && definition.target !== 'node' && definition.matches === undefined)
}

export function selectCommand(argv: readonly string[]): SelectedCommand {
  const [command = '', ...rest] = argv
  const direct = COMMANDS.find(definition => definition.name === command && definition.matches === undefined)
  if (direct?.target === 'node') return { command, argv: rest, target: {}, definition: direct }
  let taken: ReturnType<typeof takeTarget>
  let targetError: TargetError | undefined
  try { taken = takeTarget(rest) } catch (error) {
    if (!(error instanceof TargetError)) throw error
    targetError = error
    taken = { target: {}, argv: rest }
  }
  const definition = COMMANDS.find(definition => definition.name === command && (definition.matches?.(taken.argv) ?? true)) ?? TOOL_COMMAND
  return { command, ...taken, definition, ...(targetError ? { targetError } : {}) }
}

export async function loadCliCommand(selected: SelectedCommand): Promise<LoadedCommand> {
  const { definition } = selected
  if (definition.target === 'node') return { ...selected, targetKind: 'node', definition, handler: await definition.load() }
  if (definition.target === 'approver') return { ...selected, targetKind: 'approver', definition, handler: await definition.load() }
  return { ...selected, targetKind: 'workspace', definition, handler: await definition.load() }
}
