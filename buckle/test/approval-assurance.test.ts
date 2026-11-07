import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { describe, expect, it } from 'vitest'
import { atLeast, rightsOf } from '../common/domain/approval/assurance.js'
import { guardDecision, screenDecision, type DecisionClaim } from '../common/domain/approval/decision-guard.js'
import { SOURCES, type ApprovalSource } from '../common/types/ports/approval-source.js'

// Each answer names its source, and the guard rates it by the source's kind: only `local` and above decide for longer
// than the call, a backend only denies, and only `buckle approve` widens to a host pattern. Today's routes keep today's rights.

const NOW = Date.parse('2026-11-07T10:00:00.000Z')
const request: ApprovalRequest = { token: 't-1', rule: 'network_egress', subject: 'api.example.com', reason: 'egress', tool: 'web_fetch', offeredScopes: ['once', 'session', 'always'], expiresAt: '2026-11-07T10:10:00.000Z' }
const secret: ApprovalRequest = { ...request, rule: 'sensitive_path', subject: '/workspace/.env', tool: 'fs_read', offeredScopes: ['once', 'session', 'always'] }
const ledger = { waiting: { request, complete: true, challenges: [] } }
const claim = (source: ApprovalSource, decision: Partial<ApprovalDecision> = {}, extra: Partial<DecisionClaim> = {}): DecisionClaim => ({ decision: { token: 't-1', approved: true, scope: 'once', ...decision }, source, ...extra })
const RELAYED = 'This answer is relayed, so it decides once and nothing that outlives the call'
const DENIES_ONLY = 'Approval requires an enrolled device key: review and confirm with buckle client approve'

describe('the assurance each source kind carries', () => {
  it.each<[keyof typeof SOURCES, string]>([
    ['terminal', 'local'],
    ['cli', 'local'],
    ['forms', 'local'],
    ['devices', 'key'],
    ['sealed', 'relayed'],
    ['judge', 'relayed'],
  ])('rates %s %s', (source, assurance) => {
    expect(rightsOf(SOURCES[source].kind).assurance).toBe(assurance)
  })

  it('names the setup route\'s envelope as a backend, whose rights follow its kind and not its id', () => {
    expect(SOURCES.sealed.kind).toBe('backend')
    expect(screenDecision(claim({ id: 'cli', kind: 'backend' }))).toEqual({ ok: false, code: 'capability_exceeded', reason: DENIES_ONLY })
  })

  it('ranks relayed below local, and key and idp above it', () => {
    expect(atLeast('relayed', 'local')).toBe(false)
    expect(['local', 'key', 'idp'].every(assurance => atLeast(assurance as 'local' | 'key' | 'idp', 'local'))).toBe(true)
  })
})

describe('what a source may decide', () => {
  it('lets a relayed source decide once, and nothing that outlives the call', () => {
    expect(guardDecision({ claim: claim(SOURCES.judge), ledger, now: NOW })).toEqual({ ok: true, apply: {} })
    for (const decision of [{ scope: 'session' as const }, { scope: 'always' as const }, { approved: false, scope: 'session' as const }]) {
      expect(screenDecision(claim(SOURCES.judge, decision))).toEqual({ ok: false, code: 'assurance_too_low', reason: RELAYED })
    }
  })

  it.each<keyof typeof SOURCES>(['terminal', 'cli', 'forms', 'devices'])('lets %s decide for longer than the call', (source) => {
    expect(guardDecision({ claim: claim(SOURCES[source], { scope: 'session' }), ledger, now: NOW })).toEqual({ ok: true, apply: {} })
  })

  it.each(['once', 'session', 'always'] as const)('refuses the setup envelope\'s approval for %s, as it only denies', (scope) => {
    expect(screenDecision(claim(SOURCES.sealed, { scope }))).toEqual({ ok: false, code: 'capability_exceeded', reason: DENIES_ONLY })
    expect(guardDecision({ claim: claim(SOURCES.sealed, { scope }), ledger, now: NOW })).toEqual({ ok: false, code: 'capability_exceeded', reason: DENIES_ONLY })
  })

  it('keeps the setup envelope\'s denials, a lasting one of a sensitive file included, as today', () => {
    expect(guardDecision({ claim: claim(SOURCES.sealed, { approved: false }), ledger, now: NOW })).toEqual({ ok: true, apply: {} })
    for (const scope of ['session', 'always'] as const) {
      expect(guardDecision({ claim: claim(SOURCES.sealed, { approved: false, scope }), ledger: { waiting: { request: secret, complete: true, challenges: [] } }, now: NOW })).toEqual({ ok: true, apply: {} })
      expect(guardDecision({ claim: claim(SOURCES.sealed, { approved: false, scope }), ledger, now: NOW })).toEqual({ ok: false, code: 'scope_forbidden', reason: 'Persistent denials are supported only for sensitive files' })
    }
  })

  it.each<keyof typeof SOURCES>(['terminal', 'forms', 'devices', 'judge'])('refuses a host pattern from %s, which only buckle approve passes', (source) => {
    expect(screenDecision(claim(SOURCES[source], { scope: 'always' }, { widenTo: '*.example.com' }))).toEqual({ ok: false, code: source === 'judge' ? 'assurance_too_low' : 'scope_forbidden', reason: source === 'judge' ? RELAYED : 'Only buckle approve widens an approval to a host pattern' })
  })

  it('takes a host pattern from buckle approve', () => {
    expect(guardDecision({ claim: claim(SOURCES.cli, { scope: 'always' }, { widenTo: '*.example.com' }), ledger, now: NOW })).toEqual({ ok: true, apply: { widenedTo: '*.example.com' } })
  })
})
