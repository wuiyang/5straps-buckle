import { afterEach, expect, it, vi } from 'vitest'
import { historyCommand } from '../cli/history.js'
import type { BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
afterEach(() => { vi.restoreAllMocks() })
for (const verb of ['list', 'recover', 'restore']) it(`escapes every string in the human history ${verb} JSON summary`, async () => {
  const checkpoint = { id: 'change-safe', sessionId: 'chat\u001b', stageId: 'stage\u202e', turnId: 'turn\u200b', reason: 'why\u2066', changed: ['changed\u202e'], notRestorable: ['skipped\u001b'], changes: [{ path: 'path\u200b', kind: 'modified' }], restores: 'old\u202e' }
  const runtime = { history: { list: async () => [checkpoint], recover: async () => checkpoint, restore: async () => checkpoint } } as unknown as BuckleRuntime
  let shown = ''; vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { shown += String(chunk); return true })
  expect((await historyCommand(runtime, verb === 'list' ? [verb] : [verb, 'change-safe'])).exitCode).toBe(0)
  expect(shown).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u202e\u2066]/)
  const decoded = JSON.parse(shown); const answer = Array.isArray(decoded) ? decoded[0] : decoded
  expect(answer).toMatchObject({ turnId: 'turn\\u200b', reason: 'why\\u2066', changed: ['changed\\u202e'], notRestorable: ['skipped\\u001b'], restores: 'old\\u202e' })
})
