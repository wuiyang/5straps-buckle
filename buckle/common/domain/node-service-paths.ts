import { join } from 'pathe'

/** Where a node's service files live: owner-only, inside the state directory, so no agent tool reads or writes them. */
export function serviceDirectory(stateDirectory: string): string {
  return join(stateDirectory, 'service')
}

/** The Windows task's definition as Buckle wrote it, kept in the state directory, where no agent tool reads or writes it. */
export function taskDefinitionCopy(stateDirectory: string): string {
  return join(serviceDirectory(stateDirectory), 'task.xml')
}

/** The one rotating log a node running with no terminal writes, inside the state directory. */
export function serviceLogPath(stateDirectory: string): string {
  return join(stateDirectory, 'logs', 'buckle.log')
}
