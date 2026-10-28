import { redactUrl } from '@5straps/runtime'
import { shownCommand } from './argv.js'
import { wordList } from './word-list.js'

/**
 * What a call will touch, declared from parsed input before it runs. Paths may be relative;
 * `resolveEffects` turns them into the absolute, symlink-resolved form the rules judge.
 */
export type ToolEffect =
  | { kind: 'read_path'; path: string }
  /**
   * `host`: the path is the host's own, settled by the tool (a push's local destination by its real path),
   * so it is judged where it is and never read through the agent's view, where a mount would take a host
   * path under its name for one of its own (review L4).
   */
  | { kind: 'write_path'; path: string; host?: true; entry?: true; folder?: true }
  | DeleteEffect
  | { kind: 'network'; url: string }
  | ExecEffect
  | { kind: 'process_probe' }

/**
 * An entry removed (fs_delete, a move's source, the file a replacing move or a patch removes): the entry itself, a link
 * unlinked and never followed, so its folder is resolved and its own name is not. `floor`: a person is asked at the
 * destructive floor whatever the folder's write grant says (destructive-path-rule.ts); a move's source that moves a file
 * and replaces nothing is judged as a write to its folder instead (the fs-verbs brief), unless the file leaves a folder
 * outside the workspace's for the inside of it. `tree`: a folder removed with
 * everything in it, and what it held when counted, before the ask. `moved`: a folder that is moved, not destroyed, so
 * everything in it stands elsewhere afterwards and the read rules beneath it judge the move as well.
 */
export interface DeleteEffect { kind: 'delete_path'; path: string; floor: boolean; tree?: TreeCount; moved?: true }

/**
 * What a folder held when it was counted, before the ask (MAX_COUNTED_ENTRIES at most, `more` past that), or `counted:
 * false` where it lies outside the roots the agent may name, which are not looked into before a person allows the call.
 */
export type TreeCount = { counted: true; files: number; folders: number; more: boolean } | { counted: false }

/** How many entries a folder is counted to before the ask names it as holding more (the fs-verbs brief). */
export const MAX_COUNTED_ENTRIES = 10_000

/**
 * A program run. `shownAs`: the word the decision AI's stages are shown in place of `command` where `command` is a host
 * path Buckle supplies itself (its own node, the owner's validator, an absolute agent-browser), never the agent's own
 * text (fix brief 1, item 16); approvers, the rules, grants, and the standard-script match read `command`.
 */
export interface ExecEffect { kind: 'exec'; command: string; args: string[]; shownAs?: string }

export type ResolvedEffect =
  | { kind: 'read_path'; path: string; directory: string }
  /**
   * `entry`: the path names the entry itself (a move's landing), its folder resolved and its own name not followed.
   * `folder`: a folder lands there whole, so the write rules beneath that path judge it too.
   */
  | { kind: 'write_path'; path: string; directory: string; entry?: true; folder?: true }
  /** `path`: the entry where it really is, its folder resolved and its own name not followed; `directory`: that folder. */
  | { kind: 'delete_path'; path: string; directory: string; floor: boolean; tree?: TreeCount; moved?: true }
  | { kind: 'network'; url: URL }
  | ExecEffect
  | { kind: 'process_probe' }
  | SecretFileEffect
  | DestructiveWriteEffect

/**
 * What the destructive-write check found (the fs-verbs brief), added by the invoker and never declared by a tool: a write
 * that empties a file, or leaves it under half its size, which the session has not read lately (`unread_shrink`, at the
 * file's real path), or one call that rewrites more existing files than BATCH_REWRITE_LIMIT (`many_rewrites`). Each asks
 * at the destructive floor, whatever the folder's write grant says (destructive-path-rule.ts).
 */
export type DestructiveWriteEffect =
  | { kind: 'unread_shrink'; path: string; empties: boolean }
  | { kind: 'many_rewrites'; files: number }

/**
 * A file the call's secret references name (docs/secrets.md), added by the invoker and never declared by a tool: `path`
 * where it really lands, `written` each spelling the references name it by, and the NAMEs the call reads from it under
 * any of them. Buckle reads it itself as the call runs; nothing of it reaches the agent.
 */
export interface SecretFileEffect { kind: 'secret_file'; path: string; written: string[]; names: string[] }

/**
 * One line naming what an effect touches, as an approval shows it (owner decision D17): whole, a command
 * quoted word by word, and a URL with its password and credential query values hidden (owner ruling B).
 */
export function summarizeEffect(effect: ResolvedEffect): string {
  switch (effect.kind) {
    case 'read_path': return `read ${effect.path}`
    case 'write_path': return `write ${effect.path}`
    case 'delete_path': return `delete ${effect.path}${effect.tree ? ` and everything in it (${treeWords(effect.tree)})` : ''}`
    case 'network': return `network ${redactUrl(effect.url.href)}`
    case 'exec': return `exec ${shownCommand(effect.command, effect.args)}`
    case 'process_probe': return 'process probe'
    case 'secret_file': return `secrets ${effect.names.join(', ')} from ${wordList(effect.written)}`
    case 'unread_shrink': return `${effect.empties ? 'empties' : 'shrinks to under half its size'} ${effect.path}, a file this session never read`
    case 'many_rewrites': return `rewrites ${effect.files} existing files at once`
  }
}

/** What a counted folder holds, in words: `3 files and 1 folder`, `more than 10000 entries`, or that it was not counted. */
export function treeWords(tree: TreeCount): string {
  if (!tree.counted) return 'not counted, as it lies outside the workspace\'s folders'
  if (tree.more) return `more than ${MAX_COUNTED_ENTRIES} entries`
  return `${tree.files} ${tree.files === 1 ? 'file' : 'files'} and ${tree.folders} ${tree.folders === 1 ? 'folder' : 'folders'}`
}
