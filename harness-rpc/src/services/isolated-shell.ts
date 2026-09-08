import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { isInsideAny, isInside } from '../domain/paths.js'
import { sensitivePathReason } from '../domain/permission/rules/sensitive-path-rule.js'
import { ToolExecutionError } from '../domain/tool.js'
import { logger } from '../logger.js'
import { applySnapshot, changedPaths, snapshot, type Snapshot } from './history/snapshot.js'
import type { ChangeHistory, HistoryInput } from './history/journal.js'

export interface IsolatedShellOptions {
  directory: string
  maxBytes: number
  history: ChangeHistory
}

export async function runIsolatedShell<T>(input: {
  isolation: IsolatedShellOptions
  sourceRoot: string
  writableRoots: string[]
  excluded: string[]
  details: Omit<HistoryInput, 'roots'>
  execute: (copyRoot: string) => Promise<T>
}): Promise<T> {
  const id = `shell-${randomUUID()}`
  const directory = join(input.isolation.directory, id)
  const copyRoot = join(directory, 'workspace')
  const objects = join(directory, 'objects')
  mkdirSync(objects, { recursive: true, mode: 0o700 })
  const metadata = { id, ...input.details, sourceRoot: input.sourceRoot, copyRoot }
  const record = (status: string) => writeFileSync(join(directory, 'run.json'), JSON.stringify({ ...metadata, status }), { mode: 0o600 })
  const content = (hash: string) => readFileSync(join(objects, hash))
  const save = (hash: string, buffer: Buffer) => {
    const path = join(objects, hash)
    if (!existsSync(path)) writeFileSync(path, buffer, { mode: 0o600, flag: 'wx' })
  }
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
    record('publishing')
    const after = relocate(snapshot({ roots: [copyRoot], excluded: [], maxBytes: input.isolation.maxBytes, save }), copyRoot, input.sourceRoot)
    assertPublishable({ before, after, sourceRoot: input.sourceRoot, writableRoots: input.writableRoots, excluded: input.excluded })
    await input.isolation.history.promote({ ...input.details, roots: [input.sourceRoot] }, before, after, content)
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
      record('needs_review')
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

function assertPublishable(input: { before: Snapshot; after: Snapshot; sourceRoot: string; writableRoots: string[]; excluded: string[] }): void {
  for (const path of changedPaths(input.before, input.after)) {
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
