import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The delete policy brief, item 4: code mode sees the same policy, as a script's fs_delete and fs_move calls go through
// the rules a direct call meets (owner decision D82: every listed tool is reachable, and judged alike).

const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(): Promise<{ root: string; workspace: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-delete-code-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,code', BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  runtimes.push(runtime)
  await runtime.grants.grant({ sessionId: 'chat-1', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
  return { root, workspace, runtime }
}

let sequence = 0
const run = (runtime: BuckleRuntime, script: string) => runtime.invoke({ sessionId: 'chat-1', approvalWait: { mode: 'none' }, request: { requestId: `script-${++sequence}`, tool: 'code_run', args: { script }, approvalTokens: [], context: { stageId: 'stage-a' } } })

describe('a script under the default delete policy', () => {
  it('deletes and replaces inside the workspace\'s folder where writes are granted, asking nobody', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src/old.ts'), 'old')
    writeFileSync(join(workspace, 'src/next.ts'), 'next')
    writeFileSync(join(workspace, 'src/main.ts'), 'main')
    const script = 'const gone = await tools.fs_delete({ paths: ["src/old.ts"] }); const moved = await tools.fs_move({ from: "src/next.ts", to: "src/main.ts", replace: true }); return [gone.removed, moved.replaced]'
    expect(await run(runtime, script)).toMatchObject({ outcome: 'ok', output: { ok: true, value: [1, true], calls: [{ tool: 'fs_delete', status: 'ok' }, { tool: 'fs_move', status: 'ok' }] } })
    expect(existsSync(join(workspace, 'src/old.ts'))).toBe(false)
    expect(readFileSync(join(workspace, 'src/main.ts'), 'utf8')).toBe('next')
  })

  it('asks at the floor for a folder at the top of the workspace, as a direct call does', async () => {
    const { runtime, workspace } = await node()
    mkdirSync(join(workspace, 'build'))
    writeFileSync(join(workspace, 'build/out.js'), '1')
    const asked = await run(runtime, 'await tools.fs_delete({ paths: ["build"], recursive: true })')
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ tool: 'fs_delete', rule: 'write_scope', subject: `delete-tree:${join(runtime.paths().root, 'build')}` }] })
    expect(existsSync(join(workspace, 'build/out.js'))).toBe(true)
  })

  it('asks at the floor for a delete outside the workspace\'s folder, offering its folder and subfolders', async () => {
    const { root, runtime } = await node()
    mkdirSync(join(root, 'outside'))
    writeFileSync(join(root, 'outside/a.txt'), 'a')
    const asked = await run(runtime, `await tools.fs_delete({ paths: [${JSON.stringify(join(root, 'outside/a.txt'))}] })`)
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ tool: 'fs_delete', subject: `delete:${join(root, 'outside')}`, widerSubject: `delete-below:${join(root, 'outside')}` }] })
    expect(existsSync(join(root, 'outside/a.txt'))).toBe(true)
  })
})
