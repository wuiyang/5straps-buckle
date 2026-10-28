import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InvokeResponse, JsonObject } from '@5straps/protocol'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { createPathView } from '../common/domain/path-view.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import { checkpointRoots, createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { ProcessRequest } from '../common/types/ports/process-runner.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Fix brief 6, item 2 (finding 2 of recheck 4): the workspace's own folder is checked at each use, as a mount's source
// is. Swapped for a link since it was registered (by another workspace's agent with write access to its parent, say),
// it was followed by history, the execution lock, and the shell within one request: a code_run script's later calls,
// or a call that waited for its approval. Each now refuses, naming /workspace and never a host path. This machine need
// not have bubblewrap: the sandbox is resolved as bubblewrap, and its process stands in for the command.

const bwrap: ProcessRequest[] = []
const swaps: Array<() => void> = []
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
      bwrap.push(request)
      // The command `swap` stands in for another workspace's agent swapping this one's folder while the call runs.
      if (request.args.at(-1) === 'swap') swaps.shift()?.()
      return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }
    },
  }
})

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  bwrap.length = 0
  swaps.length = 0
})

/** A workspace's folder, and the owner's credentials outside it; `swap` replaces the folder with a link to them. */
function folderBesideCredentials() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-folder-swap-')))
  roots.push(root)
  const site = join(root, 'code', 'site')
  mkdirSync(site, { recursive: true })
  writeFileSync(join(site, 'readme.md'), 'site')
  const ssh = join(root, 'home', '.ssh')
  mkdirSync(ssh, { recursive: true })
  writeFileSync(join(ssh, 'id_ed25519'), 'PRIVATE KEY')
  writeFileSync(join(ssh, 'notes.txt'), 'OWNER PRIVATE NOTES')
  const swap = () => { renameSync(site, `${site}.old`); symlinkSync(ssh, site) }
  return { root, site, ssh, swap }
}

const swapped = "The workspace's folder at /workspace changed on disk since it was registered, so Buckle uses nothing there; the owner repairs it"

