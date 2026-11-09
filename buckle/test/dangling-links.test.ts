import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { emptyWorkspacePolicy, type InvokeResponse, type JsonValue } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientKeysPath, dangerouslyAllowPath, grantsPath, nodeKeyPath, pluginsPath, policyPath, requestNoncesPath, setupSessionsPath, type BuckleConfig } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import type { WorkspaceManager } from '../common/services/workspaces/workspace-manager.js'
import { byName, idOf, registerWorkspace, workspacesOf } from './support/workspaces.js'
import { createRuntime, type BuckleRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'

// Review H1 and H2 of B23-B25: a dangling link inside the workspace was judged by its own path while
// the write followed it, so an agent could create Buckle's absent state files (turn its own switch on,
// enroll a key, load a plugin) or land outside the root and the mount. A link is now judged where it
// lands, a write that lands in Buckle's state is refused, and an ask names the real target.

/**
 * A hook run once, right after the first directory read whose entries it accepts: a listing has opened
 * its judged directory and has judged none of its children yet (review H1 of the second re-review).
 */
const listing = vi.hoisted(() => ({ afterRead: undefined as undefined | ((names: string[]) => boolean) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const readdir = (async (...args: unknown[]) => {
    const read = await (original.readdir as (...input: unknown[]) => Promise<Array<string | { name: string }>>)(...args)
    if (listing.afterRead?.(read.map(entry => typeof entry === 'string' ? entry : entry.name))) listing.afterRead = undefined
    return read
  }) as typeof original.readdir
  return { ...original, readdir, default: { ...original, readdir } }
})

const roots: string[] = []
afterEach(async () => {
  listing.afterRead = undefined
  vi.restoreAllMocks()
  await settleAuditLogs()
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
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false',
    BUCKLE_PACKS: 'fs,browser', BUCKLE_AGENT_BROWSER_COMMAND: stubBrowser(root), BUCKLE_APPROVAL_TIMEOUT_MS: '1',
  })
  const manager = await workspacesOf(config)
  const runtime = (await byName(manager, 'workspace')).runtime
  await registerWorkspace(manager, { id: 'child', name: 'Child', dir: join(root, 'child'), policy: emptyWorkspacePolicy() })
  await manager.updateSettings(idOf(manager, 'child'), settings => ({ ...settings, packs: { ...settings.packs, enabled: ['fs', 'browser'] } }))
  const child = (await byName(manager, 'child')).config
  return { root, workspace, config, runtime, manager, child }
}

async function stop(setup: Node): Promise<void> {
  for (const runtime of await setup.manager.opened()) {
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

async function uses(runtime: BuckleRuntime) {
  return (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === 'policy_dangerously_allowed')
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
      if (switchOn) await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
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
      expect(await uses(runtime)).toEqual([])
      expect(runtime.policy.dangerouslyAllow().mode).toBe(switchOn ? 'on' : 'off')
      await stop(setup)
    })
  })

  it('keeps a plugin out of the Buckle process through reload() with the switch on', async () => {
    const setup = await node()
    const { runtime, workspace, config } = setup
    const marker = join(setup.root, 'plugin-ran')
    writeFileSync(join(workspace, 'plugin.mjs'), `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\nexport function createPack() { return { id: 'planted', version: '1.0.0', tools: [], skills: [], unavailableReason: null } }\n`)
    plant(workspace, 'plugins-note.json', pluginsPath(config))
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })

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
    if (switchOn) await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    const calls: Array<[string, Record<string, JsonValue>]> = [['fs_write', { path: 'draft.txt', content: 'x' }], ['fs_write_batch', { files: [{ path: 'draft.txt', content: 'x' }] }]]
    for (const [tool, args] of calls) {
      const { result } = await run(runtime, tool, args)
      expect(asks(result)).toEqual([{ rule: 'write_scope', subject: dirname(plain) }])
    }
    const { result } = await run(runtime, 'fs_write', { path: 'notes.txt', content: 'ssh-ed25519 planted' })
    expect(asks(result)).toEqual(expect.arrayContaining([{ rule: 'sensitive_path', subject: credential }, { rule: 'write_scope', subject: dirname(credential) }]))
    expect(existsSync(plain)).toBe(false)
    expect(existsSync(credential)).toBe(false)
    expect(await uses(runtime)).toEqual([])
    await stop(setup)
  })

  it.each([false, true])('with a mount (switch on: %s): the mount refuses both tools and writes nothing', async (switchOn) => {
    const setup = await node()
    const { runtime } = setup
    const { credential, plain } = links(setup)
    await runtime.policy.setMount('/workspace')
    if (switchOn) await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
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
    expect(await uses(runtime)).toEqual([])
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

  it.each(TARGETS)('refuses every file tool through a -> nope/../L/%s and changes nothing', async (_, fileOf) => {
    const setup = await node()
    const { runtime, workspace, config } = setup
    const file = fileOf(setup)
    symlinkSync(relative(workspace, config.stateDirectory), join(workspace, 'L'))
    // Written as text: path.join would fold nope/.. away.
    symlinkSync(`nope/../L/${relative(config.stateDirectory, file)}`, join(workspace, 'a'))
    // With the switch on, an ask inside the root is allowed without a person: only the boundary stands.
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null

    // Review L1 of the second re-review: every tool that takes a path, not the writers alone.
    const calls: Array<[string, Record<string, JsonValue>]> = [
      ['fs_write', { path: 'a', content: 'planted' }],
      ['fs_write_batch', { files: [{ path: 'a', content: 'planted' }] }],
      ['fs_patch', { path: 'a', edits: [{ oldText: '{', newText: '{"planted":true,' }] }],
      ['fs_read', { path: 'a' }],
      ['fs_read_batch', { paths: ['a'] }],
      ['fs_list', { path: 'a', depth: 1 }],
      ['fs_find_names', { path: 'a', pattern: '*' }],
      ['browser_command', { command: 'screenshot', args: ['a'] }],
      ['browser_command', { command: 'upload', args: ['#file', 'a'] }],
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
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    symlinkSync('drafts/new/note.md', join(workspace, 'b'))
    const { result } = await run(runtime, 'fs_write', { path: 'b', content: 'kept', createParents: true })
    expect(result).toMatchObject({ outcome: 'ok' })
    expect(readFileSync(join(workspace, 'drafts', 'new', 'note.md'), 'utf8')).toBe('kept')
    await stop(setup)
  })
})

describe('a `..` after a link whose target is missing or a file (review L2 of the second proof-of-possession re-review)', () => {
  // E -> D/../x.txt: the kernel answers ENOENT (D -> nope) or ENOTDIR (D -> a file) for D/..; read as
  // text it named <root>/x.txt, which the write then created.
  it.each([
    ['a link to a missing target', (workspace: string) => { symlinkSync('nope', join(workspace, 'D')) }],
    ['a link to a file', (workspace: string) => { writeFileSync(join(workspace, 'file.txt'), 'kept'); symlinkSync('file.txt', join(workspace, 'D')) }],
  ])('refuses a write through %s and a following `..`, and creates nothing', async (_, plantD) => {
    const setup = await node()
    const { runtime, workspace } = setup
    plantD(workspace)
    symlinkSync('D/../x.txt', join(workspace, 'E'))
    await runtime.policy.setDangerouslyAllow('on', { ignoreWarning: false })
    const calls: Array<[string, Record<string, JsonValue>]> = [['fs_write', { path: 'E', content: 'planted' }], ['fs_write_batch', { files: [{ path: 'E', content: 'planted' }] }], ['fs_read', { path: 'E' }]]
    for (const [tool, args] of calls) {
      const { result } = await run(runtime, tool, args)
      expect({ tool, result }).toMatchObject({ tool, result: { outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('climbs back out') } } })
    }
    expect(existsSync(join(workspace, 'x.txt'))).toBe(false)
    expect(existsSync(join(workspace, 'nope'))).toBe(false)
    await stop(setup)
  })
})

