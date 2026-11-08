import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { describe, expect, it } from 'vitest'
import { guardDecision, guardSkip, screenDecision, type DecisionClaim, type GuardRefusalCode, type LedgerView } from '../common/domain/approval/decision-guard.js'
import { RECORDED_BEFORE_NOTE } from '../common/domain/approval/recorded-before-note.js'
import { TODAYS_ROUTES } from '../common/domain/approval/routes.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// Today's checks on an answer, held by the pure decision guard (the approval backend design, slice 4), taken from the
// once, CLI, sensitive-file, and signed-deadline suites. guardDecision runs every check, screenDecision's first; the
// registry also runs screenDecision before it locks the approvals file, with the same messages as before.

const NOW = Date.parse('2026-11-07T10:00:00.000Z')
const SHOWN = 'a'.repeat(64)
const request: ApprovalRequest = { token: 't-1', rule: 'write_scope', subject: '/outside', reason: 'outside', tool: 'fs_write', offeredScopes: ['once', 'session', 'always'], expiresAt: '2026-11-07T10:10:00.000Z' }

const approve = (scope: ApprovalDecision['scope'] = 'once', extra: Partial<ApprovalDecision> = {}): ApprovalDecision => ({ token: 't-1', approved: true, scope, ...extra })
const deny = (scope: ApprovalDecision['scope'] = 'once'): ApprovalDecision => ({ token: 't-1', approved: false, scope })
const claim = (decision: ApprovalDecision, extra: Partial<DecisionClaim> = {}): DecisionClaim => ({ decision, source: SOURCES.cli, ...extra })
const waiting = (asked: Partial<ApprovalRequest> = {}, input: { complete?: boolean; challenges?: string[] } = {}): LedgerView => ({ waiting: { request: { ...request, ...asked }, complete: input.complete ?? true, challenges: input.challenges ?? [SHOWN], marks: PLAIN_MARKS, routes: TODAYS_ROUTES } })
const guard = (input: { claim: DecisionClaim; ledger?: LedgerView }) => guardDecision({ claim: input.claim, ledger: input.ledger ?? waiting(), now: NOW })

describe('the checks before the approvals file is read', () => {
  it.each<[string, DecisionClaim, GuardRefusalCode, string]>([
    ['a lasting approval from a relayed source', claim(approve('session'), { source: SOURCES.judge }), 'assurance_too_low', 'This answer is relayed, so it decides once and nothing that outlives the call'],
    ['a lasting denial from a relayed source', claim(deny('always'), { source: SOURCES.judge }), 'assurance_too_low', 'This answer is relayed, so it decides once and nothing that outlives the call'],
    ['a host pattern from a relayed source', claim(approve('once'), { source: SOURCES.judge, widenTo: '*.example.com' }), 'scope_forbidden', 'Only buckle approve widens an approval to a host pattern'],
    ['a host pattern on a denial', claim(deny('session'), { widenTo: '*.example.com' }), 'scope_forbidden', 'A denial names no host pattern; deny without --host'],
    ['a host pattern on a once', claim(approve('once'), { widenTo: '*.example.com' }), 'scope_forbidden', 'A once approval covers one call to the host that asked; widen a session or always approval instead'],
    ['a host pattern that is no wildcard', claim(approve('session'), { widenTo: ' api.example.com ' }), 'statement_invalid', '--host takes a wildcard pattern such as *.example.com, got api.example.com; without --host the approval is for the host that asked'],
    ['a wildcard over an address', claim(approve('session'), { widenTo: '*.10.0.0.1' }), 'statement_invalid', 'A wildcard covers a domain, not an address: *.10.0.0.1'],
  ])('refuses %s', (_name, input, code, reason) => {
    expect(screenDecision(input)).toEqual({ ok: false, code, reason })
  })

  it('passes a once from a relayed source, and gives a host pattern trimmed', () => {
    expect(screenDecision(claim(approve('once'), { source: SOURCES.judge }))).toEqual({ ok: true })
    expect(screenDecision(claim(approve('always'), { widenTo: ' *.example.com ' }))).toEqual({ ok: true, widenedTo: '*.example.com' })
  })
})

