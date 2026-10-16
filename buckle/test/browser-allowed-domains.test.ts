import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configFromEnvironment } from './support/workspace-config.js'
import { logger } from '../common/runtime/log.js'
import { workspaceStateKey } from '../common/domain/workspace-key.js'
import { browserAllowedDomains, type ApprovedList } from '../common/services/packs/browser/allowed-domains.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { openSettingsFile, settingsPath } from '../common/services/workspaces/workspace-settings.js'

const node = (...entries: string[]): ApprovedList => ({ name: 'node', entries })
const workspace = (...entries: string[]): ApprovedList => ({ name: 'workspace', entries })
const flag = (lists: ApprovedList[]) => {
  const domains = browserAllowedDomains(lists)
  return 'value' in domains ? domains.value : `refused: ${domains.refusal}`
}

describe('the approved list, read as agent-browser allowed domains (BUCKLE-D21)', () => {
  it('passes no flag when no approved list is set, since every public host is then allowed', () => {
    expect(browserAllowedDomains([])).toEqual({ value: null, loosened: [] })
  })

  it('passes a host and a wildcard as written, the wildcard covering the apex as BUCKLE-D18 says', () => {
    expect(flag([workspace('Example.com', '*.docs.test', 'my_db')])).toBe('example.com,*.docs.test,my_db')
  })

  it('passes the host part of a port, an address and a URL prefix, and names each entry it loosened', () => {
    expect(browserAllowedDomains([workspace('localhost:3000', '192.168.1.10:8080', 'https://app.example.com/admin', '*.example.com:8443', '127.0.0.1', '[::1]:3000', 'docs.test')])).toEqual({
      value: 'localhost,192.168.1.10,app.example.com,*.example.com,127.0.0.1,[::1],docs.test',
      loosened: [
        { entry: 'localhost:3000', list: 'workspace', host: 'localhost' },
        { entry: '192.168.1.10:8080', list: 'workspace', host: '192.168.1.10' },
        { entry: 'https://app.example.com/admin', list: 'workspace', host: 'app.example.com' },
        { entry: '*.example.com:8443', list: 'workspace', host: '*.example.com' },
        { entry: '[::1]:3000', list: 'workspace', host: '[::1]' },
      ],
    })
  })

  it('keeps only the hosts both the node and the workspace list allow', () => {
    expect(flag([node('*.example.com', 'other.test'), workspace('api.example.com', '*.example.com', 'else.test')])).toBe('api.example.com,*.example.com')
    expect(flag([node('example.com'), workspace('*.example.com')])).toBe('example.com')
    expect(flag([node('*.a.example.com'), workspace('*.example.com')])).toBe('*.a.example.com')
  })

  // Ports are intersected before they are dropped, so the flag never opens a host on a port only one list allows.
  it.each([
    ['localhost:3000', 'localhost', 'localhost'],
    ['localhost', 'localhost:3000', 'localhost'],
    ['localhost:3000', 'localhost:3000', 'localhost'],
    ['localhost:3000', 'localhost:4000', null],
    ['*.example.com:8443', 'api.example.com', 'api.example.com'],
    ['*.example.com:8443', 'api.example.com:443', null],
    ['https://app.example.com/admin', 'app.example.com', 'app.example.com'],
    ['https://app.example.com', 'app.example.com:443', 'app.example.com'],
    ['https://app.example.com', 'app.example.com:8443', null],
    ['http://localhost:3000', 'localhost:3000', 'localhost'],
    ['http://localhost', 'localhost:3000', null],
    ['127.0.0.1:8080', '127.0.0.1', '127.0.0.1'],
    ['[::1]:3000', '[::1]:4000', null],
  ])('node %s against workspace %s passes %s', (ceiling, own, expected) => {
    const domains = browserAllowedDomains([node(ceiling), workspace(own)])
    if (expected === null) expect(domains).toMatchObject({ refusal: expect.stringContaining('on the same host and port') })
    else expect(domains).toMatchObject({ value: expected })
  })

  it('never passes localhost when the node allows only port 3000 and the workspace only port 4000', () => {
    expect(browserAllowedDomains([node('localhost:3000'), workspace('localhost:4000')])).toEqual({
      refusal: 'Buckle does not start the browser: no entry in the workspace approved list (localhost:4000) is allowed by the node approved list (localhost:3000) on the same host and port, and an empty --allowed-domains would allow every host. The owner can add to the workspace approved list a host and port that the node approved list (localhost:3000) allows',
    })
  })

  it('refuses a list that approves nothing, naming it, since an empty flag would allow every host', () => {
    expect(browserAllowedDomains([node('example.com'), workspace()])).toEqual({
      refusal: 'Buckle does not start the browser: the workspace approved list has no usable entry, and an empty --allowed-domains would allow every host. The owner can add the hosts the browser needs to the workspace approved list',
    })
    expect(browserAllowedDomains([node()])).toMatchObject({ refusal: expect.stringContaining('the node approved list has no usable entry') })
  })
})

