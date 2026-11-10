import { stat } from 'node:fs/promises'
import { dirname } from 'pathe'
import type { ResolvedEffect, RestoreTarget, ToolEffect } from '../../domain/effect.js'
import type { PathView } from '../../domain/path-view.js'
import { missingMountReason, mountSourceState } from '../../domain/sandbox-mounts.js'
import { ToolExecutionError, ToolInputError } from '../../domain/tool.js'
import { RestoreRefusedError, withConflictPath, type ChangeHistory } from '../history/journal.js'
import { resolveTarget, resolveEntry } from './real-path.js'

/**
 * Turns declared effects into the absolute, symlink-resolved form rules judge. Resolution
 * happens before any permission check so a symlink cannot smuggle a path past the scope rules,
 * and a path the agent named under the mount is judged where it really is. A restore of the
 * change history is settled from `history` into the checkpoint it goes back to, with each path
 * it puts back judged as a write beside it.
 */
export async function resolveEffects(input: { effects: ToolEffect[]; paths: PathView; history?: Pick<ChangeHistory, 'plan'> | undefined; readable?: ((path: string) => boolean) | undefined }): Promise<ResolvedEffect[]> {
  const resolved: ResolvedEffect[] = []
  for (const effect of input.effects) {
    if (effect.kind === 'restore_checkpoint') resolved.push(...await resolveRestore(effect.target, input))
    else resolved.push(await resolveOne(effect, input.paths))
  }
  return resolved
}

/** Why an agent's restore that would put back a file inside a Git directory is refused, before anything asks. */
const GIT_DIRECTORY_REFUSAL = 'This restore would put back files inside a Git directory (.git), which rewinds the repository: its commits, branches, and index move back, and a commit that a branch or tag made outside Buckle points to can be deleted. It is refused; undo a commit with git_revert, or ask the owner to run buckle history restore'

/** Whether a path lies in a Git directory: a `.git` segment, whatever its case, as git folds it on the platforms that fold case. */
function insideGitDirectory(path: string): boolean {
  return path.split('/').some(segment => segment.toLowerCase() === '.git')
}

/**
 * A restore as the history stands now: the checkpoint it goes back to, the newest, how many it undoes, and each path it
 * puts back, the entry itself where it lies now (its folder resolved, its own name not followed), as a write. One the
 * history refuses (a step past its start, an id it does not hold, a checkpoint waiting for recovery) is refused here,
 * before anything asks, and so is one that would put back a file inside a Git directory (review M1 of the Slice D rules
 * review): the history keeps `.git`, and putting it back is a hard reset, not an undo of files. A refusal over a path in
 * conflict names it as the agent does, unless `readable` says the read rules keep it from the agent (or is not given).
 */
async function resolveRestore(target: RestoreTarget, input: { paths: PathView; history?: Pick<ChangeHistory, 'plan'> | undefined; readable?: ((path: string) => boolean) | undefined }): Promise<ResolvedEffect[]> {
  if (!input.history) throw new ToolExecutionError('This workspace keeps no change history to restore from', { code: 'HISTORY_UNAVAILABLE' })
  const plan = await input.history.plan(target).catch((error: unknown) => {
    if (error instanceof RestoreRefusedError) throw new ToolInputError(withConflictPath(error, error.path !== undefined && input.readable?.(error.path) ? input.paths.display(error.path) : undefined), { code: error.code })
    throw error
  })
  if (plan.changes.some(change => insideGitDirectory(change.path))) throw new ToolInputError(GIT_DIRECTORY_REFUSAL, { code: 'RESTORE_REFUSED' })
  const writes = plan.changes.map(({ path, kind }): ResolvedEffect => {
    const entry = resolveEntry(path, { shares: input.paths.shares })
    if (entry === null) throw new ToolInputError('A path the restore would put back names no entry in a folder, so nothing is restored', { code: 'RESTORE_REFUSED' })
    refuseMissingMount(entry.path, input.paths)
    return { kind: 'write_path', path: entry.path, directory: entry.directory, entry: true, restore: kind }
  })
  return [{ kind: 'restore_checkpoint', checkpoint: plan.checkpoint, head: plan.head, undoes: plan.undoes }, ...writes]
}

