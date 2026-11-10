import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ApprovalDecision, ApprovalRequest } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchApprovals, type WatchSource } from '../cli/approvals-watch.js'
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
import { createApprovalRegistry, type ApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import type { ApprovalService } from '../common/services/approvals/approval-service.js'
import type { CoreDecisionReceipt } from '../common/services/approvals/core-approval-api.js'
import type { ApprovalHost, DecisionBody, FullAsk } from '../common/types/ports/approval-backend.js'
import { SOURCES, type ApprovalSource } from '../common/types/ports/approval-source.js'
import { createFormsBackend } from '../mcp/forms-backend.js'
import { fakeHost } from './support/approval-backend-kit.js'
import { approvalServiceWithTerminal, fixedInteraction } from './support/interaction.js'

// Wherever an ask is answered, it offers the same choices, approve or deny, once, session, or always as the ask offers
// them, a floor ask's included. Each ask here is made by the rule that makes it in a workspace and kept in a real ledger.
// Each route is then driven for everything it can send: every key the serve terminal and `buckle approvals --watch` take,
// every answer an MCP form's schema admits over stdio and over HTTP, and every `--scope` and `--deny` the device route
// takes; each set is held to the choices the ask offers, and to the decision guard. A delete outside the workspace offers
// its folder and its subfolders on every route alike (APPROVAL-37, owner 2026-11-10), so no route offers less than another.

type Ask = Extract<PermissionDecision, { kind: 'ask' }>
type Property = { type?: string; enum?: unknown[] }
type Form = { requestedSchema: { properties: Record<string, Property>; required?: string[] } }

const WORKSPACE = '/work/project'
const CALLER = 'agent:a'
const NO_GRANTS = { subjectsFor: () => [] }
const ASK_IN_WORKSPACE: DeletePolicy = { inWorkspace: 'ask', massLimit: 100 }
const paths = createPathView({ root: WORKSPACE, mount: null })
const CALL = { arguments: { path: 'a' }, cwd: WORKSPACE, description: null, effects: [], complete: true as const }
const SCOPES = ['once', 'session', 'always'] as const

function made(rule: PermissionRule, tool: string, effect: ResolvedEffect): Ask {
  const decision = rule.evaluate({ tool, effect, effects: [effect], grants: NO_GRANTS })
  if (decision?.kind !== 'ask') throw new Error(`${tool} did not ask: ${JSON.stringify(decision)}`)
  return decision
}

const deleted = (path: string): ResolvedEffect => ({ kind: 'delete_path', path, directory: path.slice(0, path.lastIndexOf('/')), floor: true })
const fileFloor = createDestructivePathRule({ paths, strict: false, deletes: ASK_IN_WORKSPACE, home: '/home/owner' })

const EVERY_SCOPE = ['approve once', 'approve session', 'approve always']
const NO_ALWAYS = ['approve once', 'approve session']
const BELOW = ['approve session below', 'approve always below']

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

function node() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-choice-parity-'))
  roots.push(root)
  const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'w-1' }), join(root, 'approvals.json'), 600_000, { live: () => ({ forms: true }) })
  const service = approvalServiceWithTerminal({ registry, workspaceId: 'w-1', workspaceName: 'Site', serverId: 'node-1', graceMs: 200, interaction: fixedInteraction() })
  services.push(service)
  const http = createFormsBackend({ workspace: () => ({ id: 'w-1', name: 'Site' }), node: 'node-1', approves: () => false })
  let host: ApprovalHost | undefined
  service.openFormsBackend({ ...http, open: async (opener) => { host = opener; return http.open(opener) } }, 'http')
  return { registry, http, host: () => host! }
}

function choiceOf(decision: DecisionBody): string {
  return `${decision.outcome} ${decision.scope}${decision.widen === 'below' ? ' below' : ''}`
}

const sorted = (choices: Iterable<string>) => [...new Set(choices)].sort()

function answersOf(form: Form): Array<Record<string, unknown>> {
  const required = form.requestedSchema.required ?? []
  return Object.entries(form.requestedSchema.properties).reduce<Array<Record<string, unknown>>>((answers, [name, property]) => {
    const values = [...(property.enum ?? (property.type === 'boolean' ? [true, false] : [])), ...(required.includes(name) ? [] : [undefined])]
    return answers.flatMap(answer => values.map(value => (value === undefined ? answer : { ...answer, [name]: value })))
  }, [{}])
}

