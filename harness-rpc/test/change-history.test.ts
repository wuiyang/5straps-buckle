import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'
import { snapshot } from '../common/services/history/snapshot.js'
import { loadConfig } from '../common/runtime/config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { SPAWN_TEST_TIMEOUT_MS } from './spawn-timeout.js'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
async function fixture(maxBytes = 1_000_000) {
  const root = mkdtempSync('/tmp/buckle-history-'); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const options = { directory: join(root, 'history'), excluded: [], maxBytes, retentionDays: 30 }
  const history = await openChangeHistory(options)
  const details = { sessionId: 'test-session', stageId: 'edit-message', tool: 'test-write', roots: [workspace] }
  return { root, workspace, options, history, details }
}

describe('Git-independent file history', () => {
  it('restores created, modified, removed, binary and executable files without Git', async () => {
    const { workspace, history, details } = await fixture()
    const file = join(workspace, 'before.bin'); writeFileSync(file, Buffer.from([0, 255, 13])); chmodSync(file, 0o755)
    const removed = join(workspace, 'removed'); writeFileSync(removed, 'original')
    await history.run(details, async () => { writeFileSync(file, 'changed'); chmodSync(file, 0o600); rmSync(removed); mkdirSync(join(workspace, 'new')); writeFileSync(join(workspace, 'new', 'file'), 'new') })
    const checkpoint = (await history.list())[0]!
    const inverse = await history.restore(checkpoint.id)
    expect(readFileSync(file)).toEqual(Buffer.from([0, 255, 13]))
    expect(statSync(file).mode & 0o777).toBe(0o755)
    expect(readFileSync(removed, 'utf8')).toBe('original')
    expect(existsSync(join(workspace, 'new'))).toBe(false)
    await history.restore(inverse.id)
    expect(readFileSync(file, 'utf8')).toBe('changed')
    expect(existsSync(join(workspace, 'new', 'file'))).toBe(true)
  })

  it('keeps failed-tool changes reversible', async () => {
    const { workspace, history, details } = await fixture()
    const file = join(workspace, 'partial')
    await expect(history.run(details, async () => { writeFileSync(file, 'partial'); throw new Error('tool failed') })).rejects.toThrow('tool failed')
    await history.restore((await history.list())[0]!.id)
    expect(existsSync(file)).toBe(false)
  })

  it('refuses conflicts before changing any file and preserves unrelated newer files', async () => {
    const { workspace, history, details } = await fixture()
    const file = join(workspace, 'file'); writeFileSync(file, 'before')
    await history.run(details, async () => { writeFileSync(file, 'agent'); writeFileSync(join(workspace, 'created'), 'agent') })
    writeFileSync(file, 'owner')
    await expect(history.restore((await history.list())[0]!.id)).rejects.toThrow('Restore conflict')
    expect(readFileSync(join(workspace, 'created'), 'utf8')).toBe('agent')
    writeFileSync(file, 'agent'); writeFileSync(join(workspace, 'unrelated'), 'owner')
    await history.restore((await history.list())[0]!.id)
    expect(readFileSync(join(workspace, 'unrelated'), 'utf8')).toBe('owner')
  })

  it('refuses to remove newly added descendants of an agent-created directory', async () => {
    const { workspace, history, details } = await fixture()
    await history.run(details, async () => { mkdirSync(join(workspace, 'new')) })
    writeFileSync(join(workspace, 'new', 'owner-file'), 'owner')
    await expect(history.restore((await history.list())[0]!.id)).rejects.toThrow('Restore conflict')
    expect(existsSync(join(workspace, 'new', 'owner-file'))).toBe(true)
  })

  it('restores symlinks without reading or overwriting their targets', async () => {
    const { root, workspace, history, details } = await fixture()
    const external = join(root, 'external'); writeFileSync(external, 'outside')
    const link = join(workspace, 'link'); symlinkSync(external, link)
    await history.run(details, async () => { rmSync(link); writeFileSync(link, 'replacement') })
    await history.restore((await history.list())[0]!.id)
    expect(readlinkSync(link)).toBe(external)
    expect(readFileSync(external, 'utf8')).toBe('outside')
  })

  it('restores every checkpoint in a message stage while retaining unrelated stage changes', async () => {
    const { workspace, history, details } = await fixture()
    const file = join(workspace, 'file'); writeFileSync(file, 'before')
    await history.run(details, async () => { writeFileSync(file, 'one') })
    await history.run({ ...details, stageId: 'other-message' }, async () => { writeFileSync(join(workspace, 'other'), 'keep') })
    await history.run(details, async () => { writeFileSync(file, 'two') })
    await history.restoreStage(details.stageId, details.sessionId)
    expect(readFileSync(file, 'utf8')).toBe('before')
    expect(readFileSync(join(workspace, 'other'), 'utf8')).toBe('keep')
  })

  it('refuses stage restore when another writer intervened on the same path', async () => {
    const { workspace, history, details } = await fixture()
    const file = join(workspace, 'file'); writeFileSync(file, 'before')
    await history.run(details, async () => { writeFileSync(file, 'one') })
    writeFileSync(file, 'owner')
    await history.run(details, async () => { writeFileSync(file, 'two') })
    await expect(history.restoreStage(details.stageId, details.sessionId)).rejects.toThrow('interleaved')
    expect(readFileSync(file, 'utf8')).toBe('two')
  })

  it('serializes concurrent runtimes around the entire mutation', async () => {
    const { workspace, history, details, options } = await fixture()
    const second = await openChangeHistory(options)
    const file = join(workspace, 'counter'); writeFileSync(file, '0')
    await Promise.all([history, second].map(instance => instance.run(details, async () => {
      const before = Number(readFileSync(file, 'utf8'))
      await new Promise(resolve => setTimeout(resolve, 30))
      writeFileSync(file, String(before + 1))
    })))
    expect(readFileSync(file, 'utf8')).toBe('2')
    await history.restoreStage(details.stageId, details.sessionId)
    expect(readFileSync(file, 'utf8')).toBe('0')
  })

  it('fails before a mutation when the initial snapshot exceeds the budget', async () => {
    const { workspace, history, details } = await fixture(8)
    writeFileSync(join(workspace, 'large'), 'larger than eight bytes')
    const execute = vi.fn(async () => undefined)
    await expect(history.run(details, execute)).rejects.toThrow('limit')
    expect(execute).not.toHaveBeenCalled()
  })

  it('expires completed history after 30 days, never unfinished checkpoints', async () => {
    const { workspace, history, details } = await fixture()
    vi.useFakeTimers()
    await history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'new') })
    vi.advanceTimersByTime(31 * 86_400_000)
    await history.prune()
    expect(await history.list()).toEqual([])
    expect(readFileSync(join(workspace, 'file'), 'utf8')).toBe('new')
  })

  it('recovers an OS-interrupted mutation before allowing more changes', async () => {
    const { root, workspace, history, details, options } = await fixture()
    const script = join(root, 'crash.mts')
    writeFileSync(script, `import { openChangeHistory } from ${JSON.stringify(new URL('../common/services/history/journal.ts', import.meta.url).pathname)}; import { writeFileSync } from 'node:fs'; const history = await openChangeHistory(${JSON.stringify(options)}); await history.run(${JSON.stringify(details)}, async () => { writeFileSync(${JSON.stringify(join(workspace, 'partial'))}, 'partial'); process.exit(9) });`)
    expect(() => execFileSync(process.execPath, ['--import', 'tsx', script], { stdio: 'pipe' })).toThrow()
    expect((await history.list())[0]!.status).toBe('pending')
    await expect(history.run(details, async () => undefined)).rejects.toThrow('owner recovery')
    await history.recover((await history.list())[0]!.id)
    await history.restore((await history.list())[0]!.id)
    expect(existsSync(join(workspace, 'partial'))).toBe(false)
  }, SPAWN_TEST_TIMEOUT_MS)
})

