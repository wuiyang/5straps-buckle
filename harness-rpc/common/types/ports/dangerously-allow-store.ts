/**
 * A workspace's dangerously-allow switch (rulings 11 and H1 of 2026-09-28), stored apart from its
 * policy (review H1 of B20-B22): turning it on or off never writes the document a workspace's policy
 * is read from.
 */
export interface DangerouslyAllowStore {
  /** Throws when the file cannot be read; the runtime then treats the switch as off. */
  isOn(): boolean
  set(on: boolean): Promise<void>
}
