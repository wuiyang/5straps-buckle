import { existsSync } from 'node:fs'
import { z } from 'zod'
import { DANGEROUSLY_ALLOW_LEVELS, type DangerouslyAllowLevel, type DangerouslyAllowStore } from '../../types/ports/dangerously-allow-store.js'
import { createJsonFileStore } from '../json-file-store.js'

/**
 * An entry names its level only at `all`: the switch at `command` is written as it was before levels, so a node that
 * knows no level reads it the same, and one reading `all` fails closed, as an entry it cannot read is the switch off.
 */
const fileSchema = z.object({
  version: z.literal(1),
  workspaces: z.record(z.string(), z.object({ on: z.literal(true), level: z.enum(DANGEROUSLY_ALLOW_LEVELS).optional(), changedAt: z.iso.datetime() }).strict()),
})

type SwitchFile = z.infer<typeof fileSchema>

function levelIn(file: SwitchFile, key: string): DangerouslyAllowLevel | null {
  const entry = file.workspaces[key]
  return entry === undefined ? null : entry.level ?? 'command'
}

/**
 * The switch in its own file, keyed by workspace id, and held
 * only while on. Like every state file it lives in the state directory, which the rules refuse to
 * every tool and the sandbox hides from every command.
 */
export function createFileDangerouslyAllowStore(input: { filePath: string; workspace: string; lockDeadlineMs?: number }): DangerouslyAllowStore {
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, workspaces: {} }, lockDeadlineMs: input.lockDeadlineMs })
  return {
    level: () => levelIn(store.read(), input.workspace),
    async set(level) {
      await store.update((state) => {
        if (level !== null) state.workspaces[input.workspace] = { on: true, ...(level === 'all' ? { level } : {}), changedAt: new Date().toISOString() }
        else delete state.workspaces[input.workspace]
      })
    },
  }
}

/**
 * Moves a switch kept under a workspace's folder to its id (the workspace-model migration), or drops it where `to` is
 * null: a registered workspace's switch needed the node's own on too, and with that gate gone (Q14) a switch the node's
 * gate held off must not turn on.
 */
export async function rekeySwitch(input: { filePath: string; from: string; to: string | null; lockDeadlineMs?: number }): Promise<void> {
  if (!existsSync(input.filePath)) return
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, workspaces: {} }, lockDeadlineMs: input.lockDeadlineMs })
  await store.update((state) => {
    const entry = state.workspaces[input.from]
    if (entry === undefined) return
    delete state.workspaces[input.from]
    if (input.to !== null) state.workspaces[input.to] = entry
  })
}

/** The keys a switch file holds the switch on under; none where no file is. Throws StateFileError where it cannot be read. */
export function switchKeys(filePath: string): string[] {
  return Object.keys(readSwitchFile(filePath).workspaces)
}

/** The level a switch file holds the switch on at under a key, null where it is off or no file is. Throws StateFileError where it cannot be read. */
export function switchLevel(filePath: string, key: string): DangerouslyAllowLevel | null {
  return levelIn(readSwitchFile(filePath), key)
}

function readSwitchFile(filePath: string): SwitchFile {
  return createJsonFileStore({ filePath, schema: fileSchema, fallback: { version: 1 as const, workspaces: {} } }).read()
}
