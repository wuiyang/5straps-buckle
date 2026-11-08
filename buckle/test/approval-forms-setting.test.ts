import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsCommand } from '../cli/settings.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { guardDecision, guardSkip, screenDecision, type DecisionClaim, type LedgerView, type LiveSettings } from '../common/domain/approval/decision-guard.js'
import { TODAYS_ROUTES } from '../common/domain/approval/routes.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { loadConfig, unreadWorkspaceDefaults } from '../common/runtime/config.js'
import { NO_INTERACTION, type Interaction } from '../common/runtime/interaction.js'
import { createApprovalRegistry, type ApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { WorkspacePatchSchema } from '../common/services/workspaces/workspace-manager.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { openSettingsFile, resolveSettings, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { SOURCES, type ApprovalSource } from '../common/types/ports/approval-source.js'
import type { GrantStore } from '../common/types/ports/grant-store.js'
import { createMcpServer } from '../mcp/server.js'
import { openForms } from '../mcp/open-forms.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'
import { runCli } from './support/cli.js'
import { hostTool } from './support/mcp-host-tool.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { idOf, workspacesOf } from './support/workspaces.js'

// MCP form approvals are a setting: the workspace's approval.forms, else the node's
// BUCKLE_APPROVAL_FORMS, else off. Core reads it as each answer is decided, before anything else it checks, so turning it
// off refuses a form answer at once: a first answer, a repeat, a save retry, and a skip. What forms approved before stays.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-forms-setting-')))
  roots.push(root)
  return root
}

function captured() {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  return { out: () => out, err: () => err, clear: () => { out = ''; err = '' } }
}

const ON: LiveSettings = { forms: true }
const OFF: LiveSettings = { forms: false }

describe('the forms setting', () => {
  it('is the workspace\'s own, else the node\'s, else off, naming where it came from', () => {
    const unset = WorkspaceSettingsSchema.parse({ version: 1 })
    const builtIn = resolveSettings(unset, loadConfig({}).workspaceDefaults)
    expect(builtIn.approval.forms).toBe(false)
    expect(builtIn.sources['approval.forms']).toBe('built-in')

    const node = loadConfig({ BUCKLE_APPROVAL_FORMS: 'true' }).workspaceDefaults
    expect(resolveSettings(unset, node)).toMatchObject({ approval: { forms: true }, sources: { 'approval.forms': 'node' } })

    const own = WorkspaceSettingsSchema.parse({ version: 1, approval: { forms: false } })
    expect(resolveSettings(own, node)).toMatchObject({ approval: { forms: false }, sources: { 'approval.forms': 'workspace' } })
    expect(() => WorkspaceSettingsSchema.parse({ version: 1, approval: { forms: 'on' } })).toThrow()
  })

  it('comes from the node\'s environment file alone, so an MCP config\'s env naming it is not read', () => {
    const caller = { BUCKLE_APPROVAL_FORMS: 'true' }
    const layers = { file: { path: '/state/buckle.env', values: {} }, caller }
    expect(loadConfig({ ...caller }, process.platform, layers).workspaceDefaults.approval).toEqual({})
    expect(unreadWorkspaceDefaults(layers)).toEqual(['BUCKLE_APPROVAL_FORMS'])
    expect(loadConfig({ ...caller }, process.platform, { file: null, caller, defaultsFromFileAlone: true }).workspaceDefaults.approval).toEqual({})
  })

  it('is no field the admin face patches', () => {
    expect(WorkspacePatchSchema.safeParse({ approval: { forms: true } }).success).toBe(false)
    expect(WorkspacePatchSchema.safeParse({ 'approval.forms': true }).success).toBe(false)
  })
})

