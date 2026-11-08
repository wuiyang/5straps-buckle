import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DECISION_AI_FILE_KEYS, legacyWorkspaceRoot, loadConfig, unreadWorkspaceDefaults, workspaceConfig, type BuckleConfig, type EnvironmentLayers } from '../common/runtime/config.js'
import { workspaceIdFor } from '../common/services/workspaces/workspace-id.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { scopeOf, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { settleAuditLogs } from './support/action-log-writer.js'

// The decision AI's keys and addresses (D91, fix brief 1 item 17) come from the node's environment file alone where the
// process entry reads its defaults from it, as main.ts does: a shell's or an MCP config's env, which an agent may write,
// can neither send the owner's key to a host it names nor stand in a key of its own, and buckle serve names each one it
// did not read, never its value.

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const CALLER = {
  BUCKLE_JUDGE_BASE_URL: 'https://collector.example/v1', BUCKLE_JUDGE_API_KEY: 'caller-judge-key',
  BUCKLE_QUICK_JUDGE_BASE_URL: 'https://collector.example/quick', BUCKLE_QUICK_JUDGE_API_KEY: 'caller-quick-key',
  BUCKLE_SOCKET_BASE_URL: 'https://collector.example/socket', BUCKLE_SOCKET_API_KEY: 'caller-socket-key',
}

/** A node's configuration as main.ts builds it: the file's values, the caller's environment over them, and defaults from the file alone. */
function layered(file: Record<string, string> | null, caller: NodeJS.ProcessEnv) {
  const layers: EnvironmentLayers = { file: file === null ? null : { path: '/state/buckle.env', values: file }, caller, defaultsFromFileAlone: true }
  return { layers, node: loadConfig({ ...file, ...caller }, process.platform, layers) }
}

describe('the decision AI\'s keys and addresses', () => {
  it('come from the environment file alone, and the caller\'s are named as not read', () => {
    const { layers, node } = layered({ BUCKLE_JUDGE_API_KEY: 'file-judge-key' }, CALLER)
    expect(node).toMatchObject({ judgeApiKey: 'file-judge-key', judgeBaseUrl: undefined, quickJudgeApiKey: undefined, quickJudgeBaseUrl: undefined, socketApiKey: undefined, socketBaseUrl: undefined })
    expect(unreadWorkspaceDefaults(layers)).toEqual([...DECISION_AI_FILE_KEYS])
    expect(JSON.stringify(unreadWorkspaceDefaults(layers))).not.toContain('caller-judge-key')
  })

  it('are none where the node has no file, whatever the caller sets, and a caller building a config from one environment still reads its own', () => {
    expect(layered(null, CALLER).node).toMatchObject({ judgeApiKey: undefined, judgeBaseUrl: undefined, quickJudgeApiKey: undefined, socketApiKey: undefined })
    expect(loadConfig({ ...CALLER })).toMatchObject({ judgeApiKey: 'caller-judge-key', judgeBaseUrl: 'https://collector.example/v1' })
  })

  it('never send the node\'s key to a host the caller\'s env names', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-judge-layers-'))
    const state = mkdtempSync(join(tmpdir(), 'buckle-judge-layers-state-'))
    roots.push(root, state)
    writeFileSync(join(root, 'job.py'), 'print(1)\n')
    const file = {
      BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: state, BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false',
      BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1', BUCKLE_APPROVAL_JUDGE: 'automated', BUCKLE_JUDGE_API_KEY: 'file-judge-key',
    }
    const { node } = layered(file, CALLER)
    const dir = legacyWorkspaceRoot({ node, platform: process.platform })
    const config: BuckleConfig = workspaceConfig(node, { id: workspaceIdFor(dir), name: basename(dir), dir, ...scopeOf(WorkspaceSettingsSchema.parse({ version: 1 }), node.workspaceDefaults) })
    const sent: Array<{ url: string; authorization: string | null; body: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), body: String(init?.body ?? '') })
      const verdict = { command_echo: 'python3 job.py', level: 'safe', confidence: 0.95, reasoning: 'Prints one.' }
      return Response.json({ id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: 'gpt-6-luna', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(verdict) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    })
    const runtime = await createRuntime({ config })
    runtimes.push(runtime)
    const execute = vi.fn(async () => 'executed')
    vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command: 'python3', args: ['job.py'] }], execute })
    const response = await runtime.invoke({ request: { requestId: 'layers-1', approvalTokens: [], tool: 'shell_exec', args: {} }, sessionId: 'layers', approvalWait: { mode: 'none' } })
    expect(response).toMatchObject({ outcome: 'ok' })
    expect(sent.map(item => item.url)).toEqual(['https://api.openai.com/v1/chat/completions'])
    expect(sent[0]!.authorization).toBe('Bearer file-judge-key')
    expect(JSON.stringify(sent)).not.toContain('collector.example')
    expect(JSON.stringify(sent)).not.toContain('caller-judge-key')
  })
})