/** What an MCP form can send for the ask: each answer its schema admits, sent through the forms backend to a host that records it. */
async function formSends(face: 'stdio' | 'http', ask: FullAsk, request: ApprovalRequest): Promise<string[]> {
  const backend = createFormsBackend({ workspace: () => ({ id: 'w-1', name: 'Site' }), node: 'node-1', approves: () => false })
  const host = fakeHost({ routed: [ask], reach: { sameCaller: face === 'http' } })
  await backend.open(host)
  const drawn = backend.forms([request]) as unknown as { inputRequests: Record<string, { params?: Form } & Partial<Form>> }
  const shown = drawn.inputRequests[ask.token]!
  for (const content of answersOf(shown.params ?? shown as Form)) await backend.answer({ [ask.token]: { action: 'accept', content } }, { caller: CALLER })
  await backend.close()
  return sorted(host.decided.map(sent => choiceOf(sent.decision)))
}

/** A serve terminal, as `buckle serve` sets it up, asking the ask; `answer` types a key once its choices row is shown. */
async function atTerminal(ask: FullAsk, answer?: string): Promise<{ row: string; sent?: string }> {
  const input = new PassThrough()
  const output = new PassThrough()
  let shown = ''
  output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8') })
  const cli = setupCli({ terminal: { input, output, onInterrupt: () => {} } })
  const terminal = createTerminalBackend({ requester: async () => cli.requestCli })
  const host = fakeHost({ routed: [ask] })
  await terminal.open(host)
  const stop = new AbortController()
  const submitted = terminal.submit([ask], { signal: stop.signal, resend: false })
  await vi.waitFor(() => expect(shown).toMatch(/Your choice: $/), { timeout: 5_000 })
  const lines = shown.split('\n')
  const row = lines[lines.length - 2]!.replace(/^\[[^\]]*\] /, '')
  if (answer !== undefined) {
    input.write(`${answer}\n`)
    await vi.waitFor(() => expect(host.decided).toHaveLength(1), { timeout: 5_000 })
  }
  stop.abort()
  await submitted.catch(() => undefined)
  await terminal.close()
  await cli.close()
  const [sent] = host.decided
  return { row, ...(sent === undefined ? {} : { sent: choiceOf(sent.decision) }) }
}

/** What the serve terminal can send for the ask: each key its choices row shows, and one it does not. */
async function terminalSends(ask: FullAsk): Promise<string[]> {
  const { row } = await atTerminal(ask)
  const keys = [...row.matchAll(/\((\w+)\)/g)].map(([, key]) => key!)
  const answered = await Promise.all([...keys, 'x'].map(key => atTerminal(ask, key)))
  return sorted(answered.map(({ sent }) => sent!))
}

const APPLIED = (decision: DecisionBody): CoreDecisionReceipt => ({ status: 'applied', state: decision.outcome === 'approve' ? 'approved' : 'denied', assurance: 'local', decision: { token: decision.token, approved: decision.outcome === 'approve', scope: decision.scope } })

/** `buckle approvals --watch` asking the ask; `answer` types a key once its prompt is shown. */
async function atWatch(registry: ApprovalRegistry, answer?: string): Promise<{ prompt: string; sent?: string }> {
  const input = new PassThrough()
  const output = new PassThrough()
  Object.assign(output, { isTTY: true, columns: 400, rows: 24 })
  let shown = ''
  output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8') })
  const sent: DecisionBody[] = []
  const approvals: WatchSource['approvals'] = {
    waiting: () => registry.waiting(),
    pending: () => registry.pending(),
    decide: async (input) => {
      if (input.source !== 'cli') throw new Error(`--watch decided as ${input.source}`)
      sent.push(input.decision)
      return APPLIED(input.decision)
    },
    skipSave: async () => ({ status: 'skipped' }),
  }
  const stop = new AbortController()
  const done = watchApprovals({ sources: async () => [{ approvals, workspaceId: 'w-1', workspaceName: 'Site' }], input, output, errors: new PassThrough(), signal: stop.signal, pollMs: { first: 20, idle: 50 } })
  await vi.waitFor(() => expect(shown).toMatch(/n\) skip > /), { timeout: 5_000 })
  const prompt = shown.slice(shown.lastIndexOf('\n') + 1)
  if (answer !== undefined) {
    input.write(`${answer}\r`)
    await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 5_000 })
  }
  stop.abort()
  await done
  const [decided] = sent
  return { prompt, ...(decided === undefined ? {} : { sent: choiceOf(decided) }) }
}

