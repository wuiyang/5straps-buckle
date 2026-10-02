import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT, sourceFiles } from './support/sources.js'

// The registry's `resolve` records a verdict; it is reached as `approvals` on the runtime or `registry` in the service.
const RESOLVES_ON_REGISTRY = /\b(?:approvals|registry)\??\.resolve\(/
const SERVICE = 'common/services/approvals/approval-service.ts'

// Ruling 4 of 2026-09-28: the approval service is the single answerer (review L8).
describe('the approval boundary', () => {
  it('lets only the approval service record a verdict on the registry', () => {
    const callers = sourceFiles('main.ts', 'common', 'cli', 'mcp', 'server', 'layers')
      .filter(file => RESOLVES_ON_REGISTRY.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(callers).toEqual([SERVICE])
  })
})