describe('buckle workspace set approval.forms', () => {
  it('stores the workspace\'s own value, shows it with its source, refuses a value that is not on or off, and unset takes it out', async () => {
    const root = scratch()
    const folder = join(root, 'site')
    mkdirSync(folder)
    const config = loadConfig({ BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ADMIN_TOKEN: 'forms-setting-admin-credential', BUCKLE_SANDBOX: 'none' })
    const output = captured()
    const buckle = (argv: string[]) => runCli({ argv: ['workspace', ...argv], config, confirm: null, cwd: folder })
    expect((await buckle(['init'])).exitCode).toBe(0)
    const manager = await workspacesOf(config)
    const stored = () => openSettingsFile({ filePath: settingsPath(config.stateDirectory, idOf(manager, 'site')) }).read().approval
    output.clear()

    await buckle(['show'])
    expect(output.out()).toMatch(/approval\.forms +off +built-in/)
    expect((await buckle(['set', 'approval.forms', 'on'])).exitCode).toBe(0)
    expect(stored()).toEqual({ forms: true })
    output.clear()
    await buckle(['show'])
    expect(output.out()).toMatch(/approval\.forms +on +workspace/)
    expect((await buckle(['set', 'approval.forms', 'maybe'])).exitCode).toBe(1)
    expect(output.err()).toContain('approval.forms is on or off')
    expect(stored()).toEqual({ forms: true })
    expect((await buckle(['unset', 'approval.forms'])).exitCode).toBe(0)
    expect(stored()).toEqual({})
    await manager.close()
  })
})

