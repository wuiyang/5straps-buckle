import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT, sourceFiles } from './support/sources.js'

// The registry's `resolve` records a verdict; it is reached as `approvals` on the runtime or `registry` in the service.
const RESOLVES_ON_REGISTRY = /\b(?:approvals|registry)\??\.resolve\(/
const SERVICE = 'common/services/approvals/approval-service.ts'
// The registry's `evaluate` spends a `once` and claims the execution; the approval gate reaches it as `ledger`.
const EVALUATES_ON_REGISTRY = /\b(?:approvals|registry|ledger)\??\.evaluate\(/
const GATE = 'common/services/approvals/approval-gate.ts'
const INVOKER = 'common/services/invocation/invoker.ts'
// The invoker sees the approval gate and the grant lookup it hands out, never the ledger or a grant adapter.
const LEDGER_OR_GRANT_ADAPTER = /from '[^']*(?:approvals\/approval-registry|approvals\/once-store|adapters\/grant-store\/[^']*)\.js'/
// The decision guard's checks run in the registry, which holds the ledger, and nowhere else.
const GUARDS = /\b(?:guardDecision|screenDecision)\(/
const REGISTRY = 'common/services/approvals/approval-registry.ts'
const GUARD = 'common/domain/approval/decision-guard.ts'

// Ruling 4 of 2026-09-28: the approval service is the single answerer (review L8).
describe('the approval boundary', () => {
  it('lets only the approval service record a verdict on the registry', () => {
    const callers = sourceFiles('main.ts', 'common', 'cli', 'mcp', 'server', 'layers')
      .filter(file => RESOLVES_ON_REGISTRY.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(callers).toEqual([SERVICE])
  })

  it('lets only the approval gate spend a once and claim a call on the registry', () => {
    const callers = sourceFiles('main.ts', 'common', 'cli', 'mcp', 'server', 'layers')
      .filter(file => EVALUATES_ON_REGISTRY.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(callers).toEqual([GATE])
  })

  it('keeps the invoker off the ledger and the grant adapters', () => {
    expect(readFileSync(join(PACKAGE_ROOT, INVOKER), 'utf8')).not.toMatch(LEDGER_OR_GRANT_ADAPTER)
  })

  it('runs the decision guard in the registry alone', () => {
    const callers = sourceFiles('main.ts', 'common', 'cli', 'mcp', 'server', 'layers')
      .filter(file => GUARDS.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
      .filter(file => file !== GUARD)
    expect(callers).toEqual([REGISTRY])
  })
})
