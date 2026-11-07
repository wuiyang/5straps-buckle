import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { describe, expect, it } from 'vitest'
import { assuranceOf, atLeast } from '../common/domain/approval/assurance.js'
import { guardDecision, screenDecision, type DecisionClaim } from '../common/domain/approval/decision-guard.js'
import type { ApprovalSource } from '../common/types/ports/approval-source.js'

// Each answer names its source, and the guard rates it: only `local` and above decide for longer than the call, and only
// `buckle approve` widens to a host pattern. Today's routes keep today's rights.

const NOW = Date.parse('2026-11-07T10:00:00.000Z')
const request: ApprovalRequest = { token: 't-1', rule: 'network_egress', subject: 'api.example.com', reason: 'egress', tool: 'web_fetch', offeredScopes: ['once', 'session', 'always'], expiresAt: '2026-11-07T10:10:00.000Z' }
const ledger = { waiting: { request, complete: true, challenges: [] } }
const claim = (source: ApprovalSource, decision: Partial<ApprovalDecision> = {}, extra: Partial<DecisionClaim> = {}): DecisionClaim => ({ decision: { token: 't-1', approved: true, scope: 'once', ...decision }, source, ...extra })

describe('the assurance each source carries', () => {
  it.each<[ApprovalSource, string]>([
    ['terminal', 'local'],
    ['cli', 'local'],
    ['forms', 'local'],
    ['devices', 'key'],
    ['sealed', 'local'],
    ['judge', 'relayed'],
  ])('rates %s %s', (source, assurance) => {
    expect(assuranceOf(source)).toBe(assurance)
  })

  it('ranks relayed below local, and key and idp above it', () => {
    expect(atLeast('relayed', 'local')).toBe(false)
    expect(['local', 'key', 'idp'].every(assurance => atLeast(assurance as 'local' | 'key' | 'idp', 'local'))).toBe(true)
  })
})

describe('what a source may decide', () => {
  it('lets a relayed source decide once, and nothing that outlives the call', () => {
    expect(guardDecision({ claim: claim('judge'), ledger, now: NOW })).toEqual({ ok: true, apply: {} })
    for (const decision of [{ scope: 'session' as const }, { scope: 'always' as const }, { approved: false, scope: 'session' as const }]) {
      expect(screenDecision(claim('judge', decision))).toEqual({ ok: false, code: 'assurance_too_low', reason: 'This answer is relayed, so it decides once and nothing that outlives the call' })
    }
  })

  it.each<ApprovalSource>(['terminal', 'cli', 'forms', 'devices', 'sealed'])('lets %s decide for longer than the call', (source) => {
    expect(guardDecision({ claim: claim(source, { scope: 'session' }), ledger, now: NOW })).toEqual({ ok: true, apply: {} })
  })

  it.each<ApprovalSource>(['terminal', 'forms', 'devices', 'sealed', 'judge'])('refuses a host pattern from %s, which only buckle approve passes', (source) => {
    expect(screenDecision(claim(source, { scope: 'always' }, { widenTo: '*.example.com' }))).toEqual({ ok: false, code: source === 'judge' ? 'assurance_too_low' : 'scope_forbidden', reason: source === 'judge' ? 'This answer is relayed, so it decides once and nothing that outlives the call' : 'Only buckle approve widens an approval to a host pattern' })
  })

  it('takes a host pattern from buckle approve', () => {
    expect(guardDecision({ claim: claim('cli', { scope: 'always' }, { widenTo: '*.example.com' }), ledger, now: NOW })).toEqual({ ok: true, apply: { widenedTo: '*.example.com' } })
  })
})
