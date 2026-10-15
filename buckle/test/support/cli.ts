import { runCli as runCommand, type CliResult, type Confirm } from '../../cli/main.js'
import type { BuckleConfig, NodeConfig } from '../../common/runtime/config.js'
import { nodeConfigOf } from './workspace-config.js'

/**
 * `buckle <argv>` as an owner runs it in the workspace's folder: a command that names no workspace means the one that
 * folder belongs to (D83 (4)). A configuration that names no folder runs where the test does; a workspace's
 * configuration stands for its node's (nodeConfigOf).
 */
export function runCli(input: { argv: string[]; config: NodeConfig & Partial<Pick<BuckleConfig, 'cwd' | 'nodeStateDirectory'>>; confirm?: Confirm | null; cwd?: string }): Promise<CliResult> {
  return runCommand({ ...input, config: nodeConfigOf(input.config), cwd: input.cwd ?? input.config.cwd ?? process.cwd() })
}
