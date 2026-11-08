import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { PACKAGE_ROOT, sourceFiles } from './support/sources.js'

// The registry's `resolve` records a verdict, and `skipSave` a skip; it is reached as `approvals` on the runtime or `registry`
// in the service.
const RESOLVES_ON_REGISTRY = /\b(?:approvals|registry)\??\.(?:resolve|skipSave)\(/
const SERVICE = 'common/services/approvals/approval-service.ts'
// The registry's `evaluate` spends a `once` and claims the execution; the approval gate reaches it as `ledger`.
const EVALUATES_ON_REGISTRY = /\b(?:approvals|registry|ledger)\??\.evaluate\(/
const GATE = 'common/services/approvals/approval-gate.ts'
const INVOKER = 'common/services/invocation/invoker.ts'
// The invoker sees the approval gate and the grant lookup it hands out, never the ledger or a grant adapter.
const LEDGER_OR_GRANT_ADAPTER = /from '[^']*(?:approvals\/approval-registry|approvals\/once-store|adapters\/grant-store\/[^']*)\.js'/
// The decision guard's checks run in the registry, which holds the ledger, and nowhere else.
const GUARDS = /\b(?:guardDecision|guardSkip|screenDecision)\(/
// The whole approval service, whose `answer` takes any source: a face holds `approvalApi`, typed as the core approval API.
const NAMES_THE_SERVICE = /\bapprovalService\b/
const FACES = ['main.ts', 'cli', 'mcp', 'server', 'layers'] as const
// Opening a host's forms: nothing the agent's token reaches may answer an ask, so only the stdio face opens them. Any
// mention counts, so an import under another name is caught too: the opener sits on the faces' runtime type, and this
// scan, not the type, keeps it to the stdio face.
const OPENS_FORMS = /\bopenForms\b/
const NAMES_THE_FORMS_OPENER = /\bopenApprovalForms\b/
const NAMES_THE_SERVICE_FORMS_OPENER = /\bopenFormsBackend\b/
const RUNTIME = 'common/services/workspaces/workspace-runtime.ts'
// The runtime as core composes it, with the ledger and the service: a face that named it could widen its view back.
const NAMES_THE_CORE_RUNTIME = /\bCoreRuntime\b/
const REGISTRY = 'common/services/approvals/approval-registry.ts'
const GUARD = 'common/domain/approval/decision-guard.ts'
const IMPORT = /from '([^']+)'/g
// The approval core: the ledger, the gate, the service, the guard, and their ports.
const CORE = ['common/services/approvals', 'common/domain/approval', 'common/types/ports/approval-source.ts', 'common/types/ports/nonce-claims.ts', 'common/types/ports/approval-backend.ts', 'common/types/ports/decision-audit.ts']
// What puts an ask into words for a person: commands, judge lines, expiry phrases, and the terminal's rendering.
const DISPLAY = /(?:domain\/(?:approval-instruction|approval-deadline|action-phrase|describe-call|local-time)|runtime\/(?:console|log-render)|\/cli\/[^']*)\.js$/

const TERMINAL_BACKEND = 'common/adapters/approval/terminal-backend.ts'
// The contract, the runtime's CliRequest, the question the terminal shows, and the save question every route shares.
const TERMINAL_DEPENDS_ON = ['@5straps/runtime', '../../types/ports/approval-backend.js', './terminal-question.js', './grant-save-question.js']
// What a backend never reaches, through any module of its own: the ledger's schema and the approval services.
const BEYOND_A_BACKEND = /^common\/(?:domain\/approval\/asked-call|services\/approvals\/)/
const OWN_MODULES = 'common/adapters/approval/'
const FORMS_BACKEND = 'mcp/forms-backend.ts'
// What no backend reaches through any module: the permission engine, the guard, the ledger's schema, and the services.
const BEYOND_ANY_BACKEND = /^common\/(?:domain\/permission\/|domain\/approval\/(?:asked-call|decision-guard)|services\/)/
// The node's logger and config: a backend logs through its host.
const NODE_RUNTIME = /^common\/runtime\/(?:log|config)\.ts$/

// A device's proof, minted by the node's request verifier alone once a signature checked.
const MINTS_A_DEVICE_PROOF = /(?<!function )\bmintDeviceProof\(/
const REQUEST_VERIFIER = 'common/services/access/signed-requests.ts'

const importsOf = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(IMPORT)].map(match => match[1]!)

/**
 * Every module a file imports, package-relative, following the imports of the modules beside it in its own folder, or of
 * every module where `follow` is `all`.
 */
function reachedFrom(file: string, follow: 'own' | 'all' = 'own'): string[] {
  const reached = new Set<string>()
  const visit = (path: string) => {
    for (const specifier of importsOf(join(PACKAGE_ROOT, path))) {
      if (!specifier.startsWith('.')) continue
      const target = relative(PACKAGE_ROOT, resolve(dirname(join(PACKAGE_ROOT, path)), specifier)).replace(/\.js$/, '.ts')
      if (reached.has(target)) continue
      reached.add(target)
      if (follow === 'all' || target.startsWith(OWN_MODULES)) visit(target)
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
  it('lets only the approval service record a verdict or a skip on the registry', () => {
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

  it('hands the faces the core approval API alone: none names the approval service itself', () => {
    const naming = sourceFiles(...FACES)
      .filter(file => NAMES_THE_SERVICE.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(naming).toEqual([])
  })

  it('types the runtime the faces hold without the ledger or the service, and its approval API without answer or the forms opener', () => {
    expectTypeOf<BuckleRuntime>().not.toHaveProperty('approvals')
    expectTypeOf<BuckleRuntime>().not.toHaveProperty('approvalService')
    expectTypeOf<BuckleRuntime['approvalApi']>().not.toHaveProperty('answer')
    expectTypeOf<BuckleRuntime['approvalApi']>().not.toHaveProperty('openFormsBackend')
    const widening = sourceFiles(...FACES)
      .filter(file => NAMES_THE_CORE_RUNTIME.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(widening).toEqual([])
  })

  it('lets only the stdio face open a host\'s forms, through the one opener the MCP server defines', () => {
    const calling = (pattern: RegExp) => sourceFiles('main.ts', 'common', 'cli', 'mcp', 'server', 'layers')
      .filter(file => pattern.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(OPENS_FORMS.test('import { openForms as hostForms } from \'./server.js\'')).toBe(true)
    expect(calling(OPENS_FORMS)).toEqual(['mcp/server.ts', 'mcp/stdio.ts'])
    expect(calling(NAMES_THE_FORMS_OPENER)).toEqual([RUNTIME, 'mcp/server.ts'])
    expect(calling(NAMES_THE_SERVICE_FORMS_OPENER)).toEqual([SERVICE, RUNTIME])
  })

  it('lets only the node\'s request verifier mint a device\'s proof', () => {
    const minters = sourceFiles('main.ts', 'common', 'cli', 'mcp', 'server', 'layers')
      .filter(file => MINTS_A_DEVICE_PROOF.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(minters).toEqual([REQUEST_VERIFIER])
  })

  it('keeps the approval ports self-contained: they import nothing of core but each other', () => {
    const ports = ['common/types/ports/approval-backend.ts', 'common/types/ports/approval-source.ts', 'common/types/ports/decision-audit.ts']
    const reaching = ports.flatMap(port => importsOf(join(PACKAGE_ROOT, port)).filter(specifier => specifier.startsWith('.') && !specifier.startsWith('./')).map(specifier => `${port}: ${specifier}`))
    expect(reaching).toEqual([])
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

  it('keeps the terminal backend, through every module it reaches, off the permission engine, the guard, the ledger\'s schema, the services, and the node\'s runtime', () => {
    expect(reachedFrom(TERMINAL_BACKEND, 'all').filter(path => BEYOND_ANY_BACKEND.test(path) || NODE_RUNTIME.test(path))).toEqual([])
  })

  it('builds the forms backend on the contract and the display modules, never reaching the permission engine, the guard, the ledger\'s schema, or the services', () => {
    expect(reachedFrom(FORMS_BACKEND, 'all').filter(path => BEYOND_ANY_BACKEND.test(path))).toEqual([])
  })

  it('keeps the backend contract off the ledger\'s schema and the approval services', () => {
    expect(reachedFrom('common/types/ports/approval-backend.ts').filter(path => BEYOND_A_BACKEND.test(path))).toEqual([])
  })
})
