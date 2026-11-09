import type { SourceReach } from '../../types/ports/approval-backend.js'
import { ASSURANCE_ORDER, type Assurance, type SourceKind } from '../../types/ports/approval-source.js'

export interface SourceRights {
  assurance: Assurance
  /** False: its approvals are refused and its denials kept, as a backend's that does not decide. */
  approves: boolean
  /** A relayed kind whose denials may still outlast the call: the setup route's envelope alone. */
  deniesLasting?: true
  /** Approves as a person, so a floor ask may take its approval at `local` or above; the decision AI never does. */
  person: boolean
  /** Grants an ask's wider subject in place of its own: a person at the node alone. */
  widens: boolean
  /** A core client at the node, routed to every ask whatever routes the ask recorded. */
  everyAsk: boolean
  /** Its answers decide only while the workspace's forms setting is on, read as each is decided. */
  whileFormsOn?: true
  /** Its answers decide only the asks their own caller raised: the transport's actor, compared with the ask's. */
  sameCaller?: true
}

const AT_THE_NODE: SourceRights = { assurance: 'local', approves: true, person: true, widens: true, everyAsk: false }

// Ruling 3 of 2026-09-25, which the owner keeps: a form's answers count as the person's, while the owner's forms setting is on.
const FORMS: SourceRights = { assurance: 'local', approves: true, person: true, widens: false, everyAsk: false, whileFormsOn: true }

const RIGHTS: Record<SourceKind, SourceRights> = {
  terminal: AT_THE_NODE,
  cli: { ...AT_THE_NODE, everyAsk: true },
  forms: FORMS,
  // Where an ask is answered changes nothing it offers, a floor ask's approval included (APPROVAL-33, the owner's ruling of
  // 2026-11-09), so an HTTP form decides as a stdio one; anything holding an agent's token can send one, so it decides only
  // the asks that token raised, and forms stay off unless the owner turns them on.
  'http-forms': { ...FORMS, sameCaller: true },
  devices: { assurance: 'key', approves: true, person: true, widens: false, everyAsk: false },
  judge: { assurance: 'relayed', approves: true, person: false, widens: false, everyAsk: true },
  // The setup route's envelope keeps today's lasting denials of a sensitive file.
  sealed: { assurance: 'relayed', approves: false, deniesLasting: true, person: false, widens: false, everyAsk: false },
  backend: { assurance: 'relayed', approves: false, person: false, widens: false, everyAsk: false },
}

export function rightsOf(kind: SourceKind): SourceRights {
  return RIGHTS[kind]
}

/** Whose asks a backend is told its source may answer, by the rule the decision guard holds these rights to. */
export function reachOf(rights: SourceRights): SourceReach {
  return { sameCaller: rights.sameCaller === true }
}

export function atLeast(assurance: Assurance, least: Assurance): boolean {
  return ASSURANCE_ORDER.indexOf(assurance) >= ASSURANCE_ORDER.indexOf(least)
}
