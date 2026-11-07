import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { logger } from '../../runtime/log.js'
import { DANGEROUSLY_ALLOW_ON_MODES, type DangerouslyAllowMode, type DangerouslyAllowReading, type DangerouslyAllowStore } from '../../types/ports/dangerously-allow-store.js'
import { createJsonFileStore } from '../json-file-store.js'

const CURRENT_VERSION = 2

const currentFileSchema = z.object({
  version: z.literal(CURRENT_VERSION),
  workspaces: z.record(z.string(), z.object({ mode: z.enum(DANGEROUSLY_ALLOW_ON_MODES), changedAt: z.iso.datetime() }).strict()),
})

/** A file an earlier build wrote, whose levels this build does not read: every entry in it reads as off. */
const earlierFileSchema = z.object({ version: z.literal(1), workspaces: z.record(z.string(), z.unknown()) })

const fileSchema = z.discriminatedUnion('version', [currentFileSchema, earlierFileSchema])

type SwitchFile = z.infer<typeof fileSchema>

type EarlierFile = z.infer<typeof earlierFileSchema>

type CurrentEntries = z.infer<typeof currentFileSchema>['workspaces']

const EMPTY: SwitchFile = { version: CURRENT_VERSION, workspaces: {} }

const EARLIER_COPY = 'dangerously-allow.earlier.json'

const NO_EARLIER_ENTRIES: EarlierFile = { version: 1, workspaces: {} }

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
      await store.update(async (state) => {
        const workspaces: CurrentEntries = state.version === CURRENT_VERSION ? state.workspaces : {}
        if (state.version !== CURRENT_VERSION) await keepEarlierFile({ ...input, file: state })
        if (mode === 'off') delete workspaces[input.workspace]
        else workspaces[input.workspace] = { mode, changedAt: new Date().toISOString() }
        // An earlier build's file is replaced whole, as none of its entries is read.
        Object.assign(state, { version: CURRENT_VERSION, workspaces })
      })
    },
  }
}

/** Copies an earlier build's file whole beside the switch file before the first version 2 write replaces it, once: a copy already there is kept. */
async function keepEarlierFile(input: { filePath: string; lockDeadlineMs?: number; file: EarlierFile }): Promise<void> {
  const copy = join(dirname(input.filePath), EARLIER_COPY)
  if (existsSync(copy)) return
  await createJsonFileStore({ filePath: copy, schema: earlierFileSchema, fallback: NO_EARLIER_ENTRIES, lockDeadlineMs: input.lockDeadlineMs }).write(input.file)
  logger.info('Kept an earlier build\'s dangerously-allow file beside the switch file, as it holds entries this build does not read', { copy, entries: Object.keys(input.file.workspaces).length })
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

/** What a switch file holds under a key, off where no file is. Throws StateFileError where it cannot be read. */
export function switchReading(filePath: string, key: string): DangerouslyAllowReading {
  return readingIn(readSwitchFile(filePath), key)
}

function readSwitchFile(filePath: string): SwitchFile {
  return createJsonFileStore({ filePath, schema: fileSchema, fallback: EMPTY }).read()
}