describe('buckle settings set approval-forms', () => {
  it('writes the node\'s default, lists it among the workspace defaults, and names the workspace\'s own key', async () => {
    const root = scratch()
    const file = join(root, 'buckle.env')
    writeFileSync(file, `BUCKLE_STATE_DIR=${join(root, 'state')}\n`, { mode: 0o600 })
    const settings = async (argv: string[]) => {
      const output = captured()
      const result = await settingsCommand({ argv, environment: {}, environmentFile: file, cwd: root, home: root })
      vi.restoreAllMocks()
      return { ...result, out: output.out(), printed: output.out() + output.err() }
    }
    const shown = await settings(['show'])
    expect(shown.out.slice(shown.out.indexOf('Workspace defaults'))).toMatch(/approval-forms\s+BUCKLE_APPROVAL_FORMS\s+false\s+default/)
    expect((await settings(['set', 'approval-forms', 'on'])).exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toContain('BUCKLE_APPROVAL_FORMS=true\n')
    const written = loadConfig({ BUCKLE_APPROVAL_FORMS: 'true' }).workspaceDefaults
    expect(resolveSettings(WorkspaceSettingsSchema.parse({ version: 1 }), written).approval.forms).toBe(true)
  })

  it('says a running buckle mcp keeps the default it started with, and how to stop forms at once', async () => {
    const root = scratch()
    const file = join(root, 'buckle.env')
    writeFileSync(file, `BUCKLE_STATE_DIR=${join(root, 'state')}\n`, { mode: 0o600 })
    for (const argv of [['set', 'approval-forms', 'off'], ['unset', 'approval-forms']]) {
      const output = captured()
      expect((await settingsCommand({ argv, environment: {}, environmentFile: file, cwd: root, home: root })).exitCode).toBe(0)
      vi.restoreAllMocks()
      expect(output.out()).toContain('A buckle mcp an MCP client started takes the new default only when the client starts it again; buckle workspace set approval.forms off stops forms in a workspace at once.\n')
    }
    const output = captured()
    await settingsCommand({ argv: ['set', 'approval-wait', '20000'], environment: {}, environmentFile: file, cwd: root, home: root })
    vi.restoreAllMocks()
    expect(output.out()).not.toContain('buckle mcp')
  })
})

const request: ApprovalRequest = { token: 'token-1', rule: 'write_scope', subject: '/outside/one', reason: 'outside', tool: 'fs_write', offeredScopes: ['once', 'session', 'always'], expiresAt: new Date(Date.now() + 600_000).toISOString() }
const waiting: LedgerView = { waiting: { request, complete: true, challenges: [], marks: PLAIN_MARKS, routes: TODAYS_ROUTES } }
const claimOf = (source: ApprovalSource, scope: 'once' | 'session' = 'once', approved = true): DecisionClaim => ({ decision: { token: request.token, approved, scope }, source })
const NOW = Date.now()

describe('the live forms check', () => {
  it('refuses a form answer while the setting is off, before the guard reads the ledger: a first answer, a repeat, an unknown token, and a skip', () => {
    const refused = { ok: false, code: 'approver_not_allowed', reason: expect.stringContaining('approval.forms') }
    expect(screenDecision(claimOf(SOURCES.forms), OFF)).toEqual(refused)
    expect(guardDecision({ claim: claimOf(SOURCES.forms), ledger: waiting, now: NOW, live: OFF })).toEqual(refused)
    expect(guardDecision({ claim: claimOf(SOURCES.forms, 'once', false), ledger: waiting, now: NOW, live: OFF })).toEqual(refused)
    const resolved: LedgerView = { resolved: { decision: claimOf(SOURCES.forms).decision, request } }
    expect(guardDecision({ claim: claimOf(SOURCES.forms), ledger: resolved, now: NOW, live: OFF })).toEqual(refused)
    expect(guardDecision({ claim: claimOf(SOURCES.forms, 'session'), ledger: resolved, now: NOW, live: OFF })).toEqual(refused)
    expect(guardDecision({ claim: claimOf(SOURCES.forms), ledger: {}, now: NOW, live: OFF })).toEqual(refused)
    expect(guardSkip({ source: SOURCES.forms, recorded: { approved: true, scope: 'session', source: SOURCES.forms }, live: OFF })).toEqual(refused)
    expect(guardSkip({ source: SOURCES.forms, recorded: undefined, live: OFF })).toEqual(refused)
  })

  it('decides a form answer as before while the setting is on, and holds no other source to it', () => {
    expect(guardDecision({ claim: claimOf(SOURCES.forms, 'session'), ledger: waiting, now: NOW, live: ON })).toEqual({ ok: true, apply: {} })
    expect(guardSkip({ source: SOURCES.forms, recorded: { approved: true, scope: 'session', source: SOURCES.forms }, live: ON })).toEqual({ ok: true })
    for (const source of [SOURCES.terminal, SOURCES.cli, SOURCES.devices]) {
      expect(guardDecision({ claim: claimOf(source, 'session'), ledger: waiting, now: NOW, live: OFF }), source.id).toEqual({ ok: true, apply: {} })
    }
    expect(guardSkip({ source: SOURCES.cli, recorded: { approved: true, scope: 'session', source: SOURCES.cli }, live: OFF })).toEqual({ ok: true })
  })
})

const denied = () => Object.assign(new Error('EACCES: permission denied, open \'/state/grants.json\''), { code: 'EACCES' })

/** The store, its first `failing` grant writes refused as a locked grants file refuses them. */
function failingGrants(store: GrantStore, failing: number): GrantStore {
  let left = failing
  return { ...store, grant: async (input) => {
    if (left > 0) { left -= 1; throw denied() }
    return store.grant(input)
  } }
}

function ledger(input: { failingGrants?: number } = {}) {
  const root = scratch()
  const live: LiveSettings = { forms: true }
  const store = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: 'workspace-id' })
  const approvals = join(root, 'approvals.json')
  const registry = createApprovalRegistry(failingGrants(store, input.failingGrants ?? 0), approvals, 0, { live: () => live })
  return { live, store, registry, approvals }
}

async function askIn(registry: ApprovalRegistry, requestId: string): Promise<string> {
  const { requests } = await registry.ask({ tool: 'fs_write', sessionId: 's', requestId, asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'write_scope', subject: `/outside/${requestId}`, reason: 'outside', offeredScopes: ['once', 'session', 'always'] }], call: { arguments: {}, cwd: '/', description: null, complete: true } })
  return requests[0]!.token
}

const session = (token: string) => ({ token, approved: true, scope: 'session' as const })

