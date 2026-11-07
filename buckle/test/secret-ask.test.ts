import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type ApprovalRequest, type GrantScope, type InvokeResponse, type JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { grantLookup } from '../common/services/approvals/approval-gate.js'
import { summarizeEffect, type SecretFileEffect } from '../common/domain/effect.js'
import { createFilesystemPolicyRule } from '../common/domain/filesystem-policy.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import { createSensitivePathRule, secretFileSubject } from '../common/domain/permission/rules/sensitive-path-rule.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { resolveSettings, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { SETTING_KEYS } from '../cli/workspace-keys.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// The secret-references slice, part 4 (docs/user/how-to/secrets.md): the first use of a file in a workspace asks a person once under
// the credential-file rule, naming the file and the NAMEs and never a value; the answer is remembered per workspace and
// file as other grants are, a session at most in strict mode, and secrets.files lists files that need no ask.

const DECOY = 'decoy-value-0123456789'
const effect = (path: string, names = ['API_TOKEN']): SecretFileEffect => ({ kind: 'secret_file', path, written: ['.env.local'], names })
const NO_GRANTS = { subjectsFor: () => [] }

describe('the credential-file rule on a secret file', () => {
  const rule = createSensitivePathRule({ protectedRoots: ['/srv/node/.5straps'] })

  it('asks under sensitive_path, naming the file as written and the NAMEs, with every scope offered', () => {
    const decision = rule.evaluate({ tool: 'shell_exec', effect: effect('/w/.env.local', ['API_TOKEN', 'OTHER']), grants: NO_GRANTS })
    expect(decision).toMatchObject({ kind: 'ask', rule: 'sensitive_path', subject: 'secret-file:/w/.env.local', offeredScopes: ['once', 'session', 'always'] })
    if (decision?.kind !== 'ask') throw new Error('expected an ask')
    expect(decision.reason).toContain('reads API_TOKEN, OTHER from .env.local')
    expect(decision.reason).toContain('[secret:NAME]')
  })

  it('offers a session at most in strict mode', () => {
    expect(createSensitivePathRule({ protectedRoots: [], strict: true }).evaluate({ tool: 'shell_exec', effect: effect('/w/.env.local'), grants: NO_GRANTS })).toMatchObject({ offeredScopes: ['once', 'session'] })
  })

  it('refuses Buckle\'s own state, and a file the owner denied', () => {
    expect(rule.evaluate({ tool: 'shell_exec', effect: effect('/srv/node/.5straps/buckle.env'), grants: NO_GRANTS })).toMatchObject({ kind: 'deny', reason: "Buckle's own state and policy are not reachable from a tool" })
    expect(rule.evaluate({ tool: 'shell_exec', effect: effect('/w/.env.local'), grants: { ...NO_GRANTS, deniedSubjectsFor: () => [secretFileSubject('/w/.env.local')] } })).toMatchObject({ kind: 'deny', reason: 'The owner denied the secret file .env.local' })
  })

  it('allows a granted file, keeps a read grant and a secret grant apart, and needs no ask for a listed file', () => {
    expect(rule.evaluate({ tool: 'shell_exec', effect: effect('/w/.env.local'), grants: { subjectsFor: () => [secretFileSubject('/w/.env.local')] } })).toEqual({ kind: 'allow', via: { rule: 'sensitive_path', subject: 'secret-file:/w/.env.local' } })
    // A grant to read the file into the agent's view does not let a reference use it, nor the other way round.
    expect(rule.evaluate({ tool: 'shell_exec', effect: effect('/w/.env.local'), grants: { subjectsFor: () => ['/w/.env.local'] } })).toMatchObject({ kind: 'ask' })
    expect(rule.evaluate({ tool: 'fs_read', effect: { kind: 'read_path', path: '/w/.env.local', directory: '/w' }, grants: { subjectsFor: () => [secretFileSubject('/w/.env.local')] } })).toMatchObject({ kind: 'ask', subject: '/w/.env.local', offeredScopes: ['once'] })
    const listed = createSensitivePathRule({ protectedRoots: [], secretListed: path => path === '/w/.env.local' })
    expect(listed.evaluate({ tool: 'shell_exec', effect: effect('/w/.env.local'), grants: NO_GRANTS })).toEqual({ kind: 'allow' })
    expect(listed.evaluate({ tool: 'shell_exec', effect: effect('/w/other.env'), grants: NO_GRANTS })).toMatchObject({ kind: 'ask' })
  })

  it('refuses a file the workspace\'s filesystem policy keeps from reads', () => {
    const policy = { ...emptyWorkspacePolicy(), filesystem: { rules: [{ path: 'secrets', read: 'deny' as const, write: 'deny' as const }] } }
    const filesystem = createFilesystemPolicyRule({ root: '/w', policy })
    expect(filesystem.evaluate({ tool: 'shell_exec', effect: { ...effect('/w/secrets/.env'), written: ['secrets/.env'] }, grants: NO_GRANTS })).toMatchObject({ kind: 'deny', rule: 'filesystem_policy' })
  })

  it('is still asked about while the dangerously-allow switch is safe', () => {
    const engine = withDangerouslyAllow(createPermissionEngine([createSensitivePathRule()]), { mode: () => 'safe', root: () => '/w' })
    expect(engine.evaluate({ tool: 'shell_exec', effects: [effect('/w/.env.local')], grants: NO_GRANTS })).toMatchObject({ kind: 'ask', asks: [{ subject: 'secret-file:/w/.env.local' }] })
  })

  // APPROVAL-05: on, the switch answers a secret file's ask too, within the root it is bound to.
  it('is answered by the switch on for a file inside the workspace root, and still asked about outside it', () => {
    const engine = withDangerouslyAllow(createPermissionEngine([createSensitivePathRule()]), { mode: () => 'on', root: () => '/w' })
    expect(engine.evaluate({ tool: 'shell_exec', effects: [effect('/w/.env.local')], grants: NO_GRANTS })).toEqual({ kind: 'allow', allowedBy: ['dangerously_allow:on:sensitive_path:secret-file:/w/.env.local'] })
    // A file in a declared mount's source outside the root keeps its ask, as every path outside the root does.
    for (const path of ['/data/.env.local', '/w-other/.env.local']) {
      expect(engine.evaluate({ tool: 'shell_exec', effects: [effect(path)], grants: NO_GRANTS })).toMatchObject({ kind: 'ask', asks: [{ subject: `secret-file:${path}` }] })
    }
  })

  it('is refused in every mode where the rule refuses it: Buckle\'s own state and a file the owner denied', () => {
    const denied = { subjectsFor: () => [], deniedSubjectsFor: () => ['secret-file:/w/denied.env'] }
    for (const mode of ['on', 'safe'] as const) {
      const engine = withDangerouslyAllow(createPermissionEngine([createSensitivePathRule({ protectedRoots: ['/w/.5straps'] })]), { mode: () => mode, root: () => '/w' })
      expect(engine.evaluate({ tool: 'shell_exec', effects: [effect('/w/.5straps/state.env')], grants: NO_GRANTS })).toMatchObject({ kind: 'deny' })
      expect(engine.evaluate({ tool: 'shell_exec', effects: [effect('/w/denied.env')], grants: denied })).toMatchObject({ kind: 'deny' })
    }
  })

  it('names the NAMEs and the file in the approval\'s effect line, never a value', () => {
    expect(summarizeEffect(effect('/w/.env.local', ['API_TOKEN', 'OTHER']))).toBe('secrets API_TOKEN, OTHER from .env.local')
    expect(summarizeEffect({ ...effect('/w/.env.local', ['A', 'B']), written: ['.env.local', './.env.local', 'link.env'] })).toBe('secrets A, B from .env.local, ./.env.local, and link.env')
  })
})

describe('the grant a person gives', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  it.each(['session', 'always'] as const)('is remembered for a secret file at scope %s, while a credential file stays once-only', async (scope) => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-secret-grant-'))
    roots.push(root)
    const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
    const approvals = createApprovalRegistry(grants, join(root, 'approvals.json'))
    const engine = createPermissionEngine([createSensitivePathRule()])
    const check = (sessionId: string) => engine.evaluate({ tool: 'shell_exec', effects: [effect('/w/.env.local')], grants: grantLookup({ store: grants, holder: { sessionId }, consumed: [] }) })
    const outcome = check('one')
    if (outcome.kind !== 'ask') throw new Error('expected an ask')
    const call = { arguments: {}, cwd: '/w', description: null, effects: [], complete: true as const }
    const [request] = (await approvals.ask({ tool: 'shell_exec', sessionId: 'one', asks: outcome.asks, call })).requests
    expect((await approvals.resolve({ token: request!.token, approved: true, scope }, SOURCES.cli)).ok).toBe(true)
    expect(check('one').kind).toBe('allow')
    expect(check('two').kind).toBe(scope === 'always' ? 'allow' : 'ask')
    expect(grants.list()).toMatchObject([{ rule: 'sensitive_path', subject: 'secret-file:/w/.env.local', scope }])
    const credential = (await approvals.ask({ tool: 'fs_read', sessionId: 'one', asks: [{ kind: 'ask', ...PLAIN_MARKS, rule: 'sensitive_path', subject: '/w/.env.local', reason: 'WARNING', offeredScopes: ['once', 'session', 'always'] }], call })).requests[0]!
    expect(await approvals.resolve({ token: credential.token, approved: true, scope }, SOURCES.cli)).toEqual({ ok: false, code: 'scope_forbidden', reason: 'Sensitive files can only be allowed once' })
  })
})

