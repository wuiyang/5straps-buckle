import type { NodeConfig } from '../common/runtime/config.js'
import type { WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { CliResult } from './result.js'
import type { CommandTarget, TargetError } from './target.js'
import type { ChooseSave, Confirm } from './terminal-consumer.js'

/** What an owner's command asks at this process's terminal: null for each where the process has none. */
export interface OwnerPrompts { confirm: Confirm | null; chooseSave: ChooseSave | null }

export interface NodeCommandInput {
  config: NodeConfig
  workspaces: WorkspaceManager
  argv: string[]
  cwd: string
}

export interface WorkspaceCommandInput {
  command: string
  config: NodeConfig
  runtime: BuckleRuntime
  workspaces: WorkspaceManager
  argv: string[]
  prompts: OwnerPrompts
  ignoreWarning: boolean
}

export interface ApproverCommandInput {
  config: NodeConfig
  workspaces: WorkspaceManager
  command: string
  argv: string[]
  runOnWorkspace(runtime: BuckleRuntime): Promise<CliResult>
  nodeAudited(operation: () => CliResult | Promise<CliResult>): Promise<CliResult>
}

export interface WorkspaceRepairInput {
  workspaces: WorkspaceManager
  target: CommandTarget
  cwd: string
  argv: string[]
  failure: unknown
  ignoreWarning: boolean
}

export interface WorkspaceCommandHandler {
  execute(input: WorkspaceCommandInput): CliResult | Promise<CliResult>
  refuse?(message: string): CliResult
  unreadable?(error: unknown): CliResult
  repair?(input: WorkspaceRepairInput): CliResult | Promise<CliResult> | null
}

export interface ApproverCommandHandler extends WorkspaceCommandHandler {
  across(input: ApproverCommandInput): Promise<CliResult>
}

export interface NodeCommandHandler {
  execute(input: NodeCommandInput): CliResult | Promise<CliResult>
}

/** The owner's commands on one workspace that are audited; reads such as `tools` are not. */
interface CommandAudit {
  tool: string
  refusals: boolean
  isSuccessful(result: CliResult): boolean
}

interface CommandPolicy {
  name: string
  help?: {
    usage: string
    /** The commands whose own first word `help` also asks for the usage. */
    word?: true
  }
  matches?(argv: readonly string[]): boolean
  /** Whether the command runs a tool, whose call never runs without its own record. */
  runsTool: boolean
  audit?: CommandAudit
}

/** The commands that act on the node rather than on one workspace: its registry and its trusted keys. */
export interface NodeCommandDefinition extends CommandPolicy {
  target: 'node'
  audit: CommandAudit
  load(): Promise<NodeCommandHandler>
}

export interface WorkspaceCommandDefinition extends CommandPolicy {
  target: 'workspace'
  offline: boolean
  load(): Promise<WorkspaceCommandHandler>
}

/** The commands that answer asks: default to the workspace holding the current directory, or --all over every online one (Q9, Phase 1b item 4). */
export interface ApproverCommandDefinition extends CommandPolicy {
  target: 'approver'
  offline: boolean
  load(): Promise<ApproverCommandHandler>
}

export type CommandDefinition = NodeCommandDefinition | WorkspaceCommandDefinition | ApproverCommandDefinition

export interface SelectedCommand {
  command: string
  argv: string[]
  target: CommandTarget
  targetError?: TargetError
  definition: CommandDefinition
}

export type LoadedNodeCommand = SelectedCommand & { targetKind: 'node'; definition: NodeCommandDefinition; handler: NodeCommandHandler }
export type LoadedWorkspaceCommand = SelectedCommand & { targetKind: 'workspace'; definition: WorkspaceCommandDefinition; handler: WorkspaceCommandHandler }
export type LoadedApproverCommand = SelectedCommand & { targetKind: 'approver'; definition: ApproverCommandDefinition; handler: ApproverCommandHandler }
export type LoadedRuntimeCommand = LoadedWorkspaceCommand | LoadedApproverCommand
export type LoadedCommand = LoadedNodeCommand | LoadedRuntimeCommand
