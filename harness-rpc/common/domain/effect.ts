import { shownCommand } from './argv.js'
import { redactShownText } from './redact.js'

/**
 * What a call will touch, declared from parsed input before it runs. Paths may be relative;
 * `resolveEffects` turns them into the absolute, symlink-resolved form the rules judge.
 */
export type ToolEffect =
  | { kind: 'read_path'; path: string }
  | { kind: 'write_path'; path: string }
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
 * quoted word by word, and redacted as the shown arguments are.
 */
export function summarizeEffect(effect: ResolvedEffect): string {
  switch (effect.kind) {
    case 'read_path': return `read ${effect.path}`
    case 'write_path': return `write ${effect.path}`
    case 'network': return `network ${redactShownText(effect.url.href)}`
    case 'exec': return `exec ${shownCommand(effect.command, effect.args)}`
    case 'process_probe': return 'process probe'
  }
}
