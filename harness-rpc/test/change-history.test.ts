import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChangeHistory } from '../src/services/history/journal.js'

const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(maxBytes = 1_000_000) {
  const root = mkdtempSync('/tmp/buckle-history-'); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const options = { directory: join(root, 'history'), excluded: [], maxBytes, retentionDays: 30 }
  const history = createChangeHistory(options)
  const details = { sessionId: 'test-session', stageId: 'edit-message', tool: 'test-write', roots: [workspace] }
  return { root, workspace, options, history, details }
}

describe('Git-independent file history', () => {
  it('restores created, modified, removed, binary and executable files without Git', async () => {
    const { workspace, history, details } = fixture()
    const file = join(workspace, 'before.bin'); writeFileSync(file, Buffer.from([0, 255, 13])); chmodSync(file, 0o755)
    const removed = join(workspace, 'removed'); writeFileSync(removed, 'original')
    await history.run(details, async () => { writeFileSync(file, 'changed'); chmodSync(file, 0o600); rmSync(removed); mkdirSync(join(workspace, 'new')); writeFileSync(join(workspace, 'new', 'file'), 'new') })
    const checkpoint = history.list()[0]!
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
    const { workspace, history, details } = fixture()
    const file = join(workspace, 'partial')
    await expect(history.run(details, async () => { writeFileSync(file, 'partial'); throw new Error('tool failed') })).rejects.toThrow('tool failed')
    await history.restore(history.list()[0]!.id)
    expect(existsSync(file)).toBe(false)
  })

  it('refuses conflicts before changing any file and preserves unrelated newer files', async () => {
    const { workspace, history, details } = fixture()
    const file = join(workspace, 'file'); writeFileSync(file, 'before')
    await history.run(details, async () => { writeFileSync(file, 'agent'); writeFileSync(join(workspace, 'created'), 'agent') })
    writeFileSync(file, 'owner')
    await expect(history.restore(history.list()[0]!.id)).rejects.toThrow('Restore conflict')
    expect(readFileSync(join(workspace, 'created'), 'utf8')).toBe('agent')
    writeFileSync(file, 'agent'); writeFileSync(join(workspace, 'unrelated'), 'owner')
    await history.restore(history.list()[0]!.id)
    expect(readFileSync(join(workspace, 'unrelated'), 'utf8')).toBe('owner')
  })

  it('refuses to remove newly added descendants of an agent-created directory', async () => {
    const { workspace, history, details } = fixture()
    await history.run(details, async () => { mkdirSync(join(workspace, 'new')) })
    writeFileSync(join(workspace, 'new', 'owner-file'), 'owner')
    await expect(history.restore(history.list()[0]!.id)).rejects.toThrow('Restore conflict')
    expect(existsSync(join(workspace, 'new', 'owner-file'))).toBe(true)
  })

  it('restores symlinks without reading or overwriting their targets', async () => {
    const { root, workspace, history, details } = fixture()
    const external = join(root, 'external'); writeFileSync(external, 'outside')
    const link = join(workspace, 'link'); symlinkSync(external, link)
    await history.run(details, async () => { rmSync(link); writeFileSync(link, 'replacement') })
    await history.restore(history.list()[0]!.id)
    expect(readlinkSync(link)).toBe(external)
    expect(readFileSync(external, 'utf8')).toBe('outside')
  })

  it('restores every checkpoint in a message stage while retaining unrelated stage changes', async () => {
    const { workspace, history, details } = fixture()
    const file = join(workspace, 'file'); writeFileSync(file, 'before')
    await history.run(details, async () => { writeFileSync(file, 'one') })
    await history.run({ ...details, stageId: 'other-message' }, async () => { writeFileSync(join(workspace, 'other'), 'keep') })
    await history.run(details, async () => { writeFileSync(file, 'two') })
    await history.restoreStage(details.stageId, details.sessionId)
    expect(readFileSync(file, 'utf8')).toBe('before')
    expect(readFileSync(join(workspace, 'other'), 'utf8')).toBe('keep')
  })

  it('refuses stage restore when another writer intervened on the same path', async () => {
    const { workspace, history, details } = fixture()
    const file = join(workspace, 'file'); writeFileSync(file, 'before')
    await history.run(details, async () => { writeFileSync(file, 'one') })
    writeFileSync(file, 'owner')
    await history.run(details, async () => { writeFileSync(file, 'two') })
    await expect(history.restoreStage(details.stageId, details.sessionId)).rejects.toThrow('interleaved')
    expect(readFileSync(file, 'utf8')).toBe('two')
  })

  it('serializes concurrent runtimes around the entire mutation', async () => {
    const { workspace, history, details, options } = fixture()
    const second = createChangeHistory(options)
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
    const { workspace, history, details } = fixture(8)
    writeFileSync(join(workspace, 'large'), 'larger than eight bytes')
    const execute = vi.fn(async () => undefined)
    await expect(history.run(details, execute)).rejects.toThrow('limit')
    expect(execute).not.toHaveBeenCalled()
  })

  it('expires completed history after 30 days, never unfinished checkpoints', async () => {
    const { workspace, history, details } = fixture()
    vi.useFakeTimers()
    await history.run(details, async () => { writeFileSync(join(workspace, 'file'), 'new') })
    vi.advanceTimersByTime(31 * 86_400_000)
    await history.prune()
    expect(history.list()).toEqual([])
    expect(readFileSync(join(workspace, 'file'), 'utf8')).toBe('new')
  })

  it('recovers an OS-interrupted mutation before allowing more changes', async () => {
    const { root, workspace, history, details, options } = fixture()
    const script = join(root, 'crash.mts')
    writeFileSync(script, `import { createChangeHistory } from ${JSON.stringify(new URL('../src/services/history/journal.ts', import.meta.url).pathname)}; import { writeFileSync } from 'node:fs'; const history = createChangeHistory(${JSON.stringify(options)}); await history.run(${JSON.stringify(details)}, async () => { writeFileSync(${JSON.stringify(join(workspace, 'partial'))}, 'partial'); process.exit(9) });`)
    expect(() => execFileSync(process.execPath, ['--import', 'tsx', script], { stdio: 'pipe' })).toThrow()
    expect(history.list()[0]!.status).toBe('pending')
    await expect(history.run(details, async () => undefined)).rejects.toThrow('owner recovery')
    await history.recover(history.list()[0]!.id)
    await history.restore(history.list()[0]!.id)
    expect(existsSync(join(workspace, 'partial'))).toBe(false)
  })
})

it('counts checkpoint metadata toward the history disk budget', async () => {
  const { workspace, history, details } = fixture(32_768)
  for (let index = 0; index < 200; index++) writeFileSync(join(workspace, `empty-file-${index}`), '')
  const execute = vi.fn(async () => undefined)
  await expect(history.run(details, execute)).rejects.toThrow('disk budget')
  expect(execute).not.toHaveBeenCalled()
})

it('preserves the before-state when the after-snapshot exceeds the budget', async () => {
  const { workspace, history, details, options } = fixture()
  await expect(history.run(details, async () => { writeFileSync(join(workspace, 'large-output'), Buffer.alloc(2_000_000, 1)) })).rejects.toThrow('limit')
  expect(history.list()[0]!.status).toBe('pending')
  const expanded = createChangeHistory({ ...options, maxBytes: 4_000_000 })
  await expanded.recover(history.list()[0]!.id)
  await expanded.restore(history.list()[0]!.id)
  expect(existsSync(join(workspace, 'large-output'))).toBe(false)
})
