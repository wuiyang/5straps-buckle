import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { describe, expect, it } from 'vitest'
import { guardDecision, screenDecision, type DecisionClaim, type GuardCheck, type LedgerView } from '../common/domain/approval/decision-guard.js'
import { RECORDED_BEFORE_NOTE } from '../common/domain/approval-instruction.js'

// Today's checks on an answer, held by the pure decision guard (the approval backend design, slice 4), taken from the
// once, CLI, sensitive-file, and signed-deadline suites. The registry runs screenDecision before it locks the approvals
// file and guardDecision under the lock, with the same messages as before.

const NOW = Date.parse('2026-11-07T10:00:00.000Z')
const SHOWN = 'a'.repeat(64)
const request: ApprovalRequest = { token: 't-1', rule: 'write_scope', subject: '/outside', reason: 'outside', tool: 'fs_write', offeredScopes: ['once', 'session', 'always'], expiresAt: '2026-11-07T10:10:00.000Z' }

const approve = (scope: ApprovalDecision['scope'] = 'once', extra: Partial<ApprovalDecision> = {}): ApprovalDecision => ({ token: 't-1', approved: true, scope, ...extra })
const deny = (scope: ApprovalDecision['scope'] = 'once'): ApprovalDecision => ({ token: 't-1', approved: false, scope })
const claim = (decision: ApprovalDecision, extra: Partial<DecisionClaim> = {}): DecisionClaim => ({ decision, authority: 'admin', ...extra })
const waiting = (asked: Partial<ApprovalRequest> = {}, input: { complete?: boolean; challenges?: string[] } = {}): LedgerView => ({ waiting: { request: { ...request, ...asked }, complete: input.complete ?? true, challenges: input.challenges ?? [SHOWN] } })
const guard = (input: { claim: DecisionClaim; ledger?: LedgerView; widenedTo?: string }) => guardDecision({ claim: input.claim, ledger: input.ledger ?? waiting(), now: NOW, ...(input.widenedTo === undefined ? {} : { widenedTo: input.widenedTo }) })

describe('the checks before the approvals file is read', () => {
  it.each<[string, DecisionClaim, GuardCheck, string]>([
    ['a lasting approval from the agent authority', claim(approve('session'), { authority: 'agent' }), 'authority', 'Only the admin credential writes an approval that outlives the call'],
    ['a lasting denial from the agent authority', claim(deny('always'), { authority: 'agent' }), 'authority', 'Only the admin credential writes an approval that outlives the call'],
    ['a host pattern from the agent authority', claim(approve('once'), { authority: 'agent', widenTo: '*.example.com' }), 'widening', 'Only the admin credential widens an approval to a host pattern'],
    ['a host pattern on a denial', claim(deny('session'), { widenTo: '*.example.com' }), 'widening', 'A denial names no host pattern; deny without --host'],
    ['a host pattern on a once', claim(approve('once'), { widenTo: '*.example.com' }), 'widening', 'A once approval covers one call to the host that asked; widen a session or always approval instead'],
    ['a host pattern that is no wildcard', claim(approve('session'), { widenTo: ' api.example.com ' }), 'widening', '--host takes a wildcard pattern such as *.example.com, got api.example.com; without --host the approval is for the host that asked'],
    ['a wildcard over an address', claim(approve('session'), { widenTo: '*.10.0.0.1' }), 'widening', 'A wildcard covers a domain, not an address: *.10.0.0.1'],
  ])('refuses %s', (_name, input, check, reason) => {
    expect(screenDecision(input)).toEqual({ ok: false, check, reason })
  })

  it('passes a once from the agent authority, and gives a host pattern trimmed', () => {
    expect(screenDecision(claim(approve('once'), { authority: 'agent' }))).toEqual({ ok: true })
    expect(screenDecision(claim(approve('always'), { widenTo: ' *.example.com ' }))).toEqual({ ok: true, widenedTo: '*.example.com' })
  })
})

