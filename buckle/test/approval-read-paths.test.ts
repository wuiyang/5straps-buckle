import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { emptyWorkspacePolicy, type ApprovalNotice } from '@5straps/protocol'
import { callDigestOf, generateSigningKey, shownCallDigestOf, signChallenge, signingKeyFromPem } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createJsonFileStore } from '../common/adapters/json-file-store.js'
import { createApprovalNotices, type ApprovalNotices } from '../common/services/approvals/approval-notices.js'
import { createApprovalRegistry, MAX_PENDING_BYTES_PER_SESSION, MAX_PENDING_PER_SESSION, type AskedCall } from '../common/services/approvals/approval-registry.js'
import { createApprovalService } from '../common/services/approvals/approval-service.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createCommandPolicyRule } from '../common/domain/permission/rules/command-policy-rule.js'
import { createDestructiveCommandRule } from '../common/domain/permission/rules/destructive-command-rule.js'
import { compilePolicy } from '../common/domain/policy.js'
import { logger } from '../common/runtime/log.js'
import { SPAWN_TEST_TIMEOUT_MS } from './spawn-timeout.js'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const ask = (subject = '/outside') => ({ kind: 'ask' as const, rule: 'write_scope' as const, subject, reason: 'outside', offeredScopes: ['once', 'session', 'always'] as const })
const whole = (bytes = 1_000): AskedCall => ({ arguments: { content: 'x'.repeat(bytes) }, cwd: '/workspace', description: 'Write files', effects: ['write /outside'], complete: true })
function queue() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-read-paths-'))
  roots.push(root)
  const filePath = join(root, 'approvals.json')
  const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
  const registry = createApprovalRegistry(grants, filePath, root)
  const service = createApprovalService({ registry, workspaceId: 'default', serverId: 'node-1', graceMs: 1, interaction: async () => undefined })
  return { root, filePath, grants, registry, service }
}

function asks(count: number) { return Array.from({ length: count }, (_, index) => ({ ...ask(`/outside/${index}`), offeredScopes: [...ask().offeredScopes] })) }

const issue = (registry: ReturnType<typeof createApprovalRegistry>, call: AskedCall | undefined = whole()) => registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: asks(1), ...(call ? { call } : {}) })

describe('approval listings carry each whole call once', () => {
  it('keeps ten sessions of fifty one-MiB asks bounded across reads and signed listings', async () => {
    const { registry, service } = queue()
    try {
      for (let session = 0; session < 10; session++) await registry.ask({ tool: 'fs_write_batch', sessionId: `session-${session}`, actor: 'agent', asks: asks(50), call: { ...whole(1_024 * 1_024), cwd: `/workspace/${session}` } })
      const waiting = registry.waiting()
      expect(waiting).toHaveLength(500)
      expect(new Set(waiting.map(entry => entry.call)).size).toBe(10)
      const admin = service.listing()
      expect(admin.filter(entry => entry.call)).toHaveLength(10)
      expect(admin.every(entry => entry.callRef)).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(admin))).toBeLessThan(11 * 1_024 * 1_024)
      const listing = service.challengeListing()
      expect(Object.keys(listing.calls)).toHaveLength(10)
      expect(listing.challenges.every(entry => entry.challenge?.arguments === null)).toBe(true)
      const key = signingKeyFromPem(generateSigningKey().privateKeyPem)
      const signed = listing.challenges.map(entry => ({ token: entry.token, ...signChallenge({ challenge: entry.challenge!, key: key.privateKey }) }))
      expect(Buffer.byteLength(JSON.stringify({ calls: listing.calls, challenges: signed }))).toBeLessThan(12 * 1_024 * 1_024)
      const named = registry.waitingAsk(waiting[400]!.request.token)
      expect(named?.callRef).toBe(waiting[400]!.callRef)
      expect(named?.call?.arguments).toEqual(waiting[400]!.call!.arguments)
    } finally { await service.close() }
  })

  it('shares large effects as well as arguments and binds every displayed field', async () => {
    const { registry, service } = queue()
    const call = { ...whole(), effects: ['write /outside/', 'exec ' + 'argument '.repeat(4_000)] }
    try {
      await registry.ask({ tool: 'fs_write_batch', sessionId: 'mcp', asks: asks(50), call })
      const listing = service.challengeListing()
      const challenge = listing.challenges[0]!.challenge!
      expect(challenge).toMatchObject({ arguments: null, cwd: null, description: null, effects: null })
      const shared = listing.calls[challenge.callRef!]!
      expect(shared).toMatchObject({ tool: 'fs_write_batch', arguments: call.arguments, cwd: call.cwd, description: call.description, effects: call.effects })
      expect(challenge.callRef).toBe(shownCallDigestOf(shared))
      expect(challenge.callDigest).toBe(callDigestOf(shared))
      expect(Buffer.byteLength(JSON.stringify(listing))).toBeLessThan(128 * 1_024)
      for (const changed of [{ ...shared, cwd: '/different' }, { ...shared, description: 'Different summary' }, { ...shared, effects: ['write /different'] }, { ...shared, arguments: { content: 'different' } }]) expect(shownCallDigestOf(changed)).not.toBe(challenge.callRef)
      const decided = await service.answer({ decision: { token: challenge.token, approved: true, scope: 'once' }, authority: 'admin', challenge: signChallenge({ challenge, key: signingKeyFromPem(generateSigningKey().privateKeyPem).privateKey }).digest })
      expect(decided.ok).toBe(true)
    } finally { await service.close() }
  })
})

