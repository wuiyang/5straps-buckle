import type { JsonObject } from '@5straps/protocol'
import { describe, expect, it } from 'vitest'
import { browserEffects, refusedFlag } from '../src/packs/browser/effects.js'
import { createPathView } from '../src/domain/path-view.js'
import { createBrowserPack, type BrowserPackOptions } from '../src/packs/browser/index.js'
import { resolveBrowserProfile, workspaceProfileKey } from '../src/packs/browser/profile.js'
import type { ProcessRequest, ProcessResult } from '../src/ports/process-runner.js'

const PROFILE = '/state/browser-profiles/work'

function stubResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { exitCode: 0, signal: null, stdout: '{"success":true}', stderr: '', truncated: false, timedOut: false, ...overrides }
}

async function run(input: JsonObject, options: Partial<BrowserPackOptions> = {}, result = stubResult()) {
  const calls: ProcessRequest[] = []
  const pack = createBrowserPack({
    cwd: '/work',
    paths: createPathView({ root: '/work', mount: null }),
    agentBrowserCommand: 'agent-browser',
    profileDirectory: PROFILE,
    headed: false,
    available: true,
    runProcess: async request => {
      calls.push(request)
      return result
    },
    ...options,
  })

  const tool = pack.tools[0]
  if (!tool) throw new Error('the browser pack registered no tool')
  const output = await tool.prepare(input).execute({
    requestId: 'r1',
    sessionId: 's1',
    timeoutMs: 1000,
    signal: new AbortController().signal,
  })
  return { args: calls[0]?.args ?? [], output }
}

describe('the arguments the browser pack builds', () => {
  it('puts the subcommand first and its positionals next, which is the order agent-browser wants', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] })
    expect(args.slice(0, 2)).toEqual(['open', 'https://example.com'])
  })

  it('always asks for JSON, so output can be parsed rather than scraped', async () => {
    const { args } = await run({ command: 'snapshot', args: ['-i'] })
    expect(args).toContain('--json')
  })

  it('runs headless by default, because a node usually has no display', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] })
    expect(args).not.toContain('--headed')
  })

  it('shows a window when the operator configured one', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] }, { headed: true })
    expect(args).toContain('--headed')
  })

  it('lets a per-call flag override the configured default, rather than passing it twice', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com', '--headed', 'false'] }, { headed: true })
    expect(args.filter(argument => argument === '--headed')).toHaveLength(1)
    expect(args).toEqual(['open', 'https://example.com', '--headed', 'false', '--json', '--profile', PROFILE])
  })

  it('passes a session through as a flag, keeping browser state isolated per caller', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'], session: 'tester' })
    expect(args.slice(-2)).toEqual(['--session', 'tester'])
  })
})

describe('how the browser pack reports trouble', () => {
  it('surfaces an error written to stdout, which is where agent-browser puts it', async () => {
    await expect(run({ command: 'open', args: ['x'] }, {}, stubResult({ exitCode: 1, stdout: 'chrome is not installed' })))
      .rejects.toThrow('agent-browser failed (exit 1): chrome is not installed')
  })

  it('names the exit code even when the command said nothing at all', async () => {
    await expect(run({ command: 'doctor', args: [] }, {}, stubResult({ exitCode: 2, stdout: '' })))
      .rejects.toThrow('agent-browser failed (exit 2) with no output')
  })

  it('reports why the pack is missing rather than pretending it is installed', () => {
    const pack = createBrowserPack({
      cwd: '/work',
      paths: createPathView({ root: '/work', mount: null }),
      agentBrowserCommand: 'agent-browser',
      profileDirectory: PROFILE,
      headed: false,
      available: false,
      runProcess: async () => stubResult(),
    })
    expect(pack.unavailableReason).toBe('agent-browser is not installed on this node')
  })
})

describe('what the browser pack declares it will touch', () => {
  function effectsFor(command: string, args: string[]) {
    return browserEffects(command, args)
  }

  it('declares navigation as a network effect, so the egress rule judges the URL', () => {
    expect(effectsFor('open', ['https://example.com']))
      .toEqual([{ kind: 'network', url: 'https://example.com' }])
  })

  it('declares a file URL too, which is what puts it in front of the rule that refuses it', () => {
    expect(effectsFor('open', ['file:///etc/shadow']))
      .toEqual([{ kind: 'network', url: 'file:///etc/shadow' }])
  })

  it('does not mistake a Windows drive letter for a URL scheme', () => {
    expect(effectsFor('open', ['C:/Users/someone/page.html'])).toEqual([])
  })

  it('declares a screenshot destination as a write, so it cannot land outside the sandbox', () => {
    expect(effectsFor('screenshot', ['out/page.png']))
      .toEqual([{ kind: 'write_path', path: 'out/page.png' }])
  })

  it('declares nothing for a screenshot that only carries flags', () => {
    expect(effectsFor('screenshot', ['--full'])).toEqual([])
  })

  it('declares uploaded files as reads, since upload sends local files to a remote page', () => {
    expect(effectsFor('upload', ['@e3', 'a.pdf', 'b.pdf'])).toEqual([
      { kind: 'read_path', path: 'a.pdf' },
      { kind: 'read_path', path: 'b.pdf' },
    ])
  })

  it('declares a download destination as a write, skipping the selector', () => {
    expect(effectsFor('download', ['@e1', 'out/report.csv']))
      .toEqual([{ kind: 'write_path', path: 'out/report.csv' }])
  })
})