async function resolveOne(effect: Exclude<ToolEffect, { kind: 'restore_checkpoint' }>, paths: PathView): Promise<ResolvedEffect> {
  if (effect.kind === 'delete_path') {
    const entry = await entryEffect(effect.path, paths)
    return { kind: 'delete_path', ...entry, floor: effect.floor, ...(effect.tree ? { tree: effect.tree } : {}), ...(effect.moved ? { moved: true as const } : {}) }
  }
  if (effect.kind === 'write_path' && effect.entry) return { kind: 'write_path', ...await entryEffect(effect.path, paths), entry: true, ...(effect.folder ? { folder: true as const } : {}) }
  if (effect.kind === 'read_path' || effect.kind === 'write_path') {
    // A host path the tool settled is judged as resolveHostRead judges one, never through the agent's view.
    const named = effect.kind === 'write_path' && effect.host ? effect.path : paths.resolve(effect.path)
    const path = await resolveTarget(named, { shares: paths.shares })
    if (effect.kind === 'write_path') refuseMissingMount(path, paths)
    return { kind: effect.kind, path, directory: await containingDirectory(path) }
  }
  if (effect.kind === 'network') {
    try {
      return { kind: 'network', url: new URL(effect.url) }
    } catch {
      throw new ToolInputError(`Not a valid URL: ${effect.url}`)
    }
  }
  return effect
}

/** An entry the agent named, the entry itself (resolveEntry), refused where it names none or lies in a mount whose source is gone. */
async function entryEffect(named: string, paths: PathView): Promise<{ path: string; directory: string }> {
  const entry = resolveEntry(paths.resolve(named), { shares: paths.shares })
  if (entry === null) throw new ToolInputError(`${named} names no entry in a folder, so it is not removed or moved`)
  refuseMissingMount(entry.path, paths)
  return { path: entry.path, directory: entry.directory }
}

/**
 * A write into one of the owner's mounts whose source is gone is refused before any rule judges it, naming the mount
 * by its target: it would make a folder where the owner's was (a renamed ~/data), and history has nothing there to
 * checkpoint. A scratch root not made yet is still written, as its first write may make it.
 */
function refuseMissingMount(path: string, paths: PathView): void {
  const holder = paths.mountOf(path)
  if (holder && !holder.scratch && mountSourceState(holder.source) === 'missing') throw new ToolInputError(missingMountReason(holder.target, holder.node === true), { code: 'PERMISSION_DENIED' })
}

/**
 * A read of a host path a tool reached mid-call (a listed child beneath its judged directory, a searched
 * file, a shell's credential file), judged where it lands now. Never read through the agent's view:
 * the path is already the host's, and a mount would take it for one of its own names.
 */
export async function resolveHostRead(path: string, shares: readonly string[] = []): Promise<ResolvedEffect> {
  const target = await resolveTarget(path, { shares })
  return { kind: 'read_path', path: target, directory: await containingDirectory(target) }
}

/**
 * A write to a host path a tool reached mid-call (a file a revert rewrites), judged as the entry it is where it lands now,
 * as resolveHostRead judges a read: the path is already the host's, so a mount never takes it for one of its own names.
 */
export async function resolveHostWrite(path: string, paths: PathView): Promise<ResolvedEffect> {
  const entry = resolveEntry(path, { shares: paths.shares })
  if (entry === null) throw new ToolInputError(`${path} names no entry in a folder`)
  refuseMissingMount(entry.path, paths)
  return { kind: 'write_path', path: entry.path, directory: entry.directory, entry: true }
}

async function containingDirectory(path: string): Promise<string> {
  try {
    if ((await stat(path)).isDirectory()) return path
  } catch {
    // A path that does not exist yet is judged by the directory it would be created in.
  }
  return dirname(path)
}