it('counts checkpoint metadata toward the history disk budget', async () => {
  const { workspace, history, details } = await fixture(32_768)
  for (let index = 0; index < 200; index++) writeFileSync(join(workspace, `empty-file-${index}`), '')
  const execute = vi.fn(async () => undefined)
  await expect(history.run(details, execute)).rejects.toThrow('disk budget')
  expect(execute).not.toHaveBeenCalled()
})

it('preserves the before-state when the after-snapshot exceeds the budget', async () => {
  const { workspace, history, details, options } = await fixture()
  await expect(history.run(details, async () => { writeFileSync(join(workspace, 'large-output'), Buffer.alloc(2_000_000, 1)) })).rejects.toThrow('limit')
  expect((await history.list())[0]!.status).toBe('pending')
  const expanded = await openChangeHistory({ ...options, maxBytes: 4_000_000 })
  await expanded.recover((await history.list())[0]!.id)
  await expanded.restore((await history.list())[0]!.id)
  expect(existsSync(join(workspace, 'large-output'))).toBe(false)
})

it('restores read-only directory modes after restoring their children', async () => {
  const { workspace, history, details } = await fixture()
  const directory = join(workspace, 'readonly'); mkdirSync(directory)
  writeFileSync(join(directory, 'file'), 'original'); chmodSync(directory, 0o500)
  await history.run(details, async () => { chmodSync(directory, 0o700); rmSync(directory, { recursive: true }) })
  await history.restore((await history.list())[0]!.id)
  expect(readFileSync(join(directory, 'file'), 'utf8')).toBe('original')
  expect(statSync(directory).mode & 0o777).toBe(0o500)
  chmodSync(directory, 0o700)
})