describe('flags the browser pack refuses outright', () => {
  it('refuses the flag that lets an open page read local files', () => {
    expect(refusedFlag(['--allow-file-access'])).toBe('--allow-file-access')
  })

  it('refuses the flag that would launch an arbitrary binary as the browser', () => {
    expect(refusedFlag(['--executable-path', '/bin/sh'])).toBe('--executable-path')
  })

  it('catches the equals form as well as the separated form', () => {
    expect(refusedFlag(['--executable-path=/bin/sh'])).toBe('--executable-path')
  })

  it('refuses a flag it simply does not know, naming it', () => {
    expect(refusedFlag(['--user-data-dir=/tmp/x'])).toBe('--user-data-dir')
  })

  it('refuses the flag that would hand the browser the owner\'s own profile', () => {
    expect(refusedFlag(['--profile', 'Default'])).toBe('--profile')
  })

  it('refuses a write flag that would land output where the path rules never look', () => {
    expect(refusedFlag(['--screenshot-dir', '/home/someone'])).toBe('--screenshot-dir')
  })

  it('leaves ordinary arguments alone', () => {
    expect(refusedFlag(['https://example.com', '--headed'])).toBeNull()
  })

  it('admits the flags agent-browser documents and Buckle can judge', () => {
    expect(refusedFlag(['-i'])).toBeNull()
    expect(refusedFlag(['--full', '--annotate'])).toBeNull()
    expect(refusedFlag(['--timeout=5s'])).toBeNull()
  })

  it('does not mistake a negative number for a flag', () => {
    expect(refusedFlag(['down', '-100'])).toBeNull()
  })

  it('refuses the call rather than running it', async () => {
    await expect(run({ command: 'open', args: ['https://x.com', '--allow-file-access'] }))
      .rejects.toThrow('--allow-file-access is not allowed')
  })
})

describe('the profile the browser is given', () => {
  it('passes Buckle\'s own profile on every call, whatever the command', async () => {
    const { args } = await run({ command: 'open', args: ['https://example.com'] })
    expect(args).toContain('--profile')
    expect(args[args.indexOf('--profile') + 1]).toBe(PROFILE)
  })

  it('keeps one profile per workspace, so two workspaces never share a login', () => {
    const one = resolveBrowserProfile({ stateDirectory: '/state', workspaceRoot: '/work/one', environment: {} })
    const two = resolveBrowserProfile({ stateDirectory: '/state', workspaceRoot: '/work/two', environment: {} })
    expect(one).not.toBe(two)
    expect(one.startsWith('/state/browser-profiles/one-')).toBe(true)
  })

  it('names the same workspace the same way every start', () => {
    expect(workspaceProfileKey('/work/one')).toBe(workspaceProfileKey('/work/one/'))
  })

  it('lets the owner point at a directory of their own', () => {
    const profile = resolveBrowserProfile({
      stateDirectory: '/state',
      workspaceRoot: '/work/one',
      environment: { BUCKLE_BROWSER_PROFILE: '/browsers/shared' },
    })
    expect(profile).toBe('/browsers/shared')
  })
})

describe('the environment the browser is spawned with', () => {
  async function environmentFor(overrides: Record<string, string>) {
    const saved = { ...process.env }
    Object.assign(process.env, overrides)
    try {
      const calls: ProcessRequest[] = []
      const pack = createBrowserPack({
        cwd: '/work',
        paths: createPathView({ root: '/work', mount: null }),
        agentBrowserCommand: 'agent-browser',
        profileDirectory: PROFILE,
        headed: false,
        available: true,
        runProcess: async request => {
          calls.push(request)
          return stubResult()
        },
      })
      const tool = pack.tools[0]
      if (!tool) throw new Error('the browser pack registered no tool')
      await tool.prepare({ command: 'session', args: [] }).execute({
        requestId: 'r1',
        sessionId: 's1',
        timeoutMs: 1000,
        signal: new AbortController().signal,
      })
      return calls[0]?.environment ?? {}
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  }

  it('forwards agent-browser settings, which the allowlist would otherwise strip', async () => {
    const environment = await environmentFor({ AGENT_BROWSER_SCREENSHOT_DIR: 'C:/shots' })
    expect(environment.AGENT_BROWSER_SCREENSHOT_DIR).toBe('C:/shots')
  })

  it('still withholds Buckle\'s own token from the browser', async () => {
    const environment = await environmentFor({ BUCKLE_AUTH_TOKEN: 'super-secret' })
    expect(environment.BUCKLE_AUTH_TOKEN).toBeUndefined()
  })

  it('forwards nothing that merely mentions the tool without the prefix', async () => {
    const environment = await environmentFor({ MY_AGENT_BROWSER_HACK: 'no', AI_GATEWAY_API_KEY: 'sk-live' })
    expect(environment.MY_AGENT_BROWSER_HACK).toBeUndefined()
    expect(environment.AI_GATEWAY_API_KEY).toBeUndefined()
  })

  it('withholds the one setting that would replace the profile Buckle owns', async () => {
    const environment = await environmentFor({ AGENT_BROWSER_PROFILE: '/home/someone/.config/chrome' })
    expect(environment.AGENT_BROWSER_PROFILE).toBeUndefined()
  })

  it('keeps passing the variables a child genuinely needs', async () => {
    const environment = await environmentFor({})
    expect(environment.PATH).toBeDefined()
  })
})
