/**
 * How the destructive floor meets scope always. On is today's behavior; off is the safer default. What the
 * dangerously-allow switch answers at the floor is its mode's (rules/dangerously-allow.ts).
 */
export interface FloorPolicy {
  /**
   * Whether the file floor offers scope always, a destructive ask may take it where offered, and an always grant made
   * earlier on a floor subject or a `delete-below` folder still clears its ask.
   */
  alwaysAtFloor: boolean
}

export const FLOOR_POLICY: Readonly<FloorPolicy> = Object.freeze({ alwaysAtFloor: true })
