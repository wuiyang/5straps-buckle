import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { runCli } from './support/cli.js'
import type { BuckleConfig } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'

// Final review of 0.1.4, finding invoker 701: a script's calls carry the caller's own stage, unset where it named
// none, so a script's browser_command drives the browser the agent opened directly, in the same session, and the
// audit log names the script beside the stage, by its code_run call's requestId.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A node with a fake agent-browser that keeps the page each `--session` opened and answers a snapshot with it. */
async function browsing(): Promise<{ config: BuckleConfig; runtime: BuckleRuntime; sessions: () => string[] }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-code-browser-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const pages = JSON.stringify(join(root, 'pages.json'))
  const log = join(root, 'calls.jsonl')
  const binary = join(root, 'agent-browser')
  writeFileSync(binary, [
    '#!/usr/bin/env node',
    'const fs = require(\'node:fs\')',
    'const argv = process.argv.slice(2)',
    'const session = argv[argv.indexOf(\'--session\') + 1]',
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n')`,
    `const pages = fs.existsSync(${pages}) ? JSON.parse(fs.readFileSync(${pages}, 'utf8')) : {}`,
    `if (argv[0] === 'open') { pages[session] = argv[1]; fs.writeFileSync(${pages}, JSON.stringify(pages)) }`,
    'process.stdout.write(JSON.stringify({ success: true, data: { url: pages[session] ?? \'about:blank\' } }))',
    '',
  ].join('\n'))
  chmodSync(binary, 0o755)
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'browser,code',
    BUCKLE_AGENT_BROWSER_COMMAND: binary, BUCKLE_NETWORK_ALLOW: 'example.com',
  })
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  const sessions = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => {
    const argv = JSON.parse(line) as string[]
    return argv[argv.indexOf('--session') + 1]!
  }) : []
  return { config, runtime, sessions }
}

function call(runtime: BuckleRuntime, requestId: string, tool: string, args: JsonObject, stageId: string | undefined): Promise<InvokeResponse> {
  return runtime.invoke({ sessionId: 'chat-1', approvalWait: { mode: 'none' }, request: { requestId, tool, args, approvalTokens: [], ...(stageId ? { context: { stageId } } : {}) } })
}

/** The page a browser_command answer names, whether the agent made the call or a script returned what it got. */
function page(response: InvokeResponse, fromScript: boolean): unknown {
  if (response.outcome !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(response)}`)
  const answer = (fromScript ? (response.output as { value: unknown }).value : response.output) as { result: { data: { url: string } } }
  return answer.result.data.url
}

const SNAPSHOT = 'return await tools.browser_command({ command: "snapshot", args: [] })'

describe('a code_run script that drives the browser', () => {
  it.each([
    ['with no stage, as an MCP host sends', undefined],
    ['with the stage the caller named', 'message-3'],
  ])('reaches the page the agent opened directly, %s, and the audit log names the script as the parent', async (_how, stageId) => {
    const { runtime, sessions } = await browsing()
    expect(await call(runtime, 'direct-open', 'browser_command', { command: 'open', args: ['example.com'] }, stageId)).toMatchObject({ outcome: 'ok' })

    expect(page(await call(runtime, 'script-1', 'code_run', { script: SNAPSHOT }, stageId), true)).toBe('https://example.com/')
    expect(page(await call(runtime, 'script-2', 'code_run', { script: SNAPSHOT }, stageId), true)).toBe('https://example.com/')
    expect(page(await call(runtime, 'direct-snapshot', 'browser_command', { command: 'snapshot', args: [] }, stageId), false)).toBe('https://example.com/')
    // One browser for the agent and both scripts, never one per script.
    expect(sessions()).toHaveLength(4)
    expect(new Set(sessions()).size).toBe(1)

    const entries = runtime.actions.read(50).filter(entry => entry.event === 'result' && entry.tool === 'browser_command')
    expect(entries.map(entry => [entry.stageId, entry.parentRequestId])).toEqual([[stageId, undefined], [stageId, 'script-1'], [stageId, 'script-2'], [stageId, undefined]])
    expect(entries.filter(entry => entry.parentRequestId).every(entry => /^code:[0-9a-f]{64}:1$/.test(entry.requestId))).toBe(true)
    await runtime.history.close()
  })

  it('prints the parent request of a script\'s call in buckle log', async () => {
    const { config, runtime } = await browsing()
    expect(await call(runtime, 'script-7', 'code_run', { script: SNAPSHOT }, undefined)).toMatchObject({ outcome: 'ok' })
    await runtime.history.close()

    let stdout = ''
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true })
    try {
      expect((await runCli({ confirm: async () => false, argv: ['log'], config })).exitCode).toBe(0)
    } finally { write.mockRestore() }
    // Each entry is its first line and the indented lines under it: the script's call, attempt and result, names its
    // parent, and the code_run call names none.
    const entries = stdout.split(/\n(?=\S)/)
    const parents = (tool: string) => entries.filter(entry => entry.includes(` ${tool} `)).map(entry => /\n {4}parent request: script-7(\n|$)/.test(entry))
    expect(parents('browser_command')).toEqual([true, true])
    expect(parents('code_run')).toEqual([false, false])
  })
})