describe('a listing whose named root link flips during the walk (review H1 of the second proof-of-possession re-review)', () => {
  // L -> the directory that holds Buckle's state, under an owner's session read grant on it. Once the
  // listing has read that directory, L flips to a decoy the grant also covers: a child judged by the
  // agent's name (L/state) would land in the decoy and pass, while the entries come from the real one.
  it.each<[string, Record<string, JsonValue>]>([
    ['fs_list', { path: 'L', depth: 2, includeIgnored: true }],
    ['fs_find_names', { path: 'L', pattern: '**', limit: 500, includeIgnored: true }],
  ])('%s never shows Buckle\'s state, whatever L names by the time a child is judged', async (tool, args) => {
    const setup = await node()
    const { runtime, workspace, root } = setup
    symlinkSync(root, join(workspace, 'L'))
    await runtime.grants.grant({ sessionId: 'dangling-session', rule: 'read_scope', subject: root, scope: 'session' })
    let flipped = false
    listing.afterRead = (names) => {
      if (!names.includes('state')) return false
      unlinkSync(join(workspace, 'L'))
      symlinkSync(join(root, 'elsewhere'), join(workspace, 'L'))
      flipped = true
      return true
    }
    const { result } = await run(runtime, tool, args)
    expect(flipped).toBe(true)
    expect(result).toMatchObject({ outcome: 'ok' })
    const output = (result as Extract<InvokeResponse, { outcome: 'ok' }>).output as { entries?: Array<{ path: string }>; matches?: string[] }
    const shown = output.entries?.map(entry => entry.path) ?? output.matches ?? []
    expect(shown).toEqual(expect.arrayContaining(['elsewhere', 'home']))
    expect(shown.filter(path => path === 'state' || path.startsWith('state/'))).toEqual([])
    await stop(setup)
  })
})

// A link onto a root folder named like a drive (`/c:`) is refused where it lands, as pathe reads `/c:` as a drive, and
// that refusal failed the whole listing or name search of the directory holding it. It is left out instead, as any
// entry the call cannot reach is.
describe('a dangling link onto /c: in a listed directory', () => {
  it('is left out of fs_list and fs_find_names, which go on with every other entry', async () => {
    const setup = await node()
    writeFileSync(join(setup.workspace, 'kept.txt'), 'kept')
    symlinkSync('/c:', join(setup.workspace, 'L1'))
    expect((await run(setup.runtime, 'fs_list', { path: '.' })).result).toMatchObject({ outcome: 'ok', output: { entries: [expect.objectContaining({ path: 'kept.txt' })] } })
    expect((await run(setup.runtime, 'fs_find_names', { path: '.', pattern: '*' })).result).toMatchObject({ outcome: 'ok', output: { matches: ['kept.txt'] } })
    await stop(setup)
  })
})
