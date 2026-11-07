/**
 * How the destructive floor meets scope always and the dangerously-allow switch. Both are on, today's behavior; turning
 * one off is the safer default.
 */
export interface FloorPolicy {
  /**
   * Whether the file floor offers scope always, a destructive ask may take it where offered, and an always grant made
   * earlier on a floor subject or a `delete-below` folder still clears its ask.
   */
  alwaysAtFloor: boolean
  /** Whether the dangerously-allow switch lifts floor asks too. */
  switchLiftsFloor: boolean
}

export const FLOOR_POLICY: Readonly<FloorPolicy> = Object.freeze({ alwaysAtFloor: true, switchLiftsFloor: true })
