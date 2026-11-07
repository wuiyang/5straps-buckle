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
  /** Approves as a person, so a floor ask may take its approval at `local` or above; the decision AI never does. */
  person: boolean
  /** Grants an ask's wider subject in place of its own: a person at the node alone. */
  widens: boolean
  /** A core client at the node, routed to every ask whatever routes the ask recorded. */
  everyAsk: boolean
}

const AT_THE_NODE: SourceRights = { assurance: 'local', approves: true, person: true, widens: true, everyAsk: false }

const RIGHTS: Record<SourceKind, SourceRights> = {
  terminal: AT_THE_NODE,
  cli: { ...AT_THE_NODE, everyAsk: true },
  // Ruling 3 of 2026-09-25, which the owner keeps: a stdio host's form answers count as the person's. `relayed` would
  // hold them to a non-floor once.
  forms: { assurance: 'local', approves: true, person: true, widens: false, everyAsk: false },
  devices: { assurance: 'key', approves: true, person: true, widens: false, everyAsk: false },
  judge: { assurance: 'relayed', approves: true, person: false, widens: false, everyAsk: true },
  // The setup route's sealed envelope keeps today's lasting denials of a sensitive file; dropping `deniesLasting` holds
  // a backend's denials to one call.
  backend: { assurance: 'relayed', approves: false, deniesLasting: true, person: false, widens: false, everyAsk: false },
}

export function rightsOf(kind: SourceKind): SourceRights {
  return RIGHTS[kind]
}

export function atLeast(assurance: Assurance, least: Assurance): boolean {
  return ASSURANCE_ORDER.indexOf(assurance) >= ASSURANCE_ORDER.indexOf(least)
}
