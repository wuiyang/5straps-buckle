import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../src/config.js'
import { logger } from '../src/logger.js'
import { browserAllowedDomains, type ApprovedList } from '../src/packs/browser/allowed-domains.js'
import { createRuntime, type BuckleRuntime } from '../src/runtime.js'

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

  async function fixture(network: string[], ceiling?: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'buckle-allowed-domains-'))
    roots.push(root)
    mkdirSync(join(root, 'workspace'))
    const log = join(root, 'calls.jsonl')
    const binary = join(root, 'agent-browser')
    writeFileSync(binary, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\nprocess.stdout.write('{"success":true}')\n`)
    chmodSync(binary, 0o755)
    const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'browser', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_AGENT_BROWSER_COMMAND: binary })
    const runtime = await createRuntime({ config: ceiling ? { ...config, nodePolicy: policy(ceiling) } : config, channel: () => createDeferredApprovalChannel() })
    if (network.length) await runtime.policy.apply(policy(network))
    const calls = (): string[][] => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []
    return { runtime, calls }
  }

  function policy(network: string[]): WorkspacePolicy {
    const value = emptyWorkspacePolicy()
    value.network.allow = network
    return value
  }

  function browse(runtime: BuckleRuntime, args: JsonObject, approvalTokens: string[] = []): Promise<InvokeResponse> {
    return runtime.invoke({ request: { requestId: 'browse', tool: 'browser_command', args, approvalTokens }, sessionId: 'browsing-agent' })
  }

  const flagOf = (call: string[] | undefined) => call && call.includes('--allowed-domains') ? call[call.indexOf('--allowed-domains') + 1] : null
  const sessionOf = (call: string[] | undefined) => call?.[call.indexOf('--session') + 1]
  const noticeOf = (response: InvokeResponse) => {
    if (response.outcome !== 'ok') throw new Error(`expected ok, got ${response.outcome}`)
    const output = response.output
    return output !== null && typeof output === 'object' && !Array.isArray(output) && typeof output.notice === 'string' ? output.notice : null
  }

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
      const [first, second] = calls()
      expect(sessionOf(second)).toBe(sessionOf(first))
      expect(flagOf(second)).toBe('*.example.test')
      expect(warn).toHaveBeenCalledWith('Browser relaunched because its allowed domains changed', { previous: '*.example.test,docs.test', current: '*.example.test' })
    } finally {
      warn.mockRestore()
    }
  })

  it('leaves the flag off when a grant is added mid-session, since grants only answer questions a list never asks', async () => {
    const { runtime, calls } = await fixture([])
    const asked = await browse(runtime, { command: 'open', args: ['http://localhost:4173'] })
    if (asked.outcome !== 'approval_required') throw new Error(`expected an approval, got ${asked.outcome}`)
    expect(runtime.approvals.resolve({ token: asked.approvals[0]!.token, approved: true, scope: 'always' }).ok).toBe(true)
    expect(await browse(runtime, { command: 'open', args: ['http://localhost:4173'] })).toMatchObject({ outcome: 'ok' })
    expect(await browse(runtime, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'ok' })
    expect(calls().map(flagOf)).toEqual([null, null])
  })

  it('starts the browser on the host part of a port or URL prefix entry, and Buckle still judges the page by its path', async () => {
    const { runtime, calls } = await fixture(['https://app.example.test/admin', 'localhost:3000'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test/admin/users'] })).toMatchObject({ outcome: 'ok' })
    expect(flagOf(calls()[0])).toBe('app.example.test,localhost')
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test/billing'] })).toMatchObject({ outcome: 'error' })
    expect(calls()).toHaveLength(1)
  })

  it('intersects the node ceiling with the workspace list, port by port, before dropping the ports', async () => {
    const { runtime, calls } = await fixture(['app.example.test', 'localhost:4000'], ['*.example.test:443', 'localhost:4000'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test'] })).toMatchObject({ outcome: 'ok' })
    expect(flagOf(calls()[0])).toBe('app.example.test,localhost')
  })

  it('does not start the browser when the node and workspace lists approve the same host only on different ports', async () => {
    const { runtime, calls } = await fixture(['localhost:4000'], ['localhost:3000'])
    expect(await browse(runtime, { command: 'open', args: ['http://localhost:3000'] })).toMatchObject({
      outcome: 'error',
      error: { message: expect.stringContaining('no entry in the workspace approved list (localhost:4000) is allowed by the node approved list (localhost:3000) on the same host and port') },
    })
    expect(calls()).toEqual([])
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
