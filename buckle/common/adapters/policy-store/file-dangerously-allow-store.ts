import { existsSync } from 'node:fs'
import { z } from 'zod'
import { DANGEROUSLY_ALLOW_ON_MODES, type DangerouslyAllowMode, type DangerouslyAllowReading, type DangerouslyAllowStore } from '../../types/ports/dangerously-allow-store.js'
import { createJsonFileStore } from '../json-file-store.js'

const CURRENT_VERSION = 2

const currentFileSchema = z.object({
  version: z.literal(CURRENT_VERSION),
  workspaces: z.record(z.string(), z.object({ mode: z.enum(DANGEROUSLY_ALLOW_ON_MODES), changedAt: z.iso.datetime() }).strict()),
})

/** A file an earlier build wrote, whose levels this build does not read: every entry in it reads as off (BUILD-02). */
const earlierFileSchema = z.object({ version: z.literal(1), workspaces: z.record(z.string(), z.unknown()) })

const fileSchema = z.discriminatedUnion('version', [currentFileSchema, earlierFileSchema])

type SwitchFile = z.infer<typeof fileSchema>

type CurrentEntries = z.infer<typeof currentFileSchema>['workspaces']

const EMPTY: SwitchFile = { version: CURRENT_VERSION, workspaces: {} }

function readingIn(file: SwitchFile, key: string): DangerouslyAllowReading {
  if (file.version !== CURRENT_VERSION) return { mode: 'off', setByEarlierBuild: Object.hasOwn(file.workspaces, key) }
  return { mode: file.workspaces[key]?.mode ?? 'off', setByEarlierBuild: false }
}

/**
 * The switch in its own file, keyed by workspace id, and held
 * only while on. Like every state file it lives in the state directory, which the rules refuse to
 * every tool and the sandbox hides from every command.
 */
export function createFileDangerouslyAllowStore(input: { filePath: string; workspace: string; lockDeadlineMs?: number }): DangerouslyAllowStore {
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: EMPTY, lockDeadlineMs: input.lockDeadlineMs })
  return {
    read: () => readingIn(store.read(), input.workspace),
    async set(mode) {
      await store.update((state) => {
        const workspaces: CurrentEntries = state.version === CURRENT_VERSION ? state.workspaces : {}
        if (mode === 'off') delete workspaces[input.workspace]
        else workspaces[input.workspace] = { mode, changedAt: new Date().toISOString() }
        // An earlier build's file is replaced whole, as none of its entries is read.
        Object.assign(state, { version: CURRENT_VERSION, workspaces })
      })
    },
  }
}

/**
 * Moves a switch kept under a workspace's folder to its id (the workspace-model migration), or drops it where `to` is
 * null: a registered workspace's switch needed the node's own on too, and with that gate gone (Q14) a switch the node's
 * gate held off must not turn on. An earlier build's file keeps its version, so the entry still reads as off.
 */
export async function rekeySwitch(input: { filePath: string; from: string; to: string | null; lockDeadlineMs?: number }): Promise<void> {
  if (!existsSync(input.filePath)) return
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: EMPTY, lockDeadlineMs: input.lockDeadlineMs })
  await store.update(state => rekeyed<unknown>({ workspaces: state.workspaces, from: input.from, to: input.to }))
}

function rekeyed<T>(input: { workspaces: Record<string, T>; from: string; to: string | null }): void {
  const entry = input.workspaces[input.from]
  if (entry === undefined) return
  delete input.workspaces[input.from]
  if (input.to !== null) input.workspaces[input.to] = entry
}

/** The keys a switch file holds an entry under, an earlier build's included; none where no file is. Throws StateFileError where it cannot be read. */
export function switchKeys(filePath: string): string[] {
  return Object.keys(readSwitchFile(filePath).workspaces)
}

/** The mode a switch file holds under a key, off where no file is. Throws StateFileError where it cannot be read. */
export function switchMode(filePath: string, key: string): DangerouslyAllowMode {
  return readingIn(readSwitchFile(filePath), key).mode
}

function readSwitchFile(filePath: string): SwitchFile {
  return createJsonFileStore({ filePath, schema: fileSchema, fallback: EMPTY }).read()
}
