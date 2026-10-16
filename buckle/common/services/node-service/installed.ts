import { existsSync, readFileSync } from 'node:fs'
import { launchdAgentPath, readAgent } from '../../domain/launchd-agent.js'
import { homeDirectory } from '../../domain/paths.js'
import { readUnit, systemdUnitPaths } from '../../domain/systemd-unit.js'
import { sameDirectory } from '../../runtime/config.js'
import { runningNode, taskDefinitionCopy } from './serve-record.js'

/**
 * Whether a service definition for this node is installed, read from disk without starting a program: on Linux the unit
 * naming this state directory, on macOS the launchd agent naming it, on Windows the task's copy kept in it. What the
 * restart hints read (Phase 3, item 7).
 */
export function serviceInstalled(stateDirectory: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homeDirectory(platform)): boolean {
  if (platform === 'win32') return existsSync(taskDefinitionCopy(stateDirectory))
  if (platform === 'linux') return namesThisNode(systemdUnitPaths(environment, home)[0]!, text => readUnit(text).stateDirectory, stateDirectory, platform)
  if (platform === 'darwin') return namesThisNode(launchdAgentPath(home), text => readAgent(text).stateDirectory, stateDirectory, platform)
  return false
}

/** Whether the definition at `file` names this state directory, as `named` reads it; false where there is none or it cannot be read. */
function namesThisNode(file: string, named: (text: string) => string | null, stateDirectory: string, platform: NodeJS.Platform): boolean {
  if (!existsSync(file)) return false
  try {
    const directory = named(readFileSync(file, 'utf8'))
    return directory !== null && sameDirectory(directory, stateDirectory, platform)
  } catch {
    return false
  }
}

/**
 * How this node restarts for a changed setting to take effect (Phase 3, item 7, and fix brief 6, item 1): as what runs it
 * now restarts it, a service, a `buckle serve` at a terminal, or `buckle serve --background`; with none running, a
 * service where one is installed, else `buckle serve`.
 */
export type RestartRoute = 'service' | 'terminal' | 'background' | 'serve'

export async function restartRoute(stateDirectory: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homeDirectory(platform)): Promise<RestartRoute> {
  const manager = await runningManager(stateDirectory)
  if (manager === 'terminal' || manager === 'background') return manager
  if (manager !== null) return 'service'
  return serviceInstalled(stateDirectory, environment, platform, home) ? 'service' : 'serve'
}

/** What started the node serving the state directory, or null where none runs, it is still starting, or the lock cannot be read. */
async function runningManager(stateDirectory: string) {
  try {
    return (await runningNode(stateDirectory))?.record?.manager ?? null
  } catch {
    return null
  }
}

/** The steps that restart the node by `route`, where they are more than restarting `buckle serve`; null for `serve`. */
export function restartSteps(route: RestartRoute): string | null {
  if (route === 'service') return 'buckle service restart'
  if (route === 'terminal') return 'Ctrl-C at its terminal, then buckle serve again'
  if (route === 'background') return 'buckle service stop, then buckle serve --background'
  return null
}

/** What restarts, as a hint names it: `buckle serve` at a terminal, else the node. */
export function restartSubject(route: RestartRoute): string {
  return route === 'terminal' || route === 'serve' ? 'buckle serve' : 'the node'
}