describe('the checks against the ask', () => {
  it('runs the screen itself, so a caller that skips it still meets the assurance and host pattern checks', () => {
    expect(guard({ claim: claim(approve('session'), { source: SOURCES.judge }) })).toEqual({ ok: false, code: 'assurance_too_low', reason: 'This answer is relayed, so it decides once and nothing that outlives the call' })
    expect(guard({ claim: claim(deny('always'), { source: SOURCES.judge }), ledger: waiting({ rule: 'sensitive_path', subject: '/w/.env' }) })).toEqual({ ok: false, code: 'assurance_too_low', reason: 'This answer is relayed, so it decides once and nothing that outlives the call' })
    expect(guard({ claim: claim(approve('session'), { widenTo: 'api.example.com' }), ledger: waiting({ rule: 'network_egress', subject: 'api.example.com' }) })).toEqual({ ok: false, code: 'statement_invalid', reason: '--host takes a wildcard pattern such as *.example.com, got api.example.com; without --host the approval is for the host that asked' })
    expect(guard({ claim: claim(approve('session'), { widenTo: ' *.example.com ' }), ledger: waiting({ rule: 'network_egress', subject: 'api.example.com' }) })).toEqual({ ok: true, apply: { widenedTo: '*.example.com' } })
  })

  it('answers the decision already applied as repeated, naming what it answered, and refuses another', () => {
    const resolved: LedgerView = { resolved: { decision: approve('session'), request } }
    expect(guard({ claim: claim(approve('session')), ledger: resolved })).toEqual({ ok: true, repeated: true, asked: { rule: 'write_scope', subject: '/outside' } })
    expect(guard({ claim: claim(approve('session')), ledger: { resolved: { decision: approve('session') } } })).toEqual({ ok: true, repeated: true })
    for (const other of [approve('always'), deny('session'), approve('session', { subject: 'delete-below:/outside' })]) {
      expect(guard({ claim: claim(other), ledger: resolved })).toEqual({ ok: false, code: 'conflicting_decision', reason: 'Approval already has a different decision' })
    }
    expect(guard({ claim: claim(approve('session'), { widenTo: '*.example.com' }), ledger: resolved })).toEqual({ ok: false, code: 'conflicting_decision', reason: 'Approval already has a different decision' })
    expect(guard({ claim: claim(approve('session'), { widenTo: ' *.example.com' }), ledger: { resolved: { decision: approve('session'), widenedTo: '*.example.com' } } })).toEqual({ ok: true, repeated: true })
  })

  it('takes a retry of a decision whose grant is owed only from the source that recorded it', () => {
    const owed: LedgerView = { resolved: { decision: approve('session'), owedBy: SOURCES.terminal } }
    expect(guard({ claim: claim(approve('session')), ledger: owed })).toEqual({ ok: false, code: 'approver_not_allowed', reason: 'terminal recorded this decision, so only it may retry its save' })
    expect(guard({ claim: claim(approve('session'), { source: SOURCES.terminal }), ledger: owed })).toEqual({ ok: true, repeated: true })
    expect(guard({ claim: claim(approve('always'), { source: SOURCES.terminal }), ledger: owed })).toMatchObject({ ok: false, code: 'conflicting_decision' })
  })

  it.each<[string, DecisionClaim, LedgerView, GuardRefusalCode, string]>([
    ['a token nothing waits for', claim(approve()), {}, 'unknown_ask', 'Approval token is unknown or expired'],
    ['a challenge other than the ask\'s', claim(approve(), { challenge: 'f'.repeat(64) }), waiting(), 'action_mismatch', 'The decision names another challenge than this ask\'s: fetch the challenge again and decide on what it shows'],
    ['a challenge for an ask shown under none', claim(deny(), { challenge: SHOWN }), waiting({}, { complete: false, challenges: [] }), 'action_mismatch', 'The decision names another challenge than this ask\'s: fetch the challenge again and decide on what it shows'],
    ['an approval of an ask recorded without its whole call', claim(approve()), waiting({}, { complete: false }), 'incomplete_action', `This ask was ${RECORDED_BEFORE_NOTE}`],
    ['a scope the ask does not offer', claim(approve('always')), waiting({ offeredScopes: ['once', 'session'] }), 'scope_not_offered', 'Scope always is not offered for this approval'],
    ['a denial naming a subject', claim({ ...deny(), subject: 'delete-below:/outside' }), waiting(), 'statement_invalid', 'A denial names no subject: it denies the ask\'s own'],
    ['a subject the ask offers none of', claim(approve('session', { subject: '/elsewhere' })), waiting(), 'scope_not_offered', 'This ask grants /outside, not /elsewhere'],
    ['a subject other than the ask\'s wider one', claim(approve('session', { subject: '/elsewhere' })), waiting({ widerSubject: 'delete-below:/outside' }), 'scope_not_offered', 'This ask grants /outside or delete-below:/outside, not /elsewhere'],
    ['a wider subject for once', claim(approve('once', { subject: 'delete-below:/outside' })), waiting({ widerSubject: 'delete-below:/outside' }), 'scope_forbidden', 'A once approval covers the one call that asked; grant the folder and its subfolders for the session or always instead'],
    ['a lasting approval of a sensitive file', claim(approve('session')), waiting({ rule: 'sensitive_path', subject: '/w/.env' }), 'scope_forbidden', 'Sensitive files can only be allowed once'],
    ['a lasting denial of anything but a sensitive file', claim(deny('always')), waiting(), 'scope_forbidden', 'Persistent denials are supported only for sensitive files'],
    ['a signed once at its proof deadline', claim(approve(), { consumeNotAfter: NOW }), waiting(), 'proof_expired', 'Signed approval expired before tool admission; sign a fresh decision over the current challenge'],
    ['a signed once whose deadline is no time', claim(approve(), { consumeNotAfter: Number.NaN }), waiting(), 'proof_expired', 'Signed approval expired before tool admission; sign a fresh decision over the current challenge'],
  ])('refuses %s', (_name, input, ledger, code, reason) => {
    expect(guard({ claim: input, ledger })).toEqual({ ok: false, code, reason })
  })

  it('refuses a host pattern on any rule but network egress, and one that does not cover the host that asked', () => {
    expect(guard({ claim: claim(approve('session'), { widenTo: '*.example.com' }) })).toEqual({ ok: false, code: 'scope_forbidden', reason: '--host widens a network approval only; this one is write_scope for /outside' })
    expect(guard({ claim: claim(approve('session'), { widenTo: '*.example.com' }), ledger: waiting({ rule: 'network_egress', subject: 'api.other.com' }) })).toEqual({ ok: false, code: 'scope_forbidden', reason: 'The pattern *.example.com does not cover api.other.com, the host that asked' })
    expect(guard({ claim: claim(approve('session', { subject: 'delete-below:/outside' }), { widenTo: '*.example.com' }), ledger: waiting({ widerSubject: 'delete-below:/outside' }) })).toEqual({ ok: false, code: 'scope_forbidden', reason: 'A host pattern and a wider subject do not combine' })
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
    expect(guard({ claim: claim(approve('always'), { widenTo: '*.example.com' }), ledger: waiting({ rule: 'network_egress', subject: 'api.example.com' }) })).toEqual({ ok: true, apply: { widenedTo: '*.example.com' } })
    expect(guard({ claim: claim(approve('session'), { widenTo: '*.example.com:443' }), ledger: waiting({ rule: 'network_egress', subject: 'api.example.com' }) })).toEqual({ ok: true, apply: { widenedTo: '*.example.com:443' } })
  })
})

