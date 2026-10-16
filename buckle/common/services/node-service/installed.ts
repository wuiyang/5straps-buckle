import { existsSync, readFileSync } from 'node:fs'
import { homeDirectory } from '../../domain/paths.js'
import { readUnit, systemdUnitPaths } from '../../domain/systemd-unit.js'
import { sameDirectory } from '../../runtime/config.js'
import { taskDefinitionCopy } from './serve-record.js'

/**
 * Whether a service definition for this node is installed, read from disk without starting a program: on Linux the unit
 * naming this state directory, on Windows the task's copy kept in it. What the restart hints read (Phase 3, item 7).
 */
export function serviceInstalled(stateDirectory: string, environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homeDirectory(platform)): boolean {
  if (platform === 'win32') return existsSync(taskDefinitionCopy(stateDirectory))
  if (platform !== 'linux') return false
  const [unit] = systemdUnitPaths(environment, home)
  if (!existsSync(unit!)) return false
  try {
    const named = readUnit(readFileSync(unit!, 'utf8')).stateDirectory
    return named !== null && sameDirectory(named, stateDirectory, platform)
  } catch {
    return false
  }
}