describe('secrets.files', () => {
  it('lists relative paths a reference could name, and refuses any other', () => {
    const key = SETTING_KEYS.find(item => item.key === 'secrets.files')!
    const stored = WorkspaceSettingsSchema.parse({ version: 1 })
    const node = configFromEnvironment({}).workspaceDefaults
    expect(resolveSettings(stored, node).secrets).toEqual({ enabled: true, files: [] })
    const listed = WorkspaceSettingsSchema.parse(key.set(stored, '.env.local, config/keys.env,.env.local'))
    expect(resolveSettings(listed, node).secrets.files).toEqual(['.env.local', 'config/keys.env'])
    expect(resolveSettings(listed, node).sources['secrets.files']).toBe('workspace')
    for (const bad of ['/etc/app.env', '../up.env', 'C:/x.env']) expect(() => key.set(stored, bad)).toThrow('secrets.files')
    expect(() => WorkspaceSettingsSchema.parse({ version: 1, secrets: { files: ['../up.env'] } })).toThrow('secrets.files')
    expect(WorkspaceSettingsSchema.parse(key.unset(listed)).secrets).toBeUndefined()
  })
})

describe('through the invoker', () => {
  const roots: string[] = []
  const runtimes: CoreRuntime[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  async function node(extra: Record<string, string> = {}, secretFiles?: string[]): Promise<{ root: string; workspace: string; runtime: CoreRuntime; ran: JsonObject[] }> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-secret-ask-')))
    roots.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${DECOY}\nOTHER=${DECOY}-other\n`)
    const config = configFromEnvironment({
      BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true',
      BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...extra,
    })
    const runtime = await createRuntime({ config: secretFiles ? { ...config, secretFiles } : config })
    runtimes.push(runtime)
    const ran: JsonObject[] = []
    const tool = runtime.registry().get('shell_exec')
    const prepare = tool.prepare.bind(tool)
    vi.spyOn(tool, 'prepare').mockImplementation((args) => ({ ...prepare(args), execute: async () => { ran.push(args); return 'ran' } }))
    return { root, workspace, runtime, ran }
  }

  let sequence = 0
  const run = (runtime: CoreRuntime, args: string[], sessionId = 'chat-1', approvalTokens: string[] = []): Promise<InvokeResponse> => {
    sequence += 1
    return runtime.invoke({ sessionId, request: { requestId: `secret-ask-${sequence}`, tool: 'shell_exec', args: { command: 'curl', args }, approvalTokens, context: { approvalWait: { mode: 'none' } } } })
  }
  const secretAsk = (response: InvokeResponse): ApprovalRequest => {
    if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${JSON.stringify(response)}`)
    const ask = response.approvals.find(approval => approval.rule === 'sensitive_path')
    if (!ask) throw new Error('expected a secret file ask')
    return ask
  }
  /** Answers each ask: the secret file's at `scope`, every other for the session. */
  const approve = async (runtime: CoreRuntime, response: InvokeResponse, scope: GrantScope): Promise<void> => {
    if (response.outcome !== 'approval_required') throw new Error('expected asks')
    for (const approval of response.approvals) {
      const chosen = approval.rule === 'sensitive_path' ? scope : approval.offeredScopes.includes('session') ? 'session' : 'once'
      expect((await runtime.approvalService.answer({ decision: { token: approval.token, approved: true, scope: chosen }, source: SOURCES.cli })).ok).toBe(true)
    }
  }

  it('asks once for the first use of a file, shows the reference and never a value, and remembers the answer for the workspace', async () => {
    const { workspace, runtime, ran } = await node()
    const first = await run(runtime, ['-H', 'Authorization: Bearer {{file:.env.local:API_TOKEN}}'])
    const ask = secretAsk(first)
    expect(ask).toMatchObject({ subject: `secret-file:${join(workspace, '.env.local')}`, offeredScopes: ['once', 'session', 'always'] })
    expect(ask.reason).toContain('reads API_TOKEN from .env.local')
    const waiting = runtime.approvalService.waiting().find(entry => entry.request.token === ask.token)!
    expect(waiting.call).toMatchObject({ arguments: { command: 'curl', args: ['-H', 'Authorization: Bearer {{file:.env.local:API_TOKEN}}'] }, effects: expect.arrayContaining(['secrets API_TOKEN from .env.local']) })
    expect(JSON.stringify(runtime.approvalService.waiting())).not.toContain(DECOY)
    expect(ran).toEqual([])
    await approve(runtime, first, 'always')
    expect(await run(runtime, ['{{file:.env.local:API_TOKEN}}'])).toMatchObject({ outcome: 'ok' })
    // Another NAME of the same file, in another session: the file was allowed for good, so only the session's own
    // write to its folder asks.
    expect(await run(runtime, ['{{file:.env.local:OTHER}}'])).toMatchObject({ outcome: 'ok' })
    const other = await run(runtime, ['{{file:.env.local:OTHER}}'], 'chat-2')
    expect(other.outcome === 'approval_required' ? other.approvals.map(approval => approval.rule) : []).toEqual(['write_scope'])
    expect(runtime.grants.list().filter(grant => grant.rule === 'sensitive_path')).toMatchObject([{ subject: `secret-file:${join(workspace, '.env.local')}`, scope: 'always' }])
    expect(ran.length).toBe(2)
  })

  it('asks again in another session where strict mode offers a session at most', async () => {
    const { runtime } = await node({ BUCKLE_STRICT_WRITES: 'true' })
    const first = await run(runtime, ['{{file:.env.local:API_TOKEN}}'])
    expect(secretAsk(first).offeredScopes).toEqual(['once', 'session'])
    await approve(runtime, first, 'session')
    expect(await run(runtime, ['{{file:.env.local:API_TOKEN}}'])).toMatchObject({ outcome: 'ok' })
    expect(secretAsk(await run(runtime, ['{{file:.env.local:API_TOKEN}}'], 'chat-2')).subject).toMatch(/^secret-file:/)
  })

  it('needs no ask for a file secrets.files lists, and asks for one it does not', async () => {
    const { workspace, runtime, ran } = await node({}, ['./.env.local'])
    writeFileSync(join(workspace, 'other.env'), `API_TOKEN=${DECOY}\n`)
    const listed = await run(runtime, ['{{file:.env.local:API_TOKEN}}'])
    expect(listed.outcome === 'approval_required' ? listed.approvals.map(approval => approval.rule) : []).not.toContain('sensitive_path')
    await approve(runtime, listed, 'once')
    expect(secretAsk(await run(runtime, ['{{file:other.env:API_TOKEN}}'])).subject).toBe(`secret-file:${join(workspace, 'other.env')}`)
    expect(ran).toEqual([])
  })

  it('lists no file through a link at a listed name or a folder above it, so a planted link exempts nothing', async () => {
    const asked = (response: InvokeResponse) => (response.outcome === 'approval_required' ? response.approvals.map(approval => approval.rule) : [])
    // A listed name that is missing: a link planted there later lists nothing, neither the file it reaches nor itself.
    const missing = await node({}, ['.env.production'])
    writeFileSync(join(missing.workspace, 'other.env'), `API_TOKEN=${DECOY}\n`)
    expect(asked(await run(missing.runtime, ['{{file:other.env:API_TOKEN}}']))).toContain('sensitive_path')
    symlinkSync('other.env', join(missing.workspace, '.env.production'))
    expect(asked(await run(missing.runtime, ['{{file:other.env:API_TOKEN}}']))).toContain('sensitive_path')
    expect(asked(await run(missing.runtime, ['{{file:.env.production:API_TOKEN}}']))).toContain('sensitive_path')
    // A listed name that is a link lists nothing, and neither does a listed name beneath a linked folder.
    const linked = await node({}, ['listed.env', 'config/keys.env'])
    symlinkSync('.env.local', join(linked.workspace, 'listed.env'))
    mkdirSync(join(linked.workspace, 'real-config'))
    writeFileSync(join(linked.workspace, 'real-config', 'keys.env'), `API_TOKEN=${DECOY}\n`)
    symlinkSync('real-config', join(linked.workspace, 'config'))
    for (const reference of ['{{file:.env.local:API_TOKEN}}', '{{file:listed.env:API_TOKEN}}', '{{file:real-config/keys.env:API_TOKEN}}', '{{file:config/keys.env:API_TOKEN}}']) {
      expect(asked(await run(linked.runtime, [reference]))).toContain('sensitive_path')
    }
    expect([...missing.ran, ...linked.ran]).toEqual([])
  })

  it('lists no file with a second hard link, which a listed name planted that way would share with an unlisted file', async () => {
    const asked = (response: InvokeResponse) => (response.outcome === 'approval_required' ? response.approvals.map(approval => approval.rule) : [])
    const { workspace, runtime, ran } = await node({}, ['.env.production', '.env.local'])
    writeFileSync(join(workspace, 'other.env'), `API_TOKEN=${DECOY}\n`)
    linkSync(join(workspace, 'other.env'), join(workspace, '.env.production'))
    expect(asked(await run(runtime, ['{{file:.env.production:API_TOKEN}}']))).toContain('sensitive_path')
    expect(asked(await run(runtime, ['{{file:other.env:API_TOKEN}}']))).toContain('sensitive_path')
    // A listed file with one link still needs no ask.
    expect(asked(await run(runtime, ['{{file:.env.local:API_TOKEN}}']))).not.toContain('sensitive_path')
    expect(ran).toEqual([])
  })

  it('asks once for a file a call spells two ways, naming every NAME and every spelling, and reads both', async () => {
    const { workspace, runtime, ran } = await node()
    symlinkSync('.env.local', join(workspace, 'link.env'))
    for (const [args, said] of [
      [['%s %s', '{{file:.env.local:API_TOKEN}}', '{{file:./.env.local:OTHER}}'], 'API_TOKEN, OTHER from .env.local and ./.env.local'],
      [['%s %s', '{{file:link.env:API_TOKEN}}', '{{file:.env.local:OTHER}}'], 'API_TOKEN, OTHER from link.env and .env.local'],
    ] as const) {
      const response = await run(runtime, [...args], `chat-${said.length}`)
      if (response.outcome !== 'approval_required') throw new Error('expected asks')
      const asks = response.approvals.filter(approval => approval.rule === 'sensitive_path')
      expect(asks).toMatchObject([{ subject: `secret-file:${join(workspace, '.env.local')}` }])
      expect(asks[0]!.reason).toContain(`reads ${said} for this call`)
      expect(runtime.approvalService.waiting().find(entry => entry.request.token === asks[0]!.token)?.call).toMatchObject({ effects: expect.arrayContaining([`secrets ${said}`]) })
      await approve(runtime, response, 'once')
      expect(await run(runtime, [...args], `chat-${said.length}`, response.approvals.map(approval => approval.token))).toMatchObject({ outcome: 'ok' })
    }
    expect(ran).toEqual([{ command: 'curl', args: ['%s %s', DECOY, `${DECOY}-other`] }, { command: 'curl', args: ['%s %s', DECOY, `${DECOY}-other`] }])
  })

  it('refuses a file that does not exist, or that lands outside the workspace, before anyone is asked', async () => {
    const { root, workspace, runtime, ran } = await node()
    mkdirSync(join(root, 'outside'))
    writeFileSync(join(root, 'outside', 'planted.env'), `API_TOKEN=${DECOY}\n`)
    symlinkSync(join(root, 'outside', 'planted.env'), join(workspace, 'planted.env'))
    for (const [reference, said] of [['{{file:missing.env:API_TOKEN}}', 'missing.env, which does not exist in the workspace; the call reads API_TOKEN from it'], ['{{file:planted.env:API_TOKEN}}', 'planted.env, which lands outside the workspace and its mounts; the call reads API_TOKEN from it']] as const) {
      expect(await run(runtime, [reference])).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining(said) } })
    }
    expect(runtime.approvals.pending()).toEqual([])
    expect(ran).toEqual([])
  })
})