describe('the history database file', () => {
  it('starts a new history.sqlite in WAL mode, with owner-only sidecars removed on a clean close', async () => {
    const { options, history } = await fixture()
    const file = join(options.directory, 'history.sqlite')
    const header = Buffer.alloc(2)
    const descriptor = openSync(file, 'r')
    try { readSync(descriptor, header, 0, 2, 18) } finally { closeSync(descriptor) }
    // Bytes 18 and 19 are the write and read format versions: 2 means WAL.
    expect([...header]).toEqual([2, 2])
    for (const sidecar of ['-wal', '-shm']) expect(statSync(`${file}${sidecar}`).mode & 0o777).toBe(0o600)
    await history.close()
    expect(existsSync(`${file}-wal`)).toBe(false)
  })

  it.runIf(process.platform === 'linux')('is closed again when a workspace runtime fails to start after opening it', async () => {
    const root = mkdtempSync('/tmp/buckle-history-leak-'); roots.push(root)
    mkdirSync(join(root, 'workspace'))
    mkdirSync(join(root, 'state'), { mode: 0o700 })
    const config = loadConfig({ BUCKLE_WORKSPACE_ROOT: join(root, 'workspace'), BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_PACKS: 'no-such-pack', BUCKLE_ALLOW_SHELL: 'false' })
    // A registered workspace retries its whole creation on every request.
    for (let attempt = 0; attempt < 3; attempt += 1) await expect(createRuntime({ config })).rejects.toThrow('Unknown BUCKLE_PACKS')
    expect(openDescriptors(root)).toEqual([])
  })
})

/** This process's open files under a directory, read from /proc. */
function openDescriptors(directory: string): string[] {
  return readdirSync('/proc/self/fd').flatMap(fd => {
    try {
      const path = readlinkSync(`/proc/self/fd/${fd}`)
      return path.startsWith(`${directory}/`) ? [path] : []
    } catch {
      return []
    }
  })
}

