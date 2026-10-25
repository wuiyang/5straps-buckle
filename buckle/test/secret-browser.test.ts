import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The secret-references slice, parts 5 and 6 (docs/secrets.md), through the browser pack: the value a fill enters is
// handed to agent-browser as its text, and every later browser call that shows the page is masked by it, one that ran
// beside the fill included, and one another Buckle process on the workspace makes, before or after a restart. The
// agent-browser here is a stand-in script that keeps the text it was handed as its page, which close ends, except in an
// attached Chrome, where close only disconnects.

const TOKEN = 'decoy-browser-0123456789'
const LABEL = '[secret:API_TOKEN]'
const STAND_IN = `#!/bin/sh
dir="$(dirname "$0")"
case "$1" in
  fill) printf '%s' "$3" > "$dir/page.txt"; printf '{"success":true,"data":{"filled":"%s"}}' "$3" ;;
  snapshot) [ -f "$dir/slow" ] && sleep 1; printf '{"success":true,"data":{"page":"%s"}}' "$(cat "$dir/page.txt" 2>/dev/null)" ;;
  close) case " $* " in *" --cdp "*) ;; *) rm -f "$dir/page.txt" ;; esac; printf '{"success":true,"data":{}}' ;;
  *) printf '{"success":true,"data":{}}' ;;
esac
`

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A node with the stand-in agent-browser; `open` starts another Buckle process on the same workspace and state. */
async function node(environment: Record<string, string> = {}): Promise<{ bin: string; workspace: string; runtime: BuckleRuntime; open: () => Promise<BuckleRuntime> }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-secret-browser-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const bin = join(root, 'bin')
  mkdirSync(workspace)
  mkdirSync(bin)
  mkdirSync(join(root, 'profile'))
  writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}\n`)
  writeFileSync(join(bin, 'agent-browser'), STAND_IN)
  chmodSync(join(bin, 'agent-browser'), 0o755)
  const settings = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, value.replace('<root>', root)]))
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'browser', BUCKLE_AGENT_BROWSER_COMMAND: join(bin, 'agent-browser'), ...settings })
  const open = async () => {
    const opened = await createRuntime({ config: { ...config, secretFiles: ['.env.local'] } })
    runtimes.push(opened)
    return opened
  }
  return { bin, workspace, runtime: await open(), open }
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

describe('a filled page another Buckle process reaches', () => {
  const PROFILE = { BUCKLE_BROWSER_PROFILE: '<root>/profile' }
  const page = (response: InvokeResponse) => (response as { output?: { result?: { data?: { page?: string } } } }).output?.result?.data?.page

  it('is masked in a process beside the one that filled it, and in one started after it stopped', async () => {
    const { runtime, open } = await node(PROFILE)
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] })).toMatchObject({ outcome: 'ok' })
    const beside = await open()
    const seen = [await browser(beside, { command: 'snapshot', args: [] })]
    // The profile folder's browser outlives the process: closing it is the close command's alone.
    await runtime.closeSessions()
    await beside.closeSessions()
    const restarted = await open()
    seen.push(await browser(restarted, { command: 'snapshot', args: [] }))
    expect(seen.map(page)).toEqual([LABEL, LABEL])
    expect(JSON.stringify(seen)).not.toContain(TOKEN)
  })

  it('is masked in a process that reaches the fresh browser a stopped one left running', async () => {
    const { runtime, open } = await node()
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] }, 'mcp')).toMatchObject({ outcome: 'ok' })
    // The first process stops without closing its browser, as a crash leaves it, and the next one names the same session.
    const next = await open()
    const snapshot = await browser(next, { command: 'snapshot', args: [] }, 'mcp')
    expect(page(snapshot)).toBe(LABEL)
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN)
  })

  it('stays masked in an attached Chrome after close, which only disconnects, and after a restart', async () => {
    const { runtime, open } = await node({ BUCKLE_BROWSER_CDP: 'ws://127.0.0.1:9222/devtools/browser/decoy' })
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] })).toMatchObject({ outcome: 'ok' })
    expect(await browser(runtime, { command: 'close', args: [] })).toMatchObject({ outcome: 'ok' })
    await runtime.closeSessions()
    const snapshot = await browser(await open(), { command: 'snapshot', args: [] })
    expect(page(snapshot)).toBe(LABEL)
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN)
  })
})

describe('the hold a fill leaves on the workspace\'s browsers', () => {
  it('lets close end a browser whose filled value changed in its file, and ends with the last browser', async () => {
    const { workspace, runtime } = await node()
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] })).toMatchObject({ outcome: 'ok' })
    writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}-rotated\n`)
    // The page still holds the old value, which no longer reads: a call that shows it is refused.
    expect(await browser(runtime, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'error' })
    // Close shows no page, so it runs; it ends the workspace's last browser, and the hold with it.
    expect(await browser(runtime, { command: 'close', args: [] })).toMatchObject({ outcome: 'ok' })
    expect(await browser(runtime, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'ok', output: { result: { data: { page: '' } } } })
  })

  it('keeps the hold while another browser of the workspace runs', async () => {
    const { workspace, runtime } = await node()
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] })).toMatchObject({ outcome: 'ok' })
    expect(await browser(runtime, { command: 'snapshot', args: [] }, 'chat-2')).toMatchObject({ outcome: 'ok' })
    expect(await browser(runtime, { command: 'close', args: [] }, 'chat-2')).toMatchObject({ outcome: 'ok' })
    writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}-rotated\n`)
    expect(await browser(runtime, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'error' })
  })
})
