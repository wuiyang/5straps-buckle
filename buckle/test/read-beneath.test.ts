import { chmodSync, constants, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonValue } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkAppearedError, openDirectoryBeneath, openRealDirectory, withFileBeneath } from '../common/adapters/beneath.js'
import { createPathView } from '../common/domain/path-view.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { findNames, listTree, readFileEntry } from '../common/services/packs/fs/operations.js'
import { resolveTarget } from '../common/services/invocation/real-path.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction, headlessGrace } from './support/interaction.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// Review item 4 of the proof-of-possession fixes: a read was judged at its real path and then opened by
// name, so a link swapped in between (into Buckle's state, say) was followed. A read now opens the judged
// target beneath a parent reached without following a link, and a listing walks from descriptors.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-read-beneath-'))
  roots.push(root)
  mkdirSync(join(root, 'workspace', 'folder'), { recursive: true })
  mkdirSync(join(root, 'state'))
  writeFileSync(join(root, 'state', 'client-keys.json'), 'owner secret')
  writeFileSync(join(root, 'workspace', 'notes.txt'), 'notes')
  return { root, workspace: join(root, 'workspace'), state: join(root, 'state'), paths: createPathView({ root: join(root, 'workspace'), mount: null }) }
}

/** notes.txt judged as the plain file it was; by the time the read runs it is a link into Buckle's state. */
function swapToState(input: { workspace: string; state: string; name: string }): void {
  rmSync(join(input.workspace, input.name), { recursive: true, force: true })
  symlinkSync(input.state, join(input.workspace, input.name))
}

describe('a read beneath a pinned parent', () => {
  it('refuses when the name it opens became a link after the check, and reads nothing', () => {
    const { workspace, state } = fixture()
    symlinkSync(join(state, 'client-keys.json'), join(workspace, 'swapped.txt'))
    const read = vi.fn()
    expect(() => withFileBeneath(join(workspace, 'swapped.txt'), { flags: constants.O_RDONLY, shown: 'swapped.txt' }, read)).toThrow(/swapped\.txt after it was checked, so nothing was read/)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses when a parent became a link after the check', () => {
    const { workspace, state } = fixture()
    symlinkSync(state, join(workspace, 'moved'))
    expect(() => withFileBeneath(join(workspace, 'moved', 'client-keys.json'), { flags: constants.O_RDONLY }, () => undefined)).toThrow(LinkAppearedError)
  })

  it('refuses to descend into a directory that became a link after it was listed', () => {
    const { workspace, state } = fixture()
    const parent = openRealDirectory(workspace)
    try {
      swapToState({ workspace, state, name: 'folder' })
      expect(() => openDirectoryBeneath(parent, 'folder', 'folder')).toThrow(LinkAppearedError)
    } finally { parent.close() }
  })
})

