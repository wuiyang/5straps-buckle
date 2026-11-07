/**
 * The modes the switch is on at (APPROVAL-05, owner ruling of 2026-11-08): `on` answers every ask it covers, and `safe`
 * every one but floor asks and a secret reference's file. Off is no entry at all.
 */
export const DANGEROUSLY_ALLOW_ON_MODES = ['on', 'safe'] as const

export type DangerouslyAllowOnMode = typeof DANGEROUSLY_ALLOW_ON_MODES[number]

export type DangerouslyAllowMode = 'off' | DangerouslyAllowOnMode

export function isDangerouslyAllowOnMode(value: unknown): value is DangerouslyAllowOnMode {
  return DANGEROUSLY_ALLOW_ON_MODES.some(mode => mode === value)
}

/**
 * The switch as its file holds it: its mode, and whether a file an earlier build wrote held it on, which this build
 * reads as off (BUILD-02, a clean break).
 */
export interface DangerouslyAllowReading {
  mode: DangerouslyAllowMode
  setByEarlierBuild: boolean
}

/**
 * A workspace's dangerously-allow switch (rulings 11 and H1 of 2026-09-28), stored apart from its
 * policy (review H1 of B20-B22): turning it on or off never writes the document a workspace's policy
 * is read from.
 */
export interface DangerouslyAllowStore {
  /** Throws when the file cannot be read; the runtime then treats the switch as off. */
  read(): DangerouslyAllowReading
  set(mode: DangerouslyAllowMode): Promise<void>
}
