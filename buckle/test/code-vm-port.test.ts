import { describe, expect, it } from 'vitest'
import { createPiCodemodeVm, MAX_LIVE_VMS, MAX_LIVE_VMS_PER_WORKSPACE } from '../common/adapters/script-vm/pi-codemode.js'
import { keepEndsOfLines, keepEndsOfText } from '../common/domain/script-output.js'
import type { ScriptVmCall, ScriptVmRun, ScriptVmRunInput } from '../common/types/ports/script-vm.js'

// The script VM port as pi-codemode implements it (owner decision D82, point 2): QuickJS in a worker thread, held to
// its memory and deadline, stopped when the script settles, and at most four alive in one process.

const vm = createPiCodemodeVm()

function input(script: string, overrides: Partial<ScriptVmRunInput> = {}): ScriptVmRunInput {
  return { script, tools: [], globals: [], limits: { deadlineMs: 20_000, memoryBytes: 64 * 1_024 * 1_024, outputChars: 1_048_576 }, startedAt: 1_700_000_000_000, seed: 7, onCall: () => {}, ...overrides }
}

function started(run: ReturnType<typeof vm.start>): ScriptVmRun {
  if ('busy' in run) throw new Error(run.busy)
  return run
}

/** The worker message ports alive in this process: one per running VM. */
function ports(): number {
  return process.getActiveResourcesInfo().filter(name => name === 'MessagePort').length
}

