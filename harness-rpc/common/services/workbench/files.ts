import { invokePinnedWorkbenchFile } from './safe-files.js'
import { isUtf8 } from 'node:buffer'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { JsonObject, JsonValue, WorkbenchChange } from '@5straps/protocol'
import { createPathView } from '../../domain/path-view.js'
import { isInside } from '../../domain/paths.js'
import { sensitivePathReason } from '../../domain/permission/rules/sensitive-path-rule.js'
import { createToolRegistry } from '../../domain/tool-registry.js'
import { createFsPack } from '../packs/fs/index.js'
import { runProcess } from '../../adapters/process-runner.js'
import { realPathOrPlanned } from '../invocation/real-path.js'
import { applySnapshot, changedPaths, snapshot, snapshotSchema, type Snapshot } from '../history/snapshot.js'
import { WorkbenchError, writeWorkbenchJson } from './storage.js'

export interface WorkbenchFileOptions {
  sourceRoot: string
  directory: string
  maxBytes: number
  protectedRoots: string[]
  authorizePath(path: string, operation: 'read' | 'write'): boolean
  hasRipgrep: boolean
}
export function createWorkbenchFiles(options: WorkbenchFileOptions) {
  function root(id: string): string { return join(options.directory, id, 'workspace') }
  function objectPath(id: string, hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new WorkbenchError('Invalid stored content', 422)
    return join(options.directory, id, 'objects', hash)
  }
  function saveObject(id: string, hash: string, content: Buffer): void {
    const path = objectPath(id, hash)
    if (!existsSync(path)) writeFileSync(path, content, { mode: 0o600, flag: 'wx' })
  }
  function permitted(path: string, operation: 'read' | 'write'): boolean {
    return !sensitivePathReason(join(options.sourceRoot, path)) && !sensitivePathReason(join(options.sourceRoot, path, 'entry')) && options.authorizePath(path || '.', operation)
  }
  function excluded(): string[] {
    const paths = [...options.protectedRoots]
    let visited = 0
    function walk(path: string): void {
      if (++visited > 100_000) throw new WorkbenchError('Workspace has too many entries to stage', 413)
      if (paths.some(excludedPath => isInside(excludedPath, path))) return
      const info = lstatSync(path)
      if (!permitted(relative(options.sourceRoot, path) || '.', 'read') || info.isSymbolicLink()) { paths.push(path); return }
      if (info.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name))
    }
    walk(options.sourceRoot)
    return paths
  }
  function canonical(captured: Snapshot, fromRoot: string): Snapshot {
    return Object.fromEntries(Object.entries(captured).map(([path, entry]) => {
      if (!isInside(fromRoot, path)) throw new WorkbenchError('Staged path escaped its workspace', 403)
      if (entry.kind === 'symlink') {
        if (!entry.target || entry.target.startsWith('/') || !isInside(fromRoot, resolve(dirname(path), entry.target))) throw new WorkbenchError('Staged symbolic link leaves its workspace', 403)
      }
      return [join(options.sourceRoot, relative(fromRoot, path)), entry]
    }))
  }
  function capture(id: string): Snapshot {
    return canonical(snapshot({ roots: [root(id)], excluded: [], maxBytes: options.maxBytes, save: (hash, content) => saveObject(id, hash, content) }), root(id))
  }
  function base(id: string): Snapshot { return snapshotSchema.parse(JSON.parse(readFileSync(join(options.directory, id, 'base.json'), 'utf8'))) }
  async function authorize(id: string, named: string, operation: 'read' | 'write'): Promise<string> {
    const view = createPathView({ root: root(id), mount: '/workspace' })
    const path = view.resolve(named)
    const actual = await realPathOrPlanned(path)
    if (!isInside(root(id), actual)) throw new WorkbenchError('Path is outside this workbench', 403)
    for (const item of [path, actual]) if (!permitted(relative(root(id), item) || '.', operation)) throw new WorkbenchError('Workspace permission does not allow this operation', 403)
    return actual
  }
  function checkBudget(id: string): void {
    let bytes = 0, count = 0
    function visit(path: string): void {
      const info = lstatSync(path)
      if (++count > 100_000 || (bytes += info.isFile() ? info.size : 0) > options.maxBytes) throw new WorkbenchError('Staged filesystem exceeded its configured size limit', 413)
      if (info.isDirectory() && !info.isSymbolicLink()) for (const name of readdirSync(path)) visit(join(path, name))
    }
    visit(root(id))
  }
  return { root, capture, base, permitted, authorize, checkBudget,
    object: (id: string, hash: string) => readFileSync(objectPath(id, hash)),
    current(id: string): Snapshot {
      return snapshot({ roots: [options.sourceRoot], excluded: excluded(), maxBytes: options.maxBytes, save: (hash, content) => saveObject(id, hash, content) })
    },
    prepare(id: string) {
      mkdirSync(join(options.directory, id, 'objects'), { recursive: true, mode: 0o700 })
      const before = snapshot({ roots: [options.sourceRoot], excluded: excluded(), maxBytes: options.maxBytes, save: (hash, content) => saveObject(id, hash, content) })
      if (!before[options.sourceRoot]) throw new WorkbenchError('Workspace root is not readable', 403)
      const copied = Object.fromEntries(Object.entries(before).map(([path, entry]) => [join(root(id), relative(options.sourceRoot, path)), entry]))
      applySnapshot({ current: {}, target: copied, paths: Object.keys(copied), content: hash => readFileSync(objectPath(id, hash)) })
      writeWorkbenchJson(join(options.directory, id, 'base.json'), before)
    },
    async invoke(id: string, chatId: string, tool: string, args: JsonObject): Promise<JsonValue> {
      if (process.platform === 'linux') return invokePinnedWorkbenchFile({ root: root(id), tool, args, permitted })
      if (!['fs_read', 'fs_write', 'fs_list', 'fs_find_names', 'fs_search_content'].includes(tool)) throw new WorkbenchError('Tool is unavailable in the staged workbench', 400)
      const paths = createPathView({ root: root(id), mount: '/workspace' })
      const pack = createFsPack({ paths, runProcess, hasRipgrep: options.hasRipgrep })
      const prepared = createToolRegistry(pack.tools).get(tool).prepare(args)
      for (const effect of prepared.effects) {
        if (effect.kind === 'read_path' || effect.kind === 'write_path') await authorize(id, effect.path, effect.kind === 'read_path' ? 'read' : 'write')
        else throw new WorkbenchError('Only filesystem tools are supported in the staged editor', 403)
      }
      if (tool === 'fs_write' && typeof args.expectedHash !== 'string') throw new WorkbenchError('Saving requires the file revision returned by fs_read', 400)
      return prepared.execute({ requestId: id, sessionId: chatId, timeoutMs: 15_000, signal: AbortSignal.timeout(15_000),
        authorizeRead: async path => { try { await authorize(id, path, 'read'); return true } catch (error) { if (error instanceof WorkbenchError) return false; throw error } },
      })
    },
    assertWritableChanges(before: Snapshot, after: Snapshot) {
      for (const path of changedPaths(before, after)) {
        const name = relative(options.sourceRoot, path) || '.'
        if (!isInside(options.sourceRoot, path) || !permitted(name, 'write') || !permitted(name, 'read')) throw new WorkbenchError('A staged change is outside current workspace permissions', 403)
      }
    },
    describe(id: string, before: Snapshot, after: Snapshot): WorkbenchChange[] {
      const changedFiles = changedPaths(before, after)
      if (changedFiles.length > 5000) throw new WorkbenchError('Review exceeds 5,000 changed paths; split the work into smaller stages', 413)
      let previewBytes = 0
      return changedFiles.map(path => {
        const original = before[path]?.hash ? readFileSync(objectPath(id, before[path]!.hash!)) : null
        const changed = after[path]?.hash ? readFileSync(objectPath(id, after[path]!.hash!)) : null
        previewBytes += (original?.byteLength ?? 0) + (changed?.byteLength ?? 0)
        const binary = previewBytes > 4_194_304 || [original, changed].some(value => value !== null && (!isUtf8(value) || value.includes(0) || value.byteLength > 262_144))
        return { path: relative(options.sourceRoot, path) || '.', kind: !before[path] ? 'created' : !after[path] ? 'deleted' : 'modified',
          before: binary ? null : original?.toString('utf8') ?? null, after: binary ? null : changed?.toString('utf8') ?? null, binary }
      })
    },
  }
}
export type WorkbenchFiles = ReturnType<typeof createWorkbenchFiles>
