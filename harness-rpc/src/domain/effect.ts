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