describe('a form answer in the ledger once the setting is off', () => {
  it('is refused before anything is recorded, and the ask still waits for another route', async () => {
    const { live, store, registry } = ledger()
    const token = await askIn(registry, 'r1')
    live.forms = false
    expect(await registry.resolve(session(token), SOURCES.forms)).toMatchObject({ ok: false, code: 'approver_not_allowed' })
    expect(await registry.resolve({ token, approved: false, scope: 'once' }, SOURCES.forms)).toMatchObject({ ok: false, code: 'approver_not_allowed' })
    expect(registry.pending().map(asked => asked.token)).toEqual([token])
    expect(await registry.resolve(session(token), SOURCES.cli)).toMatchObject({ ok: true })
    expect(store.list()).toEqual([expect.objectContaining({ subject: '/outside/r1', scope: 'session' })])
  })

  it('refuses a repeat, a save retry, and a skip of an answer forms gave while on, and the settling pass still writes its owed grant', async () => {
    const { live, store, registry } = ledger({ failingGrants: 1 })
    const token = await askIn(registry, 'r1')
    expect(await registry.resolve(session(token), SOURCES.forms)).toMatchObject({ ok: true, save: 'owed' })
    live.forms = false

    expect(await registry.resolve(session(token), SOURCES.forms)).toMatchObject({ ok: false, code: 'approver_not_allowed' })
    expect(await registry.skipSave({ token, source: SOURCES.forms })).toMatchObject({ ok: false, code: 'approver_not_allowed' })
    expect(store.list()).toEqual([])

    await registry.recover()
    expect(store.list()).toEqual([expect.objectContaining({ subject: '/outside/r1', scope: 'session', sessionId: 's' })])
  })

  it('refuses a form answer and a skip before the lock, so each comes back while approvals.json will not read', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const { live, registry, approvals } = ledger()
    const token = await askIn(registry, 'r1')
    live.forms = false
    writeFileSync(approvals, '{ not json', { mode: 0o600 })
    expect(await registry.resolve(session(token), SOURCES.forms)).toMatchObject({ ok: false, code: 'approver_not_allowed' })
    expect(await registry.skipSave({ token, source: SOURCES.forms })).toMatchObject({ ok: false, code: 'approver_not_allowed' })
  })

  it('leaves standing the grants forms wrote while on, and refuses forms a repeat of them', async () => {
    const { live, store, registry } = ledger()
    const token = await askIn(registry, 'r1')
    expect(await registry.resolve(session(token), SOURCES.forms)).toMatchObject({ ok: true, save: 'saved' })
    live.forms = false
    expect(await registry.resolve(session(token), SOURCES.forms)).toMatchObject({ ok: false, code: 'approver_not_allowed' })
    expect(store.list()).toEqual([expect.objectContaining({ subject: '/outside/r1', scope: 'session' })])
    expect(await registry.resolve(session(token), SOURCES.cli)).toMatchObject({ ok: true, repeated: true })
  })
})

/** No terminal, a hold only while this process asks: a gated call answers at once. */
const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }

/** A node whose workspace's own settings say whether MCP forms decide, written to workspace.json before it opens. */
async function stdioNode(input: { forms: boolean }) {
  const root = scratch()
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_AUTH_TOKEN: 'forms-agent-token', BUCKLE_ADMIN_TOKEN: 'forms-admin-token',
    BUCKLE_APPROVAL_TIMEOUT_MS: '60000', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs',
  })
  const settings = openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory ?? config.stateDirectory, config.workspaceId), fallback: () => WorkspaceSettingsSchema.parse({ version: 1 }) })
  const setForms = (forms: boolean) => settings.update(current => ({ ...current, approval: { ...current.approval, forms } }))
  const breakSettings = () => writeFileSync(settings.filePath, '{ not json', { mode: 0o600 })
  await setForms(input.forms)
  const runtime = await createRuntime({ config, interaction: fixedInteraction(NOBODY) })
  runtimes.push(runtime)
  const forms = openForms(runtime, { face: 'stdio' })
  const server = createMcpServer({ runtime, serverName: 'forms-mcp', version: '0', followToolChanges: false, forms })
  const waitingTokens = () => runtime.approvalService.pending().map(asked => asked.token)
  return { workspace, runtime, forms, setForms, breakSettings, waitingTokens, write: hostTool(server, 'fs_write') }
}

const accepted = (token: string, content: { approve: boolean; scope: 'once' | 'session' | 'always' }) => ({ [token]: { action: 'accept', content } })
const ARGS = { path: 'one/a.md', content: 'a' }

