import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { openChangeHistory, RestoreRefusedError } from '../common/services/history/journal.js'
import { resolveEffects } from '../common/services/invocation/resolve-effects.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Slice D, rollback as an agent option: the change history lists its newest checkpoints from the current state back,
// names the call that made each, and restores the workspace to before one, undoing it and every later one together.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture(options: { now?: () => number } = {}) {
  const root = mkdtempSync('/tmp/buckle-rollback-'); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 1_000_000, retentionDays: 30, ...options })
  let call = 0
  /** One write as an agent call makes it: its own checkpoint, its request named. */
  const write = (name: string, content: string, sessionId = 'chat-1') => history.run({ sessionId, stageId: `req-${++call}`, tool: 'fs_write', requestId: `req-${call}`, roots: [workspace] }, async () => { writeFileSync(join(workspace, name), content) })
  const read = (name: string) => (existsSync(join(workspace, name)) ? readFileSync(join(workspace, name), 'utf8') : null)
  const by = { sessionId: 'chat-1', stageId: 'undo-1', tool: 'history_restore', requestId: 'undo-1' }
  return { workspace, history, directory, write, read, by }
}

/** What a process killed mid-call leaves: the checkpoint pending, its state before the call kept and no state after. */
function interrupt(directory: string, id: string): void {
  const database = new DatabaseSync(join(directory, 'history.sqlite'))
  try {
    const row = database.prepare('SELECT data FROM checkpoints WHERE id=?').get(id) as { data: string }
    const record = JSON.parse(row.data) as Record<string, unknown>
    delete record.after
    record.status = 'pending'
    database.prepare('UPDATE checkpoints SET data=? WHERE id=?').run(JSON.stringify(record), id)
  } finally { database.close() }
}

describe('the newest checkpoints', () => {
  it('come newest first, each naming the call that made it, with the current one marked and older ones counted', async () => {
    const { history, write, workspace } = await fixture()
    await write('a.txt', 'one')
    await write('b.txt', 'two', 'chat-2')
    await write('a.txt', 'three')
    const recent = await history.recent(2)
    expect(recent.more).toBe(true)
    expect(recent.checkpoints.map(item => [item.requestId, item.sessionId, item.tool, item.current])).toEqual([['req-3', 'chat-1', 'fs_write', true], ['req-2', 'chat-2', 'fs_write', false]])
    expect(recent.checkpoints[0]!.changes).toEqual([{ path: join(workspace, 'a.txt'), kind: 'modified' }])
    expect((await history.recent(10)).more).toBe(false)
  })

  it('mark none current while the newest is still pending', async () => {
    const { history, workspace } = await fixture()
    let release: () => void = () => undefined
    const running = history.run({ sessionId: 's', stageId: 'x', tool: 'fs_write', roots: [workspace] }, () => new Promise<void>(resolve => { release = resolve }))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await history.recent(5)).checkpoints.map(item => [item.status, item.current])).toEqual([['pending', false]])
    release()
    await running
  })
})

