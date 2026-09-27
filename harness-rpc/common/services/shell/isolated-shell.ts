import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { isInsideAny, isInside } from '../../domain/paths.js'
import { sensitivePathReason } from '../../domain/permission/rules/sensitive-path-rule.js'
import { ToolExecutionError } from '../../domain/tool.js'
import { logger } from '../../runtime/logger.js'
import { applySnapshot, changedPaths, snapshot, snapshotSchema, type Snapshot } from '../history/snapshot.js'
import type { ChangeHistory, HistoryInput } from '../history/journal.js'

export interface IsolatedShellOptions {
  directory: string
  maxBytes: number
  history: ChangeHistory
}

interface ShellRunInput<T> {
  isolation: IsolatedShellOptions
  sourceRoot: string
  writableRoots: string[]
  excluded: string[]
  readOnlyPaths?: string[]
  readOnlyOverlayPaths?: string[]
  details: Omit<HistoryInput, 'roots'>
  execute: (copyRoot: string) => Promise<T>
}

export async function runIsolatedShell<T>(input: ShellRunInput<T>): Promise<T> {
  const id = `shell-${randomUUID()}`
  return withWorkspaceLock(input.isolation.directory, id, () => executeIsolatedShell(input, id))
}

async function executeIsolatedShell<T>(input: ShellRunInput<T>, id: string): Promise<T> {
  const directory = join(input.isolation.directory, id)
  const copyRoot = join(directory, 'workspace')
  const objects = join(directory, 'objects')
  mkdirSync(objects, { recursive: true, mode: 0o700 })
  const metadata = { id, ...input.details, sourceRoot: input.sourceRoot, copyRoot, writableRoots: input.writableRoots, excluded: input.excluded, readOnlyPaths: input.readOnlyPaths ?? [], readOnlyOverlayPaths: input.readOnlyOverlayPaths ?? [], createdAt: new Date().toISOString() }
  const record = (status: string) => writeWorkspaceRecord(directory, { ...metadata, status })
  const content = (hash: string) => readFileSync(join(objects, hash))
  const save = (hash: string, buffer: Buffer) => {
    const path = join(objects, hash)
    if (!existsSync(path)) writeFileSync(path, buffer, { mode: 0o600, flag: 'wx' })
  }
  let publishing = false
  let started = false
  try {
    record('preparing')
    const before = snapshot({ roots: [input.sourceRoot], excluded: input.excluded, maxBytes: input.isolation.maxBytes, save })
    const copied = relocate(before, input.sourceRoot, copyRoot)
    applySnapshot({ current: {}, target: copied, paths: Object.keys(copied), content })
    writeFileSync(join(directory, 'before.json'), JSON.stringify(before), { mode: 0o600 })
    record('running')
    started = true
    const result = await input.execute(copyRoot)
    const after = relocate(snapshot({ roots: [copyRoot], excluded: (input.readOnlyOverlayPaths ?? []).map(path => resolve(copyRoot, relative(input.sourceRoot, path))), maxBytes: input.isolation.maxBytes, save }), copyRoot, input.sourceRoot)
    assertPublishable({ before, after, sourceRoot: input.sourceRoot, writableRoots: input.writableRoots, excluded: input.excluded, readOnlyPaths: input.readOnlyPaths })
    await input.isolation.history.promote({ ...input.details, roots: [input.sourceRoot], excluded: input.readOnlyOverlayPaths }, before, after, content, () => { publishing = true; record('publishing') })
    record('published')
    try { removePrivateWorkspace(directory) } catch (error) {
      logger.warn('Published shell workspace cleanup failed', { id, directory, message: error instanceof Error ? error.message : 'Unknown error' })
    }
    return result
  } catch (error) {
    if (!started) {
      logger.error('Isolated shell preparation failed', { id, directory, message: error instanceof Error ? error.message : 'Unknown error' })
      removePrivateWorkspace(directory)
    }
    else {
      record(publishing ? 'publication_uncertain' : 'needs_review')
      logger.warn('Isolated shell changes retained for owner review', { id, directory, message: error instanceof Error ? error.message : 'Unknown error' })
    }
    throw new ToolExecutionError(started ? `Isolated shell changes need owner review (${id}); inspect the retained copy and checkpoint history` : 'Could not prepare an isolated workspace; inspect owner logs', { code: 'ISOLATED_WORKSPACE_FAILED' })
  }
}

function relocate(source: Snapshot, from: string, to: string): Snapshot {
  return Object.fromEntries(Object.entries(source).map(([path, entry]) => {
    if (!isInside(from, path)) throw new Error('Snapshot path escaped its workspace')
    return [resolve(to, relative(from, path)), entry]
  }))
}

function assertPublishable(input: { before: Snapshot; after: Snapshot; sourceRoot: string; writableRoots: string[]; excluded: string[]; readOnlyPaths?: string[] }): void {
  for (const path of changedPaths(input.before, input.after)) {
    if (isInsideAny(input.readOnlyPaths ?? [], path)) throw new Error('Workspace policy refuses publication to this read-only path')
    const entry = input.after[path]
    if (!isInsideAny(input.writableRoots, path) || isInsideAny(input.excluded, path)) throw new Error('A shell change is outside its approved writable roots')
    if (sensitivePathReason(path) || entry?.kind === 'directory' && sensitivePathReason(join(path, 'entry'))) throw new Error('Credential paths cannot be published from a shell')
    if (entry?.kind === 'symlink' && !isInside(input.sourceRoot, resolve(dirname(path), entry.target!))) throw new Error('A new symbolic link leaves the workspace')
  }
}