describe('the pi-codemode script VM', () => {
  it('runs a script, answers its calls in numbered order, and returns its output, value, and calls', async () => {
    const calls: ScriptVmCall[] = []
    let run: ScriptVmRun | undefined
    run = started(vm.start(input('const a = tools.echo({ n: 1 }); const b = tools.echo({ n: 2 }); text(await b); console.log("x", await a); return [await a, await b]', {
      tools: [{ name: 'echo', jsName: 'echo', description: 'Echo' }],
      onCall(call) {
        calls.push(call)
        // Answered in reverse: the VM applies them by number, whatever order they come in.
        if (calls.length === 2) for (const [index, made] of [...calls].reverse().entries()) run!.deliver(index + 1, 1_700_000_000_500, made.id, { ok: true, value: (made.args as { n: number }).n * 10 })
      },
    })))
    const result = await run.result

    expect(calls.map(call => [call.id, call.target, call.name, call.args])).toEqual([[1, 'tool', 'echo', { n: 1 }], [2, 'tool', 'echo', { n: 2 }]])
    expect(result).toMatchObject({ ok: true, value: [10, 20], output: [{ kind: 'text', text: '20' }, { kind: 'console', text: 'x 10' }], outputTruncated: false })
    expect(result.calls.map(call => [call.id, call.name, call.status])).toEqual([[1, 'echo', 'ok'], [2, 'echo', 'ok']])
  })

  it('makes the same calls and output from the same clock start, seed, and results: a run can be replayed', async () => {
    const once = async () => {
      const made: unknown[] = []
      let run: ScriptVmRun | undefined
      run = started(vm.start(input('const r = await tools.echo({ at: Date.now(), roll: Math.random() }); text(JSON.stringify(r)); return [Date.now(), Math.random()]', {
        tools: [{ name: 'echo', jsName: 'echo', description: 'Echo' }],
        onCall(call) { made.push(call.args); run!.deliver(1, 1_700_000_001_000, call.id, { ok: true, value: 'answer' }) },
      })))
      return { made, result: await run.result }
    }
    const [first, second] = [await once(), await once()]

    expect(second.made).toEqual(first.made)
    expect(second.result.value).toEqual(first.result.value)
    expect((first.made[0] as { at: number }).at).toBe(1_700_000_000_000)
  })

  it('rejects a call answered with an error, carrying its properties', async () => {
    let run: ScriptVmRun | undefined
    run = started(vm.start(input('try { await tools.echo({}) } catch (error) { return [error.message, error.code, error.retryable] }', {
      tools: [{ name: 'echo', jsName: 'echo', description: 'Echo' }],
      onCall(call) { run!.deliver(1, Date.now(), call.id, { ok: false, message: 'PERMISSION_DENIED: no', properties: { code: 'PERMISSION_DENIED', retryable: false } }) },
    })))
    expect((await run.result).value).toEqual(['PERMISSION_DENIED: no', 'PERMISSION_DENIED', false])
  })

  it('holds the script to its memory: an allocation past it fails inside the script', async () => {
    const run = started(vm.start(input('const parts = []; for (;;) parts.push("x".repeat(1 << 20) + parts.length)', { limits: { deadlineMs: 20_000, memoryBytes: 16 * 1_024 * 1_024, outputChars: 1_000 } })))
    expect((await run.result).error).toMatchObject({ kind: 'script', name: 'InternalError', message: 'out of memory' })
  })

  it('ends a script at its deadline as a timeout, and its worker is gone once the result settles', async () => {
    const before = ports()
    const began = performance.now()
    const run = started(vm.start(input('while (true) {}', { limits: { deadlineMs: 300, memoryBytes: 16 * 1_024 * 1_024, outputChars: 1_000 } })))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(ports()).toBeGreaterThan(before)

    expect((await run.result).error).toMatchObject({ kind: 'timeout' })
    expect(performance.now() - began).toBeLessThan(10_000)
    expect(ports()).toBe(before)
  })

  it('ends a script whose signal fires as aborted, and one waiting on nothing at once', async () => {
    const controller = new AbortController()
    const waiting = started(vm.start(input('await tools.echo({})', { tools: [{ name: 'echo', jsName: 'echo', description: 'Echo' }], signal: controller.signal })))
    controller.abort(new Error('stop'))
    expect((await waiting.result).error).toMatchObject({ kind: 'aborted' })

    const stalled = started(vm.start(input('text("before"); await new Promise(() => {})')))
    const result = await stalled.result
    expect(result.error).toMatchObject({ kind: 'script', message: expect.stringContaining('can never settle') })
    expect(result.output).toEqual([{ kind: 'text', text: 'before' }])
  })

  // Review of the code-mode slice, finding sandbox-boundary pi-codemode.ts:46: a workspace's share within the process's.
  it(`holds at most ${MAX_LIVE_VMS} live VMs, ${MAX_LIVE_VMS_PER_WORKSPACE} of them one workspace's: another is refused at once, and a slot frees once a VM has stopped`, async () => {
    const workspaces = ['one', 'two', 'three'].map(workspace => createPiCodemodeVm({ workspace }))
    const controllers: AbortController[] = []
    const hold = (on: ReturnType<typeof createPiCodemodeVm>) => {
      const controller = new AbortController()
      controllers.push(controller)
      return on.start(input('await tools.wait({})', { tools: [{ name: 'wait', jsName: 'wait', description: 'Waits' }], signal: controller.signal }))
    }
    const runs = [hold(workspaces[0]!), hold(workspaces[0]!)].map(started)

    const workspaceFull = { busy: expect.stringContaining(`${MAX_LIVE_VMS_PER_WORKSPACE} scripts already run in this workspace`) }
    expect(hold(workspaces[0]!)).toEqual(workspaceFull)
    // The same workspace's next adapter, as after a reload, shares its count; checked while the process still has
    // slots, so only the workspace's share can refuse it (re-review of the code-mode slice, finding tests 114).
    expect(hold(createPiCodemodeVm({ workspace: 'one' }))).toEqual(workspaceFull)
    runs.push(...[hold(workspaces[1]!), hold(workspaces[1]!)].map(started))
    expect(workspaces[2]!.start(input('return 1'))).toEqual({ busy: expect.stringContaining(`${MAX_LIVE_VMS} scripts already run in this Buckle process`) })

    controllers[0]!.abort()
    await runs[0]!.result
    const next = started(workspaces[0]!.start(input('return 1')))
    expect((await next.result).value).toBe(1)
    for (const controller of controllers) controller.abort()
    await Promise.all(runs.map(run => run.result))
  })

  // Review of the code-mode slice, findings docs-rules code-mode.md:94 and packaging-platform 94: pi-codemode's own
  // limit, which the docs name, fails the script rather than cutting its output; an upgrade that moves it shows here.
  it('fails a script past 100,000 lines of output, and keeps one just under it', async () => {
    const lines = (count: number) => started(vm.start(input(`for (let i = 0; i < ${count}; i++) text("a"); return "done"`, { limits: { deadlineMs: 60_000, memoryBytes: 64 * 1_024 * 1_024, outputChars: 1_048_576 } }))).result
    expect(await lines(99_999)).toMatchObject({ ok: true, value: 'done' })
    expect(await lines(100_001)).toMatchObject({ ok: false, error: { kind: 'script', name: 'RangeError', message: expect.stringContaining('100000') } })
  }, 60_000)

  it('cuts long output in the middle, keeping its start and its end', async () => {
    const run = started(vm.start(input('for (let i = 0; i < 1000; i++) text("line " + i)', { limits: { deadlineMs: 20_000, memoryBytes: 64 * 1_024 * 1_024, outputChars: 200 } })))
    const result = await run.result
    const joined = result.output.map(item => item.text).join('\n')
    expect(result.outputTruncated).toBe(true)
    expect(joined.startsWith('line 0\nline 1\n')).toBe(true)
    expect(joined.endsWith('line 998\nline 999')).toBe(true)
    expect(joined).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/)
  })

  it('renders declarations from each tool\'s description and input schema, every call resolving to unknown', () => {
    const declared = vm.declare([{ name: 'fs_read', description: 'Read one file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }])
    expect(declared).toContain('declare const tools: {')
    expect(declared).toContain('Read one file.')
    expect(declared).toMatch(/fs_read\(args: \{\s*path: string;\s*\}\): Promise<unknown>;/)
    expect(vm.identifier('my-tool')).toBe('my_tool')
  })
})

describe('cutting what a script returns', () => {
  it('keeps text under the limit whole, and cuts longer text in the middle', () => {
    expect(keepEndsOfText('short', 10)).toEqual({ text: 'short', truncated: false })
    const cut = keepEndsOfText('a'.repeat(50) + 'b'.repeat(50), 20)
    expect(cut.truncated).toBe(true)
    expect(cut.text).toBe(`${'a'.repeat(10)}\n[... 80 characters omitted ...]\n${'b'.repeat(10)}`)
  })

  it('cuts lines inside a long one, counting what it left out', () => {
    const cut = keepEndsOfLines([{ text: 'x'.repeat(100) }], 20, text => ({ text }))
    expect(cut.items).toEqual([{ text: 'x'.repeat(10) }, { text: '[... 80 characters omitted ...]' }, { text: 'x'.repeat(10) }])
  })
})
