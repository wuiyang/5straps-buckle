/**
 * The subjects the file side of the destructive floor asks and grants under (the fs-verbs brief). They ride under the
 * `write_scope` rule with a prefix, as a secret file's use rides under `sensitive_path` (sensitive-path-rule.ts), so no
 * wire schema gains a rule a consumer pinned to an earlier protocol would refuse; no folder grant ever matches one, as
 * none is a path. `delete:<folder>`: an entry removed from that folder, matched exactly, never a folder beneath it.
 * `delete-tree:<folder>`: that folder removed with everything in it. A grant of one covers its subject alone.
 */
export const DELETE_PREFIX = 'delete:'
export const DELETE_TREE_PREFIX = 'delete-tree:'
/** A folder moved whole; this exact grant never permits deletion. */
export const MOVE_TREE_PREFIX = 'move-tree:'
/**
 * `delete-below:<folder>`: every delete outside the workspace's own folder in that folder and its subfolders, matched as a
 * write grant matches (isInside), which a person may grant for the session or always in place of the subject a delete
 * there asks under (the delete policy brief). Never a delete inside the workspace's folder, which its own setting decides.
 */
export const DELETE_BELOW_PREFIX = 'delete-below:'
/** `delete-batch:<workspace folder>`: one call that deletes more entries in the workspace's folder than its limit lets through. */
export const DELETE_BATCH_PREFIX = 'delete-batch:'
/** `overwrite:<file>`: a write that empties or halves that file, which the session never read (the destructive-write check). */
export const OVERWRITE_PREFIX = 'overwrite:'
/** `rewrite-batch:<workspace folder>`: one call that rewrites more existing files than the check lets through. */
export const REWRITE_BATCH_PREFIX = 'rewrite-batch:'
/**
 * `restore:<checkpoint>..<newest>`: a restore of the change history to before that checkpoint while `newest` is the
 * newest one (history_restore), or `restore:<checkpoint>` where it is the newest itself. It names no path, and names what
 * the restore undoes exactly, so an approval never covers a restore that undoes more than the person was shown.
 */
export const RESTORE_PREFIX = 'restore:'

/** The subject a restore asks under (RESTORE_PREFIX). */
export function restoreSubject(effect: { checkpoint: string; head: string }): string {
  return `${RESTORE_PREFIX}${effect.checkpoint}${effect.head === effect.checkpoint ? '' : `..${effect.head}`}`
}
const PATH_PREFIXES = [DELETE_PREFIX, DELETE_TREE_PREFIX, MOVE_TREE_PREFIX, DELETE_BELOW_PREFIX, DELETE_BATCH_PREFIX, OVERWRITE_PREFIX, REWRITE_BATCH_PREFIX] as const

/** Whether a `write_scope` subject is one of the floor's own, which names no folder a write grant covers. */
export function isFloorSubject(subject: string): boolean {
  return isRestoreSubject(subject) || PATH_PREFIXES.some(prefix => subject.startsWith(prefix))
}

/** Whether a `write_scope` subject is a restore's, which the dangerously-allow switch leaves to a person. */
export function isRestoreSubject(subject: string): boolean {
  return subject.startsWith(RESTORE_PREFIX)
}

/** The real path a floor subject names, for the dangerously-allow switch's bound to the workspace; null for a folder grant's subject or a restore's. */
export function floorSubjectPath(subject: string): string | null {
  const prefix = PATH_PREFIXES.find(item => subject.startsWith(item))
  return prefix === undefined ? null : subject.slice(prefix.length)
}

/**
 * The subject a secret file's use is asked and granted under (docs/user/how-to/secrets.md): never a path, so a grant to read the
 * file into a command's argument list never opens the file to the agent, nor a read of it the other way round.
 */
export const SECRET_FILE_PREFIX = 'secret-file:'

export function secretFileSubject(path: string): string {
  return `${SECRET_FILE_PREFIX}${path}`
}

/** Whether a sensitive_path subject is a secret file's use, which may be granted for a session or always. */
export function isSecretFileSubject(subject: string): boolean {
  return subject.startsWith(SECRET_FILE_PREFIX)
}
