import { redactCredentials } from '@5straps/runtime'
import { shownCommand } from './argv.js'

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
  | { kind: 'exec'; command: string; args: string[] }
  | { kind: 'process_probe' }

export type ResolvedEffect =
  | { kind: 'read_path'; path: string; directory: string }
  | { kind: 'write_path'; path: string; directory: string }
  | { kind: 'network'; url: URL }
  | { kind: 'exec'; command: string; args: string[] }
  | { kind: 'process_probe' }

/**
 * One line naming what an effect touches, as an approval shows it (owner decision D17): whole, a command
 * quoted word by word, and redacted by context (owner decision D21): a URL as the one word it is.
 */
export function summarizeEffect(effect: ResolvedEffect): string {
  switch (effect.kind) {
    case 'read_path': return `read ${effect.path}`
    case 'write_path': return `write ${effect.path}`
    case 'network': return `network ${redactCredentials(effect.url.href, 'word')}`
    case 'exec': return `exec ${shownCommand(effect.command, effect.args)}`
    case 'process_probe': return 'process probe'
  }
}
