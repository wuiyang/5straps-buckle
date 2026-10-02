import { loadConfig } from '../common/runtime/config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFileGrantStore, createGrantLookup } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createSensitivePathRule, sensitivePathReason } from '../common/domain/permission/rules/sensitive-path-rule.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import { createPathView } from '../common/domain/path-view.js'
import { openChangeHistory } from '../common/services/history/journal.js'
import type { ProcessRunner } from '../common/types/ports/process-runner.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'buckle-sensitive-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('exempts only .env.schema outside credential directories', () => {
  expect(sensitivePathReason('/workspace/.env.schema')).toBeNull()
  for (const name of ['.env', '.env.local', '.env.example', '.env.schema.local']) expect(sensitivePathReason(`/workspace/${name}`)).not.toBeNull()
  expect(sensitivePathReason('/workspace/.ssh/.env.schema')).not.toBeNull()
})
// Review item 13 of the proof-of-possession fixes: macOS's default volume ignores case, so ~/.5STRAPS is
// Buckle's state there; compared as text it fell through to an ask outside the root.
it.each([
  ['/Users/owner/.5STRAPS/buckle/plugins.json'],
  ['/Users/owner/.5straps/BUCKLE/client-keys.json'],
  ['/USERS/OWNER/.5Straps'],
])("denies %s as Buckle's state where the disk ignores case", (path) => {
  const rule = createSensitivePathRule({ protectedRoots: ['/Users/owner/.5straps'], caseInsensitive: true })
  for (const kind of ['read_path', 'write_path'] as const) {
    expect(rule.evaluate({ tool: 'fs_write', effect: { kind, path, directory: '/Users/owner' }, grants: { subjectsFor: () => [] } })).toMatchObject({ kind: 'deny', rule: 'sensitive_path' })
  }
})
it('compares protected roots exactly where the disk keeps case', () => {
  const rule = createSensitivePathRule({ protectedRoots: ['/home/owner/.5straps'], caseInsensitive: false })
  const judged = (path: string) => rule.evaluate({ tool: 'fs_write', effect: { kind: 'write_path', path, directory: '/home/owner' }, grants: { subjectsFor: () => [] } })
  expect(judged('/home/owner/.5STRAPS/notes.md')).toBeNull()
  expect(judged('/home/owner/.5straps/notes.md')).toMatchObject({ kind: 'deny' })
})
// GPT review of c71dee5 (case-insensitive denial): a remembered deny meets a case variant where the disk ignores
// case, and only there; an allow stays exact on every volume, so the fold never widens one.
it('meets a remembered deny in any case where the disk ignores case, keeps it exact where it does not, and keeps allows exact', () => {
  const judged = (input: { caseInsensitive: boolean; path: string; denied?: string[]; allowed?: string[] }) => createSensitivePathRule({ protectedRoots: [], caseInsensitive: input.caseInsensitive })
    .evaluate({ tool: 'fs_write', effect: { kind: 'write_path', path: input.path, directory: '/w' }, grants: { subjectsFor: () => input.allowed ?? [], deniedSubjectsFor: () => input.denied ?? [] } })
  for (const path of ['/w/.ENV', '/w/.Env', '/w/.env']) expect(judged({ caseInsensitive: true, path, denied: ['/w/.env'] })).toMatchObject({ kind: 'deny', reason: 'The owner denied this sensitive file' })
  expect(judged({ caseInsensitive: false, path: '/w/.ENV', denied: ['/w/.env'] })).toMatchObject({ kind: 'ask' })
  expect(judged({ caseInsensitive: false, path: '/w/.env', denied: ['/w/.env'] })).toMatchObject({ kind: 'deny' })
  expect(judged({ caseInsensitive: true, path: '/w/.ENV', allowed: ['/w/.env'] })).toMatchObject({ kind: 'ask' })
})
it.each(['session', 'always'] as const)('records a %s denial, enforces scope and supports owner revocation', async scope => {
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
  const approvals = createApprovalRegistry(grants, join(root, 'approvals.json'))
  const engine = createPermissionEngine([createSensitivePathRule()])
  const subject = join(root, '.env.local')
  const check = (sessionId: string) => engine.evaluate({ tool: 'fs_read', effects: [{ kind: 'read_path', path: subject, directory: root }], grants: createGrantLookup(grants, sessionId) })
  const outcome = check('one')
  expect(outcome.kind).toBe('ask')
  if (outcome.kind !== 'ask') throw new Error('Expected approval')
  expect(outcome.asks[0]).toMatchObject({ reason: expect.stringContaining('WARNING'), offeredScopes: ['once'] })
  const request = ((await approvals.ask({ tool: 'fs_read', sessionId: 'one', asks: outcome.asks })).requests)[0]!
  expect((await approvals.resolve({ token: request.token, approved: false, scope }, 'agent')).ok).toBe(false)
  expect((await approvals.resolve({ token: request.token, approved: false, scope }, 'admin')).ok).toBe(true)
  expect(check('one').kind).toBe('deny')
  expect(check('two').kind).toBe(scope === 'always' ? 'deny' : 'ask')
  expect(grants.activeSubjects({ sessionId: 'one', rule: 'sensitive_path' })).toEqual([])
  await grants.revoke(grants.list()[0]!.id)
  expect(check('one').kind).toBe('ask')
})
it('does not permit durable sensitive-file approvals or reuse standing allow grants', async () => {
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
  const approvals = createApprovalRegistry(grants, join(root, 'approvals.json'))
  const request = ((await approvals.ask({ tool: 'fs_read', sessionId: 'one', asks: [{ kind: 'ask', rule: 'sensitive_path', subject: '/workspace/.env', reason: 'WARNING', offeredScopes: ['once', 'session', 'always'] }] })).requests)[0]!
  expect((await approvals.resolve({ token: request.token, approved: true, scope: 'always' })).ok).toBe(false)
  await grants.grant({ sessionId: 'one', rule: 'sensitive_path', subject: '/workspace/.env', scope: 'always' })
  expect(grants.activeSubjects({ sessionId: 'one', rule: 'sensitive_path' })).toEqual([])
})
it('declares shell file effects, checks approval and overlays read-only without snapshotting credentials', async () => {
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const state = join(root, 'state'); mkdirSync(state)
  const secret = join(workspace, '.env.local'); writeFileSync(secret, 'SYNTHETIC=private')
  writeFileSync(join(workspace, '.env.schema'), 'SCHEMA=true')
  const history = await openChangeHistory({ directory: join(state, 'history'), excluded: [state], maxBytes: 1_000_000, retentionDays: 30 })
  const runProcess = vi.fn<ProcessRunner>(async request => {
    expect(existsSync(join(request.cwd, '.env.local'))).toBe(false)
    expect(readFileSync(join(request.cwd, '.env.schema'), 'utf8')).toBe('SCHEMA=true')
    const position = request.args.indexOf(secret)
    expect(request.args.slice(position - 1, position + 2)).toEqual(['--ro-bind', secret, '/workspace/.env.local'])
    // Simulate the empty mountpoint left after Bubblewrap exits.
    writeFileSync(join(request.cwd, '.env.local'), '')
    writeFileSync(join(request.cwd, 'result.txt'), 'done')
    return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }
  })
  const pack = createShellPack({ paths: createPathView({ root: workspace, mount: '/workspace' }), sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), runProcess, writableRoots: [workspace], hiddenPaths: [state], readOnlyPaths: [], unavailableReason: null, isolation: { directory: join(state, 'shell'), maxBytes: 1_000_000, history } })
  const call = pack.tools[0]!.prepare({ command: 'node', args: ['seed.mjs'], cwd: '/workspace', sensitiveFiles: ['/workspace/.env.local'] })
  expect(call.effects).toContainEqual({ kind: 'read_path', path: '/workspace/.env.local' })
  const context = { requestId: 'test', sessionId: 'one', timeoutMs: 1000, signal: AbortSignal.timeout(5000) }
  await expect(call.execute({ ...context, authorizeRead: async () => false })).rejects.toThrow('not approved')
  expect(runProcess).not.toHaveBeenCalled()
  await call.execute({ ...context, authorizeRead: async path => path === secret })
  expect(readFileSync(secret, 'utf8')).toBe('SYNTHETIC=private')
  expect((await history.list())[0]!.paths).toEqual([join(workspace, 'result.txt')])
  expect(readFileSync(join(state, 'history/history.sqlite')).includes(Buffer.from('SYNTHETIC=private'))).toBe(false)
  expect(pack.tools[1]!.prepare({ runtime: 'node', script: 'void 0', sensitiveFiles: ['/workspace/.env.local'] }).effects).toContainEqual({ kind: 'read_path', path: '/workspace/.env.local' })
})