describe('every decision needs a complete recorded call', () => {
  it.each(['missing', 'missing_file', 'incomplete', 'unreadable'] as const)('refuses every approving scope for a %s call and still permits denial', async (kind) => {
    const { root, registry, grants, service } = queue()
    const call = kind === 'missing' ? undefined : kind === 'incomplete' ? { ...whole(), complete: undefined } : whole()
    try {
      const [request] = (await registry.ask({ tool: 'fs_write', sessionId: 'mcp', asks: asks(1), ...(call ? { call } : {}) })).requests
      if (kind === 'missing_file') rmSync(join(root, 'approval-calls', readdirSync(join(root, 'approval-calls'))[0]!))
      if (kind === 'unreadable') writeFileSync(join(root, 'approval-calls', readdirSync(join(root, 'approval-calls'))[0]!), 'invalid JSON')
      for (const scope of ['once', 'session', 'always'] as const) expect(await registry.resolve({ token: request!.token, approved: true, scope }, 'admin')).toMatchObject({ ok: false, reason: expect.stringContaining('recorded before this build') })
      expect(grants.list()).toEqual([])
      expect(registry.unspent('mcp')).toEqual([])
      expect(registry.pending()).toHaveLength(1)
      expect((await registry.resolve({ token: request!.token, approved: false, scope: 'once' }, 'admin')).ok).toBe(true)
      expect(registry.pending()).toEqual([])
    } finally { await service.close() }
  })
})

// Review L4 of the continuation review: the refusal of an ask whose call file was lost recommends re-sending the call,
// and a re-send under the same requestId joined the waiting ask without recording anything, so it stayed unapprovable.
describe('a re-send repairs an ask whose kept call is lost', () => {
  it.each(['missing_file', 'unreadable'] as const)('records a %s call again under the same requestId, so the ask can be approved', async (kind) => {
    const { root, registry, service } = queue()
    const calls = join(root, 'approval-calls')
    try {
      const sent = { tool: 'fs_write', sessionId: 'mcp', requestId: 'request-1', fingerprint: 'call-1', asks: asks(1), call: whole() }
      const [request] = (await registry.ask(sent)).requests
      const [file] = readdirSync(calls)
      if (kind === 'missing_file') rmSync(join(calls, file!))
      else writeFileSync(join(calls, file!), 'invalid JSON')
      expect(await registry.resolve({ token: request!.token, approved: true, scope: 'once' }, 'admin')).toMatchObject({ ok: false, reason: expect.stringContaining('re-send the call') })
      expect(await registry.ask(sent)).toMatchObject({ joined: true, requests: [{ token: request!.token }] })
      expect(readdirSync(calls)).toHaveLength(1)
      expect(readdirSync(calls)).not.toContain(file)
      expect(registry.waitingAsk(request!.token)?.call).toEqual(whole())
      expect(await registry.resolve({ token: request!.token, approved: true, scope: 'once' }, 'admin')).toMatchObject({ ok: true })
    } finally { await service.close() }
  })
})