describe('the checks on a skip of an approval\'s save', () => {
  const recorded = (scope: ApprovalDecision['scope'], approved = true) => ({ approved, scope, source: SOURCES.cli })

  it('lets the source that recorded a session or always approval skip its save, and a lasting approval whose grant was dropped', () => {
    expect(guardSkip({ source: SOURCES.cli, recorded: recorded('session') })).toEqual({ ok: true })
    expect(guardSkip({ source: SOURCES.cli, recorded: recorded('always') })).toEqual({ ok: true })
    expect(guardSkip({ source: SOURCES.forms, recorded: { approved: true, scope: 'session' } })).toEqual({ ok: true })
  })

  it.each<[string, Parameters<typeof guardSkip>[0], GuardRefusalCode, string]>([
    ['no decision recorded', { source: SOURCES.cli, recorded: undefined }, 'unknown_ask', 'No decision is recorded for this token, so it has no save to skip'],
    ['a once approval', { source: SOURCES.cli, recorded: recorded('once') }, 'conflicting_decision', 'This decision made no session or always grant, so it has no save to skip'],
    ['a lasting denial', { source: SOURCES.cli, recorded: recorded('session', false) }, 'conflicting_decision', 'This decision made no session or always grant, so it has no save to skip'],
    ['another route', { source: SOURCES.terminal, recorded: recorded('session') }, 'approver_not_allowed', 'cli recorded this decision, so only it may skip its save'],
    ['a backend named after the route', { source: { id: 'cli', kind: 'backend' }, recorded: recorded('session') }, 'approver_not_allowed', 'cli recorded this decision, so only it may skip its save'],
  ])('refuses a skip of %s', (_name, input, code, reason) => {
    expect(guardSkip(input)).toEqual({ ok: false, code, reason })
  })
})