describe('the workspace\'s own folder swapped for a link', () => {
  it('is refused by the roots a checkpoint and the execution lock cover, which keep the stored folder', () => {
    const { root, site, swap } = folderBesideCredentials()
    expect(checkpointRoots(site, [], '/workspace')).toEqual([site])
    swap()
    let refusal: unknown
    try { checkpointRoots(site, [], '/workspace') } catch (error) { refusal = error }
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: swapped })
    expect(String(refusal)).not.toContain(root)
    rmSync(site)
    expect(() => checkpointRoots(site, [], null)).toThrow("The workspace's folder is gone from disk, so Buckle uses nothing there; the owner restores it")
  })

  it.each([['without isolation', false], ['under isolation', true]])('is refused by the shell %s, which binds or copies nothing where the link lands', async (_case, isolated) => {
    const { root, site, ssh, swap } = folderBesideCredentials()
    const calls: ProcessRequest[] = []
    const pack = createShellPack({
      paths: createPathView({ root: site, mount: '/workspace' }), sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots: [site], hiddenPaths: [join(root, 'home', '.5straps')], readOnlyPaths: [], unavailableReason: null,
      ...(isolated ? { isolation: { directory: join(root, 'isolation'), maxBytes: 1_000_000, history: { promote: vi.fn() } as never } } : {}),
      runProcess: async (request) => { calls.push(request); return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false } },
    })
    swap()
    const run = pack.tools[0]!.prepare({ command: 'cat', args: ['/workspace/id_ed25519'] }).execute({ requestId: 'swap', sessionId: 'caller', timeoutMs: 1000, signal: new AbortController().signal })
    await expect(run).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: swapped })
    expect(calls).toEqual([])
    expect(existsSync(join(root, 'isolation'))).toBe(false)
    expect(JSON.stringify(calls)).not.toContain(ssh)
  })

  /** A workspace whose commands may work in a scratch root outside its folder, as the reproduction's did. */
  async function runtimeOver(site: string, root: string) {
    mkdirSync(join(root, 'state'), { mode: 0o700, recursive: true })
    mkdirSync(join(root, 'scratch'))
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: site, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'fs,shell,code', BUCKLE_ALLOW_HOST_GIT: 'true', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_WORKSPACE_MOUNT: '/workspace', BUCKLE_SCRATCH_ROOTS: join(root, 'scratch') })
    return { config, runtime: await createRuntime({ config, interaction: fixedInteraction() }) }
  }

  /** Every checkpoint's roots, and the text of every object history holds, across the state directory's history databases. */
  function history(root: string): { roots: string[][]; objects: string[] } {
    const state = join(root, 'state')
    const found = { roots: [] as string[][], objects: [] as string[] }
    const files = readdirSync(state, { recursive: true }).map(String)
    for (const name of files.filter(entry => entry.endsWith('checkpoints.json'))) {
      const data = JSON.parse(readFileSync(join(state, name), 'utf8')) as { checkpoints: Array<{ roots: string[] }> }
      found.roots.push(...data.checkpoints.map(record => record.roots))
    }
    for (const name of files.filter(entry => entry.endsWith('/git/HEAD'))) {
      const git = join(state, name.slice(0, -'/HEAD'.length))
      found.objects.push(execFileSync('git', ['--git-dir', git, 'cat-file', '--batch-all-objects', '--batch']).toString())
    }
    return found
  }

  it('refuses a script\'s later calls once its folder is swapped mid-script, and history never covers where the link lands', async () => {
    const { root, site, ssh, swap } = folderBesideCredentials()
    const { runtime } = await runtimeOver(site, root)
    await runtime.grants.grant({ sessionId: 'chat-1', rule: 'write_scope', subject: site, scope: 'always' })
    swaps.push(swap)
    const invoke = (requestId: string, tool: string, args: JsonObject): Promise<InvokeResponse> => runtime.invoke({ sessionId: 'chat-1', approvalWait: { mode: 'none' }, request: { requestId, tool, args, approvalTokens: [] } })
    const scratch = JSON.stringify(join(root, 'scratch'))
    const ran = await invoke('script-1', 'code_run', { script: `await tools.shell_exec({ command: "swap", cwd: ${scratch} }); const read = await tools.shell_exec({ command: "cat", args: ["/workspace/id_ed25519"], cwd: ${scratch} }).catch(error => String(error)); const written = await tools.fs_write({ path: "/workspace/planted.txt", content: "x" }).catch(error => String(error)); return { read, written }` })
    expect(JSON.stringify(ran)).toContain(swapped)
    expect(JSON.stringify(ran)).not.toContain(root)
    expect(bwrap.map(call => call.args.at(-1))).toEqual(['swap'])
    expect(existsSync(join(ssh, 'planted.txt'))).toBe(false)
    // The swap's own call was checkpointed over the stored folder; no call since, and nothing where the link lands.
    const captured = history(root)
    expect(captured.roots).toEqual([[site, join(root, 'scratch')]])
    expect(captured.objects.length).toBeGreaterThan(0)
    expect(captured.objects.join('\n')).not.toMatch(/PRIVATE/)
    // A runtime opened before the swap answers each later call with the same refusal, reads included.
    expect(await invoke('read-1', 'fs_read', { path: '/workspace/notes.txt' })).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: swapped } })
    await runtime.closeSessions()
    await runtime.history.close()
    runtime.closeWatchers()
  })

  it('refuses a call whose folder was swapped while it waited for its approval, after the approval', async () => {
    const { root, site, ssh, swap } = folderBesideCredentials()
    mkdirSync(join(root, 'state'), { mode: 0o700, recursive: true })
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: site, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'fs', BUCKLE_WORKSPACE_MOUNT: '/workspace' })
    const asked: string[] = []
    const runtime = await createRuntime({ config, interaction: fixedInteraction({ hold: 'prompt', requestCli: async (request) => { asked.push(request.id); swap(); return { status: 'answered', requestId: request.id, answer: { choice: 'once' } } } }) })
    const written = await runtime.invoke({ sessionId: 'chat-1', request: { requestId: 'write-1', tool: 'fs_write', args: { path: '/workspace/planted.txt', content: 'x' }, approvalTokens: [] } })
    expect(asked).toHaveLength(1)
    expect(written).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: swapped } })
    expect(existsSync(join(ssh, 'planted.txt'))).toBe(false)
    expect(history(root).roots).toEqual([])
    await runtime.closeSessions()
    await runtime.history.close()
    runtime.closeWatchers()
  })
})
