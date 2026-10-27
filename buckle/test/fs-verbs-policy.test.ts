import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type InvokeResponse, type JsonObject } from '@5straps/protocol'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { createPiCodemodeVm } from '../common/adapters/script-vm/pi-codemode.js'
import { isToolAllowed } from '../common/domain/tool-policy.js'
import { declare } from '../common/services/packs/code/declarations.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The fs-verbs brief: fs_delete, fs_move, and fs_apply_patch are listed in the fs pack, denied where fs_write is, and
// reachable from a script with typed declarations (owner decision D82: every listed tool is reachable).

const NEW_TOOLS = ['fs_delete', 'fs_move', 'fs_apply_patch'] as const
const roots: string[] = []
const runtimes: BuckleRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(packs = 'fs'): Promise<{ workspace: string; runtime: BuckleRuntime }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-fs-verbs-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: packs, BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
  const runtime = await createRuntime({ config, interaction: fixedInteraction() })
  runtimes.push(runtime)
  return { workspace, runtime }
}

const errorOf = (response: InvokeResponse) => (response.outcome === 'error' ? response.error : null)

/** What TypeScript says of one file, compiled strictly with its default library: the diagnostics' text. */
function typeErrors(source: string): string[] {
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts'], types: [] }
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (name, version) => (name === 'script.ts' ? ts.createSourceFile(name, source, version) : read(name, version))
  const program = ts.createProgram(['script.ts'], options, host)
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

describe('the manifest and the tool policy', () => {
  it('lists the new tools in the fs pack and among the tools an agent sees', async () => {
    const { runtime } = await node()
    const manifest = runtime.manifest()
    expect(manifest.packs.find(pack => pack.id === 'fs')?.toolNames).toEqual(expect.arrayContaining([...NEW_TOOLS]))
    expect(manifest.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([...NEW_TOOLS]))
  })

  it.each(NEW_TOOLS)('reads a denial of fs_write as a denial of %s, and an allowlist must name it', (tool) => {
    expect(isToolAllowed({ tools: { deny: ['fs_write'] } }, tool)).toBe(false)
    expect(isToolAllowed({ tools: { deny: [] } }, tool)).toBe(true)
    expect(isToolAllowed({ tools: { allow: ['fs_write'], deny: [] } }, tool)).toBe(false)
    expect(isToolAllowed({ tools: { allow: ['fs_write', tool], deny: [] } }, tool)).toBe(true)
    expect(isToolAllowed({ tools: { deny: ['fs_read'] } }, tool)).toBe(true)
  })

  it('refuses each of them on a node whose policy denies fs_write, and touches nothing', async () => {
    const { runtime, workspace } = await node()
    writeFileSync(join(workspace, 'a.txt'), 'a\n')
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), tools: { deny: ['fs_write'] } })
    const calls: Array<[string, JsonObject]> = [
      ['fs_delete', { paths: ['a.txt'] }],
      ['fs_move', { from: 'a.txt', to: 'b.txt' }],
      ['fs_apply_patch', { patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n' }],
    ]
    for (const [tool, args] of calls) {
      const response = await runtime.invoke({ request: { requestId: `denied-${tool}`, tool, args, approvalTokens: [] }, sessionId: 'agent' })
      expect(errorOf(response)).toMatchObject({ code: 'PERMISSION_DENIED' })
    }
    expect(existsSync(join(workspace, 'a.txt'))).toBe(true)
  })
})

describe('code mode', () => {
  it('declares each new tool with its typed arguments and what it resolves to', async () => {
    const { runtime } = await node()
    const vm = createPiCodemodeVm()
    for (const tool of runtime.registry().capabilities().filter(item => (NEW_TOOLS as readonly string[]).includes(item.name))) {
      const declared = declare(vm, [tool])
      expect(declared).toMatch(new RegExp(`\\n  ${tool.name}\\(args: \\{`))
      expect(declared).toMatch(/Resolves to \{/)
    }
    // The declarations type-check a script that calls each tool, and refuse one that names an argument none takes.
    const declared = declare(vm, runtime.registry().capabilities().filter(item => (NEW_TOOLS as readonly string[]).includes(item.name)))
    const calls = 'await tools.fs_delete({ paths: ["a.txt"], recursive: true }); await tools.fs_move({ from: "a", to: "b/", replace: true }); await tools.fs_apply_patch({ patch: "--- a/x" })'
    expect(typeErrors(`${declared}\nexport async function script() { ${calls} }`)).toEqual([])
    expect(typeErrors(`${declared}\nexport async function script() { await tools.fs_delete({ path: "a.txt" }) }`).join('\n')).toMatch(/path/)
  })

  it('lets a script call fs_delete, which asks a person as a direct call does, and runs once approved', async () => {
    const { runtime, workspace } = await node('fs,code')
    writeFileSync(join(workspace, 'old.log'), 'old')
    await runtime.grants.grant({ sessionId: 'chat-1', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
    const script = 'const done = await tools.fs_delete({ paths: ["old.log"] }); return done.removed'
    const send = (requestId: string, tokens: string[] = []) => runtime.invoke({ sessionId: 'chat-1', approvalWait: { mode: 'none' }, request: { requestId, tool: 'code_run', args: { script }, approvalTokens: tokens, context: { stageId: 'stage-a' } } })
    const asked = await send('outer-1')
    expect(asked).toMatchObject({ outcome: 'approval_required', approvals: [{ tool: 'fs_delete', rule: 'write_scope', subject: `delete:${runtime.paths().root}` }] })
    const tokens = asked.outcome === 'approval_required' ? asked.approvals.map(approval => approval.token) : []
    for (const token of tokens) await runtime.approvalService.answer({ decision: { token, approved: true, scope: 'once' }, authority: 'admin' })
    expect(await send('outer-2', tokens)).toMatchObject({ outcome: 'ok', output: { ok: true, value: 1, calls: [{ tool: 'fs_delete', status: 'ok' }] } })
    expect(existsSync(join(workspace, 'old.log'))).toBe(false)
  })
})
