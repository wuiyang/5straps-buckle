import { describe, expect, it, vi } from 'vitest'
import type { ScriptVmResult, ScriptVmRunInput } from '../common/types/ports/script-vm.js'

// The pi-codemode adapter forgets where it found the package after a failure of the VM itself, so a node whose install
// changed under it finds the package again without a restart (review of the code-mode slice, finding sandbox-boundary
// 91; re-review, finding tests pi-codemode.ts:89). Its own file, so the module mocks below reach no other test.

const state = vi.hoisted(() => ({ lookups: 0, sandboxFails: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      if (String(path).endsWith('@earendil-works/pi-codemode/package.json')) state.lookups++
      return actual.existsSync(path)
    },
  }
})

vi.mock('@earendil-works/pi-codemode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@earendil-works/pi-codemode')>()
  /** The real sandbox, or, when the test says so, one whose run fails as a VM that could not load does. */
  class Sandbox extends actual.CodemodeSandbox {
    override start(...args: Parameters<InstanceType<typeof actual.CodemodeSandbox>['start']>): ReturnType<InstanceType<typeof actual.CodemodeSandbox>['start']> {
      if (!state.sandboxFails) return super.start(...args)
      const failed = { ok: false, error: { kind: 'sandbox', name: 'Error', message: 'Cannot find module' }, output: [], calls: [] }
      return { deliver() {}, finished: true, result: Promise.resolve(failed) } as unknown as ReturnType<InstanceType<typeof actual.CodemodeSandbox>['start']>
    }
  }
  return { ...actual, CodemodeSandbox: Sandbox }
})

const { createPiCodemodeVm } = await import('../common/adapters/script-vm/pi-codemode.js')

function input(script: string): ScriptVmRunInput {
  return { script, tools: [], globals: [], limits: { deadlineMs: 20_000, memoryBytes: 64 * 1_024 * 1_024, outputChars: 1_000 }, startedAt: 1_700_000_000_000, seed: 7, onCall: () => {} }
}

describe('where the pi-codemode adapter finds the package', () => {
  it('keeps it across runs and a script\'s own failure, and looks again after a failure of the VM itself', async () => {
    const vm = createPiCodemodeVm()
    const run = async (script: string): Promise<ScriptVmResult> => {
      const started = vm.start(input(script))
      if ('busy' in started) throw new Error(started.busy)
      return await started.result
    }

    expect((await run('return 1')).ok).toBe(true)
    const found = state.lookups
    expect(found).toBeGreaterThan(0)
    expect((await run('return 2')).ok).toBe(true)
    expect((await run('throw new Error("mine")')).error?.kind).toBe('script')
    expect(state.lookups).toBe(found)

    state.sandboxFails = true
    expect((await run('return 3')).error?.kind).toBe('sandbox')
    state.sandboxFails = false
    expect(state.lookups).toBe(found)
    expect((await run('return 4')).ok).toBe(true)
    expect(state.lookups).toBeGreaterThan(found)
  })
})
