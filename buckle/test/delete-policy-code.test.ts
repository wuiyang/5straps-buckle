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

async function node(extra: Record<string, string> = {}): Promise<{ root: string; workspace: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-delete-code-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,code', BUCKLE_APPROVAL_TIMEOUT_MS: '1', ...extra })
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

  // The delete policy review, R1: the mass-delete guard counts what one script removes, so a loop of single deletes, a
  // run of calls at once, and a folder emptied then removed meet it as one call does.
  describe('the mass-delete guard over one script', () => {
    function files(workspace: string, folder: string, count: number): string[] {
      mkdirSync(join(workspace, folder), { recursive: true })
      return Array.from({ length: count }, (_, index) => {
        writeFileSync(join(workspace, `${folder}/f${index}.ts`), '')
        return `${folder}/f${index}.ts`
      })
    }
    const surviving = (workspace: string, names: string[]) => names.filter(name => existsSync(join(workspace, name))).length
    // A limit of 10 keeps the scripts short: each nested call is audited and checkpointed, which is slow on a busy disk.
    const small = { BUCKLE_MASS_DELETE_LIMIT: '10' }

    it('asks once the script\'s own deletes pass the limit, though each call removes one', async () => {
      const { runtime, workspace } = await node(small)
      const names = files(workspace, 'lib/gen', 15)
      const asked = await run(runtime, `for (const path of ${JSON.stringify(names)}) await tools.fs_delete({ paths: [path] })`)
      expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ tool: 'fs_delete', rule: 'write_scope', subject: `delete-batch:${runtime.paths().root}` }] })
      expect(surviving(workspace, names)).toBe(5)
    })

    it('lets the script finish under a grant of that ask, and counts each script on its own', async () => {
      const first = await node(small)
      const names = files(first.workspace, 'lib/gen', 15)
      await first.runtime.grants.grant({ sessionId: 'chat-1', rule: 'write_scope', subject: `delete-batch:${first.runtime.paths().root}`, scope: 'session' })
      expect(await run(first.runtime, `for (const path of ${JSON.stringify(names)}) await tools.fs_delete({ paths: [path] })`)).toMatchObject({ outcome: 'ok' })
      expect(surviving(first.workspace, names)).toBe(0)
      const second = await node(small)
      const some = files(second.workspace, 'lib/a', 6)
      const more = files(second.workspace, 'lib/b', 6)
      expect(await run(second.runtime, `for (const path of ${JSON.stringify(some)}) await tools.fs_delete({ paths: [path] })`)).toMatchObject({ outcome: 'ok' })
      expect(await run(second.runtime, `for (const path of ${JSON.stringify(more)}) await tools.fs_delete({ paths: [path] })`)).toMatchObject({ outcome: 'ok' })
    })

    it('counts calls made at once, so no more than the limit goes before the ask', async () => {
      const { runtime, workspace } = await node(small)
      const names = files(workspace, 'lib/gen', 30)
      const asked = await run(runtime, `await Promise.all(${JSON.stringify(names)}.map(path => tools.fs_delete({ paths: [path] })))`)
      // Each call over the limit asks for itself, all under the one subject.
      expect(asked.outcome).toBe('approval_required')
      const subjects = new Set(asked.outcome === 'approval_required' ? asked.approvals.map(approval => approval.subject) : [])
      expect(subjects).toEqual(new Set([`delete-batch:${runtime.paths().root}`]))
      expect(surviving(workspace, names)).toBeGreaterThanOrEqual(20)
    })

    it('asks for a folder at the top of the workspace that the script emptied first, which holds nothing now', async () => {
      const { runtime, workspace } = await node(small)
      const names = files(workspace, 'src', 3)
      const asked = await run(runtime, `await tools.fs_delete({ paths: ${JSON.stringify(names)} }); await tools.fs_delete({ paths: ["src"] })`)
      expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ tool: 'fs_delete', subject: `delete-tree:${join(runtime.paths().root, 'src')}` }] })
      expect(existsSync(join(workspace, 'src'))).toBe(true)
      expect(surviving(workspace, names)).toBe(0)
    })

    it('still removes an empty folder at the top that the script never took anything from', async () => {
      const { runtime, workspace } = await node()
      mkdirSync(join(workspace, 'empty'))
      expect(await run(runtime, 'await tools.fs_delete({ paths: ["empty"] })')).toMatchObject({ outcome: 'ok' })
      expect(existsSync(join(workspace, 'empty'))).toBe(false)
    })
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