// GPT review of c71dee5 (history snapshots, P2): every history root is snapshotted before a tracked write, and a
// hard-linked file anywhere refused the snapshot, so a pnpm node_modules blocked an unrelated fs_write.
describe('history beside a pnpm-style hard-linked node_modules', () => {
  /** A workspace whose node_modules holds a file hard-linked from a store outside it, as pnpm lays it out. */
  async function linkedWorkspace() {
    const setup = await fixture()
    const store = join(setup.root, 'store'); mkdirSync(store)
    writeFileSync(join(store, 'index.js'), 'module.exports = 1\n')
    const linked = join(setup.workspace, 'node_modules', '.pnpm', 'left-pad@1.3.0', 'node_modules', 'left-pad', 'index.js')
    mkdirSync(join(linked, '..'), { recursive: true })
    linkSync(join(store, 'index.js'), linked)
    return { ...setup, store, linked }
  }

  it('records and restores an unrelated write, and leaves the hard-linked file as it is', async () => {
    const { workspace, history, details, linked } = await linkedWorkspace()
    await history.run(details, async () => { writeFileSync(join(workspace, 'notes.md'), 'hello') })
    const [checkpoint] = await history.list()
    expect(checkpoint).toMatchObject({ status: 'complete', paths: [join(workspace, 'notes.md')] })
    await history.restore(checkpoint!.id)
    expect(existsSync(join(workspace, 'notes.md'))).toBe(false)
    expect(readFileSync(linked, 'utf8')).toBe('module.exports = 1\n')
    expect(statSync(linked).nlink).toBe(2)
  })

  it('records the hard-linked file as excluded, without its content, and never restores a change to it', async () => {
    const { workspace, history, details, linked, store } = await linkedWorkspace()
    const saved: Buffer[] = []
    const captured = snapshot({ roots: [workspace], excluded: [], maxBytes: 1_000_000, excludeLinkedDependencies: true, save: (_, content) => { saved.push(content) } })
    expect(captured[linked]).toEqual({ kind: 'excluded', mode: statSync(linked).mode & 0o777 })
    expect(saved).toEqual([])
    await history.run(details, async () => { writeFileSync(linked, 'module.exports = 2\n'); writeFileSync(join(workspace, 'notes.md'), 'x') })
    await history.restore((await history.list())[0]!.id)
    // What history never captured it never rewrites, through this name or the store's.
    expect(readFileSync(join(store, 'index.js'), 'utf8')).toBe('module.exports = 2\n')
    expect(existsSync(join(workspace, 'notes.md'))).toBe(false)
  })

  it('leaves a hard-linked dependency out of the change set when a call removes it, and restores the rest', async () => {
    const { workspace, history, details, linked } = await linkedWorkspace()
    await history.run(details, async () => { rmSync(linked); writeFileSync(join(workspace, 'notes.md'), 'x') })
    const [checkpoint] = await history.list()
    expect(checkpoint!.paths).toEqual([join(workspace, 'notes.md')])
    await history.restore(checkpoint!.id)
    expect(existsSync(join(workspace, 'notes.md'))).toBe(false)
    expect(existsSync(linked)).toBe(false)
  })

  it('refuses, before changing anything, a restore that would remove a directory holding a hard-linked dependency', async () => {
    const { workspace, history, details, store } = await linkedWorkspace()
    const added = join(workspace, 'node_modules', '.pnpm', 'is-odd@3.0.1', 'node_modules', 'is-odd')
    await history.run(details, async () => {
      mkdirSync(added, { recursive: true })
      linkSync(join(store, 'index.js'), join(added, 'index.js'))
      writeFileSync(join(workspace, 'notes.md'), 'x')
    })
    await expect(history.restore((await history.list())[0]!.id)).rejects.toThrow('Restore conflict: a directory holds hard-linked dependency files history does not capture')
    expect(readFileSync(join(added, 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('x')
  })

  it('still refuses a hard link outside node_modules, and a snapshot that is not history\'s', async () => {
    const { workspace, history, details, store } = await linkedWorkspace()
    linkSync(join(store, 'index.js'), join(workspace, 'linked-elsewhere.js'))
    await expect(history.run(details, async () => { writeFileSync(join(workspace, 'notes.md'), 'x') })).rejects.toThrow('History cannot safely restore hard-linked files')
    expect(existsSync(join(workspace, 'notes.md'))).toBe(false)
    rmSync(join(workspace, 'linked-elsewhere.js'))
    expect(() => snapshot({ roots: [workspace], excluded: [], maxBytes: 1_000_000, save: () => {} })).toThrow('History cannot safely restore hard-linked files')
  })

  it('lets fs_write run in a workspace whose node_modules is hard-linked, and restores it', async () => {
    const { root, workspace, linked } = await linkedWorkspace()
    const runtime = await createRuntime({ config: loadConfig({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' }) })
    try {
      const request = { requestId: 'linked-write', tool: 'fs_write', args: { path: 'notes.md', content: 'hello' }, approvalTokens: [] as string[], context: { approvalWait: { mode: 'none' as const } } }
      const asked = await runtime.invoke({ sessionId: 's', request })
      if (asked.outcome !== 'approval_required') throw new Error(`expected an ask, got ${asked.outcome}`)
      for (const approval of asked.approvals) await runtime.approvalService.answer({ decision: { token: approval.token, approved: true, scope: 'session' }, authority: 'admin' })
      expect(await runtime.invoke({ sessionId: 's', request: { ...request, requestId: 'linked-write-2' } })).toMatchObject({ outcome: 'ok' })
      expect(readFileSync(join(workspace, 'notes.md'), 'utf8')).toBe('hello')
      const [checkpoint] = await runtime.history.list()
      expect(checkpoint).toMatchObject({ tool: 'fs_write', paths: [join(workspace, 'notes.md')] })
      await runtime.history.restore(checkpoint!.id)
      expect(existsSync(join(workspace, 'notes.md'))).toBe(false)
      expect(statSync(linked).nlink).toBe(2)
    } finally { await runtime.approvalService.close(); await runtime.history.close() }
  })
})