// Slice 7 review R7-RR-1: the L4 repair parsed the group's call file once per waiting ask inside the approvals lock,
// so one same-requestId re-send of 50 asks sharing a 960 KB call held the lock 6.5 to 11 s, and a decision from
// another process failed at the lock's 5 s deadline. A re-send now judges each call file by one stat.
describe('a re-send of a large waiting group stays cheap under the approvals lock', () => {
  /** fs_write_batch as an agent may send it: 50 paths outside the scope, each with dense JSON the tool's schema strips. */
  const dense = (root: string): AskedCall => ({
    arguments: { files: Array.from({ length: 50 }, (_, index) => ({ path: `/outside/${index}`, content: 'x', meta: Array.from({ length: 1_400 }, (_, key) => [key, { a: 1 }]) })) },
    cwd: root, description: null, complete: true,
  })

  it('re-sends in well under a second while another process decides one of the asks', async () => {
    const { root, registry, service } = queue()
    const call = dense(root)
    expect(Buffer.byteLength(JSON.stringify(call.arguments))).toBeGreaterThan(900_000)
    const sent = { tool: 'fs_write_batch', sessionId: 'mcp', requestId: 'batch-1', fingerprint: 'call-1', asks: asks(50), call }
    const warn = vi.spyOn(logger, 'warn')
    try {
      const { requests } = await registry.ask(sent)
      const script = join(root, 'decide.mts')
      writeFileSync(script, `
        import { createFileGrantStore } from ${JSON.stringify(new URL('../common/adapters/grant-store/file-grant-store.ts', import.meta.url).href)};
        import { createApprovalRegistry } from ${JSON.stringify(new URL('../common/services/approvals/approval-registry.ts', import.meta.url).href)};
        const [root, token] = process.argv.slice(2);
        const registry = createApprovalRegistry(createFileGrantStore({ filePath: root + '/grants.json', workspace: root }), root + '/approvals.json', root);
        const started = Date.now();
        const decided = await registry.resolve({ token, approved: false, scope: 'once' }, 'admin');
        console.log(JSON.stringify({ ok: decided.ok, ms: Date.now() - started }));
      `)
      const started = Date.now()
      const resend = registry.ask(sent)
      const other = promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), script, root, requests[1]!.token])
      expect(await resend).toMatchObject({ joined: true, requests: requests.map(request => ({ token: request.token })) })
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(JSON.parse((await other).stdout)).toMatchObject({ ok: true })
      for (let attempt = 0; attempt < 3; attempt++) {
        const again = Date.now()
        await registry.ask(sent)
        expect(Date.now() - again).toBeLessThan(1_000)
      }
      expect(warn.mock.calls.filter(([message]) => /call file/.test(message))).toEqual([])
    } finally {
      warn.mockRestore()
      await service.close()
    }
  }, SPAWN_TEST_TIMEOUT_MS)

  it('warns once, not once per ask, when a waiting group\'s call file is missing, and repairs it on the re-send', async () => {
    const { root, registry, service } = queue()
    const sent = { tool: 'fs_write_batch', sessionId: 'mcp', requestId: 'batch-2', fingerprint: 'call-2', asks: asks(50), call: whole() }
    const warn = vi.spyOn(logger, 'warn')
    try {
      const { requests } = await registry.ask(sent)
      const calls = join(root, 'approval-calls')
      rmSync(join(calls, readdirSync(calls)[0]!))
      expect(registry.waiting().filter(ask => ask.call === undefined)).toHaveLength(50)
      expect(warn.mock.calls.filter(([message]) => /call files are missing or unreadable/.test(message))).toHaveLength(1)
      expect(await registry.ask(sent)).toMatchObject({ joined: true })
      expect(readdirSync(calls)).toHaveLength(1)
      expect(registry.waiting().every(ask => ask.call?.complete === true)).toBe(true)
      expect(await registry.resolve({ token: requests[0]!.token, approved: true, scope: 'once' }, 'admin')).toMatchObject({ ok: true })
      expect(warn.mock.calls.filter(([message]) => /call files are missing or unreadable/.test(message))).toHaveLength(1)
    } finally {
      warn.mockRestore()
      await service.close()
    }
  })
})

