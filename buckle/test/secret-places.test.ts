import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLACES_REASON, PLATFORM_REASON } from '../common/domain/secret-reference.js'
import { MAX_REFERENCES, MAX_SECRET_FILES, planSecrets, SECRETS_OFF_REASON } from '../common/services/secrets/places.js'
import { resolveSettings, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { SETTING_KEYS } from '../cli/workspace-keys.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'

// The secret-references slice, part 2 (docs/user/how-to/secrets.md): references are read in three places only, shell words,
// browser fill values, and web_fetch header values; a reference anywhere else refuses the call before it is judged.

const REF = '{{file:.env.local:API_TOKEN}}'
const plan = (tool: string, pack: string, args: JsonObject, enabled = true) => planSecrets({ tool, pack, args, enabled })
const refusalOf = (outcome: ReturnType<typeof planSecrets>): string => {
  if (!('refusal' in outcome)) throw new Error('expected a refusal')
  return outcome.refusal
}
const placesOf = (outcome: ReturnType<typeof planSecrets>) => {
  if ('refusal' in outcome) throw new Error(outcome.refusal)
  return outcome.plan?.places.map(place => ({ at: place.at, kind: place.kind, names: place.references.map(reference => reference.name) })) ?? []
}

describe('the three places', () => {
  it('reads a reference in a shell_exec argument as an argv word', () => {
    expect(placesOf(plan('shell_exec', 'shell', { command: 'curl', args: ['-H', `Authorization: Bearer ${REF}`, 'https://api.example.test'] }))).toEqual([{ at: ['args', 1], kind: 'argv', names: ['API_TOKEN'] }])
  })

  it('reads a reference in a bash script_run body as shell text', () => {
    expect(placesOf(plan('script_run', 'shell', { runtime: 'bash', script: `curl -H "X-Key: ${REF}" https://api.example.test` }))).toEqual([{ at: ['script'], kind: 'shell', names: ['API_TOKEN'] }])
  })

  it('reads a reference in the text a browser fill or type enters', () => {
    expect(placesOf(plan('browser_command', 'browser', { command: 'fill', args: ['@e5', REF] }))).toEqual([{ at: ['args', 1], kind: 'fill', names: ['API_TOKEN'] }])
    expect(placesOf(plan('browser_command', 'browser', { command: 'type', args: ['--timeout', '500', '#password', REF] }))).toEqual([{ at: ['args', 3], kind: 'fill', names: ['API_TOKEN'] }])
  })

  it('reads a reference in a web_fetch header value', () => {
    expect(placesOf(plan('web_fetch', 'web', { url: 'https://api.example.test', headers: { Authorization: `Bearer ${REF}` } }))).toEqual([{ at: ['headers', 'Authorization'], kind: 'header', names: ['API_TOKEN'] }])
  })

  it('lists each file once with the NAMEs read from it, in the order met', () => {
    const outcome = plan('shell_exec', 'shell', { command: 'tool', args: [REF, '{{file:keys.env:B}}', '{{file:.env.local:C}}', REF] })
    if ('refusal' in outcome) throw new Error(outcome.refusal)
    expect([...outcome.plan!.files]).toEqual([['.env.local', ['API_TOKEN', 'C']], ['keys.env', ['B']]])
  })

  // The owner's report of 2026-11-01: a script passes a reference on to the calls it makes, each planned as it is made.
  it('reads nothing in a code_run script, which hands each reference to the call it makes, and refuses none there', () => {
    expect(plan('code_run', 'code', { script: `await tools.browser_command({ command: 'fill', args: ['#password', '${REF}'] })` })).toEqual({ plan: null })
    expect(plan('code_run', 'code', { script: `await tools.fs_write({ path: 'a', content: '${REF} {{env:API_KEY}} {{file:../up.env:A}}' })`, timeoutMs: 1_000 })).toEqual({ plan: null })
    expect(plan('code_run', 'code', { script: `return '${REF}'` }, false)).toEqual({ plan: null })
  })

  it('holds no plan for a call with no reference', () => {
    expect(plan('shell_exec', 'shell', { command: 'echo', args: ['{{ not a reference }}', 'plain'] })).toEqual({ plan: null })
  })
})

describe('anywhere else', () => {
  it.each([
    ['the program shell_exec runs', 'shell_exec', 'shell', { command: REF, args: [] }, 'command'],
    ['a shell_exec variable', 'shell_exec', 'shell', { command: 'curl', args: [], env: { TOKEN: REF } }, 'env.TOKEN'],
    ['a shell_exec working directory', 'shell_exec', 'shell', { command: 'ls', args: [], cwd: REF }, 'cwd'],
    ['a node script_run body', 'script_run', 'shell', { runtime: 'node', script: `fetch(url, { headers: { a: '${REF}' } })` }, 'script'],
    ['a python script_run body', 'script_run', 'shell', { runtime: 'python', script: `print("${REF}")` }, 'script'],
    ['a file write', 'fs_write', 'fs', { path: 'notes.txt', content: `token=${REF}` }, 'content'],
    ['a fetched URL', 'web_fetch', 'web', { url: `https://api.example.test/?key=${REF}` }, 'url'],
    ['a fetched body', 'web_fetch', 'web', { url: 'https://api.example.test', method: 'POST', body: `{"key":"${REF}"}` }, 'body'],
    ['a browser selector', 'browser_command', 'browser', { command: 'fill', args: [REF, 'text'] }, 'args[0]'],
    ['a page the browser opens', 'browser_command', 'browser', { command: 'open', args: [`https://example.test/${REF}`] }, 'args[0]'],
    ['a plugin tool under a built-in name', 'shell_exec', 'plugin-pack', { command: 'curl', args: [REF] }, 'args[0]'],
    ['a plugin tool under the code_run name', 'code_run', 'plugin-pack', { script: `await tools.shell_exec({ command: 'curl', args: ['${REF}'] })` }, 'script'],
  ])('refuses a reference in %s', (_what, tool, pack, args, where) => {
    const refusal = refusalOf(plan(tool, pack, args as JsonObject))
    expect(refusal.startsWith(PLACES_REASON)).toBe(true)
    expect(refusal).toContain(`this one is in ${where}`)
  })

  it('refuses a reference in a header name, as the key it is', () => {
    expect(refusalOf(plan('web_fetch', 'web', { url: 'https://api.example.test', headers: { [REF]: 'x' } }))).toBe(`${PLACES_REASON}; this one is in a key of headers`)
  })

  it('refuses a bare env reference and a platform reference outside the places too', () => {
    expect(refusalOf(plan('fs_write', 'fs', { path: 'a', content: '{{env:API_KEY}}' })).startsWith(PLACES_REASON)).toBe(true)
    expect(refusalOf(plan('fs_write', 'fs', { path: 'a', content: '{{env:rings:API_KEY}}' })).startsWith(PLACES_REASON)).toBe(true)
  })

  it('takes template braces outside the places as text', () => {
    expect(plan('fs_write', 'fs', { path: 'a.vue', content: '<p>{{ item.name }}</p><div :style="{ color: x }">{{name}}</div>' })).toEqual({ plan: null })
  })
})

describe('inside a place, a form outside the grammar', () => {
  it('refuses a platform reference, naming the reason', () => {
    expect(refusalOf(plan('shell_exec', 'shell', { command: 'curl', args: ['{{env:rings:ADMIN}}'] })).startsWith(PLATFORM_REASON)).toBe(true)
  })

  it.each(['{{env:TOKEN}}', '{{vault:a:B}}', '{{file:../up.env:A}}', '{{ file:.env:A }}', '{{color:red}}'])('refuses %s', (text) => {
    expect('refusal' in plan('web_fetch', 'web', { url: 'https://x.test', headers: { 'X-Key': text } })).toBe(true)
  })
})

describe('bounds and the switch', () => {
  it(`refuses more than ${MAX_REFERENCES} references and more than ${MAX_SECRET_FILES} files`, () => {
    expect(refusalOf(plan('shell_exec', 'shell', { command: 'x', args: Array.from({ length: MAX_REFERENCES + 1 }, () => REF) }))).toContain(`at most ${MAX_REFERENCES}`)
    expect(refusalOf(plan('shell_exec', 'shell', { command: 'x', args: Array.from({ length: MAX_SECRET_FILES + 1 }, (_, index) => `{{file:f${index}.env:A}}`) }))).toContain(`at most ${MAX_SECRET_FILES} files`)
  })

  it('refuses a reference in a place while references are off, and reads no text elsewhere', () => {
    expect(refusalOf(plan('shell_exec', 'shell', { command: 'curl', args: [REF] }, false))).toBe(SECRETS_OFF_REASON)
    expect(plan('fs_write', 'fs', { path: 'a', content: REF }, false)).toEqual({ plan: null })
  })

  it('is on by default, and secrets.enabled turns it off and unsets', () => {
    const stored = WorkspaceSettingsSchema.parse({ version: 1 })
    const node = configFromEnvironment({}).workspaceDefaults
    expect(resolveSettings(stored, node).secrets).toMatchObject({ enabled: true })
    expect(resolveSettings(stored, node).sources['secrets.enabled']).toBe('built-in')
    const key = SETTING_KEYS.find(item => item.key === 'secrets.enabled')!
    const off = key.set(stored, 'off')
    expect(resolveSettings(WorkspaceSettingsSchema.parse(off), node).secrets).toMatchObject({ enabled: false })
    expect(resolveSettings(WorkspaceSettingsSchema.parse(off), node).sources['secrets.enabled']).toBe('workspace')
    expect(WorkspaceSettingsSchema.parse(key.unset(off)).secrets).toBeUndefined()
    expect(() => key.set(stored, 'sometimes')).toThrow('secrets.enabled is on or off')
  })
})

describe('through the invoker', () => {
  const roots: string[] = []
  const runtimes: CoreRuntime[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
    await settleAuditLogs()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  async function node(): Promise<{ runtime: CoreRuntime; ran: JsonObject[] }> {
    const root = mkdtempSync(join(tmpdir(), 'buckle-secret-places-'))
    roots.push(root)
    mkdirSync(join(root, 'workspace'))
    const config = configFromEnvironment({
      BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true',
      BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
    })
    const runtime = await createRuntime({ config })
    runtimes.push(runtime)
    const ran: JsonObject[] = []
    for (const name of ['shell_exec', 'fs_write']) {
      const tool = runtime.registry().get(name)
      const prepare = tool.prepare.bind(tool)
      vi.spyOn(tool, 'prepare').mockImplementation((args) => ({ ...prepare(args), execute: async () => { ran.push(args); return 'ran' } }))
    }
    return { runtime, ran }
  }

  let sequence = 0
  const call = (runtime: CoreRuntime, tool: string, args: JsonObject): Promise<InvokeResponse> => {
    sequence += 1
    return runtime.invoke({ sessionId: 'chat-1', request: { requestId: `secret-places-${sequence}`, tool, args, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
  }

  it('refuses a reference in a variable or a file write before it is judged, runs nothing, and audits the refusal', async () => {
    const { runtime, ran } = await node()
    const calls: Array<[string, JsonObject]> = [['shell_exec', { command: 'curl', args: [], env: { TOKEN: REF } }], ['fs_write', { path: 'notes.txt', content: REF }]]
    for (const [tool, args] of calls) {
      const response = await call(runtime, tool, args)
      expect(response).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', retryable: false } })
      if (response.outcome !== 'error') throw new Error('expected a refusal')
      expect(response.error.message.startsWith(PLACES_REASON)).toBe(true)
    }
    expect(ran).toEqual([])
    expect((await auditEntries(runtime.actions, 10)).filter(entry => entry.event === 'result').map(entry => entry.outcome)).toEqual(['denied', 'denied'])
    expect(runtime.approvals.pending().length).toBe(0)
  })

  it('refuses a platform reference in a shell argument before anyone is asked', async () => {
    const { runtime, ran } = await node()
    const response = await call(runtime, 'shell_exec', { command: 'curl', args: ['{{env:rings:ADMIN}}'] })
    expect(response).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining(PLATFORM_REASON) } })
    expect(ran).toEqual([])
  })
})