describe('the checks against the ask', () => {
  it('answers the decision already applied as repeated, naming what it answered, and refuses another', () => {
    const resolved: LedgerView = { resolved: { decision: approve('session'), request } }
    expect(guard({ claim: claim(approve('session')), ledger: resolved })).toEqual({ ok: true, repeated: true, asked: { rule: 'write_scope', subject: '/outside' } })
    expect(guard({ claim: claim(approve('session')), ledger: { resolved: { decision: approve('session') } } })).toEqual({ ok: true, repeated: true })
    for (const other of [approve('always'), deny('session'), approve('session', { subject: 'delete-below:/outside' })]) {
      expect(guard({ claim: claim(other), ledger: resolved })).toEqual({ ok: false, check: 'repeat', reason: 'Approval already has a different decision' })
    }
    expect(guard({ claim: claim(approve('session')), ledger: resolved, widenedTo: '*.example.com' })).toEqual({ ok: false, check: 'repeat', reason: 'Approval already has a different decision' })
    expect(guard({ claim: claim(approve('session')), ledger: { resolved: { decision: approve('session'), widenedTo: '*.example.com' } }, widenedTo: '*.example.com' })).toEqual({ ok: true, repeated: true })
  })

  it.each<[string, DecisionClaim, LedgerView, GuardCheck, string]>([
    ['a token nothing waits for', claim(approve()), {}, 'unknown', 'Approval token is unknown or expired'],
    ['a challenge other than the ask\'s', claim(approve(), { challenge: 'f'.repeat(64) }), waiting(), 'challenge', 'The decision names another challenge than this ask\'s: fetch the challenge again and decide on what it shows'],
    ['a challenge for an ask shown under none', claim(deny(), { challenge: SHOWN }), waiting({}, { complete: false, challenges: [] }), 'challenge', 'The decision names another challenge than this ask\'s: fetch the challenge again and decide on what it shows'],
    ['an approval of an ask recorded without its whole call', claim(approve()), waiting({}, { complete: false }), 'recorded_whole', `This ask was ${RECORDED_BEFORE_NOTE}`],
    ['a scope the ask does not offer', claim(approve('always')), waiting({ offeredScopes: ['once', 'session'] }), 'scope_offered', 'Scope always is not offered for this approval'],
    ['a denial naming a subject', claim({ ...deny(), subject: 'delete-below:/outside' }), waiting(), 'wider_subject', 'A denial names no subject: it denies the ask\'s own'],
    ['a subject the ask offers none of', claim(approve('session', { subject: '/elsewhere' })), waiting(), 'wider_subject', 'This ask grants /outside, not /elsewhere'],
    ['a subject other than the ask\'s wider one', claim(approve('session', { subject: '/elsewhere' })), waiting({ widerSubject: 'delete-below:/outside' }), 'wider_subject', 'This ask grants /outside or delete-below:/outside, not /elsewhere'],
    ['a wider subject for once', claim(approve('once', { subject: 'delete-below:/outside' })), waiting({ widerSubject: 'delete-below:/outside' }), 'wider_subject', 'A once approval covers the one call that asked; grant the folder and its subfolders for the session or always instead'],
    ['a lasting approval of a sensitive file', claim(approve('session')), waiting({ rule: 'sensitive_path', subject: '/w/.env' }), 'sensitive_file', 'Sensitive files can only be allowed once'],
    ['a lasting denial of anything but a sensitive file', claim(deny('always')), waiting(), 'sensitive_file', 'Persistent denials are supported only for sensitive files'],
    ['a signed once at its proof deadline', claim(approve(), { consumeNotAfter: NOW }), waiting(), 'proof_deadline', 'Signed approval expired before tool admission; sign a fresh decision over the current challenge'],
    ['a signed once whose deadline is no time', claim(approve(), { consumeNotAfter: Number.NaN }), waiting(), 'proof_deadline', 'Signed approval expired before tool admission; sign a fresh decision over the current challenge'],
  ])('refuses %s', (_name, input, ledger, check, reason) => {
    expect(guard({ claim: input, ledger })).toEqual({ ok: false, check, reason })
  })

  it('refuses a host pattern on any rule but network egress, and one that does not cover the host that asked', () => {
    expect(guard({ claim: claim(approve('session')), widenedTo: '*.example.com' })).toEqual({ ok: false, check: 'widening', reason: '--host widens a network approval only; this one is write_scope for /outside' })
    expect(guard({ claim: claim(approve('session')), ledger: waiting({ rule: 'network_egress', subject: 'api.other.com' }), widenedTo: '*.example.com' })).toEqual({ ok: false, check: 'widening', reason: 'The pattern *.example.com does not cover api.other.com, the host that asked' })
    expect(guard({ claim: claim(approve('session', { subject: 'delete-below:/outside' })), ledger: waiting({ widerSubject: 'delete-below:/outside' }), widenedTo: '*.example.com' })).toEqual({ ok: false, check: 'wider_subject', reason: 'A host pattern and a wider subject do not combine' })
  })

  it.each<[string, DecisionClaim, LedgerView, string | undefined]>([
    ['a once', claim(approve()), waiting(), undefined],
    ['a denial of an ask recorded without its whole call', claim(deny()), waiting({}, { complete: false }), undefined],
    ['the ask\'s own challenge', claim(approve(), { challenge: SHOWN }), waiting({}, { challenges: ['b'.repeat(64), SHOWN] }), undefined],
    ['the ask\'s own subject named', claim(approve('session', { subject: '/outside' })), waiting(), undefined],
    ['the ask\'s wider subject for good', claim(approve('always', { subject: 'delete-below:/outside' })), waiting({ widerSubject: 'delete-below:/outside' }), 'delete-below:/outside'],
    ['a secret file\'s use for the session', claim(approve('session')), waiting({ rule: 'sensitive_path', subject: 'secret-file:/w/.env' }), undefined],
    ['a lasting denial of a sensitive file', claim(deny('always')), waiting({ rule: 'sensitive_path', subject: '/w/.env' }), undefined],
    ['a signed once before its proof deadline', claim(approve(), { consumeNotAfter: NOW + 1 }), waiting(), undefined],
    ['a proof deadline on a session approval', claim(approve('session'), { consumeNotAfter: NOW }), waiting(), undefined],
    ['a proof deadline on a denial', claim(deny(), { consumeNotAfter: NOW }), waiting(), undefined],
  ])('applies %s', (_name, input, ledger, wider) => {
    expect(guard({ claim: input, ledger })).toEqual({ ok: true, apply: wider === undefined ? {} : { wider } })
  })

  it('applies a host pattern that covers the host that asked, over http or https', () => {
    expect(guard({ claim: claim(approve('always')), ledger: waiting({ rule: 'network_egress', subject: 'api.example.com' }), widenedTo: '*.example.com' })).toEqual({ ok: true, apply: { widenedTo: '*.example.com' } })
    expect(guard({ claim: claim(approve('session')), ledger: waiting({ rule: 'network_egress', subject: 'api.example.com' }), widenedTo: '*.example.com:443' })).toEqual({ ok: true, apply: { widenedTo: '*.example.com:443' } })
  })
})
