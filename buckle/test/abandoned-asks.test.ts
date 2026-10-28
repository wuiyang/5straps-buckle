import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeRequest } from '@5straps/protocol'
import { describe, expect, it, vi } from 'vitest'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'

// The MCP asks brief, item 5: a call whose caller left before its hold ended did not run, and its audit entry says so in a
// code of its own; its ask is marked abandoned, stays answerable for the join window, and makes room under the caps.

async function node(wait = '60000') {
  const root = mkdtempSync(join(tmpdir(), 'buckle-abandoned-'))
  for (const directory of ['workspace', 'workspace/one']) mkdirSync(join(root, directory))
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: wait })
  return { root, config, runtime: await createRuntime({ config, interaction: fixedInteraction() }) }
}

const write = (requestId: string, path = 'one/a.md'): InvokeRequest => ({ requestId, tool: 'fs_write', args: { path, content: 'a' }, approvalTokens: [] })

function results(runtime: BuckleRuntime, requestId: string) {
  return runtime.actions.read(200).filter(entry => entry.event === 'result' && entry.requestId === requestId)
}

describe('a call whose caller left while it waited for a person', () => {
  it('answers CALLER_LEFT, audits that it did not run under that code, and keeps its ask', async () => {
    const { runtime } = await node()
    const leaving = new AbortController()
    const waiting = runtime.invoke({ sessionId: 'chat-1', request: write('left-1'), signal: leaving.signal })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    leaving.abort()

    expect(await waiting).toMatchObject({ outcome: 'error', error: { code: 'CALLER_LEFT', retryable: true } })
    expect(results(runtime, 'left-1')).toEqual([expect.objectContaining({ outcome: 'error', detail: 'CALLER_LEFT' })])
    expect(runtime.approvalService.pending()).toHaveLength(1)
    await runtime.history.close()
  })
})