function removePrivateWorkspace(directory: string): void {
  if (!lstatSync(directory).isDirectory()) { rmSync(directory); return }
  chmodSync(directory, 0o700)
  for (const name of readdirSync(directory)) removePrivateWorkspace(join(directory, name))
  rmSync(directory, { recursive: true })
}

const workspaceIdSchema = z.string().regex(/^shell-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const workspaceRecordSchema = z.object({
  id: workspaceIdSchema, sessionId: z.string(), stageId: z.string(), tool: z.string(),
  sourceRoot: z.string(), copyRoot: z.string(), writableRoots: z.array(z.string()), excluded: z.array(z.string()), readOnlyPaths: z.array(z.string()).default([]), readOnlyOverlayPaths: z.array(z.string()).default([]),
  createdAt: z.iso.datetime(), status: z.enum(['preparing', 'running', 'needs_review', 'publishing', 'publication_uncertain', 'published']),
})

export function createShellWorkspaceRecovery(input: IsolatedShellOptions & { sourceRoot: string; retentionDays: number }) {
  function read(id: string) {
    workspaceIdSchema.parse(id)
    const directory = join(input.directory, id)
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid retained workspace directory')
    const record = workspaceRecordSchema.parse(JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8')))
    if (record.id !== id || record.sourceRoot !== input.sourceRoot || record.copyRoot !== join(directory, 'workspace')) throw new Error('Retained workspace does not belong to this workspace')
    return record
  }
  function capture(record: z.infer<typeof workspaceRecordSchema>) {
    const before = snapshotSchema.parse(JSON.parse(readFileSync(join(input.directory, record.id, 'before.json'), 'utf8')))
    if (Object.keys(before).some(path => !isInside(input.sourceRoot, path))) throw new Error('Retained snapshot escapes its workspace')
    const objects = new Map<string, Buffer>()
    const after = relocate(snapshot({ roots: [record.copyRoot], excluded: record.readOnlyOverlayPaths.map(path => resolve(record.copyRoot, relative(input.sourceRoot, path))), maxBytes: input.maxBytes, save: (hash, content) => { objects.set(hash, content) } }), record.copyRoot, input.sourceRoot)
    return { before, after, objects }
  }
  return {
    list() {
      if (!existsSync(input.directory)) return []
      return readdirSync(input.directory).filter(id => workspaceIdSchema.safeParse(id).success).map(read)
    },
    async inspect(id: string) {
      return withWorkspaceLock(input.directory, id, async () => {
        const record = read(id)
        const { before, after } = capture(record)
        return { ...record, paths: changedPaths(before, after) }
      })
    },
    async publish(id: string) {
      return withWorkspaceLock(input.directory, id, async () => {
        const record = read(id)
        if (!['needs_review', 'running'].includes(record.status)) throw new Error('Publication state is uncertain; inspect checkpoint history before discarding or manually recovering files')
        const { before, after, objects } = capture(record)
        assertPublishable({ before, after, sourceRoot: input.sourceRoot, writableRoots: record.writableRoots, excluded: record.excluded, readOnlyPaths: record.readOnlyPaths })
        const saveStatus = (status: string) => writeWorkspaceRecord(join(input.directory, id), { ...record, status })
        const checkpoint = await input.history.promote({ sessionId: record.sessionId, stageId: record.stageId, tool: 'owner_workspace_publish', roots: [input.sourceRoot], excluded: record.readOnlyOverlayPaths }, before, after, hash => {
          const content = objects.get(hash)
          if (!content) throw new Error('Retained workspace content is missing')
          return content
        }, () => saveStatus('publishing'))
        saveStatus('published')
        removePrivateWorkspace(join(input.directory, id))
        return { id, checkpoint }
      })
    },
    async discard(id: string) {
      return withWorkspaceLock(input.directory, id, async () => { read(id); removePrivateWorkspace(join(input.directory, id)); return { id, discarded: true } })
    },
    async prune() {
      const removed: string[] = []
      if (!existsSync(input.directory)) return { removed }
      for (const id of readdirSync(input.directory).filter(id => workspaceIdSchema.safeParse(id).success)) {
        try {
          await withWorkspaceLock(input.directory, id, async () => {
            const record = read(id)
            if (record.status !== 'published' || Date.parse(record.createdAt) >= Date.now() - input.retentionDays * 86_400_000) return
            removePrivateWorkspace(join(input.directory, id)); removed.push(id)
          })
        } catch (error) {
          if (!(error instanceof WorkspaceActiveError)) throw error
          logger.info('Skipped active shell workspace during prune', { id })
        }
      }
      return { removed }
    },
  }
}

async function withWorkspaceLock<T>(directory: string, id: string, operation: () => Promise<T>): Promise<T> {
  workspaceIdSchema.parse(id)
  const locks = `${directory}.locks`
  mkdirSync(locks, { recursive: true, mode: 0o700 })
  const lockPath = join(locks, `${id}.sqlite`)
  const lock = new DatabaseSync(lockPath, { timeout: 0 })
  try {
    try { lock.exec('BEGIN IMMEDIATE') } catch (error) {
      if (error instanceof Error && /locked|busy/i.test(error.message)) throw new WorkspaceActiveError('Shell workspace is active; wait for execution or recovery to finish')
      throw error
    }
    return await operation()
  } finally {
    lock.close()
    if (!existsSync(join(directory, id))) rmSync(lockPath, { force: true })
  }
}

function writeWorkspaceRecord(directory: string, record: unknown): void {
  const temporary = join(directory, `run-${randomUUID()}.json`)
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  try { renameSync(temporary, join(directory, 'run.json')) }
  finally { rmSync(temporary, { force: true }) }
}

class WorkspaceActiveError extends Error {}