describe('a restore to before a checkpoint', () => {
  it('counts steps back from the current state, and undoes that many checkpoints together', async () => {
    const { history, write, read, by } = await fixture()
    await write('a.txt', 'one')
    await write('b.txt', 'two')
    await write('a.txt', 'three')
    const [, middle] = (await history.recent(3)).checkpoints
    const plan = await history.plan({ steps: 2 })
    expect(plan).toMatchObject({ checkpoint: middle!.id, undoes: 2 })
    const restored = await history.rollback({ target: { steps: 2 }, by })
    expect([read('a.txt'), read('b.txt')]).toEqual(['one', null])
    expect(restored).toMatchObject({ tool: 'history_restore', requestId: 'undo-1', restores: middle!.id, undoes: 2 })
    expect(restored.changes.map(change => change.kind).sort()).toEqual(['deleted', 'modified'])
  })

  it('by id undoes that checkpoint and every later one, and is itself a checkpoint one step undoes', async () => {
    const { history, write, read, by } = await fixture()
    await write('a.txt', 'one')
    await write('a.txt', 'two')
    await write('c.txt', 'three')
    const oldest = (await history.recent(3)).checkpoints[2]!
    await history.rollback({ target: { id: oldest.id }, by })
    expect([read('a.txt'), read('c.txt')]).toEqual([null, null])
    expect((await history.recent(1)).checkpoints[0]).toMatchObject({ tool: 'history_restore', current: true, restores: oldest.id, undoes: 3 })
    await history.rollback({ target: { steps: 1 }, by: { ...by, requestId: 'redo-1' } })
    expect([read('a.txt'), read('c.txt')]).toEqual(['two', 'three'])
  })

  it('is refused, naming why, where steps reach past the history or the id is not among the newest 100', async () => {
    const { history, write, by } = await fixture()
    await write('a.txt', 'one')
    await expect(history.plan({ steps: 2 })).rejects.toThrow(RestoreRefusedError)
    await expect(history.plan({ steps: 2 })).rejects.toThrow('holds 1 checkpoint')
    await expect(history.rollback({ target: { id: 'change-unknown' }, by })).rejects.toThrow('No checkpoint change-unknown is among the newest 100')
  })

  it('changes nothing where a file changed outside Buckle since, or between two of the checkpoints it undoes', async () => {
    const { history, write, read, by, workspace } = await fixture()
    await write('a.txt', 'one')
    writeFileSync(join(workspace, 'a.txt'), 'edited by hand')
    await write('a.txt', 'two')
    await write('b.txt', 'three')
    await expect(history.rollback({ target: { steps: 3 }, by })).rejects.toThrow('Restore conflict')
    expect([read('a.txt'), read('b.txt')]).toEqual(['two', 'three'])
    writeFileSync(join(workspace, 'b.txt'), 'edited again')
    await expect(history.rollback({ target: { steps: 1 }, by })).rejects.toBeInstanceOf(RestoreRefusedError)
    await expect(history.rollback({ target: { steps: 1 }, by })).rejects.toMatchObject({ code: 'RESTORE_REFUSED', message: expect.stringContaining('Restore conflict') })
    expect(read('b.txt')).toBe('edited again')
  })

  it('runs its check under the lock with the plan it will apply, and a check that throws changes nothing', async () => {
    const { history, write, read, by } = await fixture()
    await write('a.txt', 'one')
    const judged = await history.plan({ steps: 1 })
    await write('a.txt', 'two')
    const seen: unknown[] = []
    await expect(history.rollback({ target: { steps: 1 }, by, check: (plan) => { seen.push(plan); throw new Error('not the judged plan') } })).rejects.toThrow('not the judged plan')
    expect(read('a.txt')).toBe('two')
    expect(seen).toEqual([expect.objectContaining({ undoes: 1 })])
    expect(seen[0]).not.toEqual(judged)
    expect((await history.recent(5)).checkpoints).toHaveLength(2)
  })

  // Review m2 of the Slice D rules review and m4 of its tests review: a call at work holds the execution lock, and an
  // interrupted one leaves a pending checkpoint and no lock, so an agent is told to try again for the one and the owner is
  // named for the other.
  it('is refused while another call is changing the files, as a wait and not as a recovery', async () => {
    const { history, workspace, write } = await fixture()
    await write('a.txt', 'one')
    let release: () => void = () => undefined
    const running = history.run({ sessionId: 's', stageId: 'x', tool: 'fs_write', roots: [workspace] }, () => new Promise<void>(resolve => { release = resolve }))
    await new Promise(resolve => setTimeout(resolve, 50))
    const refused = history.plan({ steps: 1 })
    await expect(refused).rejects.toBeInstanceOf(RestoreRefusedError)
    await expect(refused).rejects.toThrow('Another call is changing the files now; try again once it finishes')
    await expect(refused).rejects.not.toThrow('recover')
    release()
    await running
    expect((await history.plan({ steps: 1 })).undoes).toBe(1)
  })

  it('is refused naming the checkpoint an interrupted call left, until the owner recovers it, and then restores through it', async () => {
    const { history, directory, write, read, by } = await fixture()
    await write('a.txt', 'one')
    await write('b.txt', 'two')
    const newest = (await history.recent(1)).checkpoints[0]!
    interrupt(directory, newest.id)
    await expect(history.plan({ steps: 1 })).rejects.toThrow(`waits for the owner's recovery (buckle history recover ${newest.id})`)
    await expect(history.rollback({ target: { steps: 1 }, by })).rejects.toThrow(`buckle history recover ${newest.id}`)
    expect((await history.recent(1)).checkpoints[0]).toMatchObject({ id: newest.id, status: 'pending', current: false })
    expect(read('b.txt')).toBe('two')
    await history.recover(newest.id)
    expect((await history.recent(1)).checkpoints[0]).toMatchObject({ id: newest.id, status: 'interrupted', current: true })
    await history.rollback({ target: { steps: 1 }, by })
    expect([read('a.txt'), read('b.txt')]).toEqual(['one', null])
  })

  // Review M2 of the Slice D rules review: a checkpoint past its retention is pruned as the next change begins, and a
  // restore that began by pruning the checkpoints it was restoring from left the files half restored.
  describe('past the retention', () => {
    const DAY = 86_400_000
    async function aged() {
      const clock = { now: Date.now() }
      return { ...await fixture({ now: () => clock.now }), clock }
    }

    it('leaves a checkpoint out of the newest and out of a restore, though nothing has pruned it yet, and changes nothing', async () => {
      const { history, write, read, by, clock } = await aged()
      await write('a.txt', 'one')
      await write('b.txt', 'two')
      clock.now += 31 * DAY
      expect(await history.recent(5)).toEqual({ checkpoints: [], more: false })
      await expect(history.plan({ steps: 1 })).rejects.toThrow('holds 0 checkpoints')
      await expect(history.rollback({ target: { steps: 1 }, by })).rejects.toBeInstanceOf(RestoreRefusedError)
      expect([read('a.txt'), read('b.txt')]).toEqual(['one', 'two'])
      expect(await history.list()).toHaveLength(2)
    })

    it('refuses a restore judged just before the retention ran out, whole, once it has', async () => {
      const { history, write, read, by, clock } = await aged()
      await write('a.txt', 'one')
      await write('b.txt', 'two')
      clock.now += 29 * DAY
      expect((await history.plan({ steps: 2 })).undoes).toBe(2)
      clock.now += 2 * DAY
      await expect(history.rollback({ target: { steps: 2 }, by })).rejects.toBeInstanceOf(RestoreRefusedError)
      expect([read('a.txt'), read('b.txt')]).toEqual(['one', 'two'])
    })

    it('restores every file when the checkpoints it restores from pass their retention as it begins', async () => {
      const { history, workspace, write, read, by, clock } = await aged()
      await write('a.txt', 'one')
      await history.run({ sessionId: 'chat-1', stageId: 'both', tool: 'shell_exec', roots: [workspace] }, async () => {
        writeFileSync(join(workspace, 'a.txt'), 'two')
        writeFileSync(join(workspace, 'b.txt'), 'new')
      })
      clock.now += 29 * DAY
      const restored = await history.rollback({ target: { steps: 1 }, by, check: () => { clock.now += 2 * DAY } })
      expect([read('a.txt'), read('b.txt')]).toEqual(['one', null])
      expect(restored).toMatchObject({ tool: 'history_restore', undoes: 1, changes: [{ kind: 'modified' }, { kind: 'deleted' }] })
      await write('c.txt', 'four')
      expect((await history.list()).map(item => item.tool)).toEqual(['history_restore', 'fs_write'])
    })
  })
})