/** What --watch can send for the ask: each key its prompt shows but the skip, which sends nothing. */
async function watchSends(registry: ApprovalRegistry): Promise<string[]> {
  const { prompt } = await atWatch(registry)
  const keys = [...prompt.matchAll(/(?:^|\s)([\w-]+)\) /g)].map(([, key]) => key!).filter(key => key !== 'n')
  const answered = await Promise.all(keys.map(key => atWatch(registry, key)))
  return sorted(answered.map(({ sent }) => sent!))
}

/**
 * Whether the guard takes the choice from `source`, as the asking caller's answer, with the forms setting on. A `below`
 * choice names the ask's wider subject, as `--below` does; a client refuses `--below` where the ask shows none.
 */
function takes(input: { source: ApprovalSource; choice: string; request: ApprovalRequest; ask: Ask }): boolean {
  const [outcome, scope, below] = input.choice.split(' ') as ['approve' | 'deny', ApprovalDecision['scope'], 'below' | undefined]
  if (below !== undefined && input.request.widerSubject === undefined) return false
  const ledger: LedgerView = { waiting: { request: input.request, complete: true, challenges: [], marks: { floor: input.ask.floor, destructive: input.ask.destructive }, routes: TODAYS_ROUTES, actor: CALLER } }
  const subject = below === undefined ? {} : { subject: input.request.widerSubject! }
  const claim = { decision: { token: input.request.token, approved: outcome === 'approve', scope, ...subject }, source: input.source, caller: CALLER }
  return guardDecision({ claim, ledger, now: Date.now(), live: { forms: true } }).ok
}

describe('the choices each route can send for one ask', () => {
  it.each(ASKS)('are the same for %s at the serve terminal, at --watch, in a stdio and an HTTP form, at buckle approve, and from a device', async (_name, tool, makeAsk, offered) => {
    const ask = makeAsk()
    const { registry, http, host } = node()
    const [request] = (await registry.ask({ tool, sessionId: 'mcp', actor: CALLER, requestId: `r-${tool}`, asks: [ask], call: CALL })).requests
    const { token } = request!
    const fullAsk = host().pending().find(waiting => waiting.token === token)!
    const widened = ask.widerSubject === undefined ? [] : BELOW

    const choices = sorted([...offered, ...widened])
    const terminal = await terminalSends(fullAsk)
    expect(terminal).toEqual(choices)
    expect(await watchSends(registry)).toEqual(choices)
    expect(await formSends('stdio', fullAsk, request!)).toEqual(choices)
    const overHttp = await formSends('http', fullAsk, request!)
    expect(overHttp).toEqual(choices)
    // `buckle approve` and `buckle client approve` take --scope, --deny, and --below as typed and print the scopes the ask
    // offers; the guard takes from each what the terminal offers.
    const typed = SCOPES.flatMap(scope => [`approve ${scope}`, `deny ${scope}`, `approve ${scope} below`])
    expect(sorted(typed.filter(choice => takes({ source: SOURCES.cli, choice, request: request!, ask })))).toEqual(choices)
    expect(sorted(typed.filter(choice => takes({ source: SOURCES.devices, choice, request: request!, ask })))).toEqual(choices)

    for (const choice of overHttp) {
      const sources = [SOURCES['http-forms'], SOURCES.forms, SOURCES.terminal]
      expect(sources.map(source => takes({ source, choice, request: request!, ask })), choice).toEqual([true, true, true])
    }
    const widest = overHttp.filter(choice => choice.startsWith('approve ')).map(choice => choice.split(' ')[1]!).sort((left, right) => SCOPES.indexOf(left as typeof SCOPES[number]) - SCOPES.indexOf(right as typeof SCOPES[number])).at(-1)!
    expect((await http.answer({ [token]: { action: 'accept', content: { action: `allow_${widest}` } } }, { caller: CALLER })).tokens).toEqual([token])
  }, 60_000)
})
