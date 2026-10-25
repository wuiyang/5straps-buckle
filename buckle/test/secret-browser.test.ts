import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The secret-references slice, parts 5 and 6 (docs/secrets.md), through the browser pack: the value a fill enters is
// handed to agent-browser as its text, and every later browser call that shows the page is masked by it, one that ran
// beside the fill included. The agent-browser here is a stand-in script that keeps the text it was handed as its page.

const TOKEN = 'decoy-browser-0123456789'
const LABEL = '[secret:API_TOKEN]'
const STAND_IN = `#!/bin/sh
dir="$(dirname "$0")"
case "$1" in
  fill) printf '%s' "$3" > "$dir/page.txt"; printf '{"success":true,"data":{"filled":"%s"}}' "$3" ;;
  snapshot) [ -f "$dir/slow" ] && sleep 1; printf '{"success":true,"data":{"page":"%s"}}' "$(cat "$dir/page.txt" 2>/dev/null)" ;;
  *) printf '{"success":true,"data":{}}' ;;
esac
`

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(): Promise<{ bin: string; runtime: BuckleRuntime }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-secret-browser-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const bin = join(root, 'bin')
  mkdirSync(workspace)
  mkdirSync(bin)
  writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}\n`)
  writeFileSync(join(bin, 'agent-browser'), STAND_IN)
  chmodSync(join(bin, 'agent-browser'), 0o755)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'browser', BUCKLE_AGENT_BROWSER_COMMAND: join(bin, 'agent-browser') })
  const runtime = await createRuntime({ config: { ...config, secretFiles: ['.env.local'] } })
  runtimes.push(runtime)
  return { bin, runtime }
}

let sequence = 0
function browser(runtime: BuckleRuntime, args: JsonObject, sessionId = 'chat-1'): Promise<InvokeResponse> {
  sequence += 1
  return runtime.invoke({ sessionId, request: { requestId: `secret-browser-${sequence}`, tool: 'browser_command', args, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
}

describe('a browser fill', () => {
  it('hands agent-browser the value and masks it in the fill\'s answer and in a later snapshot', async () => {
    const { runtime } = await node()
    const filled = await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] })
    expect(filled).toMatchObject({ outcome: 'ok', output: { result: { data: { filled: LABEL } } } })
    const snapshot = await browser(runtime, { command: 'snapshot', args: [] })
    expect(snapshot).toMatchObject({ outcome: 'ok', output: { result: { data: { page: LABEL } } } })
    expect(JSON.stringify([filled, snapshot, runtime.actions.read(10)])).not.toContain(TOKEN)
  })

  it('masks a snapshot that began before a fill beside it and answered after', async () => {
    const { bin, runtime } = await node()
    writeFileSync(join(bin, 'slow'), '')
    const snapshot = browser(runtime, { command: 'snapshot', args: [] }, 'chat-2')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] })).toMatchObject({ outcome: 'ok' })
    const late = await snapshot
    expect(late).toMatchObject({ outcome: 'ok', output: { result: { data: { page: LABEL } } } })
    expect(JSON.stringify(late)).not.toContain(TOKEN)
  })
})
