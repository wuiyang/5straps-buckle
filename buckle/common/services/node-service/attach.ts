import { readFileSync } from 'node:fs'
import { ignoresCase, isInsideComparable } from '../../domain/paths.js'
import { realPathOf } from '../../runtime/config.js'
import { registryPath, RegistrySchema } from '../workspaces/registry.js'
import { ALREADY_SERVING, type RunningNode } from './serve-record.js'

/**
 * Why a serve is refused beside a node already serving the state directory with no terminal (Q5, Phase 3 item 5): it
 * says so, and names the command that answers that node's approvals here. Beside a serve at a terminal, which answers
 * its approvals there, it says to stop that one with Ctrl-C first (fix brief 6, item 1).
 */
export function besideService(input: { running: RunningNode; command: string; stateDirectory: string; cwd: string; platform?: NodeJS.Platform | undefined }): string {
  const pid = input.running.record === null ? '' : ` (pid ${input.running.record.pid})`
  if (input.running.record?.manager === 'terminal') return `${atTerminal(input.running)}, then run ${input.command} again.`
  return `${ALREADY_SERVING}${pid}, so ${input.command} starts nothing. Answer its approvals here with: ${attachCommand(input.stateDirectory, input.cwd, input.platform)}`
}

/** A node `buckle serve` runs at a terminal, which only Ctrl-C there stops: the start of every refusal beside it. */
export function atTerminal(running: RunningNode): string {
  return `Buckle runs at a terminal${running.record === null ? '' : ` (pid ${running.record.pid})`}; stop it there with Ctrl-C`
}

/**
 * The command that answers a running node's approvals at this terminal: `buckle approvals --watch`, which answers the
 * workspace holding the current directory (Q9), where that is the one workspace online, and with `--all` otherwise.
 */
export function attachCommand(stateDirectory: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  try {
    // Read as it is, with nothing logged: a registry this command cannot read names every workspace instead.
    const workspaces = RegistrySchema.parse(JSON.parse(readFileSync(registryPath(stateDirectory), 'utf8'))).workspaces
    const online = workspaces.filter(workspace => workspace.online)
    const real = realPathOf(cwd, platform)
    const holder = workspaces.filter(workspace => isInsideComparable(workspace.dir, real, ignoresCase(platform), platform)).sort((left, right) => right.dir.length - left.dir.length)[0]
    if (online.length === 1 && holder?.id === online[0]!.id) return 'buckle approvals --watch'
  } catch {
    // An unreadable registry names every workspace, which the watch reports on.
  }
  return 'buckle approvals --watch --all'
}

/** Where a node's record says it listens, as a URL a person can open: an unspecified address is reached at loopback. */
export function addressOf(record: { host: string; port: number }): string {
  const host = record.host === '0.0.0.0' ? '127.0.0.1' : record.host === '::' ? '::1' : record.host
  return `http://${host.includes(':') ? `[${host}]` : host}:${record.port}`
}
