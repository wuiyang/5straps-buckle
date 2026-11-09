import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupCli } from '../cli/setup.js'
import { createTerminalBackend } from '../common/adapters/approval/terminal-backend.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { guardDecision, type LedgerView } from '../common/domain/approval/decision-guard.js'
import { TODAYS_ROUTES } from '../common/domain/approval/routes.js'
import type { DeletePolicy } from '../common/domain/delete-policy.js'
import type { ResolvedEffect } from '../common/domain/effect.js'
import { createPathView } from '../common/domain/path-view.js'
import type { PermissionDecision, PermissionRule } from '../common/domain/permission/decision.js'
import { createDestructiveCommandRule } from '../common/domain/permission/rules/destructive-command-rule.js'
import { createDestructivePathRule } from '../common/domain/permission/rules/destructive-path-rule.js'
import { createSensitivePathRule } from '../common/domain/permission/rules/sensitive-path-rule.js'
import { createWriteScopeRule } from '../common/domain/permission/rules/write-scope-rule.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import type { ApprovalService } from '../common/services/approvals/approval-service.js'
import type { ApprovalHost, FullAsk } from '../common/types/ports/approval-backend.js'
import { SOURCES, type ApprovalSource } from '../common/types/ports/approval-source.js'
import { createFormsBackend, type FormsBackend } from '../mcp/forms-backend.js'
import { fakeHost } from './support/approval-backend-kit.js'
import { approvalServiceWithTerminal, fixedInteraction } from './support/interaction.js'

// APPROVAL-33, the owner's ruling of 2026-11-09: wherever an ask is answered, it offers the same choices, approve or deny,
// once, session, or always as the ask offers them. Each ask here is made by the rule that makes it in a workspace, kept
// in a real ledger, and drawn as the serve terminal draws it and as an MCP form over HTTP and over stdio draws it; every
// choice the HTTP form offers is then held to the decision guard as its own caller's answer, as a stdio form's, and as
// the terminal's. The terminal alone grants a delete's folder and its subfolders (the delete policy brief), which only the
// node's terminal and buckle approve widen to, so those two choices are read apart.

type Ask = Extract<PermissionDecision, { kind: 'ask' }>
type Form = { requestedSchema: { properties: Record<string, { enum?: string[] }> } }

const WORKSPACE = '/work/project'
const CALLER = 'agent:a'
const NO_GRANTS = { subjectsFor: () => [] }
const ASK_IN_WORKSPACE: DeletePolicy = { inWorkspace: 'ask', massLimit: 100 }
const paths = createPathView({ root: WORKSPACE, mount: null })
const CALL = { arguments: { path: 'a' }, cwd: WORKSPACE, description: null, effects: [], complete: true as const }

/** A choice as `<outcome> <scope>`, and ` below` where it grants the ask's folder and its subfolders in place of its subject. */
const TERMINAL_CHOICES: Readonly<Record<string, string>> = {
  'approve once': 'approve once', 'approve this session': 'approve session', 'always approve': 'approve always',
  'approve this session, folder and below': 'approve session below', 'always approve, folder and below': 'approve always below',
  'deny': 'deny once', 'deny this session': 'deny session', 'always deny': 'deny always',
}
const FORM_ACTIONS: Readonly<Record<string, string>> = {
  allow_once: 'approve once', allow_session: 'approve session', allow_always: 'approve always',
  deny: 'deny once', deny_session: 'deny session', always_deny: 'deny always',
}

function made(rule: PermissionRule, tool: string, effect: ResolvedEffect): Ask {
  const decision = rule.evaluate({ tool, effect, effects: [effect], grants: NO_GRANTS })
  if (decision?.kind !== 'ask') throw new Error(`${tool} did not ask: ${JSON.stringify(decision)}`)
  return decision
}

const deleted = (path: string): ResolvedEffect => ({ kind: 'delete_path', path, directory: path.slice(0, path.lastIndexOf('/')), floor: true })
const fileFloor = createDestructivePathRule({ paths, strict: false, deletes: ASK_IN_WORKSPACE, home: '/home/owner' })

const EVERY_SCOPE = ['approve once', 'approve session', 'approve always']
const NO_ALWAYS = ['approve once', 'approve session']

/** Each ask, its tool, and the choices it offers for its own subject wherever it is answered. */
const ASKS: Array<[string, string, () => Ask, string[]]> = [
  ['a plain write', 'fs_write', () => made(createWriteScopeRule({ paths, strict: false, deletes: ASK_IN_WORKSPACE }), 'fs_write', { kind: 'write_path', path: `${WORKSPACE}/a.md`, directory: WORKSPACE }), [...EVERY_SCOPE, 'deny once']],
  ['a floor command', 'shell_exec', () => made(createDestructiveCommandRule(), 'shell_exec', { kind: 'exec', command: 'sudo', args: ['ls'] }), [...NO_ALWAYS, 'deny once']],
  ['a file floor delete', 'fs_delete', () => made(fileFloor, 'fs_delete', deleted(`${WORKSPACE}/src/a.ts`)), [...EVERY_SCOPE, 'deny once']],
  ['a file floor delete outside the workspace', 'fs_delete', () => made(fileFloor, 'fs_delete', deleted('/elsewhere/data/a.ts')), [...EVERY_SCOPE, 'deny once']],
  ['a secret reference file', 'shell_exec', () => made(createSensitivePathRule({ protectedRoots: [] }), 'shell_exec', { kind: 'secret_file', path: `${WORKSPACE}/.env.local`, written: ['.env.local'], names: ['API_TOKEN'] }), [...EVERY_SCOPE, 'deny once', 'deny session', 'deny always']],
  ['a script file run', 'shell_exec', () => made(createDestructiveCommandRule(), 'shell_exec', { kind: 'exec', command: './x.sh', args: [] }), [...NO_ALWAYS, 'deny once']],
]