describe('the stdio face and the forms setting', () => {
  it('draws one form per ask for a host that declares form elicitation, as Claude Code does, while the setting is on, and a once answer runs the call', async () => {
    const { workspace, write, waitingTokens } = await stdioNode({ forms: true })
    const asked = await write({ args: ARGS })
    const [token] = waitingTokens()
    expect(asked).toMatchObject({ resultType: 'input_required' })
    expect(Object.keys(asked.inputRequests ?? {})).toEqual([token])
    expect(await write({ args: ARGS, responses: accepted(token!, { approve: true, scope: 'once' }) })).not.toHaveProperty('isError')
    expect(readFileSync(join(workspace, 'one', 'a.md'), 'utf8')).toBe('a')
  })

  it('gives a host that declares form elicitation the relay text while the setting is off, and reads no answer its call carries', async () => {
    const { workspace, runtime, write, waitingTokens } = await stdioNode({ forms: false })
    expect(await write({ args: ARGS })).toMatchObject({ isError: false, structuredContent: { outcome: 'approval_required' } })
    const [token] = waitingTokens()
    const answers = vi.spyOn(runtime.approvalService, 'answer')
    expect(await write({ args: ARGS, responses: accepted(token!, { approve: true, scope: 'session' }) })).toMatchObject({ structuredContent: { outcome: 'approval_required' } })
    expect(answers).not.toHaveBeenCalled()
    expect(waitingTokens()).toEqual([token])
    expect(runtime.grants.list()).toEqual([])
    expect(existsSync(join(workspace, 'one', 'a.md'))).toBe(false)
  })

  it('turned off after a form was drawn, reads no answer to it, and refuses one that reaches core, recording the refusal', async () => {
    const { workspace, runtime, forms, setForms, write, waitingTokens } = await stdioNode({ forms: true })
    expect(await write({ args: ARGS })).toMatchObject({ resultType: 'input_required' })
    const [token] = waitingTokens()
    await setForms(false)

    expect(await write({ args: ARGS, responses: accepted(token!, { approve: true, scope: 'once' }) })).toMatchObject({ structuredContent: { outcome: 'approval_required' } })
    expect(await forms.answer(accepted(token!, { approve: true, scope: 'once' }))).toEqual({ tokens: [], unsaved: [] })
    expect(waitingTokens()).toEqual([token])
    expect(existsSync(join(workspace, 'one', 'a.md'))).toBe(false)
    const decisions = (await auditEntries(runtime.actions, 50)).filter(entry => entry.tool === 'approval_decision')
    expect(decisions.map(entry => [entry.event, entry.outcome, entry.detail])).toEqual([['attempt', 'started', undefined], ['result', 'error', 'approver_not_allowed']])
  })

  it('counts the setting off while workspace.json will not read, so no form is drawn and no answer decides', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const { workspace, runtime, forms, breakSettings, write, waitingTokens } = await stdioNode({ forms: true })
    expect(await write({ args: ARGS })).toMatchObject({ resultType: 'input_required' })
    const [token] = waitingTokens()
    breakSettings()

    expect(runtime.approvalForms()).toBe(false)
    expect(await write({ args: ARGS, responses: accepted(token!, { approve: true, scope: 'once' }) })).toMatchObject({ structuredContent: { outcome: 'approval_required' } })
    expect(await forms.answer(accepted(token!, { approve: true, scope: 'once' }))).toEqual({ tokens: [], unsaved: [] })
    expect(waitingTokens()).toEqual([token])
    expect(existsSync(join(workspace, 'one', 'a.md'))).toBe(false)
  })

  it('turned on, draws a form for an ask already waiting from the next call, with no restart', async () => {
    const { workspace, setForms, write, waitingTokens } = await stdioNode({ forms: false })
    expect(await write({ args: ARGS })).toMatchObject({ structuredContent: { outcome: 'approval_required' } })
    const [token] = waitingTokens()
    await setForms(true)
    expect(await write({ args: ARGS })).toMatchObject({ resultType: 'input_required', inputRequests: { [token!]: expect.anything() } })
    expect(await write({ args: ARGS, responses: accepted(token!, { approve: true, scope: 'once' }) })).not.toHaveProperty('isError')
    expect(readFileSync(join(workspace, 'one', 'a.md'), 'utf8')).toBe('a')
  })
})
