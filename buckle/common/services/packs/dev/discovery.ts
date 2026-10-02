import { buildChildEnvironment } from '../../../domain/environment.js'
import type { ProcessRunner } from '../../../types/ports/process-runner.js'
import { ToolExecutionError } from '../../../domain/tool.js'
import { knownServerForCommand } from './servers.js'

export interface DiscoveredServer {
  pid: number
  serverId: string
  commandLine: string
  /**
   * A server started in socket mode can be attached to. One using stdio cannot, because its pipes
   * belong to the editor that launched it, so the only option is spawning a matching twin.
   */
  attach: 'socket' | 'spawn_twin'
  port: number | null
}

const SOCKET_FLAG_PATTERN = /--(?:port|socket|tcp)[= ](\d{2,5})/

export async function discoverServers(input: {
  runProcess: ProcessRunner
  timeoutMs: number
  signal: AbortSignal
}): Promise<DiscoveredServer[]> {
  const result = await input.runProcess({
    command: 'ps',
    args: ['-eo', 'pid=,args='],
    cwd: process.cwd(),
    timeoutMs: input.timeoutMs,
    environment: buildChildEnvironment({ parent: process.env, extra: {} }),
    signal: input.signal,
  })
  if (result.exitCode !== 0) {
    throw new ToolExecutionError(`Could not list processes: ${result.stderr.trim()}`, { code: 'PROCESS_LIST_FAILED' })
  }

  const discovered: DiscoveredServer[] = []
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match) continue

    const commandLine = match[2] ?? ''
    const server = knownServerForCommand(commandLine)
    if (!server) continue

    const port = commandLine.match(SOCKET_FLAG_PATTERN)?.[1]
    discovered.push({
      pid: Number.parseInt(match[1] ?? '', 10),
      serverId: server.id,
      commandLine: commandLine.slice(0, 300),
      attach: port ? 'socket' : 'spawn_twin',
      port: port ? Number.parseInt(port, 10) : null,
    })
  }
  return discovered
}
