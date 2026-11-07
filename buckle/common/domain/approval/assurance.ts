import type { ApprovalSource } from '../../types/ports/approval-source.js'

/** Ranked low to high. `BUCKLE-D14`: only `local` and above decide for longer than the call. */
export const ASSURANCE_ORDER = ['relayed', 'local', 'key', 'idp'] as const
export type Assurance = (typeof ASSURANCE_ORDER)[number]

const SOURCE_ASSURANCE: Record<ApprovalSource, Assurance> = {
  terminal: 'local',
  cli: 'local',
  // Ruling 3 of 2026-09-25, which the owner keeps: a stdio host's form answers count as the person's. `relayed` would
  // hold them to one call.
  forms: 'local',
  devices: 'key',
  // The service refuses its approvals; its denials keep the reach the owner's credential gives them.
  sealed: 'local',
  judge: 'relayed',
}

export function assuranceOf(source: ApprovalSource): Assurance {
  return SOURCE_ASSURANCE[source]
}

export function atLeast(assurance: Assurance, least: Assurance): boolean {
  return ASSURANCE_ORDER.indexOf(assurance) >= ASSURANCE_ORDER.indexOf(least)
}
