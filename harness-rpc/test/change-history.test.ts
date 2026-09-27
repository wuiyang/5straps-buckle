import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'
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
