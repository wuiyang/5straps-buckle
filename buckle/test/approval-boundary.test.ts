import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
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
// The approval service's own answer, which takes any source; a core client decides through `decide`, naming its own.
const ANSWERS_ON_SERVICE = /\b(?:approvals|approvalService)\??\.answer\(/
const ON_THE_SERVICE = /\bapprovalService\??\.(\w+)/g
// CoreApprovalApi's methods, and the forms backend the stdio face opens.
const CORE_API = ['decide', 'pending', 'waiting', 'waitingAsk', 'listing', 'challengeListing', 'withdrawCall', 'openFormsBackend']
const REGISTRY = 'common/services/approvals/approval-registry.ts'
const GUARD = 'common/domain/approval/decision-guard.ts'
const IMPORT = /from '([^']+)'/g
// The approval core: the ledger, the gate, the service, the guard, and their ports.
const CORE = ['common/services/approvals', 'common/domain/approval', 'common/types/ports/approval-source.ts', 'common/types/ports/nonce-claims.ts', 'common/types/ports/approval-backend.ts', 'common/types/ports/decision-audit.ts']
// What puts an ask into words for a person: commands, judge lines, expiry phrases, and the terminal's rendering.
const DISPLAY = /(?:domain\/(?:approval-instruction|approval-deadline|action-phrase|describe-call|local-time)|runtime\/(?:console|log-render)|\/cli\/[^']*)\.js$/

const TERMINAL_BACKEND = 'common/adapters/approval/terminal-backend.ts'
// The contract, the runtime's CliRequest, and the question the terminal shows.
const TERMINAL_DEPENDS_ON = ['@5straps/runtime', '../../types/ports/approval-backend.js', './terminal-question.js']
// What a backend never reaches, through any module of its own: the ledger's schema and the approval services.
const BEYOND_A_BACKEND = /^common\/(?:domain\/approval\/asked-call|services\/approvals\/)/
const OWN_MODULES = 'common/adapters/approval/'
const FORMS_BACKEND = 'mcp/forms-backend.ts'
const BEYOND_A_FORMS_BACKEND = /(?:domain\/approval\/asked-call|services\/|workspaces\/)/

// A device's proof, minted by the node's request verifier alone once a signature checked.
const MINTS_A_DEVICE_PROOF = /(?<!function )\bmintDeviceProof\(/
const REQUEST_VERIFIER = 'common/services/access/signed-requests.ts'

const importsOf = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(IMPORT)].map(match => match[1]!)

/** Every module a file imports, package-relative, following the imports of the modules beside it in its own folder. */
function reachedFrom(file: string): string[] {
  const reached = new Set<string>()
  const visit = (path: string) => {
    for (const specifier of importsOf(join(PACKAGE_ROOT, path))) {
      if (!specifier.startsWith('.')) continue
      const target = relative(PACKAGE_ROOT, resolve(dirname(join(PACKAGE_ROOT, path)), specifier)).replace(/\.js$/, '.ts')
      if (reached.has(target)) continue
      reached.add(target)
      if (target.startsWith(OWN_MODULES)) visit(target)
    }
  }
  visit(file)
  return [...reached]
}
const importing = (paths: string[], target: RegExp): string[] => sourceFiles(...paths)
  .filter(file => importsOf(file).some(specifier => target.test(specifier)))
  .map(file => relative(PACKAGE_ROOT, file))

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

  it('lets the CLI approvers and the MCP faces decide through the core approval API and the forms backend alone', () => {
    const callers = sourceFiles('cli', 'mcp')
      .filter(file => ANSWERS_ON_SERVICE.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(callers).toEqual([])
  })

  it('lets the faces reach the approval service through the core approval API alone, and the stdio face open its forms', () => {
    const reached = new Set(sourceFiles('main.ts', 'cli', 'mcp', 'server', 'layers').flatMap(file => [...readFileSync(file, 'utf8').matchAll(ON_THE_SERVICE)].map(match => match[1]!)))
    expect([...reached].filter(method => !CORE_API.includes(method))).toEqual([])
  })

  it('lets only the node\'s request verifier mint a device\'s proof', () => {
    const minters = sourceFiles('main.ts', 'common', 'cli', 'mcp', 'server', 'layers')
      .filter(file => MINTS_A_DEVICE_PROOF.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(minters).toEqual([REQUEST_VERIFIER])
  })

  it('keeps every adapter off the approval services', () => {
    expect(importing(['common/adapters'], /services\/approvals\//)).toEqual([])
  })

  it('keeps the approval core off the approval adapters', () => {
    expect(importing(CORE, /adapters\/approval\//)).toEqual([])
  })

  it('keeps the approval core off the display modules', () => {
    expect(importing(CORE, DISPLAY)).toEqual([])
  })

  it('builds the terminal backend on the contract and the CLI requester alone', () => {
    expect(importsOf(join(PACKAGE_ROOT, TERMINAL_BACKEND)).filter(specifier => !TERMINAL_DEPENDS_ON.includes(specifier))).toEqual([])
  })

  it('keeps the terminal backend\'s own modules off the ledger\'s schema and the approval services', () => {
    expect(reachedFrom(TERMINAL_BACKEND).filter(path => BEYOND_A_BACKEND.test(path))).toEqual([])
  })

  it('builds the forms backend on the contract and the display modules, never the ledger\'s schema or the approval services', () => {
    expect(importsOf(join(PACKAGE_ROOT, FORMS_BACKEND)).filter(specifier => BEYOND_A_FORMS_BACKEND.test(specifier))).toEqual([])
  })

  it('keeps the backend contract off the ledger\'s schema and the approval services', () => {
    expect(reachedFrom('common/types/ports/approval-backend.ts').filter(path => BEYOND_A_BACKEND.test(path))).toEqual([])
  })
})
