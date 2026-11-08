import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy, WorkspacePolicySchema, type InvokeResponse, type JsonObject } from '@5straps/protocol'
import { runCli } from './support/cli.js'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { settleAuditLogs } from './support/action-log-writer.js'

// Recheck of the final review of 0.1.4, finding shell index.ts:151: the isolated shell checkpoints its own changes, and
// filed a script's under the nested requestId while the invoker filed the same script's file writes under the code_run
// call. Both now go under the invoker's history stage, so restoring that stage reverts the whole script. This machine
// need not have bubblewrap: the sandbox is resolved as bubblewrap, and its process stands in for a command that writes
// one file into the private copy it is handed.

vi.mock('../common/adapters/sandbox/create-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/adapters/sandbox/create-sandbox.js')>()
  return { ...actual, resolveSandbox: () => ({ sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), unavailableReason: null }) }
})
vi.mock('../common/adapters/process-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/adapters/process-runner.js')>()
  return {
    ...actual,
    runProcess: async (request: Parameters<typeof actual.runProcess>[0]) => {
      if (request.command !== '/usr/bin/bwrap') return await actual.runProcess(request)
      // The private copy is the --bind source, bound over the workspace's own path, and the command's working directory.
      const bound = request.args.indexOf('--bind')
      writeFileSync(join(request.args[bound + 1]!, 'shell.md'), 'from the shell')
      return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }
    },
  }
})

const roots: string[] = []
afterEach(async () => { await settleAuditLogs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('files a script\'s shell and file changes under one stage, which restore-stage reverts together', async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-code-shell-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'fs,shell,code', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'true' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  await runtime.policy.apply(WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules: [{ path: '.', write: 'allow' }] } }))
  const invoke = (requestId: string, tool: string, args: JsonObject): Promise<InvokeResponse> => runtime.invoke({ sessionId: 'chat-1', approvalWait: { mode: 'none' }, request: { requestId, tool, args, approvalTokens: [] } })

  const ran = await invoke('script-1', 'code_run', { script: 'await tools.fs_write({ path: "file.md", content: "from the script" }); return await tools.shell_exec({ command: "true" })' })
  expect(ran).toMatchObject({ outcome: 'ok', output: { ok: true } })
  expect([readFileSync(join(workspace, 'file.md'), 'utf8'), readFileSync(join(workspace, 'shell.md'), 'utf8')]).toEqual(['from the script', 'from the shell'])
  expect((await runtime.history.list()).map(checkpoint => [checkpoint.tool, checkpoint.stageId]).sort()).toEqual([['fs_write', 'script-1'], ['shell_exec', 'script-1']])
  await runtime.history.close()

  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    expect((await runCli({ confirm: async () => true, argv: ['history', 'restore-stage', 'script-1', 'chat-1'], config })).exitCode).toBe(0)
  } finally { write.mockRestore() }
  expect([existsSync(join(workspace, 'file.md')), existsSync(join(workspace, 'shell.md'))]).toEqual([false, false])
})