it('records the request of the agent call whose write a checkpoint holds', async () => {
  const root = mkdtempSync('/tmp/buckle-rollback-'); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const runtime = await createRuntime({ config: configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs' }) })
  try {
    await runtime.grants.grant({ sessionId: 'chat-1', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
    const written = await runtime.invoke({ sessionId: 'chat-1', request: { requestId: 'write-42', tool: 'fs_write', args: { path: 'a.txt', content: 'one' }, approvalTokens: [] } })
    expect(written.outcome).toBe('ok')
    expect((await runtime.history.recent(1)).checkpoints[0]).toMatchObject({ tool: 'fs_write', sessionId: 'chat-1', requestId: 'write-42', current: true })
  } finally { await runtime.approvalService.close(); await runtime.history.close() }
})

describe('a restore as the rules judge it', () => {
  it('is settled from the history into the checkpoint it goes back to, and each path it puts back as a write', async () => {
    const { history, write, workspace } = await fixture()
    await write('a.txt', 'one')
    await write('b.txt', 'two')
    const [newest, oldest] = (await history.recent(2)).checkpoints
    const paths = createPathView({ root: workspace, mount: null })
    const effects = await resolveEffects({ effects: [{ kind: 'restore_checkpoint', target: { steps: 2 } }], paths, history })
    expect(effects).toEqual([
      { kind: 'restore_checkpoint', checkpoint: oldest!.id, head: newest!.id, undoes: 2 },
      { kind: 'write_path', path: join(workspace, 'a.txt'), directory: workspace, entry: true, restore: true },
      { kind: 'write_path', path: join(workspace, 'b.txt'), directory: workspace, entry: true, restore: true },
    ])
  })

  it('is refused before any rule judges it where the history cannot go back that far, or is not kept', async () => {
    const { history, write, workspace } = await fixture()
    await write('a.txt', 'one')
    const paths = createPathView({ root: workspace, mount: null })
    await expect(resolveEffects({ effects: [{ kind: 'restore_checkpoint', target: { steps: 5 } }], paths, history })).rejects.toMatchObject({ code: 'RESTORE_REFUSED', message: expect.stringContaining('fewer than the 5 steps') })
    await expect(resolveEffects({ effects: [{ kind: 'restore_checkpoint', target: { steps: 1 } }], paths })).rejects.toMatchObject({ code: 'HISTORY_UNAVAILABLE' })
  })
})
