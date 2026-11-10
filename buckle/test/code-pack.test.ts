import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, WorkspacePolicySchema, type InvokeResponse, type JsonObject, type JsonValue, type ToolCapability } from '@5straps/protocol'
import { createPiCodemodeVm } from '../common/adapters/script-vm/pi-codemode.js'
import type { NestedCall, ToolContext } from '../common/domain/tool.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { logger } from '../common/runtime/log.js'
import { CODE_CALL_LIMIT, CODE_VM_BUSY, createCodePack, ERROR_CHARS, MAX_IN_FLIGHT, MAX_NESTED_CALLS, OUTPUT_CHARS, REQUEST_TOO_LARGE, SANDBOX_FAILED } from '../common/services/packs/code/index.js'
import type { ScriptVm, ScriptVmResult } from '../common/types/ports/script-vm.js'
import { createSetupViews } from '../common/services/setup/setup-views.js'
import { byName, registerWorkspace, workspacesOf } from './support/workspaces.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'

// Code mode (owner decision D82): a script's calls are the workspace's own calls, judged, refused, and audited as
// direct ones, and the script is held to its limits on calls, output, and time.

const roots: string[] = []
afterEach(async () => { await settleAuditLogs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function node(environment: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-code-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  for (const directory of ['workspace', 'workspace/docs', 'workspace/secret']) mkdirSync(join(root, directory))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  for (const name of ['alpha', 'beta', 'gamma']) writeFileSync(join(workspace, 'docs', `${name}.md`), `# ${name} title\n${'filler line\n'.repeat(2_000)}`)
  writeFileSync(join(workspace, 'secret', 'key.txt'), 'never shown')
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,code', ...environment })
  return { root, workspace, config, runtime: await createRuntime({ config, interaction: fixedInteraction() }) }
}

type Ran = { ok: boolean; value?: JsonValue; output: string; calls: Array<{ id: number; tool: string; status: string }>; callsOmitted?: number; truncated: boolean; error?: { kind: string; name?: string; message: string; stack?: string } }

let sequence = 0
async function run(runtime: CoreRuntime, script: string, input: { timeoutMs?: number; stageId?: string } = {}): Promise<InvokeResponse> {
  return runtime.invoke({
    sessionId: 'chat-1', approvalWait: { mode: 'none' },
    request: { requestId: `outer-${++sequence}`, tool: 'code_run', args: { script, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) }, approvalTokens: [], ...(input.stageId ? { context: { stageId: input.stageId } } : {}) },
  })
}

function ran(response: InvokeResponse): Ran {
  if (response.outcome !== 'ok') throw new Error(`code_run answered ${JSON.stringify(response)}`)
  return response.output as unknown as Ran
}

async function results(runtime: CoreRuntime) {
  return (await auditEntries(runtime.actions, 200)).filter(entry => entry.event === 'result')
}

describe('a code_run script on a workspace', () => {
  it('calls fs_list and fs_read and hands back only what it kept', async () => {
    const { runtime } = await node()
    const response = await run(runtime, `
      const listed = await tools.fs_list({ path: 'docs' })
      const files = listed.entries.filter(entry => entry.type === 'file').map(entry => 'docs/' + entry.path)
      const read = await Promise.all(files.map(path => tools.fs_read({ path })))
      for (const file of read) text(file.content.split('\\n')[0])
      return read.reduce((sum, file) => sum + file.size, 0)
    `)
    const result = ran(response)

    expect(result.ok).toBe(true)
    expect(result.output).toBe('# alpha title\n# beta title\n# gamma title')
    expect(result.value).toBeGreaterThan(60_000)
    expect(JSON.stringify(response).length).toBeLessThan(2_000)
    expect(result.calls.map(call => [call.tool, call.status])).toEqual([['fs_list', 'ok'], ['fs_read', 'ok'], ['fs_read', 'ok'], ['fs_read', 'ok']])
    await runtime.history.close()
  })

  it('catches a refused call as an error carrying its code, and the audit log holds the refusal', async () => {
    const { runtime } = await node()
    await runtime.policy.apply(WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules: [{ path: 'secret', read: 'deny' }] } }))
    const result = ran(await run(runtime, `
      try { return await tools.fs_read({ path: 'secret/key.txt' }) } catch (error) { return [error.message.split(':')[0], error.code, error.retryable] }
    `))

    expect(result.value).toEqual(['PERMISSION_DENIED', 'PERMISSION_DENIED', false])
    expect(JSON.stringify(result)).not.toContain('never shown')
    expect((await results(runtime)).filter(entry => entry.tool === 'fs_read').map(entry => entry.outcome)).toEqual(['denied'])
    await runtime.history.close()
  })

  // Final review of 0.1.4, finding invoker 701: the stage stays the caller's own, unset where it named none, and the
  // script is named beside it by its code_run call's requestId.
  it('audits each call the script made with the outer call\'s own stage and its requestId as the parent', async () => {
    const { runtime } = await node()
    ran(await run(runtime, 'await tools.fs_list({ path: "docs" })', { stageId: 'stage-7' }))
    const outer = ran(await run(runtime, 'await tools.fs_list({ path: "docs" })'))
    expect(outer.ok).toBe(true)

    const nested = (await results(runtime)).filter(entry => entry.tool === 'fs_list')
    expect(nested.map(entry => [entry.stageId, entry.parentRequestId])).toEqual([['stage-7', `outer-${sequence - 1}`], [undefined, `outer-${sequence}`]])
    expect((await results(runtime)).filter(entry => entry.tool === 'code_run').map(entry => entry.parentRequestId)).toEqual([undefined, undefined])
    expect(nested.every(entry => /^code:[0-9a-f]{64}:1$/.test(entry.requestId) && entry.sessionId === 'chat-1' && entry.outcome === 'ok')).toBe(true)
    await runtime.history.close()
  })

  it('never offers code_run or code_api to a script, and the invoker refuses a script\'s call to either', async () => {
    const { runtime } = await node()
    const result = ran(await run(runtime, `
      const reached = []
      for (const name of ['code_run', 'code_api']) { try { tools[name]; reached.push(name) } catch (error) { reached.push(error.name) } }
      return [reached, ALL_TOOLS.map(tool => tool.name).filter(name => name.startsWith('code_'))]
    `))
    expect(result.value).toEqual([['TypeError', 'TypeError'], []])

    // A tool that reaches tools and names code_api itself, standing in for any route a script might find.
    vi.spyOn(runtime.registry().get('code_run'), 'prepare').mockImplementation(() => ({
      effects: [], reachesTools: true, execute: async (context: ToolContext) => context.invokeNested!({ id: 1, tool: 'code_api', args: {} }) as unknown as JsonValue,
    }))
    const refused = await run(runtime, 'ignored', { stageId: 'nesting' })
    expect(refused).toMatchObject({ outcome: 'ok', output: { outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Scripts cannot start scripts') } } })
    expect((await results(runtime)).find(entry => entry.tool === 'code_api')).toMatchObject({ outcome: 'denied', stageId: 'nesting' })
    await runtime.history.close()
  })

  // Review of the code-mode slice, coordinator decision 3: pi-codemode's error for an unknown tool names searchTools.
  it('finds tools with searchTools by the words of a query, names first, at most its limit', async () => {
    const { runtime } = await node()
    const result = ran(await run(runtime, `
      let unknown
      try { tools.fs_reed } catch (error) { unknown = error.message.includes('searchTools') }
      const found = await searchTools('READ file')
      const one = await searchTools('fs', { limit: 1 })
      const codes = []
      for (const args of [[''], ['fs', { limit: 0 }], [3]]) { try { await searchTools(...args) } catch (error) { codes.push(error.code) } }
      return [unknown, found.map(tool => tool.name), Object.keys(found[0]).sort(), one.length, (await searchTools('nothing matches this')).length, codes]
    `))
    const [unknown, names, keys, limited, none, codes] = result.value as [boolean, string[], string[], number, number, string[]]
    expect(unknown).toBe(true)
    expect(names[0]).toBe('fs_read')
    expect(names.length).toBeLessThanOrEqual(8)
    expect(names.every(name => name.startsWith('fs_'))).toBe(true)
    expect([keys, limited, none, codes]).toEqual([['description', 'name'], 1, 0, ['INVALID_TOOL_INPUT', 'INVALID_TOOL_INPUT', 'INVALID_TOOL_INPUT']])
    expect(await results(runtime)).toEqual([expect.objectContaining({ tool: 'code_run' })])
    await runtime.history.close()
  })

  it('cuts output past 1 MiB, and a return value past it as JSON text, keeping the start and the end', async () => {
    const { runtime } = await node()
    const printed = ran(await run(runtime, 'for (let i = 0; i < 40000; i++) text("line " + String(i).padStart(5, "0") + " " + "x".repeat(30))'))
    expect(printed.truncated).toBe(true)
    expect(printed.output.length).toBeLessThanOrEqual(OUTPUT_CHARS + 100)
    expect(printed.output.startsWith('line 00000 ')).toBe(true)
    expect(printed.output.endsWith(`line 39999 ${'x'.repeat(30)}`)).toBe(true)
    expect(printed.output).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/)

    const returned = ran(await run(runtime, 'return "a" + "b".repeat(2 * 1024 * 1024) + "z"'))
    expect(returned.truncated).toBe(true)
    expect(typeof returned.value).toBe('string')
    expect((returned.value as string).length).toBeLessThanOrEqual(OUTPUT_CHARS + 100)
    expect((returned.value as string).startsWith('"ab')).toBe(true)
    expect((returned.value as string).endsWith('bz"')).toBe(true)
    await runtime.history.close()
  })

  it('fails at once a script waiting on a promise nothing can settle', async () => {
    const { runtime } = await node()
    const began = performance.now()
    const result = ran(await run(runtime, 'text("waiting"); await new Promise(() => {})'))
    expect(result).toMatchObject({ ok: false, output: 'waiting', error: { kind: 'script', message: expect.stringContaining('can never settle') } })
    expect(performance.now() - began).toBeLessThan(10_000)
    await runtime.history.close()
  })

  it('ends a script at its timeout, never past the node\'s maximum, as a timeout', async () => {
    const { runtime } = await node({ BUCKLE_MAX_TIMEOUT_MS: '1500' })
    const short = ran(await run(runtime, 'text("spinning"); while (true) {}', { timeoutMs: 300 }))
    expect(short).toMatchObject({ ok: false, output: 'spinning', error: { kind: 'timeout' } })

    const began = performance.now()
    const capped = ran(await run(runtime, 'while (true) {}', { timeoutMs: 60_000 }))
    expect(capped.error).toMatchObject({ kind: 'timeout', message: expect.stringContaining('1500 ms') })
    expect(performance.now() - began).toBeLessThan(15_000)
    await runtime.history.close()
  })

  // Review of the code-mode slice, finding sandbox-boundary 213: a script's call is held to the request budget.
  it('refuses inside the script a call whose arguments pass the node\'s request budget, before it is audited', async () => {
    const { runtime } = await node({ BUCKLE_MAX_REQUEST_BYTES: '4096' })
    const result = ran(await run(runtime, `
      const codes = []
      for (const call of [() => tools.fs_read({ path: 'docs/alpha.md', pad: 'x'.repeat(5000) }), () => describeTool('x'.repeat(5000))]) {
        try { await call() } catch (error) { codes.push([error.code, error.message.includes('4096')]) }
      }
      return [codes, (await tools.fs_read({ path: 'docs/alpha.md', pad: 'x'.repeat(100) })).size > 0]
    `))
    expect(result.value).toEqual([[[REQUEST_TOO_LARGE, true], [REQUEST_TOO_LARGE, true]], true])
    expect((await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'fs_read').map(entry => entry.event)).toEqual(['attempt', 'result'])
    await runtime.history.close()
  })

  it('keeps the output a script made before it threw, with the error', async () => {
    const { runtime } = await node()
    const result = ran(await run(runtime, 'text("one"); console.log("two", 2); await tools.fs_list({ path: "docs" }); throw new TypeError("boom")'))
    expect(result).toMatchObject({ ok: false, output: 'one\ntwo 2', error: { kind: 'script', name: 'TypeError', message: 'boom' } })
    expect(result.calls).toEqual([expect.objectContaining({ tool: 'fs_list', status: 'ok' })])
    await runtime.history.close()
  })
})

