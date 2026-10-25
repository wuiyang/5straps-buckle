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
  | { kind: 'write_path'; path: string; host?: true }
  | { kind: 'network'; url: string }
  | ExecEffect
  | { kind: 'process_probe' }

/**
 * A program run. `shownAs`: the word the decision AI's stages are shown in place of `command` where `command` is a host
 * path Buckle supplies itself (its own node, the owner's validator, an absolute agent-browser), never the agent's own
 * text (fix brief 1, item 16); approvers, the rules, grants, and the standard-script match read `command`.
 */
export interface ExecEffect { kind: 'exec'; command: string; args: string[]; shownAs?: string }

export type ResolvedEffect =
  | { kind: 'read_path'; path: string; directory: string }
  | { kind: 'write_path'; path: string; directory: string }
  | { kind: 'network'; url: URL }
  | ExecEffect
  | { kind: 'process_probe' }
  | SecretFileEffect

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
    case 'network': return `network ${redactUrl(effect.url.href)}`
    case 'exec': return `exec ${shownCommand(effect.command, effect.args)}`
    case 'process_probe': return 'process probe'
    case 'secret_file': return `secrets ${effect.names.join(', ')} from ${wordList(effect.written)}`
  }
}
