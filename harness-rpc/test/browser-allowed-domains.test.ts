import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { emptyWorkspacePolicy, type WorkspacePolicy } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeferredApprovalChannel } from '../src/adapters/approval/deferred-approval-channel.js'
import { loadConfig } from '../src/config.js'
import { browserAllowedDomains } from '../src/packs/browser/allowed-domains.js'
import { createRuntime, type BuckleRuntime } from '../src/runtime.js'

describe('the approved list, read as agent-browser allowed domains', () => {
  it('passes no flag when no approved list is set, since every public host is then allowed', () => {
    expect(browserAllowedDomains([])).toEqual({ value: null })
  })

  it('passes a host and a wildcard as written, the wildcard covering the apex as BUCKLE-D18 says', () => {
    expect(browserAllowedDomains([['Example.com', '*.docs.test', 'my_db']])).toEqual({ value: 'example.com,*.docs.test,my_db' })
  })

  it('keeps only what both the node and the workspace list allow', () => {
    expect(browserAllowedDomains([['*.example.com', 'other.test'], ['api.example.com', '*.example.com', 'else.test']]))
      .toEqual({ value: 'api.example.com,*.example.com' })
    expect(browserAllowedDomains([['example.com'], ['*.example.com']])).toEqual({ value: 'example.com' })
    expect(browserAllowedDomains([['*.a.example.com'], ['*.example.com']])).toEqual({ value: '*.a.example.com' })
    expect(browserAllowedDomains([['example.com'], ['*.sub.example.com']])).toMatchObject({ refusal: expect.stringContaining('covers no host') })
  })

  it.each([
    ['localhost:3000', 'names port 3000'],
    ['*.example.com:8443', 'names port 8443'],
    ['127.0.0.1', 'is an address'],
    ['[::1]', 'is an address'],
    ['https://app.example.com', 'is a URL prefix with a scheme and path'],
    ['https://app.example.com/admin', 'is a URL prefix with a scheme and path'],
  ])('refuses %s by name rather than widening or narrowing it', (entry, why) => {
    expect(browserAllowedDomains([['example.com', entry]])).toEqual({
      refusal: `Buckle does not start the browser: approved list entry ${entry} ${why}, which agent-browser --allowed-domains cannot express`,
    })
  })

  it('refuses a list that approves nothing, since an empty flag would allow every host', () => {
    expect(browserAllowedDomains([[]])).toMatchObject({ refusal: expect.stringContaining('an empty --allowed-domains would allow every host') })
  })
})

describe('the allowed domains a real runtime hands a fake agent-browser', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  async function fixture(network: string[]) {
    const root = mkdtempSync(join(tmpdir(), 'buckle-allowed-domains-'))
    roots.push(root)
    mkdirSync(join(root, 'workspace'))
    const log = join(root, 'calls.jsonl')
    const binary = join(root, 'agent-browser')
    writeFileSync(binary, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')\nprocess.stdout.write('{"success":true}')\n`)
    chmodSync(binary, 0o755)
    const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'browser', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_AGENT_BROWSER_COMMAND: binary })
    const runtime = await createRuntime({ config, channel: () => createDeferredApprovalChannel() })
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

  it('launches the browser with the approved list as its allowed domains', async () => {
    const { runtime, calls } = await fixture(['*.example.test', 'docs.test'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test'] })).toMatchObject({ outcome: 'ok' })
    expect(flagOf(calls()[0])).toBe('*.example.test,docs.test')
  })

  it('hands the next call of the same browser session the list the owner just changed', async () => {
    const { runtime, calls } = await fixture(['*.example.test', 'docs.test'])
    await browse(runtime, { command: 'open', args: ['https://app.example.test'] })
    await runtime.policy.apply(policy(['*.example.test']))
    expect(await browse(runtime, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'ok' })
    const [first, second] = calls()
    expect(sessionOf(second)).toBe(sessionOf(first))
    expect(flagOf(second)).toBe('*.example.test')
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

  it('refuses to start the browser for an entry it cannot express, naming it, before anything runs', async () => {
    const { runtime, calls } = await fixture(['*.example.test', 'localhost:3000'])
    expect(await browse(runtime, { command: 'open', args: ['https://app.example.test'] })).toMatchObject({
      outcome: 'error',
      error: { message: 'Buckle does not start the browser: approved list entry localhost:3000 names port 3000, which agent-browser --allowed-domains cannot express' },
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