describe('the code pack setting', () => {
  it('withholds the pack with its reason under BUCKLE_ALLOW_CODE=false, and the status view says so', async () => {
    const off = await node({ BUCKLE_ALLOW_CODE: 'false' })
    expect(off.runtime.manifest().packs.find(pack => pack.id === 'code')).toEqual({ id: 'code', version: '1.0.0', toolNames: ['code_run', 'code_api'], unavailableReason: 'Code mode is turned off in this workspace: its setting packs.code is off' })
    expect(off.runtime.manifest().tools.map(tool => tool.name).filter(name => name.startsWith('code_'))).toEqual([])
    expect((await createSetupViews().status({ config: off.config, runtime: off.runtime })).code).toBe('withheld (Code mode is turned off in this workspace: its setting packs.code is off)')

    const on = await node()
    expect(on.runtime.manifest().tools.map(tool => tool.name).filter(name => name.startsWith('code_'))).toEqual(['code_api', 'code_run'])
    expect((await createSetupViews().status({ config: on.config, runtime: on.runtime })).code).toBe('on')
    const left = await node({ BUCKLE_PACKS: 'fs' })
    expect((await createSetupViews().status({ config: left.config, runtime: left.runtime })).code).toBe('withheld (the workspace setting packs.enabled leaves the code pack out)')
    for (const { runtime } of [off, on, left]) await runtime.history.close()
  })

  // Review of the code-mode slice, finding tests 180: a sandbox this host cannot give, so the shell pack is withheld
  // for it, rather than BUCKLE_SANDBOX=none, which is a sandbox decision.
  it('is never withheld for want of an operating-system sandbox', async () => {
    const unavailable = process.platform === 'darwin' ? 'bubblewrap' : 'seatbelt'
    const { runtime } = await node({ BUCKLE_SANDBOX: unavailable, BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell,code' })
    const packs = runtime.manifest().packs
    expect(packs.find(pack => pack.id === 'shell')?.unavailableReason).toContain(`BUCKLE_SANDBOX=${unavailable}`)
    expect(packs.find(pack => pack.id === 'code')?.unavailableReason).toBeNull()
    expect(runtime.manifest().tools.map(tool => tool.name).filter(name => name.startsWith('code_'))).toEqual(['code_api', 'code_run'])
    await runtime.history.close()
  })
})

describe('the script VMs a workspace holds', () => {
  // Re-review of the code-mode slice, finding tests 114: the packs index names the VM's workspace by its state key, so
  // the adapter a reload builds shares the count of the one before it.
  it('counts a workspace\'s scripts across a reload of its packs', async () => {
    const { runtime } = await node()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let reading = 0
    const fsRead = runtime.registry().get('fs_read')
    const prepare = fsRead.prepare.bind(fsRead)
    vi.spyOn(fsRead, 'prepare').mockImplementation((args) => {
      const prepared = prepare(args)
      return { ...prepared, execute: async (context: ToolContext) => { reading++; await held; return await prepared.execute(context) } }
    })
    const holding = ['alpha', 'beta'].map(name => run(runtime, `return (await tools.fs_read({ path: 'docs/${name}.md' })).size`))
    await vi.waitFor(() => expect(reading).toBe(2), { timeout: 10_000 })
    await runtime.reload()

    expect(await run(runtime, 'return 1')).toMatchObject({ outcome: 'error', error: { code: CODE_VM_BUSY, retryable: true, message: expect.stringContaining('in this workspace') } })
    release()
    for (const response of await Promise.all(holding)) expect(ran(response).ok).toBe(true)
    await runtime.history.close()
  }, 30_000)
})

describe('code mode inside one workspace (BUCKLE-D07: a token opens one workspace)', () => {
  async function nodeWithChild(childPolicy = emptyWorkspacePolicy()) {
    const root = mkdtempSync(join(tmpdir(), 'buckle-code-child-'))
    roots.push(root)
    for (const directory of ['default', 'child']) mkdirSync(join(root, directory))
    writeFileSync(join(root, 'default', 'private.txt'), 'the default workspace only')
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'default'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,code' })
    const manager = await workspacesOf(config, { interaction: fixedInteraction() })
    await registerWorkspace(manager, { id: 'child', name: 'Child', dir: join(root, 'child'), policy: childPolicy })
    return { root, runtime: (await byName(manager, 'default')).runtime, child: (await byName(manager, 'child')).runtime }
  }

  it('reaches only the registered workspace: the default root is refused there, and nothing lands in the default workspace\'s log', async () => {
    const { root, runtime, child } = await nodeWithChild()
    const result = ran(await run(child, `
      const settled = await Promise.allSettled([tools.fs_read({ path: ${JSON.stringify(join(root, 'default', 'private.txt'))} }), tools.fs_list({ path: '../default' })])
      return settled.map(item => item.status === 'fulfilled' ? item.value : item.reason.code)
    `))

    expect(result.value).toEqual(['PERMISSION_DENIED', 'PERMISSION_DENIED'])
    expect(JSON.stringify(result)).not.toContain('the default workspace only')
    expect((await results(child)).filter(entry => entry.requestId.startsWith('code:')).map(entry => [entry.tool, entry.outcome])).toEqual([['fs_read', 'denied'], ['fs_list', 'denied']])
    expect((await results(runtime)).filter(entry => entry.requestId.startsWith('code:') || entry.tool === 'code_run')).toEqual([])
    expect([...runtime.approvals.pending(), ...child.approvals.pending()]).toEqual([])
    await runtime.history.close()
  }, 30_000)

  it('lets one workspace\'s tool policy deny code_run while the node leaves the pack on', async () => {
    const { runtime, child } = await nodeWithChild({ ...emptyWorkspacePolicy(), tools: { deny: ['code_run'] } })
    expect(runtime.manifest().tools.some(tool => tool.name === 'code_run')).toBe(true)
    expect(child.manifest().tools.some(tool => tool.name === 'code_run')).toBe(false)
    expect(await run(child, 'return 1')).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Disabled by workspace tool policy. Ask the owner to review buckle policy show ') } })
    await runtime.history.close()
  }, 30_000)
})

describe('the limits on a script\'s calls', () => {
  const echo: ToolCapability = { name: 'echo', description: 'Echo its arguments.', inputSchema: { type: 'object' }, risk: 'read', tags: [], pack: 'test' }

  function codeRun(invokeNested: (call: NestedCall) => Promise<InvokeResponse>) {
    const directory = mkdtempSync(join(tmpdir(), 'buckle-code-limits-'))
    roots.push(directory)
    const pack = createCodePack({ vm: createPiCodemodeVm(), reachableTools: () => [echo], journalDirectory: directory, unavailableReason: null })
    return async (script: string) => {
      const context: ToolContext = { requestId: 'outer', sessionId: 'chat-1', timeoutMs: 60_000, signal: new AbortController().signal, nestedKey: 'a'.repeat(64), invokeNested, forgetNested: () => {} }
      return await pack.tools[0]!.prepare({ script }).execute(context) as unknown as Ran
    }
  }
  const ok = (call: NestedCall): InvokeResponse => ({ requestId: `code:${call.id}`, outcome: 'ok', output: call.args as JsonObject, meta: { durationMs: 0, truncated: false } })

  it(`fails every call past ${MAX_NESTED_CALLS} inside the script`, async () => {
    const invoked = vi.fn(async (call: NestedCall) => ok(call))
    const result = await codeRun(invoked)(`
      for (let i = 0; ; i++) { try { await tools.echo({ i }) } catch (error) { return [i, error.code] } }
    `)
    expect(result.value).toEqual([MAX_NESTED_CALLS, CODE_CALL_LIMIT])
    expect(invoked).toHaveBeenCalledTimes(MAX_NESTED_CALLS)
  })

  // Review of the code-mode slice, coordinator decision 9 and finding sandbox-boundary 254.
  // Re-review of the code-mode slice, finding new-surface index.ts:224: a queued call never starts once the VM has
  // finished, though its result has not settled yet, and one that never started is reported skipped, not cancelled.
  // A stub VM fixes the order: twelve calls, then the end, then the result once the test lets it settle.
  it('starts no queued call once the script has ended, and reports those as skipped', async () => {
    let settle!: () => void
    const vm: ScriptVm = {
      declare: () => '', identifier: name => name,
      start(input) {
        let finished = false
        const calls = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, name: 'echo', status: 'cancelled' as const, durationMs: 0 }))
        const result = new Promise<ScriptVmResult>((resolve) => { settle = () => resolve({ ok: true, value: 'done', output: [], outputTruncated: false, calls }) })
        queueMicrotask(() => {
          for (const call of calls) input.onCall({ id: call.id, target: 'tool', name: 'echo', args: {} })
          finished = true
        })
        return { deliver() {}, get finished() { return finished }, result }
      },
    }
    const directory = mkdtempSync(join(tmpdir(), 'buckle-code-ended-'))
    roots.push(directory)
    const invoked = vi.fn(async (call: NestedCall) => ok(call))
    const pack = createCodePack({ vm, reachableTools: () => [echo], journalDirectory: directory, unavailableReason: null })
    const context: ToolContext = { requestId: 'outer', sessionId: 'chat-1', timeoutMs: 60_000, signal: new AbortController().signal, nestedKey: 'd'.repeat(64), invokeNested: invoked, forgetNested: () => {} }
    const running = pack.tools[0]!.prepare({ script: 'ignored' }).execute(context) as Promise<unknown> as Promise<Ran>
    await vi.waitFor(() => expect(invoked).toHaveBeenCalledTimes(MAX_IN_FLIGHT))
    await new Promise(resolve => setTimeout(resolve, 50))
    settle()

    const result = await running
    expect(invoked).toHaveBeenCalledTimes(MAX_IN_FLIGHT)
    expect(result.calls.map(call => call.status)).toEqual([...Array.from({ length: MAX_IN_FLIGHT }, () => 'cancelled'), ...Array.from({ length: 12 - MAX_IN_FLIGHT }, () => 'skipped')])
  })

  it('counts refused calls toward the cap', async () => {
    const invoked = vi.fn(async (call: NestedCall) => ok(call))
    const result = await codeRun(invoked)(`
      for (let i = 0; ; i++) { try { await tools.echo(i < 10 ? [i] : { i }) } catch (error) { if (error.code === '${CODE_CALL_LIMIT}') return i } }
    `)
    expect(result.value).toBe(MAX_NESTED_CALLS)
    expect(invoked).toHaveBeenCalledTimes(MAX_NESTED_CALLS - 10)
  })

  it('ends a script that goes on calling past its cap, and hands back a bounded list of calls', async () => {
    const invoked = vi.fn(async (call: NestedCall) => ok(call))
    const began = performance.now()
    const result = await codeRun(invoked)('for (;;) { try { await tools.echo({}) } catch (error) {} }')
    expect(result).toMatchObject({ ok: false, truncated: true, error: { kind: 'script', message: expect.stringContaining(CODE_CALL_LIMIT) } })
    expect(result.calls).toHaveLength(MAX_NESTED_CALLS)
    expect(result.callsOmitted).toBeGreaterThan(MAX_NESTED_CALLS)
    expect(invoked).toHaveBeenCalledTimes(MAX_NESTED_CALLS)
    expect(JSON.stringify(result).length).toBeLessThan(64 * 1_024)
    expect(performance.now() - began).toBeLessThan(10_000)
  })

  // Review of the code-mode slice, coordinator decision 2: a call past the slots waits for one, in order.
  it(`runs at most ${MAX_IN_FLIGHT} calls at once, and starts the rest in order as slots free`, async () => {
    let running = 0
    let most = 0
    const invoked = vi.fn(async (call: NestedCall) => {
      most = Math.max(most, ++running)
      await new Promise(resolve => setTimeout(resolve, 20))
      running--
      return ok(call)
    })
    const result = await codeRun(invoked)('return (await Promise.all(Array.from({ length: 20 }, (_, i) => tools.echo({ i })))).map(item => item.i)')
    expect(result.value).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(invoked.mock.calls.map(([call]) => (call.args as { i: number }).i)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(most).toBe(MAX_IN_FLIGHT)
  })

  // Review of the code-mode slice, finding sandbox-boundary 257.
  it(`cuts a script error's name, message, and stack to ${ERROR_CHARS} characters each`, async () => {
    const huge = 2 * 1_024 * 1_024
    for (const script of [`throw new Error('x'.repeat(${huge}))`, `const error = new Error('m'); error.name = 'n'.repeat(${huge}); throw error`]) {
      const result = await codeRun(vi.fn())(script)
      expect(result).toMatchObject({ ok: false, truncated: true, error: { kind: 'script' } })
      for (const field of [result.error!.name, result.error!.message, result.error!.stack]) expect(field?.length ?? 0).toBeLessThanOrEqual(ERROR_CHARS + 100)
      expect(JSON.stringify(result).length).toBeLessThan(4 * ERROR_CHARS)
    }
  })

  // Review of the code-mode slice, finding sandbox-boundary 91.
  it('tells the agent a fixed sentence when the VM itself fails, and the owner\'s log the detail', async () => {
    const failed: ScriptVmResult = { ok: false, output: [], outputTruncated: false, calls: [], error: { kind: 'sandbox', name: 'Error', message: 'Cannot find module \'/opt/buckle/node_modules/pi/worker.js\'' } }
    const vm: ScriptVm = { declare: () => '', identifier: name => name, start: () => ({ deliver() {}, finished: true, result: Promise.resolve(failed) }) }
    const directory = mkdtempSync(join(tmpdir(), 'buckle-code-sandbox-'))
    roots.push(directory)
    const warn = vi.spyOn(logger, 'warn')
    const pack = createCodePack({ vm, reachableTools: () => [echo], journalDirectory: directory, unavailableReason: null })
    const context: ToolContext = { requestId: 'outer', sessionId: 'chat-1', timeoutMs: 60_000, signal: new AbortController().signal, nestedKey: 'b'.repeat(64), invokeNested: vi.fn(), forgetNested: () => {} }
    const result = await pack.tools[0]!.prepare({ script: 'return 1' }).execute(context) as unknown as Ran

    expect(result.error).toEqual({ kind: 'sandbox', message: SANDBOX_FAILED })
    expect(JSON.stringify(result)).not.toContain('/opt')
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining('/opt/buckle') }))
    warn.mockRestore()
  })

  // Review of the code-mode slice, finding tests 195: a full VM pool is a retryable refusal, and touches no journal.
  it(`answers ${CODE_VM_BUSY}, retryable, when the VM takes no more scripts, and leaves the script's journal alone`, async () => {
    const vm: ScriptVm = { declare: () => '', identifier: name => name, start: () => ({ busy: 'every slot is taken' }) }
    const directory = mkdtempSync(join(tmpdir(), 'buckle-code-busy-'))
    roots.push(directory)
    const key = 'c'.repeat(64)
    const journal = join(directory, `${key}.json`)
    writeFileSync(journal, JSON.stringify({ version: 1, key, startedAt: 1, seed: 1, tools: [], entries: [], expiresAt: Date.now() + 60_000 }))
    const pack = createCodePack({ vm, reachableTools: () => [echo], journalDirectory: directory, unavailableReason: null })
    const context: ToolContext = { requestId: 'outer', sessionId: 'chat-1', timeoutMs: 60_000, signal: new AbortController().signal, nestedKey: key, invokeNested: vi.fn(), forgetNested: () => {} }

    await expect(pack.tools[0]!.prepare({ script: 'return 1' }).execute(context)).rejects.toMatchObject({ code: CODE_VM_BUSY, retryable: true, message: 'every slot is taken' })
    expect(existsSync(journal)).toBe(true)
  })

  it('refuses arguments that are not one object inside the script, without a call', async () => {
    const invoked = vi.fn(async (call: NestedCall) => ok(call))
    const result = await codeRun(invoked)('try { await tools.echo([1, 2]) } catch (error) { return error.code }')
    expect(result.value).toBe('INVALID_TOOL_INPUT')
    expect(invoked).not.toHaveBeenCalled()
  })
})