it('asks again after a once read and enforces a session denial through the invoker', async () => {
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  writeFileSync(join(workspace, '.env.local'), 'SYNTHETIC=fixture')
  writeFileSync(join(workspace, '.env.schema'), 'SCHEMA=true')
  const runtime = await createRuntime({ config: loadConfig({ BUCKLE_AUTH_TOKEN: 'test-agent', BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false' }) })
  const read = (path: string, sessionId = 'one') => runtime.invoke({ request: { requestId: crypto.randomUUID(), tool: 'fs_read', args: { path }, approvalTokens: [] }, sessionId })
  expect((await read('.env.schema')).outcome).toBe('ok')
  const first = await read('.env.local')
  if (first.outcome !== 'approval_required') throw new Error('Expected approval')
  expect(first.approvals[0]).toMatchObject({ offeredScopes: ['once'], reason: expect.stringContaining('WARNING') })
  expect((await runtime.approvals.resolve({ token: first.approvals[0]!.token, approved: true, scope: 'once' })).ok).toBe(true)
  expect((await read('.env.local')).outcome).toBe('ok')
  const second = await read('.env.local')
  if (second.outcome !== 'approval_required') throw new Error('Expected a new approval')
  await runtime.approvals.resolve({ token: second.approvals[0]!.token, approved: false, scope: 'session' })
  expect(await read('.env.local')).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
  expect((await read('.env.local', 'two')).outcome).toBe('approval_required')
})
// Review H2 of the second proof-of-possession re-review: toLowerCase kept the long s (U+017F), which case
// folding maps to s, so .5ſtraps passed the protected-root check where the disk folds it.
it('denies a long-s variant of ~/.5straps as Buckle\'s state where the disk ignores case', () => {
  const rule = createSensitivePathRule({ protectedRoots: ['/Users/owner/.5straps'], caseInsensitive: true })
  expect(rule.evaluate({ tool: 'fs_write', effect: { kind: 'write_path', path: '/Users/owner/.5ſtraps/buckle/plugins.json', directory: '/Users/owner' }, grants: { subjectsFor: () => [] } })).toMatchObject({ kind: 'deny', rule: 'sensitive_path' })
})
