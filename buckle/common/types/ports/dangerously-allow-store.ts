/**
 * The levels the switch is on at (owner ruling of 2026-10-25). `command`, the bare `on`, answers every ask it covers but a
 * secret reference's file, which still asks a person; `all` answers that file's ask too.
 */
export const DANGEROUSLY_ALLOW_LEVELS = ['command', 'all'] as const

export type DangerouslyAllowLevel = typeof DANGEROUSLY_ALLOW_LEVELS[number]

export function isDangerouslyAllowLevel(value: unknown): value is DangerouslyAllowLevel {
  return DANGEROUSLY_ALLOW_LEVELS.some(level => level === value)
}

/**
 * A workspace's dangerously-allow switch (rulings 11 and H1 of 2026-09-28), stored apart from its
 * policy (review H1 of B20-B22): turning it on or off never writes the document a workspace's policy
 * is read from.
 */
export interface DangerouslyAllowStore {
  /** The level the switch is on at, null while it is off. Throws when the file cannot be read; the runtime then treats the switch as off. */
  level(): DangerouslyAllowLevel | null
  /** Turns the switch on at a level, or off with null. */
  set(level: DangerouslyAllowLevel | null): Promise<void>
}