describe('the fs pack reads only what its permission check judged', () => {
  it('refuses fs_read of a target a link swapped in while the call waited', async () => {
    const { workspace, state, paths } = fixture()
    const judged = join(workspace, 'notes.txt')
    swapToState({ workspace, state: join(state, 'client-keys.json'), name: 'notes.txt' })
    await expect(readFileEntry({ path: 'notes.txt', encoding: 'utf8' }, { paths, authorizeReadTarget: target => target === judged })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it.each([['fs_list', listTree], ['fs_find_names', findNames]] as const)('refuses %s of a directory a link swapped in', async (_, walk) => {
    const { workspace, state, paths } = fixture()
    const judged = join(workspace, 'folder')
    swapToState({ workspace, state, name: 'folder' })
    await expect(walk({ path: 'folder', depth: 1, includeIgnored: false, pattern: '*', limit: 10 }, { paths, authorizeReadTarget: target => target === judged })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('still reads, lists and finds through a link that was judged at its target', async () => {
    const { workspace, paths } = fixture()
    writeFileSync(join(workspace, 'folder', 'AGENTS.md'), 'agents')
    symlinkSync('folder/AGENTS.md', join(workspace, 'CLAUDE.md'))
    symlinkSync('folder', join(workspace, 'docs'))
    await expect(readFileEntry({ path: 'CLAUDE.md', encoding: 'utf8' }, { paths, authorizeReadTarget: target => target === join(workspace, 'folder', 'AGENTS.md') })).resolves.toMatchObject({ path: 'CLAUDE.md', content: 'agents' })
    const judgedFolder = (target: string) => target === join(workspace, 'folder')
    await expect(listTree({ path: 'docs', depth: 1, includeIgnored: false }, { paths, authorizeReadTarget: judgedFolder })).resolves.toMatchObject({ entries: [expect.objectContaining({ path: 'AGENTS.md', type: 'file' })] })
    await expect(findNames({ path: 'docs', pattern: '*.md', limit: 10, includeIgnored: false }, { paths, authorizeReadTarget: judgedFolder })).resolves.toMatchObject({ matches: ['AGENTS.md'] })
  })
})

describe('a read whose target a link replaces during its approval wait', () => {
  it('is refused when it runs, and the state file it now names is never read', async () => {
    const { root, workspace, state } = fixture()
    writeFileSync(join(workspace, '.env'), 'API_TOKEN=workspace-value')
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'buckle-state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
    const runtime = await createRuntime({ config, interaction: fixedInteraction(headlessGrace) })
    // .env asks (sensitive_path); while it waits, it becomes a link to a state file.
    const call = runtime.invoke({ sessionId: 'reader', request: { requestId: 'swap-read', tool: 'fs_read', args: { path: '.env' }, approvalTokens: [] } })
    await vi.waitFor(() => expect(runtime.approvalService.pending()).toHaveLength(1))
    unlinkSync(join(workspace, '.env'))
    symlinkSync(join(state, 'client-keys.json'), join(workspace, '.env'))
    const [ask] = runtime.approvalService.pending()
    expect((await runtime.approvalService.answer({ decision: { token: ask!.token, approved: true, scope: 'once' }, source: SOURCES.cli })).ok).toBe(true)
    const result = await call
    expect(result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED' } })
    expect(JSON.stringify(result)).not.toContain('owner secret')
    await runtime.history.close()
  })
})

describe('a listing whose named root link flips during the walk (review H1 of the second proof-of-possession re-review)', () => {
  // L -> a directory that holds Buckle's state, under an owner read grant; the listing opens it, then L
  // flips to a decoy before the first child is judged. Children read from the pinned directory must be
  // judged there, not by the agent's name, which now leads to the decoy.
  function flipping() {
    const { root, workspace, state, paths } = fixture()
    mkdirSync(join(root, 'decoy'))
    symlinkSync(root, join(workspace, 'L'))
    let flipped = false
    const judged: string[] = []
    const context = {
      paths,
      authorizeReadTarget: (target: string) => target === root,
      // The invoker's rule for a mid-call read, reduced to the state boundary: judged where the path lands now.
      authorizeRead: async (path: string) => {
        if (!flipped) {
          flipped = true
          unlinkSync(join(workspace, 'L'))
          symlinkSync(join(root, 'decoy'), join(workspace, 'L'))
        }
        judged.push(path)
        const target = resolveTarget(path)
        return !(target === state || target.startsWith(`${state}/`))
      },
    }
    return { root, context, judged }
  }

  it('fs_list judges each child at its real path, so the state directory is neither listed nor walked', async () => {
    const { root, context, judged } = flipping()
    const listed = await listTree({ path: 'L', depth: 2, includeIgnored: true }, context) as { entries: Array<{ path: string }> }
    const shown = listed.entries.map(entry => entry.path)
    expect(shown).toEqual(expect.arrayContaining(['decoy', 'workspace']))
    expect(shown.filter(path => path === 'state' || path.startsWith('state/'))).toEqual([])
    expect(judged.every(path => path.startsWith(`${root}/`))).toBe(true)
  })

  it('fs_find_names judges each child at its real path, so nothing in the state directory matches', async () => {
    const { context } = flipping()
    const found = await findNames({ path: 'L', pattern: '**/client-keys.json', limit: 10, includeIgnored: true }, context) as { matches: string[] }
    expect(found.matches).toEqual([])
  })
})

describe('a hard link to Buckle\'s state (review L3 of the second proof-of-possession re-review)', () => {
  /** A stand-in for agent-browser: `upload <selector> <file>` succeeds and names the file it was handed. */
  function stubBrowser(root: string): string {
    const path = join(root, 'agent-browser-stub.mjs')
    writeFileSync(path, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ success: true, data: { file: process.argv[4] } }))\n`)
    chmodSync(path, 0o755)
    return path
  }

  async function linked() {
    const { root, workspace } = fixture()
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'buckle-state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,browser', BUCKLE_AGENT_BROWSER_COMMAND: stubBrowser(root), BUCKLE_APPROVAL_TIMEOUT_MS: '1' })
    const runtime = await createRuntime({ config })
    // A state file with owner content, and a workspace name for the same file, as a process that can read the state could make.
    writeFileSync(join(config.stateDirectory, 'owner-state.json'), '{"owner":"secret"}')
    linkSync(join(config.stateDirectory, 'owner-state.json'), join(workspace, 'linked.json'))
    const invoke = (tool: string, args: Record<string, JsonValue>) => runtime.invoke({ sessionId: 'reader', request: { requestId: `hard-link-${tool}-${Math.random()}`, tool, args, approvalTokens: [] }, approvalWait: { mode: 'none' } })
    return { workspace, runtime, invoke }
  }

  it.each<[string, Record<string, JsonValue>]>([
    ['fs_read', { path: 'linked.json' }],
    ['fs_read_batch', { paths: ['linked.json'] }],
    ['browser_command', { command: 'upload', args: ['#file', 'linked.json'] }],
  ])('refuses %s of it, and returns none of its content', async (tool, args) => {
    const { runtime, invoke } = await linked()
    const result = await invoke(tool, args)
    expect(result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('hard link on the disk that holds Buckle\'s state') } })
    expect(JSON.stringify(result)).not.toContain('secret')
    await runtime.history.close()
  })

  // Review L3: the exemption matched a node_modules component anywhere in the host path, the root's own included.
  it('refuses a hard link to state in a workspace root that sits beneath a node_modules directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-read-beneath-root-'))
    roots.push(root)
    const workspace = join(root, 'node_modules', 'project')
    mkdirSync(workspace, { recursive: true })
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'buckle-state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' })
    const runtime = await createRuntime({ config })
    writeFileSync(join(config.stateDirectory, 'owner-state.json'), '{"owner":"secret"}')
    linkSync(join(config.stateDirectory, 'owner-state.json'), join(workspace, 'linked.json'))
    const result = await runtime.invoke({ sessionId: 'reader', request: { requestId: 'root-under-node-modules', tool: 'fs_read', args: { path: 'linked.json' }, approvalTokens: [] }, approvalWait: { mode: 'none' } })
    expect(result).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('hard link on the disk that holds Buckle\'s state') } })
    expect(JSON.stringify(result)).not.toContain('secret')
    await runtime.history.close()
  })

  it('still reads a hard-linked file under node_modules, as pnpm links its store there', async () => {
    const { workspace, runtime, invoke } = await linked()
    mkdirSync(join(workspace, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(workspace, 'store-file.js'), 'module.exports = 1')
    linkSync(join(workspace, 'store-file.js'), join(workspace, 'node_modules', 'left-pad', 'index.js'))
    expect(await invoke('fs_read', { path: 'node_modules/left-pad/index.js' })).toMatchObject({ outcome: 'ok', output: { content: 'module.exports = 1' } })
    await runtime.history.close()
  })
})