describe('the allowed domains a real runtime hands a fake agent-browser', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  async function fixture(network: string[], closeDelayMs = 0, waitDelayMs = 0, environment: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'buckle-allowed-domains-'))
    roots.push(root)
    mkdirSync(join(root, 'workspace'))
    const log = join(root, 'calls.jsonl')
    const binary = join(root, 'agent-browser')
    const slowClose = closeDelayMs > 0 ? `if (process.argv[2] === 'close') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${closeDelayMs})\n` : ''
    const slowWait = waitDelayMs > 0 ? `if (process.argv[2] === 'wait') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${waitDelayMs})\n` : ''
    writeFileSync(binary, `#!/usr/bin/env node\n${slowClose}require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n${slowWait}process.stdout.write('{"success":true}')\n`)
    chmodSync(binary, 0o755)
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'browser', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_AGENT_BROWSER_COMMAND: binary, ...environment })
    const runtime = await createRuntime({ config })
    if (network.length) await runtime.policy.apply(policy(network))
    const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []
    const stored = () => JSON.parse(readFileSync(join(config.stateDirectory, 'browser-sessions', workspaceStateKey(config.cwd), 'sessions.json'), 'utf8')) as { sessions: Record<string, string>; allowedDomains: Record<string, string | null> }
    return { runtime, calls, config, stored }
  }

  function policy(network: string[]): WorkspacePolicy {
    const value = emptyWorkspacePolicy()
    value.network.allow = network
    return value
  }

  function browse(runtime: BuckleRuntime, args: JsonObject, approvalTokens: string[] = []): Promise<InvokeResponse> {
    return runtime.invoke({ request: { requestId: `browse-${randomUUID()}`, tool: 'browser_command', args, approvalTokens }, sessionId: 'browsing-agent' })
  }

  const flagOf = (call: string[] | undefined) => call && call.includes('--allowed-domains') ? call[call.indexOf('--allowed-domains') + 1] : null
  const sessionOf = (call: string[] | undefined) => call?.[call.indexOf('--session') + 1]
  const noticeOf = (response: InvokeResponse) => {
    if (response.outcome !== 'ok') throw new Error(`expected ok, got ${response.outcome}`)
    const output = response.output
    return output !== null && typeof output === 'object' && !Array.isArray(output) && typeof output.notice === 'string' ? output.notice : null
  }

  // Phase 2 item 5: one URL list per workspace, the node's BUCKLE_ALLOWED_HOSTS among its entries.
  it('holds the browser to the node\'s BUCKLE_ALLOWED_HOSTS, the workspace\'s list where it has none of its own', async () => {
    const { runtime, calls } = await fixture([], 0, 0, { BUCKLE_ALLOWED_HOSTS: 'app.example.test' })
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test'] })).toMatchObject({ outcome: 'ok' })
    expect(flagOf(calls()[0])).toBe('app.example.test')
    await runtime.closeSessions()
  })

  it('closes the browsers it started when the node shuts down, and forgets their sessions (B19)', async () => {
    const { runtime, calls } = await fixture(['*.example.test'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test'] })).toMatchObject({ outcome: 'ok' })
    const session = sessionOf(calls()[0])

    await runtime.closeSessions()

    expect(calls().at(-1)).toEqual(['close', '--session', session, '--json'])
    // A later call starts a fresh session instead of the one shutdown closed.
    await browse(runtime, { command: 'open', args: ['https://app.example.test'] })
    expect(sessionOf(calls().at(-1))).not.toBe(session)
    await runtime.closeSessions()
    expect(calls().filter(call => call[0] === 'close')).toHaveLength(2)
  })

  it('closes several browsers in parallel under one bound, then forgets them all (review L10 of B18-B19)', async () => {
    const { runtime, calls } = await fixture(['*.example.test'], 1_500)
    for (const agent of ['a', 'b', 'c']) {
      const response = await runtime.invoke({ request: { requestId: `browse-${agent}`, tool: 'browser_command', args: { command: 'open', args: ['https://app.example.test'] }, approvalTokens: [] }, sessionId: `agent-${agent}` })
      expect(response).toMatchObject({ outcome: 'ok' })
    }
    const sessions = new Set(calls().map(sessionOf))
    expect(sessions.size).toBe(3)

    const started = performance.now()
    await runtime.closeSessions()

    // One after another they would take at least 4.5 s.
    expect(performance.now() - started).toBeLessThan(4_000)
    expect(new Set(calls().filter(call => call[0] === 'close').map(sessionOf))).toEqual(sessions)
    await runtime.closeSessions()
    expect(calls().filter(call => call[0] === 'close')).toHaveLength(3)
  })

  it('launches the browser with the approved list as its allowed domains', async () => {
    const { runtime, calls } = await fixture(['*.example.test', 'docs.test'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test'] })).toMatchObject({ outcome: 'ok' })
    expect(flagOf(calls()[0])).toBe('*.example.test,docs.test')
  })

  it('hands the next call of the same browser session the list the owner just changed, and says the browser was reset', async () => {
    const { runtime, calls } = await fixture(['*.example.test', 'docs.test'])
    const warn = vi.spyOn(logger, 'warn')
    try {
      expect(noticeOf(await browse(runtime, { command: 'open', args: ['https://app.example.test'] }))).toBeNull()
      await runtime.policy.apply(policy(['*.example.test']))
      expect(noticeOf(await browse(runtime, { command: 'snapshot', args: [] }))).toBe('The browser was relaunched because the allowed domains changed; open tabs and cookies were reset.')
      expect(noticeOf(await browse(runtime, { command: 'snapshot', args: [] }))).toBeNull()
      // The session's browser was closed before the call that was told so, which ran on a new one under the new list (fix brief 4, finding 9).
      const all = calls()
      const [first, second, third] = all.filter(call => call[0] !== 'close')
      expect(sessionOf(second)).not.toBe(sessionOf(first))
      expect(sessionOf(third)).toBe(sessionOf(second))
      expect(flagOf(second)).toBe('*.example.test')
      expect(all.findIndex(call => call[0] === 'close' && sessionOf(call) === sessionOf(first))).toBeLessThan(all.indexOf(second!))
      expect(warn).toHaveBeenCalledWith('Browser relaunched because its allowed domains changed', { previous: '*.example.test,docs.test', current: '*.example.test' })
    } finally {
      warn.mockRestore()
    }
  }, 20000) // three real agent-browser spawns in sequence; default 5000ms is tight under a loaded gate

  // Fix brief 2, R2: the pack a policy change replaces is retired, not shut down, so the agent's session carries over.
  it('ends the browsers of the pack a policy change replaces, keeps their sessions for the pack that follows, and forgets them at shutdown alone', async () => {
    const { runtime, calls, stored } = await fixture(['*.example.test', 'docs.test'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test'] })).toMatchObject({ outcome: 'ok' })
    const session = sessionOf(calls()[0])

    await runtime.policy.apply(policy(['*.example.test']))

    // Closed as shutdown would close it, with its record left for the pack that follows: the session and its last list.
    expect(calls().at(-1)).toEqual(['close', '--session', session, '--json'])
    expect(Object.values(stored().sessions)).toEqual([session])
    expect(Object.values(stored().allowedDomains)).toEqual(['*.example.test,docs.test'])
    expect(noticeOf(await browse(runtime, { command: 'snapshot', args: [] }))).toBe('The browser was relaunched because the allowed domains changed; open tabs and cookies were reset.')
    // The session's next call closes what ran under the old list, whoever closed it before, and starts a browser under a new name (fix brief 4, finding 9).
    const relaunched = sessionOf(calls().at(-1))
    expect(relaunched).not.toBe(session)
    expect(Object.values(stored().sessions)).toEqual([relaunched])

    await runtime.closeSessions()
    // Two browsers were started for this session, one before the change and one after, and each was closed.
    expect(calls().filter(call => call[0] === 'close')).toEqual([['close', '--session', session, '--json'], ['close', '--session', session, '--json'], ['close', '--session', relaunched, '--json']])
    expect(stored()).toEqual({ sessions: {}, allowedDomains: {}, modes: {}, writers: {} })
  }, 20000)

  // Fix brief 4, finding 9: a host list swapped in while another call ran left the session on the daemon launched with
  // the old list, and the agent was told it had been relaunched.
  it('relaunches a session before its next call when the hosts change while another call runs, so that call runs under the new list', async () => {
    const { runtime, calls, config } = await fixture(['*.example.test', 'docs.test'], 0, 1_500)
    expect(noticeOf(await browse(runtime, { command: 'open', args: ['https://app.example.test'] }))).toBeNull()
    const before = sessionOf(calls()[0])
    // Another agent's call runs on a browser of its own while the hosts change.
    const waiting = runtime.invoke({ request: { requestId: 'wait', tool: 'browser_command', args: { command: 'wait', args: ['1000'] }, approvalTokens: [] }, sessionId: 'other-agent' })
    await vi.waitFor(() => expect(calls().some(call => call[0] === 'wait')).toBe(true))
    const other = sessionOf(calls().find(call => call[0] === 'wait'))
    await openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory!, config.workspaceId) }).update(settings => ({ ...settings, policy: { ...settings.policy, network: { allow: ['*.example.test'] } } }))

    expect(noticeOf(await browse(runtime, { command: 'snapshot', args: [] }))).toBe('The browser was relaunched because the allowed domains changed; open tabs and cookies were reset.')
    const all = calls()
    const snapshot = all.findIndex(call => call[0] === 'snapshot')
    const after = sessionOf(all[snapshot])
    expect(after).not.toBe(before)
    expect(flagOf(all[snapshot])).toBe('*.example.test')
    // The browser launched under the old list was closed before the call that was told so.
    const closedBefore = all.findIndex(call => call[0] === 'close' && sessionOf(call) === before)
    expect(closedBefore).toBeGreaterThan(-1)
    expect(closedBefore).toBeLessThan(snapshot)

    expect(await waiting).toMatchObject({ outcome: 'ok' })
    // The pack the change replaced ends the other agent's browser once its call ends, and never the relaunched one.
    await vi.waitFor(() => expect(calls().some(call => call[0] === 'close' && sessionOf(call) === other)).toBe(true))
    expect(noticeOf(await browse(runtime, { command: 'snapshot', args: [] }))).toBeNull()
    expect(sessionOf(calls().filter(call => call[0] === 'snapshot').at(-1))).toBe(after)
    expect(calls().filter(call => call[0] === 'close' && sessionOf(call) === after)).toEqual([])
    await runtime.closeSessions()
  }, 20000)

  it('keeps the browser and its session through a change to the workspace variables, which rebuilds the other packs alone', async () => {
    const { runtime, calls, config } = await fixture(['*.example.test'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test'] })).toMatchObject({ outcome: 'ok' })
    const session = sessionOf(calls()[0])

    await openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory!, config.workspaceId) }).update(settings => ({ ...settings, env: { GREETING: 'hello' } }))
    await runtime.takeUpSettings()

    expect(config.commandEnvironment).toEqual({ GREETING: 'hello' })
    expect(noticeOf(await browse(runtime, { command: 'snapshot', args: [] }))).toBeNull()
    expect(calls().map(call => call[0])).toEqual(['open', 'snapshot'])
    expect(sessionOf(calls()[1])).toBe(session)
    await runtime.closeSessions()
    expect(calls().filter(call => call[0] === 'close')).toHaveLength(1)
  })

  // Recheck of the workspace-model fix round 1 (the browser pack): what the browser is handed decides whether its pack is replaced, not the stored list it comes from.
  it.each([
    ['the same hosts in another order', ['*.example.test', 'docs.test'], ['docs.test', '*.example.test']],
    ['a host listed twice', ['*.example.test', 'docs.test'], ['*.example.test', 'docs.test', 'docs.test']],
    ['another path on a host already allowed', ['https://app.example.test/admin'], ['https://app.example.test/admin', 'https://app.example.test/billing']],
    ['a port on a host already allowed', ['app.example.test'], ['app.example.test', 'app.example.test:8443']],
  ])('keeps the browser, its session, and its tabs through an approved list change to %s, with no close and no notice', async (_change, before, after) => {
    const { runtime, calls } = await fixture(before)
    const warn = vi.spyOn(logger, 'warn')
    try {
      expect(noticeOf(await browse(runtime, { command: 'open', args: ['https://app.example.test/admin'] }))).toBeNull()
      const session = sessionOf(calls()[0])
      await runtime.policy.apply(policy(after))

      expect(noticeOf(await browse(runtime, { command: 'snapshot', args: [] }))).toBeNull()
      expect(calls().map(call => call[0])).toEqual(['open', 'snapshot'])
      expect(sessionOf(calls()[1])).toBe(session)
      expect(warn.mock.calls.some(([message]) => String(message).startsWith('Browser relaunched'))).toBe(false)
      await runtime.closeSessions()
      expect(calls().filter(call => call[0] === 'close')).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  }, 20000)

  it('keeps the browser through a hand edit of the stored browser block, which no pack reads yet', async () => {
    const { runtime, calls, config } = await fixture(['*.example.test'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test'] })).toMatchObject({ outcome: 'ok' })

    await openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory!, config.workspaceId) }).update(settings => ({ ...settings, browser: { ...settings.browser, idleTimeoutMs: 120_000 } }))
    await runtime.takeUpSettings()

    expect(noticeOf(await browse(runtime, { command: 'snapshot', args: [] }))).toBeNull()
    expect(calls().map(call => call[0])).toEqual(['open', 'snapshot'])
    await runtime.closeSessions()
  }, 20000)

  it('leaves the flag off when a grant is added mid-session, since grants only answer questions a list never asks', async () => {
    const { runtime, calls } = await fixture([])
    const asked = await browse(runtime, { command: 'open', args: ['http://localhost:4173'] })
    if (asked.outcome !== 'approval_required') throw new Error(`expected an approval, got ${asked.outcome}`)
    expect((await runtime.approvals.resolve({ token: asked.approvals[0]!.token, approved: true, scope: 'always' })).ok).toBe(true)
    expect(await browse(runtime, { command: 'open', args: ['http://localhost:4173'] })).toMatchObject({ outcome: 'ok' })
    expect(await browse(runtime, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'ok' })
    expect(calls().map(flagOf)).toEqual([null, null])
  })

  it('starts the browser on the host part of a port or URL prefix entry, logging what it loosened at that call, not at build', async () => {
    const info = vi.spyOn(logger, 'info')
    const loosenedLogs = () => info.mock.calls.filter(([message]) => message.startsWith('The browser is held to these approved hosts'))
    try {
      const { runtime, calls } = await fixture(['https://app.example.test/admin', 'localhost:3000'])
      expect(loosenedLogs()).toEqual([])
      expect(await browse(runtime, { command: 'open', args: ['https://app.example.test/admin/users'] })).toMatchObject({ outcome: 'ok' })
      expect(flagOf(calls()[0])).toBe('app.example.test,localhost')
      expect(loosenedLogs().map(([, context]) => context)).toEqual([{ loosened: 'https://app.example.test/admin (workspace list) as app.example.test, localhost:3000 (workspace list) as localhost' }])
    } finally {
      info.mockRestore()
    }
  })

  it('still judges the page a command names by the path of a URL prefix entry', async () => {
    const { runtime, calls } = await fixture(['https://app.example.test/admin', 'localhost:3000'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test/admin/users'] })).toMatchObject({ outcome: 'ok' })
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test/billing'] })).toMatchObject({ outcome: 'error' })
    expect(calls()).toHaveLength(1)
  })

  it('refuses an allowed-domains list the agent chose, since Buckle sets it', async () => {
    const { runtime, calls } = await fixture(['*.example.test'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test', '--allowed-domains', 'evil.test'] })).toMatchObject({
      outcome: 'error',
      error: { message: expect.stringContaining('--allowed-domains is not allowed: Buckle owns the network policy') },
    })
    expect(calls()).toEqual([])
  })
})
