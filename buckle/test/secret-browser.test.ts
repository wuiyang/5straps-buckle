import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { workspaceStateKey } from '../common/domain/workspace-key.js'

// The secret-references slice, parts 5 and 6 (docs/user/how-to/secrets.md), through the browser pack: the value a fill enters is
// handed to agent-browser as its text, and every later browser call that shows the page is masked by it, one that ran
// beside the fill included, and one another Buckle process on the workspace makes, before or after a restart. The
// agent-browser here is a stand-in script that keeps the text it was handed as its page, which close ends, except in an
// attached Chrome, where close only disconnects.

const TOKEN = 'decoy-browser-0123456789'
const LABEL = '[secret:API_TOKEN]'
// A close is bare (Slice F4, item 2), so the stand-in tells an attached Chrome by the --cdp its other commands carried.
const STAND_IN = `#!/bin/sh
dir="$(dirname "$0")"
case " $* " in *" --cdp "*) : > "$dir/attached" ;; esac
case "$1" in
  fill) printf '%s' "$3" > "$dir/page.txt"; printf '{"success":true,"data":{"filled":"%s"}}' "$3" ;;
  snapshot) [ -f "$dir/slow" ] && sleep 1; printf '{"success":true,"data":{"page":"%s"}}' "$(cat "$dir/page.txt" 2>/dev/null)" ;;
  close) [ -f "$dir/attached" ] || rm -f "$dir/page.txt"; printf '{"success":true,"data":{}}' ;;
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
async function node(environment: Record<string, string> = {}): Promise<{ bin: string; workspace: string; runtime: BuckleRuntime; open: (changed?: Record<string, string | undefined>) => Promise<BuckleRuntime>; stop: () => void; sessions: string }> {
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
  const configOf = (settings: Record<string, string | undefined>) => configFromEnvironment(Object.fromEntries(Object.entries({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'browser', BUCKLE_AGENT_BROWSER_COMMAND: join(bin, 'agent-browser'), ...settings }).flatMap(([key, value]) => value === undefined ? [] : [[key, value.replace('<root>', root)]])))
  const config = configOf(environment)
  // Another Buckle process on the same workspace and state, under the node's settings or, where named, changed ones.
  const open = async (changed?: Record<string, string | undefined>) => {
    const opened = await createRuntime({ config: { ...(changed ? configOf({ ...environment, ...changed }) : config), secretFiles: ['.env.local'] } })
    runtimes.push(opened)
    return opened
  }
  const sessions = join(config.stateDirectory, 'browser-sessions', workspaceStateKey(config.cwd), 'sessions.json')
  // As a process that stopped without its close step leaves its records: written by a pid that no longer runs.
  const stop = () => {
    const file = sessions
    const state = JSON.parse(readFileSync(file, 'utf8')) as { browsers: Record<string, { writer: unknown }> }
    for (const record of Object.values(state.browsers)) record.writer = { pid: spawnSync(process.execPath, ['-e', '']).pid, instance: 'stopped' }
    writeFileSync(file, JSON.stringify(state))
  }
  return { bin, workspace, runtime: await open(), open, stop, sessions }
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

  it('masks a snapshot that began before a fill beside it, in the same browser, and answered after', async () => {
    const { bin, runtime } = await node()
    // A session's first command runs alone, as it starts the daemon (Codex review L3), so the browser is started first.
    expect(await browser(runtime, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'ok' })
    writeFileSync(join(bin, 'slow'), '')
    const snapshot = browser(runtime, { command: 'snapshot', args: [] })
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

  it('is masked in a process beside the one that filled it, which shares the profile folder\'s browser', async () => {
    const { runtime, open } = await node(PROFILE)
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] })).toMatchObject({ outcome: 'ok' })
    const beside = await open()
    const seen = [await browser(beside, { command: 'snapshot', args: [] })]
    // The process that filled it stops; the one beside it still shows the page.
    await runtime.closeSessions()
    seen.push(await browser(beside, { command: 'snapshot', args: [] }))
    expect(seen.map(page)).toEqual([LABEL, LABEL])
    expect(JSON.stringify(seen)).not.toContain(TOKEN)
  })

  // Slice F4, item 4: the owner's restart kept the hold, as the stopped process's browser and record stayed.
  it.each([['a fresh browser', {}], ['a profile folder', PROFILE]])('in %s a stopped process left running ends at the next start, and the hold with it', async (_, settings) => {
    const { workspace, runtime, open, stop } = await node(settings)
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] }, 'mcp')).toMatchObject({ outcome: 'ok' })
    // The first process stops without closing its browser, as a crash leaves it, and the next one names the same session.
    stop()
    const next = await open()
    writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}-rotated\n`)
    const snapshot = await browser(next, { command: 'snapshot', args: [] }, 'mcp')
    expect(snapshot).toMatchObject({ outcome: 'ok', output: { result: { data: { page: '' } } } })
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

  // Slice F4, item 5: the hold is the browser's that was filled, not the workspace's.
  it('refuses no call of another browser once the filled value changed in its file', async () => {
    const { workspace, runtime } = await node()
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] })).toMatchObject({ outcome: 'ok' })
    writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}-rotated\n`)
    expect(await browser(runtime, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'error' })
    expect(await browser(runtime, { command: 'snapshot', args: [] }, 'chat-2')).toMatchObject({ outcome: 'ok' })
  })

  // Slice F4, item 7: the refusal names the browser that holds the value, and the commands that end it.
  it('names the browser that holds a value no longer read, and the close and the owner\'s command that end it', async () => {
    const { workspace, runtime } = await node()
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'], session: 'login' })).toMatchObject({ outcome: 'ok' })
    writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}-rotated\n`)
    const refused = await browser(runtime, { command: 'snapshot', args: [], session: 'login' })
    const message = (refused as { error?: { message?: string } }).error?.message ?? ''
    expect(message).toMatch(/^The secret API_TOKEN in \.env\.local changed since this browser was filled with it, so this browser call's result could not be masked\. It is held by 1 browser: the fresh browser of caller chat-1, session login, last used \S+, which browser_command close with session login from that caller ends\. Put the file back, or end it; the owner's buckle browser close --workspace \S+ ends every browser of the workspace and drops what they hold\./)
    expect(message).toContain(`--workspace ${runtime.workspaceName()}`)
    writeFileSync(join(workspace, '.env.local'), 'OTHER=decoy-other-0123\n')
    const gone = await browser(runtime, { command: 'snapshot', args: [], session: 'login' })
    expect((gone as { error?: { message?: string } }).error?.message).toMatch(/can no longer be read, so this browser call's result could not be masked: .*\. It is held by 1 browser: the fresh browser of caller chat-1, session login/)
  })

  // Codex review L4: a browser two fills of one reference reached, the file rotated between them, shows both values.
  it('refuses a call on a browser that holds two values of one reference, as the file now gives only one', async () => {
    const { runtime, sessions: file } = await node()
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] })).toMatchObject({ outcome: 'ok' })
    const state = JSON.parse(readFileSync(file, 'utf8')) as { browsers: Record<string, { held: Array<{ digest: string }> }> }
    // The earlier value first, as the hold kept it, then the file's own.
    for (const record of Object.values(state.browsers)) record.held = [{ ...record.held[0]!, digest: 'e'.repeat(64) }, ...record.held]
    writeFileSync(file, JSON.stringify(state))
    expect(await browser(runtime, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'error' })
    // Close shows no page, so it still runs, and ends the browser with both.
    expect(await browser(runtime, { command: 'close', args: [] })).toMatchObject({ outcome: 'ok' })
    expect(await browser(runtime, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'ok' })
  })

  // Codex review L6: an attached Chrome's hold refused every call on a profile folder, which could never show its page.
  it('refuses no call on a profile folder once a value an attached Chrome holds changed in its file', async () => {
    const { workspace, runtime, open } = await node({ BUCKLE_BROWSER_CDP: 'ws://127.0.0.1:9222/devtools/browser/decoy' })
    expect(await browser(runtime, { command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] })).toMatchObject({ outcome: 'ok' })
    expect(await browser(runtime, { command: 'close', args: [] })).toMatchObject({ outcome: 'ok' })
    await runtime.closeSessions()
    const profile = await open({ BUCKLE_BROWSER_CDP: undefined, BUCKLE_BROWSER_PROFILE: '<root>/profile' })
    writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}-rotated\n`)
    expect(await browser(profile, { command: 'snapshot', args: [] })).toMatchObject({ outcome: 'ok' })
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
