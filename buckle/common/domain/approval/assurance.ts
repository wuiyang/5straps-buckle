import type { SourceKind } from '../../types/ports/approval-source.js'

/** Ranked low to high. `BUCKLE-D14`: only `local` and above decide for longer than the call. */
export const ASSURANCE_ORDER = ['relayed', 'local', 'key', 'idp'] as const
export type Assurance = (typeof ASSURANCE_ORDER)[number]

export interface SourceRights {
  assurance: Assurance
  /** False: its approvals are refused and its denials kept, as a backend's that does not decide. */
  approves: boolean
  /** A relayed kind whose denials may still outlast the call. */
  deniesLasting?: true
}

const PERSON: SourceRights = { assurance: 'local', approves: true }

const RIGHTS: Record<SourceKind, SourceRights> = {
  terminal: PERSON,
  cli: PERSON,
  // Ruling 3 of 2026-09-25, which the owner keeps: a stdio host's form answers count as the person's. `relayed` would
  // hold them to one call.
  forms: PERSON,
  devices: { assurance: 'key', approves: true },
  judge: { assurance: 'relayed', approves: true },
  // The setup route's sealed envelope keeps today's lasting denials of a sensitive file; dropping `deniesLasting` holds
  // a backend's denials to one call.
  backend: { assurance: 'relayed', approves: false, deniesLasting: true },
}

export function rightsOf(kind: SourceKind): SourceRights {
  return RIGHTS[kind]
}

export function atLeast(assurance: Assurance, least: Assurance): boolean {
  return ASSURANCE_ORDER.indexOf(assurance) >= ASSURANCE_ORDER.indexOf(least)
}
