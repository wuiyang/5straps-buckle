import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { hostEnvironment } from '../common/domain/environment.js'
import { ownRoots, resolveProgram } from '../common/domain/executable.js'
import { createPathView } from '../common/domain/path-view.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import { createEnvironmentPack } from '../common/services/packs/environment/index.js'
import { collectShellHiddenPaths } from '../common/services/shell/shell-filesystem.js'
import type { ProcessRunner } from '../common/types/ports/process-runner.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync('/tmp/buckle-shell-'); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const cwd = join(workspace, 'src'); mkdirSync(cwd)
  writeFileSync(join(workspace, '.env'), 'SYNTHETIC_SECRET=must-not-return')
  writeFileSync(join(cwd, 'credentials.json'), '{"synthetic":"hidden"}')
  const runProcess = vi.fn<ProcessRunner>(async () => ({ exitCode: 0, signal: null, stdout: 'SYNTHETIC_SECRET=must-not-return', stderr: 'sensitive diagnostics', truncated: false, timedOut: false }))
  const context = { requestId: 'shell-check', sessionId: 'shell-session', timeoutMs: 1_000, signal: new AbortController().signal }
  return { root, workspace, cwd, runProcess, context }
}

describe('shell filesystem and network policy', () => {
  it('masks credential files and grants writes only to the approved working directory', async () => {
    const { workspace, cwd, runProcess, context } = fixture()
    const pack = createShellPack({ paths: createPathView({ root: workspace, mount: '/workspace' }), runProcess, sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots: [workspace], hiddenPaths: [], readOnlyPaths: [], unavailableReason: null })
    await pack.tools[0]!.prepare({ command: 'true', args: [], cwd: '/workspace/src' }).execute(context)
    const request = runProcess.mock.calls[0]![0]
    expect(request.args).toContain('--unshare-net')
    const bindings = request.args.flatMap((arg, index) => arg === '--bind' ? [request.args.slice(index + 1, index + 3)] : [])
    expect(bindings).toEqual([[cwd, '/workspace/src']])
    const hidden = request.args.flatMap((arg, index) => arg === '--ro-bind' && request.args[index + 1] === '/dev/null' ? [request.args[index + 2]] : [])
    expect(hidden).toContain('/workspace/.env')
    expect(hidden).toContain('/workspace/src/credentials.json')
  })

  it('rejects caller-selected networking unless the owner enabled it', async () => {
    const { workspace, runProcess, context } = fixture()
    const pack = createShellPack({ paths: createPathView({ root: workspace, mount: null }), runProcess, sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots: [workspace], hiddenPaths: [], readOnlyPaths: [], unavailableReason: null })
    await expect(pack.tools[0]!.prepare({ command: 'true', allowNetwork: true }).execute(context)).rejects.toThrow('networking is disabled')
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('discovers hidden credentials under exposed roots before execution', async () => {
    const { workspace, cwd, context } = fixture()
    const hidden = await collectShellHiddenPaths({ roots: [workspace], protectedPaths: [], signal: context.signal })
    expect(hidden.files.sort()).toEqual([join(workspace, '.env'), join(cwd, 'credentials.json')].sort())
  })
})

describe('optional environment validation', () => {
  /** The pack as createBuiltinPacks builds it over one workspace: the validator resolved, and run with the host environment. */
  function validatorPack(input: { command: string; workspace: string; runProcess: ProcessRunner }) {
    const roots = () => ownRoots({ root: input.workspace, scratchRoots: [] })
    return createEnvironmentPack({ command: input.command, validator: resolveProgram(input.command, roots()), cwd: input.workspace, runProcess: input.runProcess, environment: hostEnvironment(roots) })
  }

  it('returns only validity and never validator output', async () => {
    const { workspace, runProcess, context } = fixture()
    const pack = validatorPack({ command: process.execPath, workspace, runProcess })
    expect(await pack.tools[0]!.prepare({}).execute(context)).toEqual({ valid: true, timedOut: false })
    expect(runProcess.mock.calls[0]?.[0].args).toEqual(['load', '--agent'])
  })

  it('rejects a validator executable supplied by the agent workspace', async () => {
    const { workspace, runProcess, context } = fixture()
    const command = join(workspace, 'fake-validator'); writeFileSync(command, 'fake'); chmodSync(command, 0o755)
    const pack = validatorPack({ command, workspace, runProcess })
    await expect(pack.tools[0]!.prepare({}).execute(context)).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: `${command} is found in or through a workspace of this node, where an agent can write, so Buckle does not run it` })
    expect(runProcess).not.toHaveBeenCalled()
  })
})