// Slice 7b review W7B-1: a re-send of a call approved once, with no token, checks it four times inside the approvals
// lock; each check of a 1 MB script of nested evals took 5 s, so the lock was held about 20 s and a cancel from
// another process failed at the lock's 5 s deadline. The forms are read once per effect and within a budget.
describe('a re-send of a large nested script approved once', () => {
  const doubleQuoted = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`
  const nested = (levels: number, tail: string) => {
    let body = `${'a '.repeat(levels === 8 ? 499_000 : 499_400)}${tail}`
    for (let level = 0; level < levels; level++) body = `eval ${doubleQuoted(`${body} ; true`)}`
    return body
  }

  it.each([[8, ''], [3, '; git clean -fdx']] as const)('holds the lock well under 5 s for %i levels while another process cancels', async (levels, tail) => {
    const { root, registry, service } = queue()
    const policy = emptyWorkspacePolicy()
    policy.commands.allow = ['bash -c *']
    const compiled = compilePolicy(policy)
    const engine = createPermissionEngine([createCommandPolicyRule(compiled), createDestructiveCommandRule({ added: compiled.commands.destructive })])
    const effects = [{ kind: 'exec' as const, command: 'bash', args: ['-c', nested(levels, tail)] }]
    const check = (subjects: Array<{ rule: string; subject: string }>) => engine.evaluate({ tool: 'script_run', effects, grants: { subjectsFor: rule => subjects.filter(entry => entry.rule === rule).map(entry => entry.subject) } })
    const asked = check([])
    if (asked.kind !== 'ask') throw new Error(`expected an ask, got ${asked.kind}`)
    const sent = { tool: 'script_run', sessionId: 'mcp', requestId: 'nested-1', fingerprint: 'nested-call', asks: asked.asks, call: whole() }
    const marker = join(root, 'in-lock')
    const script = join(root, 'cancel.mts')
    writeFileSync(script, `
      import { existsSync } from 'node:fs';
      import { createFileGrantStore } from ${JSON.stringify(new URL('../common/adapters/grant-store/file-grant-store.ts', import.meta.url).href)};
      import { createApprovalRegistry } from ${JSON.stringify(new URL('../common/services/approvals/approval-registry.ts', import.meta.url).href)};
      const [root, marker] = process.argv.slice(2);
      const registry = createApprovalRegistry(createFileGrantStore({ filePath: root + '/grants-other.json', workspace: root }), root + '/approvals.json', root);
      console.log('ready');
      while (!existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 5));
      const started = Date.now();
      try { await registry.cancel(['another-token']); console.log(JSON.stringify({ ok: true, ms: Date.now() - started })) }
      catch (error) { console.log(JSON.stringify({ ok: false, ms: Date.now() - started, name: error?.constructor?.name })) }
    `)
    try {
      const { requests } = await registry.ask(sent)
      expect(await registry.resolve({ token: requests[0]!.token, approved: true, scope: 'once' }, 'admin')).toMatchObject({ ok: true })
      const other = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), script, root, marker], { stdio: ['ignore', 'pipe', 'inherit'] })
      let output = ''
      const ready = new Promise<void>(resolve => other.stdout.on('data', (chunk) => { output += String(chunk); if (output.includes('ready')) resolve() }))
      const exited = new Promise(resolve => other.on('exit', resolve))
      await ready
      let checks = 0
      let locked = 0
      const outcome = await registry.evaluate({
        tokens: [], sessionId: 'mcp', tool: 'script_run', fingerprint: 'nested-call', admit: () => true,
        check: (subjects) => {
          checks += 1
          // The first check runs before the lock; the ones after it run inside the update that holds it.
          if (checks === 2) { locked = performance.now(); writeFileSync(marker, 'x') }
          return check(subjects)
        },
      })
      const held = performance.now() - locked
      expect(outcome.kind).toBe('allow')
      expect(checks).toBeGreaterThanOrEqual(4)
      expect(held).toBeLessThan(2_000)
      await exited
      expect(JSON.parse(output.slice(output.indexOf('{')))).toMatchObject({ ok: true })
    } finally { await service.close() }
  }, SPAWN_TEST_TIMEOUT_MS)
})

// Review L3 of the continuation review: an ordinary call read the index to learn the next expiry, so a damaged
// approvals.json made every allowed or denied call throw until the owner repaired it.
describe('an unreadable approvals index fails the calls that need it, not ordinary ones', () => {
  it('lets allowed and denied calls through while it is damaged, refuses an ask, and prunes again once it is repaired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { filePath, registry, service } = queue()
    const allowed = () => registry.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: () => ({ kind: 'allow', allowedBy: [] }) })
    const denied = () => registry.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: () => ({ kind: 'deny', denial: { kind: 'deny', rule: 'command_policy', subject: 'x', reason: 'refused' } }) })
    try {
      const [request] = (await issue(registry)).requests
      const healthy = readFileSync(filePath, 'utf8')
      writeFileSync(filePath, '{"version":1,"pending":[')
      expect(await allowed()).toMatchObject({ kind: 'allow' })
      expect(await denied()).toMatchObject({ kind: 'deny' })
      vi.setSystemTime(Date.now() + 11 * 60_000)
      expect(await allowed()).toMatchObject({ kind: 'allow' })
      expect(await denied()).toMatchObject({ kind: 'deny' })
      await expect(issue(registry)).rejects.toThrow(/unreadable or invalid/)
      writeFileSync(filePath, healthy)
      expect(await allowed()).toMatchObject({ kind: 'allow' })
      expect(JSON.parse(readFileSync(filePath, 'utf8')).pending).toEqual([])
      expect(registry.pending().map(entry => entry.token)).not.toContain(request!.token)
    } finally { await service.close() }
  })
})

// Slice 7 review R7-RR-2: after an unreadable index, ordinary calls read it again only when its version changed, so
// one repaired in place (its mode put back, same mtime and size) never pruned again. Slice 7 review R7-RR-3: the
// warning carried the StateFileError with its cause, whose V8 message quotes the file around the fault.
describe('an index unreadable for a while, then repaired in place', () => {
  const allowed = (registry: ReturnType<typeof createApprovalRegistry>) => registry.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: () => ({ kind: 'allow', allowedBy: [] }) })
  const unreadableWarnings = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(([message]) => String(message).startsWith('The approvals index is unreadable'))

  it.skipIf(process.getuid?.() === 0)('prunes an expired ask from another process at the first ordinary call after the retry delay, and warns once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { root, filePath, grants, registry, service } = queue()
    const other = createApprovalRegistry(grants, filePath, root)
    const warn = vi.spyOn(logger, 'warn')
    try {
      expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
      const [request] = (await issue(other)).requests
      vi.setSystemTime(Date.now() + 11 * 60_000)
      chmodSync(filePath, 0o000)
      expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
      expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
      chmodSync(filePath, 0o600)
      expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
      expect(JSON.parse(readFileSync(filePath, 'utf8')).pending).toHaveLength(1)
      vi.setSystemTime(Date.now() + 6_000)
      expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
      expect(JSON.parse(readFileSync(filePath, 'utf8')).pending).toEqual([])
      expect(registry.pending().map(entry => entry.token)).not.toContain(request!.token)
      expect(unreadableWarnings(warn)).toHaveLength(1)
    } finally {
      warn.mockRestore()
      await service.close()
    }
  })

  // Slice 7b review RRL-2: the timed retry read the unreadable index every 5 s, and the store logged its error line on
  // each read, about 720 an hour until the owner repaired it.
  it.skipIf(process.getuid?.() === 0)('logs an index unreadable across 30 s of ordinary calls once, from the store and the registry each', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { filePath, registry, service } = queue()
    await issue(registry)
    const warn = vi.spyOn(logger, 'warn')
    const error = vi.spyOn(logger, 'error')
    try {
      chmodSync(filePath, 0o000)
      for (let second = 0; second <= 30; second++) {
        expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
        vi.setSystemTime(Date.now() + 1_000)
      }
      expect(unreadableWarnings(warn)).toHaveLength(1)
      expect(error.mock.calls.filter(([message]) => message === 'State file cannot be read safely')).toHaveLength(1)
    } finally {
      chmodSync(filePath, 0o600)
      warn.mockRestore()
      error.mockRestore()
      await service.close()
    }
  })

  // Slice 7c review R7C-TL-3: an index read before it went unreadable kept its version, so pruning an expired ask went
  // straight to the update, whose read logged the store's line and a warning every 5 s; with a webhook, the outcome
  // sender's retry read logged both lines again every 5 s, calls or not.
  describe('an index unreadable after an ask expired, read by the prune retry and the outcome sender (R7C-TL-3)', () => {
    const stored = (error: { mock: { calls: unknown[][] } }) => error.mock.calls.filter(([message]) => message === 'State file cannot be read safely').length
    const warned = (warn: { mock: { calls: unknown[][] } }, message: string) => warn.mock.calls.filter(([logged]) => logged === message).length
    /** The prune's and the sender's warnings together: whichever reads the damage first warns, and the other stays quiet. */
    const retries = (warn: { mock: { calls: unknown[][] } }) => warned(warn, 'Could not drop the approvals that expired') + warned(warn, 'Approval lifecycle delivery will be retried')

    /** A queue whose ends go to an outcome receiver through the durable outbox, retried every 20 ms. */
    function withWebhook() {
      const root = mkdtempSync(join(tmpdir(), 'buckle-read-paths-'))
      roots.push(root)
      const filePath = join(root, 'approvals.json')
      const sent: ApprovalNotice[] = []
      let notices: ApprovalNotices | undefined
      const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), filePath, root, 0, { durableNotices: true, onNoticeQueued: () => { void notices?.flush() } })
      notices = createApprovalNotices(async (batch) => { sent.push(...batch) }, { registry, retryMs: 20 })
      return { root, filePath, registry, notices, sent }
    }

    /** Thirty seconds of ordinary calls, one a second; with a webhook, the sender retries between them. */
    async function thirtySeconds(registry: ReturnType<typeof createApprovalRegistry>): Promise<void> {
      for (let second = 0; second <= 30; second++) {
        expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
        vi.setSystemTime(Date.now() + 1_000)
        await new Promise(resolve => setTimeout(resolve, 30))
      }
    }

    it.skipIf(process.getuid?.() === 0)('logs a file\'s failure once per version until a read succeeds, so a damage after a repair in place logs again', async () => {
      const root = mkdtempSync(join(tmpdir(), 'buckle-read-paths-'))
      roots.push(root)
      const filePath = join(root, 'state.json')
      writeFileSync(filePath, '{"value":1}\n')
      const store = createJsonFileStore({ filePath, schema: z.object({ value: z.number() }), fallback: { value: 0 } })
      const error = vi.spyOn(logger, 'error')
      const failure = () => { try { store.read(); return null } catch (thrown) { return thrown as { repeated?: boolean } } }
      try {
        chmodSync(filePath, 0o000)
        expect([failure(), failure(), failure()].map(thrown => thrown?.repeated)).toEqual([false, true, true])
        expect(stored(error)).toBe(1)
        chmodSync(filePath, 0o600)
        expect(store.read()).toEqual({ value: 1 })
        chmodSync(filePath, 0o000)
        expect([failure(), failure()].map(thrown => thrown?.repeated)).toEqual([false, true])
        expect(stored(error)).toBe(2)
        chmodSync(filePath, 0o600)
        writeFileSync(filePath, '{"value":')
        expect(failure()?.repeated).toBe(false)
        expect(stored(error)).toBe(3)
      } finally {
        chmodSync(filePath, 0o600)
        error.mockRestore()
      }
    })

    it.skipIf(process.getuid?.() === 0)('logs the store error once across 30 s of ordinary calls, prunes after the repair, and logs a new damage once more', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const { filePath, registry, service } = queue()
      const warn = vi.spyOn(logger, 'warn')
      const error = vi.spyOn(logger, 'error')
      try {
        await issue(registry)
        expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
        chmodSync(filePath, 0o000)
        vi.setSystemTime(Date.now() + 11 * 60_000)
        await thirtySeconds(registry)
        expect(stored(error)).toBe(1)
        expect(warned(warn, 'Could not drop the approvals that expired')).toBe(1)
        chmodSync(filePath, 0o600)
        vi.setSystemTime(Date.now() + 6_000)
        expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
        expect(JSON.parse(readFileSync(filePath, 'utf8')).pending).toEqual([])
        await issue(registry)
        expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
        chmodSync(filePath, 0o000)
        vi.setSystemTime(Date.now() + 11 * 60_000)
        await thirtySeconds(registry)
        expect(stored(error)).toBe(2)
        expect(warned(warn, 'Could not drop the approvals that expired')).toBe(2)
      } finally {
        chmodSync(filePath, 0o600)
        warn.mockRestore()
        error.mockRestore()
        await service.close()
      }
    })

    it.skipIf(process.getuid?.() === 0)('logs it once with a webhook too, whose sender retries meanwhile, and delivers the expiry after the repair', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const { filePath, registry, notices, sent } = withWebhook()
      const warn = vi.spyOn(logger, 'warn')
      const error = vi.spyOn(logger, 'error')
      try {
        const [request] = (await issue(registry)).requests
        expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
        chmodSync(filePath, 0o000)
        vi.setSystemTime(Date.now() + 11 * 60_000)
        await thirtySeconds(registry)
        expect(stored(error)).toBe(1)
        expect(retries(warn)).toBe(1)
        chmodSync(filePath, 0o600)
        vi.setSystemTime(Date.now() + 6_000)
        expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
        await vi.waitFor(() => expect(sent.map(notice => [notice.token, notice.event])).toEqual([[request!.token, 'expired']]))
        expect(JSON.parse(readFileSync(filePath, 'utf8'))).toMatchObject({ pending: [], outbox: [] })
        const [again] = (await issue(registry)).requests
        expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
        chmodSync(filePath, 0o000)
        vi.setSystemTime(Date.now() + 11 * 60_000)
        await thirtySeconds(registry)
        expect(stored(error)).toBe(2)
        expect(retries(warn)).toBe(2)
        chmodSync(filePath, 0o600)
        vi.setSystemTime(Date.now() + 6_000)
        expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
        await vi.waitFor(() => expect(sent.map(notice => notice.token)).toContain(again!.token))
      } finally {
        chmodSync(filePath, 0o600)
        warn.mockRestore()
        error.mockRestore()
        await notices.settle()
      }
    })

    // Slice 7d review R7D-GR-1: with the state directory's search permission gone, the queue's version stat threw a raw
    // EACCES, not a StateFileError, so the outcome sender warned at every retry (every 5 s in production) and an
    // ordinary call threw it. The version is now `unknown:EACCES`, as the store names it, so the sender warns once.
    describe('a state directory that cannot be searched (R7D-GR-1)', () => {
      /** Every logged line's text, so a raw system error in any field shows. */
      const lines = (...spies: Array<{ mock: { calls: unknown[][] } }>) => spies.flatMap(spy => spy.mock.calls.map(call => JSON.stringify(call)))

      it.skipIf(process.getuid?.() === 0)('warns once across 30 sender retries and 30 s of ordinary calls, with no raw EACCES, and delivers after the repair', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const { root, registry, notices, sent } = withWebhook()
        const reads = vi.spyOn(registry, 'pendingDeliveries')
        const warn = vi.spyOn(logger, 'warn')
        const error = vi.spyOn(logger, 'error')
        try {
          const [request] = (await issue(registry)).requests
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          chmodSync(root, 0o000)
          const before = reads.mock.calls.length
          await vi.waitFor(() => expect(reads.mock.calls.length - before).toBeGreaterThanOrEqual(30), { timeout: 10_000, interval: 20 })
          expect(warned(warn, 'Approval lifecycle delivery will be retried')).toBe(1)
          vi.setSystemTime(Date.now() + 11 * 60_000)
          await thirtySeconds(registry)
          expect(stored(error)).toBe(1)
          expect(warned(warn, 'Approval lifecycle delivery will be retried')).toBe(1)
          expect(warn.mock.calls.filter(([message]) => String(message).startsWith('The approvals index is unreadable'))).toHaveLength(1)
          expect(lines(warn, error).filter(line => line.includes('EACCES: permission denied'))).toEqual([])
          chmodSync(root, 0o700)
          vi.setSystemTime(Date.now() + 6_000)
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          await vi.waitFor(() => expect(sent.map(notice => [notice.token, notice.event])).toEqual([[request!.token, 'expired']]))
          expect(warned(warn, 'Approval lifecycle delivery will be retried')).toBe(1)
        } finally {
          chmodSync(root, 0o700)
          warn.mockRestore()
          error.mockRestore()
          await notices.settle()
        }
      })

      // Slice 7e review R7E-QV-1: a repair in place gave back the queue version last read whole, so nothing read the
      // index again, and neither the registry's mark nor the store's was cleared; a second outage at the same
      // unknown:EACCES logged nothing. Each outage now logs as the first one did.
      const index = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter(([message]) => String(message).startsWith('The approvals index is unreadable')).length
      /** Twelve seconds of ordinary calls, one a second, past the prune's retry delay. */
      async function twelveSeconds(registry: ReturnType<typeof createApprovalRegistry>): Promise<void> {
        for (let second = 0; second <= 12; second++) {
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          vi.setSystemTime(Date.now() + 1_000)
          await new Promise(resolve => setTimeout(resolve, 30))
        }
      }

      /** Two seconds of ordinary calls, shorter than the prune's retry delay, so no timed prune reads the index. */
      async function twoSeconds(registry: ReturnType<typeof createApprovalRegistry>): Promise<void> {
        for (let step = 0; step < 4; step++) {
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          vi.setSystemTime(Date.now() + 500)
        }
      }

      it.skipIf(process.getuid?.() === 0)('logs each of three outages once, from the store and the registry each, after a short repair in place', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const { root, registry, service } = queue()
        await issue(registry)
        const warn = vi.spyOn(logger, 'warn')
        const error = vi.spyOn(logger, 'error')
        try {
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          for (const episode of [1, 2, 3]) {
            chmodSync(root, 0o000)
            await twelveSeconds(registry)
            expect([stored(error), index(warn)]).toEqual([episode, episode])
            chmodSync(root, 0o700)
            await twoSeconds(registry)
            expect([stored(error), index(warn)]).toEqual([episode, episode])
          }
        } finally {
          chmodSync(root, 0o700)
          warn.mockRestore()
          error.mockRestore()
          await service.close()
        }
      })

      it.skipIf(process.getuid?.() === 0)('with a webhook, logs each of three outages once, from the store, the sender and the registry each', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const { root, registry, notices } = withWebhook()
        const reads = vi.spyOn(registry, 'pendingDeliveries')
        const warn = vi.spyOn(logger, 'warn')
        const error = vi.spyOn(logger, 'error')
        const senderRetries = async () => {
          const before = reads.mock.calls.length
          await vi.waitFor(() => expect(reads.mock.calls.length - before).toBeGreaterThanOrEqual(10), { timeout: 10_000, interval: 20 })
        }
        try {
          await issue(registry)
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          for (const episode of [1, 2, 3]) {
            chmodSync(root, 0o000)
            await senderRetries()
            await twelveSeconds(registry)
            expect([stored(error), warned(warn, 'Approval lifecycle delivery will be retried'), index(warn)]).toEqual([episode, episode, episode])
            chmodSync(root, 0o700)
            await senderRetries()
            await twelveSeconds(registry)
            expect([stored(error), warned(warn, 'Approval lifecycle delivery will be retried'), index(warn)]).toEqual([episode, episode, episode])
          }
        } finally {
          chmodSync(root, 0o700)
          warn.mockRestore()
          error.mockRestore()
          await notices.settle()
        }
      })

      // Slice 7f review R7F-QV-1: a repair seen only by an ask (a read), a decision (an update) or the sender cleared
      // the store's report but not the registry's mark, so the registry stayed silent on the next outage. Any read that
      // succeeds now clears the mark, so each outage logs from the store and the registry each, whichever path saw the
      // repair. Each episode repairs through one path only, with no ordinary call between the outages.
      it.skipIf(process.getuid?.() === 0)('logs each outage once when only an ask reads the repair', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const { root, registry, service } = queue()
        await issue(registry)
        const warn = vi.spyOn(logger, 'warn')
        const error = vi.spyOn(logger, 'error')
        try {
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          for (const episode of [1, 2, 3]) {
            chmodSync(root, 0o000)
            await twelveSeconds(registry)
            expect([stored(error), index(warn)]).toEqual([episode, episode])
            chmodSync(root, 0o700)
            registry.pending()
          }
        } finally {
          chmodSync(root, 0o700)
          warn.mockRestore()
          error.mockRestore()
          await service.close()
        }
      })

      it.skipIf(process.getuid?.() === 0)('logs each outage once when only a decision updates the repair', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const { root, registry, service } = queue()
        await issue(registry)
        const warn = vi.spyOn(logger, 'warn')
        const error = vi.spyOn(logger, 'error')
        try {
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          for (const episode of [1, 2, 3]) {
            chmodSync(root, 0o000)
            await twelveSeconds(registry)
            expect([stored(error), index(warn)]).toEqual([episode, episode])
            chmodSync(root, 0o700)
            await registry.sweep()
          }
        } finally {
          chmodSync(root, 0o700)
          warn.mockRestore()
          error.mockRestore()
          await service.close()
        }
      })

      it.skipIf(process.getuid?.() === 0)('logs each outage once when only the sender reads the repair', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const { root, registry, notices } = withWebhook()
        const reads = vi.spyOn(registry, 'pendingDeliveries')
        const warn = vi.spyOn(logger, 'warn')
        const error = vi.spyOn(logger, 'error')
        const senderReads = async () => {
          const before = reads.mock.calls.length
          await vi.waitFor(() => expect(reads.mock.calls.length - before).toBeGreaterThanOrEqual(10), { timeout: 10_000, interval: 20 })
        }
        try {
          await issue(registry)
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          for (const episode of [1, 2, 3]) {
            chmodSync(root, 0o000)
            await twelveSeconds(registry)
            expect(index(warn)).toBe(episode)
            chmodSync(root, 0o700)
            await senderReads()
          }
        } finally {
          chmodSync(root, 0o700)
          warn.mockRestore()
          error.mockRestore()
          await notices.settle()
        }
      })

      it('reads a missing state directory as an empty queue, as before, and delivers once it is back', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const { root, registry, notices, sent } = withWebhook()
        const reads = vi.spyOn(registry, 'pendingDeliveries')
        const warn = vi.spyOn(logger, 'warn')
        const error = vi.spyOn(logger, 'error')
        try {
          const [request] = (await issue(registry)).requests
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          renameSync(root, `${root}.gone`)
          const before = reads.mock.calls.length
          await vi.waitFor(() => expect(reads.mock.calls.length - before).toBeGreaterThanOrEqual(30), { timeout: 10_000, interval: 20 })
          vi.setSystemTime(Date.now() + 11 * 60_000)
          await thirtySeconds(registry)
          expect(lines(warn, error)).toEqual([])
          renameSync(`${root}.gone`, root)
          expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
          await vi.waitFor(() => expect(sent.map(notice => [notice.token, notice.event])).toEqual([[request!.token, 'expired']]))
        } finally {
          if (existsSync(`${root}.gone`)) renameSync(`${root}.gone`, root)
          warn.mockRestore()
          error.mockRestore()
          await notices.settle()
        }
      })
    })
  })

  it('names the error and the file in its warning, and no part of the damaged text', async () => {
    const { filePath, registry, service } = queue()
    const warn = vi.spyOn(logger, 'warn')
    try {
      writeFileSync(filePath, '{"version":1,"pending":[{"request":{"subject": psql -c DROP TABLE accounts}}]}')
      expect(await allowed(registry)).toMatchObject({ kind: 'allow' })
      const [warning] = unreadableWarnings(warn)
      const logged = (warning?.[1] as { error?: Error } | undefined)?.error
      expect(logged).toMatchObject({ name: 'StateFileError', message: `State file is unreadable or invalid: ${filePath}; owner repair is required` })
      expect(logged?.cause).toBeUndefined()
      expect(`${logged?.message} ${logged?.stack}`).not.toMatch(/psql|DROP|accounts/)
    } finally {
      warn.mockRestore()
      await service.close()
    }
  })
})

describe('approval caps distinguish the actor and session pair', () => {
  it('keeps an HTTP caller using mcp from filling the stdio host count cap', async () => {
    const { registry, service } = queue()
    try {
      await registry.ask({ tool: 'fs_write_batch', sessionId: 'mcp', actor: 'http-agent', asks: asks(MAX_PENDING_PER_SESSION), call: whole() })
      await expect(registry.ask({ tool: 'fs_write', sessionId: 'mcp', actor: 'http-agent', asks: asks(1), call: whole() })).rejects.toThrow('This session already has')
      expect((await registry.ask({ tool: 'fs_write', sessionId: 'mcp', actor: 'stdio-host', asks: asks(1), call: whole() })).requests).toHaveLength(1)
    } finally { await service.close() }
  })

  it('keeps the same session name from sharing its byte cap between callers', async () => {
    const { registry, service } = queue()
    try {
      await registry.ask({ tool: 'fs_write', sessionId: 'mcp', actor: 'http-agent', asks: asks(1), call: whole(MAX_PENDING_BYTES_PER_SESSION - 64 * 1_024) })
      await expect(registry.ask({ tool: 'fs_write', sessionId: 'mcp', actor: 'http-agent', asks: asks(1), call: whole(128 * 1_024) })).rejects.toThrow('per session')
      expect((await registry.ask({ tool: 'fs_write', sessionId: 'mcp', actor: 'stdio-host', asks: asks(1), call: whole(128 * 1_024) })).requests).toHaveLength(1)
    } finally { await service.close() }
  })
})

describe('expired approval cleanup runs without another approval event', () => {
  it('prunes expired asks, files and notices before an ordinary allowed call returns', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { root, filePath, grants, registry, service } = queue()
    const expired: string[] = []
    const watching = createApprovalRegistry(grants, filePath, root, 0, { onExpired: requests => expired.push(...requests.map(request => request.token)) })
    try {
      const [request] = (await issue(watching)).requests
      vi.setSystemTime(Date.now() + 11 * 60_000)
      expect(await watching.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: () => ({ kind: 'allow', allowedBy: [] }) })).toMatchObject({ kind: 'allow' })
      expect(expired).toEqual([request!.token])
      expect(JSON.parse(readFileSync(filePath, 'utf8')).pending).toEqual([])
      expect(readdirSync(join(root, 'approval-calls'))).toEqual([])
      expect(registry.pending()).toEqual([])
    } finally { await service.close() }
  })

  it('notices another process adding asks after this process started with an empty queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { root, filePath, grants, registry, service } = queue()
    try {
      await service.close()
      const expired: string[] = []
      const serving = createApprovalRegistry(grants, filePath, root, 0, { onExpired: requests => expired.push(...requests.map(request => request.token)) })
      await serving.sweepIfDue()
      const [request] = (await issue(registry)).requests
      vi.setSystemTime(Date.now() + 11 * 60_000)
      expect(await serving.evaluate({ tokens: [], sessionId: 'reader', tool: 'fs_read', check: () => ({ kind: 'allow', allowedBy: [] }) })).toMatchObject({ kind: 'allow' })
      expect(expired).toEqual([request!.token])
      expect(JSON.parse(readFileSync(filePath, 'utf8')).pending).toEqual([])
      expect(readdirSync(join(root, 'approval-calls'))).toEqual([])
    } finally { await service.close() }
  })

  it('awaits process-start pruning and expiry notice delivery when the service closes immediately', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { root, filePath, grants, registry, service } = queue()
    await service.close()
    const [request] = (await issue(registry)).requests
    writeFileSync(join(root, 'approval-calls', 'orphan.tmp'), 'abandoned write')
    vi.setSystemTime(Date.now() + 11 * 60_000)
    const sent: ApprovalNotice[] = []
    const notices = createApprovalNotices(async batch => { await new Promise(resolve => setTimeout(resolve, 20)); sent.push(...batch) })
    const restarted = createApprovalRegistry(grants, filePath, root, 0, { onExpired: requests => notices.expired(requests) })
    const closing = createApprovalService({ registry: restarted, workspaceId: 'default', serverId: 'node-1', graceMs: 1, interaction: async () => undefined, notices })
    await closing.close()
    expect(sent).toEqual([expect.objectContaining({ token: request!.token, event: 'expired' })])
    expect(JSON.parse(readFileSync(filePath, 'utf8')).pending).toEqual([])
    expect(existsSync(join(root, 'approval-calls', 'orphan.tmp'))).toBe(false)
    expect(readdirSync(join(root, 'approval-calls'))).toEqual([])
  })
})
