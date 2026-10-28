import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, mkdirSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'pathe'
import { z } from 'zod'
import { requireOwnerOnly, setMode } from '../../adapters/file-modes.js'
import { resolveProgram, rootsOf, type Program, type UntrustedRoots } from '../../domain/executable.js'
import { isInside } from '../../domain/paths.js'
import { captureHashes } from './capture-hashes.js'
import { snapshotSchema, type Snapshot } from './snapshot.js'

export const DEFAULT_HISTORY_FILE_BYTES = 32 * 1_048_576
export const treeCaptureSchema = z.object({ root: z.string(), workTree: z.string(), selector: z.string(), git: z.string(), commit: z.string(), extra: snapshotSchema })
export type TreeCapture = z.infer<typeof treeCaptureSchema>
export interface CapturedState { snapshot: Snapshot; trees: TreeCapture[]; restorable: boolean; reason?: string }
const HASH = /^[a-f0-9]{40,64}$/
const CHECKPOINT_ID = /^change-[a-zA-Z0-9-]+$/
const RAW_ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n**/* -text -filter -ident -working-tree-encoding\n'

export function historyGitProgram(input: { allowed: boolean; roots: string[]; untrusted?: UntrustedRoots }): Program | null {
  if (!input.allowed) return null
  const found = resolveProgram('git', { ...input.untrusted, untrustedRoots: [...input.untrusted?.untrustedRoots ?? [], ...rootsOf('workspace', input.roots)] })
  return found.path === null ? null : found
}

export function createGitStore(input: { directory: string; excluded: string[]; maxFileBytes: () => number; allowed: () => boolean; untrusted?: () => UntrustedRoots; platform?: NodeJS.Platform }) {
  const owned = join(input.directory, 'git-private')
  mkdirSync(owned, { recursive: true, mode: 0o700 })
  const empty = join(owned, 'empty'); mkdirSync(empty, { recursive: true, mode: 0o700 })
  const config = join(owned, 'config'); writeFileSync(config, '', { mode: 0o600 })
  const primaryFile = join(owned, 'primary-root')
  let primary: string | undefined = existsSync(primaryFile) ? readFileSync(primaryFile, 'utf8') : undefined
  let program: Program | null | undefined
  const exclusions = [...input.excluded, input.directory]
  const safeEnv = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
  const environment = { ...safeEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: '', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1', GIT_AUTHOR_NAME: 'Buckle history', GIT_AUTHOR_EMAIL: 'history@buckle.invalid', GIT_COMMITTER_NAME: 'Buckle history', GIT_COMMITTER_EMAIL: 'history@buckle.invalid' }
  const safety = ['-c', `core.hooksPath=${empty}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.ignoreStat=false', '-c', 'core.trustctime=true', '-c', 'core.untrackedCache=false', '-c', 'commit.gpgSign=false', '-c', 'gc.auto=0', '-c', 'gc.writeCommitGraph=false', '-c', 'core.commitGraph=false', '-c', 'maintenance.auto=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', `core.attributesFile=${config}`, '-c', 'core.fileMode=true', '-c', 'core.symlinks=true']

  async function git(state: Pick<TreeCapture, 'git' | 'workTree'>, args: string[], data?: string | Buffer, extra: Record<string, string> = {}, acceptedCodes = [0]): Promise<Buffer> {
    program = historyGitProgram({ allowed: input.allowed(), roots: ['root' in state && typeof state.root === 'string' ? state.root : state.workTree], ...(input.untrusted ? { untrusted: input.untrusted() } : {}) })
    if (!program) throw new Error('Content capture requires trusted host git')
    return runProgram({ program, args: [...safety, ...args], cwd: owned, environment: { ...environment, GIT_DIR: state.git, GIT_WORK_TREE: state.workTree, GIT_INDEX_FILE: join(state.git, 'index'), ...extra }, data, acceptedCodes })
  }
  function gitDirectory(root: string): string {
    primary = existsSync(primaryFile) ? readFileSync(primaryFile, 'utf8') : root
    if (!existsSync(primaryFile)) writeFileSync(primaryFile, primary, { mode: 0o600 })
    return root === primary ? join(input.directory, 'git') : join(input.directory, 'roots', createHash('sha256').update(root).digest('hex').slice(0, 24), 'git')
  }
  async function prepare(root: string): Promise<Pick<TreeCapture, 'root' | 'workTree' | 'selector' | 'git'>> {
    const stat = lstatSync(root, { throwIfNoEntry: false })
    let workTree = stat?.isDirectory() ? root : dirname(root)
    while (!lstatSync(workTree, { throwIfNoEntry: false })?.isDirectory() && dirname(workTree) !== workTree) workTree = dirname(workTree)
    const state = { root, workTree, selector: root === workTree ? '.' : relative(workTree, root), git: gitDirectory(root) }
    if (!existsSync(join(state.git, 'HEAD'))) {
      mkdirSync(state.git, { recursive: true, mode: 0o700 }); setMode(state.git, 0o700); requireOwnerOnly(state.git, 'directory')
      await git(state, ['init', '--quiet', `--template=${empty}`, state.git])
      mkdirSync(join(state.git, 'info'), { recursive: true, mode: 0o700 }); mkdirSync(join(state.git, 'objects', 'info'), { recursive: true, mode: 0o700 })
      writeFileSync(join(state.git, 'info', 'attributes'), RAW_ATTRIBUTES, { mode: 0o600 })
      const objects = ownerObjects(workTree)
      if (objects) writeFileSync(join(state.git, 'objects', 'info', 'alternates'), `${objects}\n`, { mode: 0o600 })
    }
    return state
  }
  async function capture(details: { roots: string[]; excluded?: string[]; id: string; phase: 'before' | 'after'; parents?: TreeCapture[] }): Promise<CapturedState> {
    const roots = normalizedRoots(details.roots)
    program = historyGitProgram({ allowed: input.allowed(), roots, ...(input.untrusted ? { untrusted: input.untrusted() } : {}) })
    const scanned = await captureHashes({ roots, excluded: [...exclusions, ...details.excluded ?? []], maxFileBytes: input.maxFileBytes(), hashFiles: !program, platform: input.platform ?? process.platform })
    if (!program) return { snapshot: scanned, trees: [], restorable: false, reason: 'History records hashes only because content capture requires permitted trusted host git' }
    const combined: Snapshot = {}
    const trees: TreeCapture[] = []
    for (const root of roots) {
      const state = await prepare(root)
      const selected = Object.fromEntries(Object.entries(scanned).filter(([path]) => isInside(root, path)))
      const omitted = Object.entries(selected).filter(([, entry]) => entry.kind === 'excluded' || entry.kind === 'unreadable').map(([path]) => path)
      const excluded = [...exclusions, ...details.excluded ?? [], ...omitted]
      writeFileSync(join(state.git, 'info', 'exclude'), excluded.filter(path => isInside(state.workTree, path)).map(path => `/${escapeIgnore(relative(state.workTree, path))}`).join('\n') + '\n', { mode: 0o600 })
      const ignoredTracked = await git(state, ['ls-files', '-ci', '--exclude-standard', '-z'])
      if (ignoredTracked.length) await git(state, ['update-index', '--force-remove', '-z', '--stdin'], ignoredTracked)
      if (existsSync(root)) await git(state, ['add', '-A', '--', state.selector])
      else await git(state, ['read-tree', '--empty'])
      const tree = (await git(state, ['write-tree'])).toString().trim()
      const parent = details.parents?.find(value => value.root === root)?.commit
      const commit = (await git(state, ['commit-tree', tree, ...parent ? ['-p', parent] : []], `Buckle ${details.id} ${details.phase}\n`)).toString().trim()
      const listed = await loadTree({ ...state, commit, extra: {} })
      const names = Object.keys(selected).filter(path => path !== state.workTree).map(path => relative(state.workTree, path))
      const checked = names.length ? (await git(state, ['check-ignore', '--no-index', '--stdin', '-z', '-v', '--non-matching'], Buffer.from(names.join('\0') + '\0'), { GIT_LITERAL_PATHSPECS: '0' }, [0, 1])).toString().split('\0') : []
      const ignored = new Set<string>()
      for (let index = 0; index + 3 < checked.length; index += 4) {
        const source = checked[index]; const pattern = checked[index + 2]; const name = checked[index + 3]
        if (source && pattern && name && !pattern.startsWith('!') && resolve(state.workTree, source) !== join(state.git, 'info', 'exclude')) ignored.add(join(state.workTree, name))
      }
      const extra: Snapshot = {}
      for (const [path, entry] of Object.entries(selected)) {
        const inheritedIgnore = ignoredAncestor(path, state.workTree, ignored)
        if ((path !== root || entry.kind !== 'directory') && (ignored.has(path) || inheritedIgnore)) {
          if (!inheritedIgnore) extra[path] = { kind: 'excluded', mode: entry.mode, reason: 'ignored' }
          continue
        }
        if (entry.kind === 'directory' ? entry.mode !== 0o755 || !listed[path] : entry.kind === 'excluded' || entry.kind === 'unreadable') extra[path] = entry
        else if (listed[path] && entry.mode !== listed[path]!.mode) extra[path] = { ...entry, hash: undefined }
        if (listed[path]) listed[path] = { ...listed[path]!, mode: entry.mode, ...(entry.kind === 'symlink' ? { target: entry.target } : {}) }
      }
      Object.assign(listed, Object.fromEntries(Object.entries(extra).filter(([, entry]) => entry.kind !== 'file' && entry.kind !== 'symlink')))
      Object.assign(combined, listed)
      const captured: TreeCapture = { ...state, commit, extra }
      trees.push(captured)
      await reference({ capture: captured, id: details.id, phase: details.phase })
    }
    return { snapshot: combined, trees, restorable: true }
  }
  async function loadTree(captured: TreeCapture): Promise<Snapshot> {
    assertHash(captured.commit)
    const result: Snapshot = {}
    const raw = await git(captured, ['ls-tree', '-r', '-t', '-z', captured.commit])
    for (const row of raw.toString().split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t'); const [mode, type, hash] = row.slice(0, tab).split(' '); const name = row.slice(tab + 1)
      if (!hash || !mode || !type || !name || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.git')) throw new Error('Invalid path in history tree')
      const path = join(captured.workTree, name)
      if (!isInside(captured.root, path)) continue
      if (type === 'tree') result[path] = { kind: 'directory', mode: 0o755 }
      else if (mode === '120000') result[path] = { kind: 'symlink', mode: 0o777, target: (await git(captured, ['cat-file', 'blob', hash])).toString() }
      else if (type === 'blob') result[path] = { kind: 'file', mode: mode === '100755' ? 0o755 : 0o644, hash }
      else result[path] = { kind: 'excluded', mode: 0 }
    }
    if (captured.selector === '.') result[captured.root] ??= { kind: 'directory', mode: 0o755 }
    for (const [path, entry] of Object.entries(captured.extra)) result[path] = { ...result[path], ...entry, ...(result[path]?.hash ? { hash: result[path]!.hash } : {}) }
    return result
  }
  async function reference(input: { capture: TreeCapture; id: string; phase: 'before' | 'after' }): Promise<void> {
    if (!CHECKPOINT_ID.test(input.id)) throw new Error('Invalid checkpoint reference')
    await git(input.capture, ['update-ref', `refs/buckle/checkpoints/${input.id}${input.phase === 'before' ? '-before' : ''}`, input.capture.commit])
  }
  async function changed(before: TreeCapture[], after: TreeCapture[]): Promise<string[]> {
    const result: string[] = []
    for (const right of after) {
      const left = before.find(value => value.root === right.root)
      if (!left) continue
      const names = await git(right, ['diff-tree', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--name-only', '-r', '-z', left.commit, right.commit])
      for (const name of names.toString().split('\0').filter(Boolean)) result.push(join(right.workTree, name))
    }
    return [...new Set(result)].sort()
  }
  async function restoreContent(input: { trees: TreeCapture[]; target: Snapshot; paths: string[] }): Promise<Map<string, Buffer>> {
    const content = new Map<string, Buffer>()
    for (const tree of input.trees) {
      const paths = input.paths.filter(path => isInside(tree.root, path) && input.target[path]?.kind === 'file')
      if (!paths.length) continue
      const temporary = join(owned, `restore-${randomUUID()}`); mkdirSync(temporary, { mode: 0o700 })
      const index = join(temporary, 'index')
      try {
        await git(tree, ['read-tree', tree.commit], undefined, { GIT_INDEX_FILE: index })
        for (const path of paths) {
          const entry = input.target[path]!
          await git(tree, ['update-index', '--add', '--cacheinfo', `${entry.mode & 0o111 ? '100755' : '100644'},${entry.hash!},${relative(tree.workTree, path)}`], undefined, { GIT_INDEX_FILE: index })
        }
        await git(tree, ['checkout-index', '--force', '--prefix', `${temporary}/files/`, '-z', '--stdin'], Buffer.from(paths.map(path => relative(tree.workTree, path)).join('\0') + '\0'), { GIT_INDEX_FILE: index })
        for (const path of paths) content.set(input.target[path]!.hash!, readFileSync(join(temporary, 'files', relative(tree.workTree, path))))
      } finally { rmSync(temporary, { recursive: true, force: true }) }
    }
    return content
  }
  async function removeRefs(id: string, trees: TreeCapture[]): Promise<void> {
    if (!CHECKPOINT_ID.test(id)) return
    for (const tree of trees) for (const suffix of ['', '-before']) await git(tree, ['update-ref', '-d', `refs/buckle/checkpoints/${id}${suffix}`])
  }
  async function reconcile(records: Array<{ id: string; beforeTrees?: TreeCapture[]; afterTrees?: TreeCapture[] }>): Promise<boolean> {
    const all = new Map<string, TreeCapture>()
    for (const record of records) for (const tree of [...record.beforeTrees ?? [], ...record.afterTrees ?? []]) all.set(tree.git, tree)
    for (const directory of gitDirectories()) if (!all.has(directory)) all.set(directory, { git: directory, workTree: owned, root: owned, selector: '.', commit: '', extra: {} })
    const keep = new Set(records.flatMap(record => record.beforeTrees?.length || record.afterTrees?.length ? [`refs/buckle/checkpoints/${record.id}`, `refs/buckle/checkpoints/${record.id}-before`] : []))
    let removed = false
    for (const tree of all.values()) {
      const output = await git(tree, ['for-each-ref', '--format=%(refname)', 'refs/buckle/checkpoints/'])
      for (const ref of output.toString().trim().split('\n').filter(Boolean)) if (!keep.has(ref)) { await git(tree, ['update-ref', '-d', ref]); removed = true }
    }
    return removed
  }
  async function reparent(records: Array<{ id: string; beforeTrees?: TreeCapture[]; afterTrees?: TreeCapture[] }>): Promise<void> {
    const previous = new Map<string, string>()
    for (const record of records) for (const phase of ['before', 'after'] as const) for (const tree of phase === 'before' ? record.beforeTrees ?? [] : record.afterTrees ?? []) {
      const parent = previous.get(tree.git)
      const hash = (await git(tree, ['rev-parse', `${tree.commit}^{tree}`])).toString().trim()
      tree.commit = (await git(tree, ['commit-tree', hash, ...parent ? ['-p', parent] : []], `Buckle ${record.id} ${phase}\n`)).toString().trim()
      previous.set(tree.git, tree.commit)
      await reference({ capture: tree, id: record.id, phase })
    }
  }
  function gitDirectories(): string[] {
    const roots = join(input.directory, 'roots')
    const directories = [join(input.directory, 'git'), ...existsSync(roots) ? readdirSync(roots, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(roots, entry.name, 'git')) : []]
    return directories.filter(directory => lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() && existsSync(join(directory, 'HEAD')))
  }
  function objectFiles(): string[] {
    const found: string[] = []
    function visit(directory: string): void {
      if (!existsSync(directory)) return
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (entry.isFile() && /\/objects\/[a-f0-9]{2}\/[a-f0-9]{38,62}$/.test(path)) found.push(path)
      }
    }
    visit(input.directory)
    return found
  }
  async function reachableBytes(trees: TreeCapture[]): Promise<number> {
    let bytes = 0
    const groups = new Map<string, TreeCapture[]>()
    for (const tree of trees) groups.set(tree.git, [...groups.get(tree.git) ?? [], tree])
    for (const group of groups.values()) {
      const first = group[0]!
      const packed = new Map<string, number>()
      const packDirectory = join(first.git, 'objects', 'pack')
      if (existsSync(packDirectory)) for (const name of readdirSync(packDirectory).filter(name => name.endsWith('.idx'))) {
        const output = await git(first, ['verify-pack', '-v', join(packDirectory, name)])
        for (const line of output.toString().split('\n')) { const fields = line.split(/ +/); if (fields[0] && HASH.test(fields[0]) && fields[3]) packed.set(fields[0], Number(fields[3])) }
      }
      const output = await git(first, ['rev-list', '--objects', '--no-object-names', '--no-walk', ...new Set(group.map(tree => tree.commit))])
      for (const oid of output.toString().trim().split('\n').filter(Boolean)) { assertHash(oid); const loose = lstatSync(join(first.git, 'objects', oid.slice(0, 2), oid.slice(2)), { throwIfNoEntry: false }); bytes += loose?.size ?? packed.get(oid) ?? 0 }
    }
    return bytes
  }
  async function pruneLoose(): Promise<void> {
    const files = objectFiles()
    if (files.length > 20_000) return
    const groups = new Map<string, string[]>()
    for (const file of files) { const directory = file.slice(0, file.lastIndexOf('/objects/')); groups.set(directory, [...groups.get(directory) ?? [], file]) }
    for (const [directory, objects] of groups) {
      const output = await git({ git: directory, workTree: owned }, ['rev-list', '--all', '--objects', '--no-object-names'])
      const reachable = new Set(output.toString().trim().split('\n'))
      for (const file of objects) { const parts = file.split('/'); const oid = parts.at(-2)! + parts.at(-1)!; if (!reachable.has(oid)) rmSync(file, { force: true }) }
      rmSync(join(directory, 'index'), { force: true })
    }
  }
  async function collect(trees: TreeCapture[]): Promise<void> {
    const directories = new Map(trees.map(tree => [tree.git, tree]))
    for (const directory of gitDirectories()) if (!directories.has(directory)) directories.set(directory, { git: directory, workTree: owned, root: owned, selector: '.', commit: '', extra: {} })
    for (const tree of directories.values()) {
      rmSync(join(tree.git, 'index'), { force: true })
      rmSync(join(tree.git, 'objects', 'info', 'commit-graph'), { force: true })
      await git(tree, ['-c', 'gc.reflogExpire=now', '-c', 'gc.reflogExpireUnreachable=now', 'gc', '--quiet', '--prune=now'])
    }
  }
  return { capture, loadTree, changed, restoreContent, removeRefs, reconcile, reparent, collect, pruneLoose, reachableBytes, get available() { return historyGitProgram({ allowed: input.allowed(), roots: [], ...(input.untrusted ? { untrusted: input.untrusted() } : {}) }) !== null }, bytes: () => storeBytes(input.directory) }
}

function normalizedRoots(roots: string[]): string[] { return [...new Set(roots.map(root => resolve(root)))].filter(root => !roots.some(parent => parent !== root && lstatSync(parent, { throwIfNoEntry: false })?.isDirectory() && isInside(parent, root))) }
function ignoredAncestor(path: string, root: string, ignored: Set<string>): boolean {
  let parent = dirname(path)
  while (isInside(root, parent)) {
    if (ignored.has(parent)) return true
    if (parent === root) break
    parent = dirname(parent)
  }
  return false
}
function escapeIgnore(path: string): string { return path.replace(/[\\*?\[\] !#]/g, '\\$&') }
function assertHash(hash: string): void { if (!HASH.test(hash)) throw new Error('Invalid history object') }
function ownerObjects(workTree: string): string | undefined {
  let root = workTree
  while (true) {
    const marker = join(root, '.git'); const stat = lstatSync(marker, { throwIfNoEntry: false })
    if (stat) {
      let directory: string
      if (stat.isDirectory() || stat.isSymbolicLink()) { try { directory = realpathSync(marker) } catch { return undefined } }
      else {
        const pointer = readGitMetadata(marker)
        if (!pointer || !/^gitdir: [^\0\r\n]+\n?$/.test(pointer)) return undefined
        directory = resolve(root, pointer.slice(8).trim())
      }
      const common = join(directory, 'commondir')
      if (existsSync(common)) { const pointer = readGitMetadata(common); if (!pointer || /[\0\r\n]./.test(pointer.trim())) return undefined; directory = resolve(directory, pointer.trim()) }
      const objects = join(directory, 'objects')
      return lstatSync(objects, { throwIfNoEntry: false })?.isDirectory() ? objects : undefined
    }
    if (dirname(root) === root) return undefined
    root = dirname(root)
  }
}
export function readGitMetadata(path: string): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (!stat?.isFile() || stat.size > 8192) return undefined
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.size > 8192 || opened.ino !== stat.ino || opened.dev !== stat.dev) return undefined
    const content = Buffer.alloc(8193)
    let bytes = 0
    while (bytes < content.length) {
      const read = readSync(descriptor, content, bytes, content.length - bytes, null)
      if (!read) break
      bytes += read
    }
    const final = fstatSync(descriptor)
    if (bytes > 8192 || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs || final.ctimeMs !== opened.ctimeMs) return undefined
    return content.toString('utf8', 0, bytes)
  } catch { return undefined }
  finally { if (descriptor !== undefined) closeSync(descriptor) }
}
export function storeBytes(directory: string): number {
  let bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'history.sqlite' || entry.name.startsWith('execution.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) bytes += storeBytes(path)
    else if (entry.isFile()) bytes += statSync(path).size
  }
  return bytes
}
function runProgram(input: { program: Program; args: string[]; cwd: string; environment: NodeJS.ProcessEnv; data?: string | Buffer; acceptedCodes?: number[] }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.program.path, [...input.program.args, ...input.args], { argv0: input.program.argv0, cwd: input.cwd, env: input.environment, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const output: Buffer[] = []; let bytes = 0
    const timeout = setTimeout(() => child.kill(), 10_000)
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 64 * 1_048_576) child.kill(); else output.push(chunk) })
    child.stderr.resume()
    child.on('error', error => { clearTimeout(timeout); reject(new Error('History git could not start', { cause: error })) })
    child.on('close', code => { clearTimeout(timeout); if (code !== null && (input.acceptedCodes ?? [0]).includes(code) && bytes <= 64 * 1_048_576) resolve(Buffer.concat(output)); else reject(new Error('History git did not finish; inspect the checkpoint and retry')) })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input.data)
  })
}
