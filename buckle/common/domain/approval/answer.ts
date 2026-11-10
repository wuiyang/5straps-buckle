import type { ApprovalDecision } from '@5straps/protocol'
import type { ApprovalSource } from '../../types/ports/approval-source.js'
import type { DecisionProofKind } from '../../types/ports/decision-audit.js'
import type { CodeBinding } from '../permission/judged.js'

export interface ApprovalAnswer {
  decision: ApprovalDecision
  source: ApprovalSource
  /** `BUCKLE-D18`: a host pattern, which only `buckle approve --host` passes. */
  widenTo?: string
  /** The digest of the challenge a person's key decided on: it must be the ask's own (B24). */
  challenge?: string
  /** key:<fingerprint> for a decision a person's enrolled key signed; recorded with it and its grant. */
  decidedBy?: string
  consumeNotAfter?: number
  /** The code an approved `once` binds to, where the decision AI's thorough stage approved it on request (fix brief 9, B31). */
  code?: CodeBinding
  /** Grant the ask's wider subject in place of its own, as the ledger records it. */
  widen?: 'below'
  /** What carried it beyond its route, whose nonce reading it already claimed; none when absent. */
  proof?: Exclude<DecisionProofKind, 'none'>
  /** The sender's caller, which core takes from a forms host alone. */
  caller?: string
}
