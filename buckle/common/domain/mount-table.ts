import { posix } from 'pathe'
import { MountPathSchema } from '@5straps/protocol'
import { isInside } from './paths.js'
import { SANDBOX_HOME } from './sandbox-mounts.js'

/** How a mount is shared (Q6 of the workspace-model brief, ruled read-write by default): `rw`, or `ro` to opt out. */
export type MountAccess = 'rw' | 'ro'

/**
 * One of the owner's mounts (D84 (3), D85 Q6): a folder or file of the host, `source`, which the agent sees at `target`
 * inside the sandbox, as Docker's `-v <source>:<target>[:ro]` reads. The source is stored as the disk names it.
 */
export interface OwnerMount {
  source: string
  target: string
  access: MountAccess
}

/**
 * A mount as a workspace's runtime holds it: one of the table's, or a scratch root the node's BUCKLE_SCRATCH_ROOTS names,
 * which keeps what it always meant (writable without asking, at its own path) now that it is one of the node's default
 * mounts (Phase 2 item 1: the node's mount settings are migration input and defaults).
 */
export interface TableMount extends OwnerMount {
  scratch?: true
  /** One of the node's BUCKLE_MOUNTS, which `buckle settings` changes, not `buckle workspace mount` (fix brief 6, item 9). */
  node?: true
}

/** The most mounts of the owner's one workspace holds, as BUCKLE_MOUNTS held. */
export const MAX_OWNER_MOUNTS = 32

/**
 * The folders the sandbox binds for the host's own programs, and the ones it builds itself (D85, Q1, ruled "present but
 * unlisted"): `ls /` shows them, no mount table lists them, and no mount may stand at, above, or inside one. `/sys` is
 * never bound, and stays refused, as the explicit mounts refused it.
 */
export const SYSTEM_TARGETS: readonly string[] = Object.freeze(['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/dev', '/proc', '/sys', '/tmp'])

/**
 * Why a mount may not show at `target`, or null. `folder` is where the workspace's folder shows; `others` are the other
 * mounts' targets; `fixed` are host paths the sandbox binds at their own path (the Node prefix and the toolchains the
 * node names), which a mount would hide or be hidden by. A target inside the sandbox home (`/tmp/home/...`, where HOME
 * points) is taken, as the explicit mounts took one, so a dotfile can be shared.
 */
export function mountTargetRefusal(target: string, input: { folder: string | null; others: readonly string[]; fixed?: readonly string[] }): string | null {
  if (!MountPathSchema.safeParse(target).success || posix.normalize(target) !== target || target.split('/').some(name => name === '.' || name === '..')) {
    return `${target} is not an absolute sandbox path with plain names, such as /data`
  }
  const inHome = isInside(SANDBOX_HOME, target, 'linux') && target !== SANDBOX_HOME
  const reserved = SYSTEM_TARGETS.find(system => overlaps(system, target))
  if (reserved && !inHome) return `${target} is where the sandbox keeps ${reserved} for the host's own programs, so no mount shows there`
  if (input.folder !== null && overlaps(input.folder, target)) return `${target} overlaps ${input.folder}, where the workspace's folder shows`
  const other = input.others.find(existing => overlaps(existing, target))
  if (other !== undefined) return `${target} overlaps ${other}, where another mount shows`
  const fixed = (input.fixed ?? []).find(path => overlaps(path, target))
  if (fixed !== undefined) return `${target} overlaps a toolchain folder the sandbox binds at its own path`
  return null
}

/**
 * A mount as Docker's `-v` writes it, `<local>:<sandbox>[:ro]` (Q6 of the workspace-model brief): the sandbox path is
 * the last part that starts with `/`, so a Windows drive (`C:\data:/data`) or a colon in a local name stays in the
 * source. `readOnly` is the long form, `--read-only`. Answers the parts, unchecked, or null where none is named.
 */
export function parseMountSpec(spec: string, readOnly: boolean): { source: string; target: string; access: MountAccess } | null {
  let rest = spec
  let access: MountAccess = readOnly ? 'ro' : 'rw'
  const suffix = /:(ro|rw)$/.exec(rest)
  if (suffix) {
    if (suffix[1] === 'ro') access = 'ro'
    else if (readOnly) return null
    rest = rest.slice(0, -suffix[0].length)
  }
  const split = rest.lastIndexOf(':/')
  if (split <= 0) return null
  const source = rest.slice(0, split)
  const target = rest.slice(split + 1)
  if (target.includes(':')) return null
  return { source, target, access }
}

/** A mount as `buckle workspace mount list` prints it, `source:target:access`, as it is added. */
export function formatMount(mount: OwnerMount): string {
  return `${mount.source}:${mount.target}:${mount.access}`
}

function overlaps(left: string, right: string): boolean {
  return isInside(left, right, 'linux') || isInside(right, left, 'linux')
}
