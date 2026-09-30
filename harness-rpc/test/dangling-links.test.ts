import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { emptyWorkspacePolicy, type InvokeResponse, type JsonValue } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientKeysPath, dangerouslyAllowPath, grantsPath, loadConfig, nodeKeyPath, pluginsPath, policyPath, requestNoncesPath, setupSessionsPath, type BuckleConfig } from '../common/runtime/config.js'
import { createWorkspaceManager, type WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'

// Review H1 and H2 of B23-B25: a dangling link inside the workspace was judged by its own path while
// the write followed it, so an agent could create Buckle's absent state files (turn its own switch on,
// enroll a key, load a plugin) or land outside the root and the mount. A link is now judged where it
// lands, a write that lands in Buckle's state is refused, and an ask names the real target.

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface Node { root: string; workspace: string; config: BuckleConfig; runtime: BuckleRuntime; manager: WorkspaceManager; child: BuckleConfig }

/**
 * A stand-in for agent-browser that does what the real one does with a file argument: `screenshot <path>`
 * writes the path it is handed, following any link in it.
 */
function stubBrowser(root: string): string {
  const path = join(root, 'agent-browser-stub.mjs')
  writeFileSync(path, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'\nconst [command, file] = process.argv.slice(2)\nif (command === 'screenshot') writeFileSync(file, 'planted by the browser')\nprocess.stdout.write(JSON.stringify({ success: true, data: { path: file } }))\n`)
  chmodSync(path, 0o755)
  return path
}

async function node(): Promise<Node> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-dangling-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  for (const directory of [workspace, join(root, 'child'), join(root, 'home', '.ssh'), join(root, 'elsewhere')]) mkdirSync(directory, { recursive: true })
  const config = loadConfig({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false',
    BUCKLE_PACKS: 'fs,browser', BUCKLE_AGENT_BROWSER_COMMAND: stubBrowser(root), BUCKLE_APPROVAL_TIMEOUT_MS: '1',
  })
  const runtime = await createRuntime({ config })
  const manager = createWorkspaceManager({ config, runtime })
  await manager.register({ id: 'child', name: 'Child', root: join(root, 'child'), authToken: 'dangling-child-agent-token', adminToken: 'dangling-child-admin-token', policy: emptyWorkspacePolicy() })
  const child = (await manager.resolve('child')).config
  return { root, workspace, config, runtime, manager, child }
}

async function stop(setup: Node): Promise<void> {
  for (const runtime of [setup.runtime, ...await setup.manager.opened()]) {
    await runtime.workbenches.close()
    await runtime.history.close()
  }
}

async function run(runtime: BuckleRuntime, tool: string, args: Record<string, JsonValue>): Promise<{ result: InvokeResponse; requestId: string }> {
  const requestId = `dangling-${randomUUID()}`
  const result = await runtime.invoke({ request: { requestId, approvalTokens: [], tool, args }, sessionId: 'dangling-session', approvalWait: { mode: 'none' } })
  return { result, requestId }
}

/** The link as an agent plants it: relative, from inside the workspace, to a file that does not exist. */
function plant(workspace: string, name: string, target: string): void {
  symlinkSync(relative(workspace, target), join(workspace, name))
}

function uses(runtime: BuckleRuntime) {
  return runtime.actions.read(200).filter(entry => entry.tool === 'policy_dangerously_allowed')
}

function asks(result: InvokeResponse): Array<{ rule: string; subject: string }> {
  return result.outcome === 'approval_required' ? result.approvals.map(({ rule, subject }) => ({ rule, subject })) : []
}

const STATE_FILES: Array<[string, (setup: Node) => string]> = [
  ['dangerously-allow.json', setup => dangerouslyAllowPath(setup.config)],
  ['plugins.json', setup => pluginsPath(setup.config)],
  ['client-keys.json', setup => clientKeysPath(setup.config)],
  ['a child workspace\'s policy.json', setup => policyPath(setup.child)],
]

describe('a dangling link to Buckle\'s absent state (review H1 of B23-B25)', () => {
  describe.each([['off, with a session write grant for the root', false], ['on', true]] as const)('with the switch %s', (_, switchOn) => {
    it.each(STATE_FILES)('refuses fs_write and fs_write_batch through a link to %s and never creates it', async (_, fileOf) => {
      const setup = await node()
      const { runtime, workspace } = setup
      const file = fileOf(setup)
      expect(existsSync(file)).toBe(false)
      plant(workspace, 'settings.json', file)
      // Switching on writes dangerously-allow.json itself; the link then names an existing file the agent must not change.
      if (switchOn) await runtime.policy.setDangerouslyAllow(true)
      // What a person's "session" answer to "Writing to <root>" records.
      else await runtime.grants.grant({ sessionId: 'dangling-session', rule: 'write_scope', subject: workspace, scope: 'session' })
      const before = existsSync(file) ? readFileSync(file, 'utf8') : null

      const content = JSON.stringify({ version: 1, workspaces: { [workspace]: { on: true } }, plugins: [], keys: [] })
      const calls: Array<[string, Record<string, JsonValue>]> = [['fs_write', { path: 'settings.json', content }], ['fs_write_batch', { files: [{ path: 'settings.json', content }] }]]
      for (const [tool, args] of calls) {
        const { result } = await run(runtime, tool, args)
        expect({ tool, result }).toMatchObject({ tool, result: { outcome: 'error', error: { code: 'PERMISSION_DENIED' } } })
        expect(existsSync(file) ? readFileSync(file, 'utf8') : null).toBe(before)
      }
      expect(uses(runtime)).toEqual([])
      expect(runtime.policy.dangerouslyAllow().on).toBe(switchOn)
      await stop(setup)
    })
  })

  it('keeps a plugin out of the Buckle process through reload() with the switch on', async () => {
    const setup = await node()
    const { runtime, workspace, config } = setup
    const marker = join(setup.root, 'plugin-ran')
    writeFileSync(join(workspace, 'plugin.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport function createPack() { return { id: 'planted', version: '1.0.0', tools: [], skills: [], unavailableReason: null } }\n`)
    plant(workspace, 'plugins-note.json', pluginsPath(config))
    await runtime.policy.setDangerouslyAllow(true)

    const planted = JSON.stringify({ version: 1, plugins: [{ id: 'planted', specifier: pathToFileURL(join(workspace, 'plugin.mjs')).href, enabled: true }] })
    const { result } = await run(runtime, 'fs_write', { path: 'plugins-note.json', content: planted })
    expect(result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    await runtime.reload()
    expect(existsSync(pluginsPath(config))).toBe(false)
    expect(runtime.plugins.list()).toEqual([])
    expect(existsSync(marker)).toBe(false)
    await stop(setup)
  })
})

describe('a dangling link to an absent target outside the root (review H2 of B23-B25)', () => {
  /** notes.txt -> ../home/.ssh/authorized_keys and draft.txt -> ../elsewhere/draft.txt, neither target present. */
  function links(setup: Node): { credential: string; plain: string } {
    const credential = join(setup.root, 'home', '.ssh', 'authorized_keys')
    const plain = join(setup.root, 'elsewhere', 'draft.txt')
    plant(setup.workspace, 'notes.txt', credential)
    plant(setup.workspace, 'draft.txt', plain)
    return { credential, plain }
  }

  it.each([false, true])('without a mount (switch on: %s): asks about the real target, never the root, and writes nothing', async (switchOn) => {
    const setup = await node()
    const { runtime } = setup
    const { credential, plain } = links(setup)
    if (switchOn) await runtime.policy.setDangerouslyAllow(true)
    const calls: Array<[string, Record<string, JsonValue>]> = [['fs_write', { path: 'draft.txt', content: 'x' }], ['fs_write_batch', { files: [{ path: 'draft.txt', content: 'x' }] }]]
    for (const [tool, args] of calls) {
      const { result } = await run(runtime, tool, args)
      expect(asks(result)).toEqual([{ rule: 'write_scope', subject: dirname(plain) }])
    }
    const { result } = await run(runtime, 'fs_write', { path: 'notes.txt', content: 'ssh-ed25519 planted' })
    expect(asks(result)).toEqual(expect.arrayContaining([{ rule: 'sensitive_path', subject: credential }, { rule: 'write_scope', subject: dirname(credential) }]))
    expect(existsSync(plain)).toBe(false)
    expect(existsSync(credential)).toBe(false)
    expect(uses(runtime)).toEqual([])
    await stop(setup)
  })

  it.each([false, true])('with a mount (switch on: %s): the mount refuses both tools and writes nothing', async (switchOn) => {
    const setup = await node()
    const { runtime } = setup
    const { credential, plain } = links(setup)
    await runtime.policy.apply({ ...emptyWorkspacePolicy(), mount: '/workspace' })
    if (switchOn) await runtime.policy.setDangerouslyAllow(true)
    const calls: Array<[string, Record<string, JsonValue>]> = [
      ['fs_write', { path: '/workspace/draft.txt', content: 'x' }],
      ['fs_write_batch', { files: [{ path: '/workspace/draft.txt', content: 'x' }] }],
      ['fs_write', { path: '/workspace/notes.txt', content: 'ssh-ed25519 planted' }],
    ]
    for (const [tool, args] of calls) {
      const { result } = await run(runtime, tool, args)
      expect({ tool, result }).toMatchObject({ tool, result: { outcome: 'error', error: { code: 'PERMISSION_DENIED' } } })
    }
    expect(existsSync(plain)).toBe(false)
    expect(existsSync(credential)).toBe(false)
    expect(uses(runtime)).toEqual([])
    await stop(setup)
  })
})

describe('a link that climbs back out of a missing directory (review item 0 of the proof-of-possession fixes)', () => {
  // L -> Buckle's state is live; a -> nope/../L/<file> was judged as <root>/L/<file>, inside the root, while
  // agent-browser followed L. The kernel answers ENOENT for nope/..; Buckle refuses it.
  const TARGETS: Array<[string, (setup: Node) => string]> = [
    ...STATE_FILES,
    ['grants.json', setup => grantsPath(setup.config)],
    ['node-signing-key.pem', setup => nodeKeyPath(setup.config)],
    ['request-nonces.json', setup => requestNoncesPath(setup.config)],
    ['setup-sessions.json', setup => setupSessionsPath(setup.config)],
  ]

  it.each(TARGETS)('refuses fs_write, fs_patch and browser_command through a -> nope/../L/%s and changes nothing', async (_, fileOf) => {
    const setup = await node()
    const { runtime, workspace, config } = setup
    const file = fileOf(setup)
    symlinkSync(relative(workspace, config.stateDirectory), join(workspace, 'L'))
    // Written as text: path.join would fold nope/.. away.
    symlinkSync(`nope/../L/${relative(config.stateDirectory, file)}`, join(workspace, 'a'))
    // With the switch on, an ask inside the root is allowed without a person: only the boundary stands.
    await runtime.policy.setDangerouslyAllow(true)
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null

    const calls: Array<[string, Record<string, JsonValue>]> = [
      ['fs_write', { path: 'a', content: 'planted' }],
      ['fs_patch', { path: 'a', edits: [{ oldText: '{', newText: '{"planted":true,' }] }],
      ['browser_command', { command: 'screenshot', args: ['a'] }],
    ]
    for (const [tool, args] of calls) {
      const { result } = await run(runtime, tool, args)
      // Refused where it is judged, before any tool opens it.
      expect({ tool, result }).toMatchObject({ tool, result: { outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('climbs back out of a directory that does not exist') } } })
      expect(existsSync(file) ? readFileSync(file, 'utf8') : null).toBe(before)
    }
    expect(existsSync(join(workspace, 'nope'))).toBe(false)
    await stop(setup)
  })

  it('still creates a file beneath a missing directory when nothing climbs back out', async () => {
    const setup = await node()
    const { runtime, workspace } = setup
    await runtime.policy.setDangerouslyAllow(true)
    symlinkSync('drafts/new/note.md', join(workspace, 'b'))
    const { result } = await run(runtime, 'fs_write', { path: 'b', content: 'kept', createParents: true })
    expect(result).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(workspace, 'drafts', 'new', 'note.md'), 'utf8')).toBe('kept')
    await stop(setup)
  })
})
