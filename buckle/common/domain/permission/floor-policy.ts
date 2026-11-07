/**
 * How the destructive floor meets scope always and the dangerously-allow switch: owner questions 1 and 4 of the approval
 * backend design, both answered "keep today's behavior" on 2026-11-07. Turning a switch off is the safer default.
 */
export interface FloorPolicy {
  /** Question 1: the file floor offers scope always, and a destructive ask may take it where offered. */
  alwaysAtFloor: boolean
  /** Question 4: the dangerously-allow switch lifts floor asks too. */
  switchLiftsFloor: boolean
}

export const FLOOR_POLICY: Readonly<FloorPolicy> = Object.freeze({ alwaysAtFloor: true, switchLiftsFloor: true })