const roots: string[] = []
const services: ApprovalService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A ledger with both faces' forms open on it as core opens them, the forms setting on. */
function node() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-choice-parity-'))
  roots.push(root)
  const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' }), join(root, 'approvals.json'), 600_000, { live: () => ({ forms: true }) })
  const service = approvalServiceWithTerminal({ registry, workspaceId: 'w-1', workspaceName: 'Site', serverId: 'node-1', graceMs: 200, interaction: fixedInteraction() })
  services.push(service)
  const formsOf = (face: 'stdio' | 'http') => {
    const backend = createFormsBackend({ workspace: () => ({ id: 'w-1', name: 'Site' }), node: 'node-1', approves: () => false })
    let host: ApprovalHost | undefined
    service.openFormsBackend({ ...backend, open: async (opener) => { host = opener; return backend.open(opener) } }, face)
    return { backend, host: () => host! }
  }
  return { registry, http: formsOf('http'), stdio: formsOf('stdio') }
}

function formChoices(drawn: unknown, token: string): string[] {
  const shown = (drawn as { inputRequests: Record<string, { params?: Form } & Partial<Form>> }).inputRequests[token]!
  const { properties } = (shown.params ?? shown as Form).requestedSchema
  if (properties['action']) return properties['action'].enum!.map(action => FORM_ACTIONS[action]!)
  return [...properties['scope']!.enum!.map(scope => `approve ${scope}`), 'deny once']
}

/** The choices row the serve terminal prints for the ask, as `buckle serve` sets its terminal up, read off its output. */
async function terminalChoices(ask: FullAsk): Promise<string[]> {
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8') })
  const cli = setupCli({ terminal: { input, output, onInterrupt: () => {} } })
  const terminal = createTerminalBackend({ requester: async () => cli.requestCli })
  await terminal.open(fakeHost({ routed: [ask] }))
  const stop = new AbortController()
  const submitted = terminal.submit([ask], { signal: stop.signal, resend: false })
  await vi.waitFor(() => expect(shown).toMatch(/Your choice: $/), { timeout: 3_000 })
  const lines = shown.split('\n')
  stop.abort()
  await submitted.catch(() => undefined)
  await terminal.close()
  await cli.close()
  const row = lines[lines.length - 2]!.replace(/^\[[^\]]*\] /, '')
  return [...row.matchAll(/\((\w+)\) (.+?)(?= {2}\(|$)/g)].map(([, , label]) => TERMINAL_CHOICES[label!]!)
}

/** Whether the guard takes the choice from `source`, as the asking caller's answer, with the forms setting on. */
function takes(input: { source: ApprovalSource; choice: string; request: ApprovalRequest; ask: Ask }): boolean {
  const [outcome, scope] = input.choice.split(' ') as ['approve' | 'deny', ApprovalDecision['scope']]
  const ledger: LedgerView = { waiting: { request: input.request, complete: true, challenges: [], marks: { floor: input.ask.floor, destructive: input.ask.destructive }, routes: TODAYS_ROUTES, actor: CALLER } }
  const claim = { decision: { token: input.request.token, approved: outcome === 'approve', scope }, source: input.source, caller: CALLER }
  return guardDecision({ claim, ledger, now: Date.now(), live: { forms: true } }).ok
}

describe('the choices each route offers for one ask', () => {
  it.each(ASKS)('are the same for %s at the serve terminal, in a stdio form, and in an HTTP form, which its own caller\'s answer decides', async (_name, tool, makeAsk, offered) => {
    const ask = makeAsk()
    const { registry, http, stdio } = node()
    const [request] = (await registry.ask({ tool, sessionId: 'mcp', actor: CALLER, requestId: `r-${tool}`, asks: [ask], call: CALL })).requests
    const { token } = request!
    const fullAsk = http.host().pending().find(waiting => waiting.token === token)!

    const atTerminal = await terminalChoices(fullAsk)
    expect(atTerminal.filter(choice => !choice.endsWith(' below'))).toEqual(offered)
    expect(atTerminal.filter(choice => choice.endsWith(' below'))).toEqual(ask.widerSubject === undefined ? [] : ['approve session below', 'approve always below'])
    const overHttp = formChoices(http.backend.forms([request!]), token)
    expect(overHttp).toEqual(offered)
    expect(formChoices(stdio.backend.forms([request!]), token)).toEqual(offered)

    for (const choice of overHttp) {
      const sources = [SOURCES['http-forms'], SOURCES.forms, SOURCES.terminal]
      expect(sources.map(source => takes({ source, choice, request: request!, ask })), choice).toEqual([true, true, true])
    }
    const widest = overHttp.filter(choice => choice.startsWith('approve ')).at(-1)!.split(' ')[1]!
    const answer = ask.rule === 'sensitive_path' ? { action: `allow_${widest}` } : { approve: true, scope: widest }
    expect((await http.backend.answer({ [token]: { action: 'accept', content: answer } }, { caller: CALLER })).tokens).toEqual([token])
  })
})
