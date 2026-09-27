import { isInside } from '../../domain/paths.js'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { createJsonFileStore } from '../../adapters/json-file-store.js'

const mapSchema = z.object({ version: z.literal(1), workspaces: z.record(z.string().refine(isAbsolute, 'Workspace paths must be absolute'), z.uuid()).refine(entries => new Set(Object.values(entries)).size === Object.keys(entries).length, 'Workspace IDs must be unique') })
export interface WorkspaceConfigLocation { id: string; root: string; directory: string; file: string; state: string }

function workspaceMap(home = homedir()) {
  const directory = join(home, '.5straps', 'workspaces')
  const store = createJsonFileStore({ filePath: join(directory, 'map.json'), schema: mapSchema, fallback: { version: 1 as const, workspaces: {} } })
  return { directory, store }
}
function location(directory: string, root: string, id: string): WorkspaceConfigLocation {
  const workspaceDirectory = join(directory, id)
  return { id, root, directory: workspaceDirectory, file: join(workspaceDirectory, 'buckle.env'), state: join(workspaceDirectory, 'state') }
}

export function findWorkspaceConfig(input: { cwd: string; home?: string; exact?: boolean }): WorkspaceConfigLocation | null {
  const { directory, store } = workspaceMap(input.home)
  const entries = store.read().workspaces
  let path = realpathSync(input.cwd)
  for (;;) {
    const id = entries[path]
    if (id) return location(directory, path, id)
    const parent = dirname(path)
    if (input.exact || parent === path) return null
    path = parent
  }
}

/** BUCKLE_ENV_FILE, else the nearest registered workspace's file; null when neither exists. */
export function workspaceEnvironmentFile(input: { cwd: string; explicit?: string; home?: string }): string | null {
  if (input.explicit) return resolve(input.cwd, input.explicit)
  const registered = findWorkspaceConfig(input)
  if (!registered) return null
  if (!existsSync(registered.file)) throw new Error('Registered workspace configuration is missing; repair it or run buckle init --force from the workspace root')
  const configured = parseEnv(readFileSync(registered.file, 'utf8')).BUCKLE_WORKSPACE_ROOT
  if (!configured || realpathSync(configured) !== registered.root) throw new Error('Workspace configuration and path map disagree; repair the mapping before starting Buckle')
  return registered.file
}

/** The map lock serializes initialization; only publish a mapping after its configuration exists. */
export function registerWorkspaceConfig(input: { root: string; home?: string; write: (entry: WorkspaceConfigLocation) => void }): WorkspaceConfigLocation {
  const root = realpathSync(input.root)
  const { directory, store } = workspaceMap(input.home)
  if (isInside(root, directory)) throw new Error('Workspace root must not contain the private workspace configuration directory')
  return store.update(map => {
    const entry = location(directory, root, map.workspaces[root] ?? randomUUID())
    mkdirSync(entry.directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    chmodSync(entry.directory, 0o700)
    input.write(entry)
    map.workspaces[root] = entry.id
    return entry
  })
}

/** Retain the ID when an owner changes a managed workspace's root. */
export function moveWorkspaceConfig(input: { file: string; root: string; home?: string; write: () => boolean }): boolean {
  const { directory, store } = workspaceMap(input.home)
  const file = resolve(input.file)
  const mapped = Object.entries(store.read().workspaces).find(([root, id]) => location(directory, root, id).file === file)
  if (!mapped) return input.write()
  const nextRoot = realpathSync(input.root)
  if (isInside(nextRoot, directory)) throw new Error('Workspace root must not contain the private workspace configuration directory')
  return store.update(map => {
    const [oldRoot, id] = mapped
    if (map.workspaces[oldRoot] !== id) throw new Error('Workspace mapping changed; retry the settings command')
    if (map.workspaces[nextRoot] && map.workspaces[nextRoot] !== id) throw new Error('The new root already belongs to another registered workspace')
    if (!input.write()) return false
    delete map.workspaces[oldRoot]
    map.workspaces[nextRoot] = id
    return true
  })
}

export function isManagedWorkspaceConfig(file: string, home?: string): boolean {
  const { directory, store } = workspaceMap(home)
  return Object.entries(store.read().workspaces).some(([root, id]) => location(directory, root, id).file === resolve(file))
}
