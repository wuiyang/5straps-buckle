import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'
import type { Checkpoint } from '../common/services/history/records.js'
import { historyObjects } from './support/history-objects.js'

// Slice F2, item 5: the rolling cap counts the content the retained checkpoints hold, never the copy of the workspace git
// keeps for the next command's before state (B2). Over it, history drops whole oldest turns, never the current one, and
// deletes the objects no checkpoint names; it never rewrites a retained checkpoint or reads the workspace again (A9).

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(maxBytes: number) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-retention-cap-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const journal = () => JSON.parse(readFileSync(join(directory, 'checkpoints.json'), 'utf8')) as { checkpoints: Checkpoint[] }
  return { workspace, directory, journal, settings: { directory, excluded: [], maxBytes } }
}
const command = (turn: string, workspace: string) => ({ sessionId: 's', stageId: turn, tool: 'shell_exec', roots: [workspace] })
const fileTool = (turn: string, path: string) => ({ sessionId: 's', stageId: turn, tool: 'fs_write', roots: [path], scope: [{ path }] })

it('keeps older restorable turns in a workspace larger than the cap', async () => {
  const { workspace, settings } = fixture(1_000_000)
  for (let index = 0; index < 10; index++) writeFileSync(join(workspace, `asset-${index}.bin`), randomBytes(200_000))
  writeFileSync(join(workspace, 'a.txt'), 'a1'); writeFileSync(join(workspace, 'b.txt'), 'b1')
  const history = await openChangeHistory(settings)
  try {
    await history.run(command('one', workspace), async () => { writeFileSync(join(workspace, 'a.txt'), 'a2') })
    await history.run(command('two', workspace), async () => { writeFileSync(join(workspace, 'b.txt'), 'b2') })
    expect((await history.list()).map(item => item.restorable)).toEqual([true, true])
    await history.rollback({ target: { turns: 2 }, by: { sessionId: 's', tool: 'history_restore' } })
    expect([readFileSync(join(workspace, 'a.txt'), 'utf8'), readFileSync(join(workspace, 'b.txt'), 'utf8')]).toEqual(['a1', 'b1'])
  } finally { await history.close() }
})

it('drops whole oldest turns over the cap, deletes what no checkpoint names, and never rewrites a retained checkpoint', async () => {
  const { workspace, directory, journal, settings } = fixture(330_000)
  const content = [randomBytes(150_000), randomBytes(150_000), randomBytes(150_000)]
  const history = await openChangeHistory(settings)
  try {
    for (const [index, bytes] of content.entries()) {
      const file = join(workspace, `file-${index}.bin`)
      await history.run(fileTool(`turn-${index}`, file), async () => { writeFileSync(file, bytes) })
      // A second call in the same turn, so a turn drops whole.
      await history.run(fileTool(`turn-${index}`, join(workspace, `note-${index}`)), async () => { writeFileSync(join(workspace, `note-${index}`), String(index)) })
    }
    const before = journal().checkpoints
    expect(before.map(record => record.stageId)).toEqual(['turn-1', 'turn-1', 'turn-2', 'turn-2'])
    expect(historyObjects(directory).some(object => object.includes(content[0]!.subarray(0, 64)))).toBe(false)
    expect(historyObjects(directory).filter(object => object.includes(content[1]!.subarray(0, 64)) || object.includes(content[2]!.subarray(0, 64)))).toHaveLength(2)
    const retained = structuredClone(before)
    await history.run(fileTool('turn-2', join(workspace, 'last')), async () => { writeFileSync(join(workspace, 'last'), 'x') })
    expect(journal().checkpoints.slice(0, 4)).toEqual(retained)
  } finally { await history.close() }
})

it('records a checkpoint that alone exceeds the cap without content, and keeps the turns before it', async () => {
  const { workspace, settings } = fixture(100_000)
  writeFileSync(join(workspace, 'a.txt'), 'a1')
  const history = await openChangeHistory(settings)
  try {
    await history.run(command('one', workspace), async () => { writeFileSync(join(workspace, 'a.txt'), 'a2') })
    await history.run(command('two', workspace), async () => { writeFileSync(join(workspace, 'random.bin'), randomBytes(300_000)) })
    const [first, second] = await history.list()
    expect(first).toMatchObject({ restorable: true, paths: [join(workspace, 'a.txt')] })
    expect(second).toMatchObject({ restorable: false, reason: expect.stringContaining('rolling size cap'), paths: [join(workspace, 'random.bin')] })
  } finally { await history.close() }
})

// X13 of the Codex review of 670f1dc2..01d3b0c9: a stage restore checks every checkpoint it undoes, as a rollback does, so
// a later checkpoint the cap left without content never has its paths removed under the first one's flag.
it('refuses a stage restore past a checkpoint the cap left without content, and changes nothing', async () => {
  const { workspace, settings } = fixture(100_000)
  const small = join(workspace, 'a.txt'); writeFileSync(small, 'a1')
  const big = join(workspace, 'big.bin')
  const history = await openChangeHistory(settings)
  try {
    await history.run(fileTool('one', small), async () => { writeFileSync(small, 'a2') })
    await history.run(fileTool('one', big), async () => { writeFileSync(big, randomBytes(300_000)) })
    expect((await history.list()).map(item => item.restorable)).toEqual([true, false])
    await expect(history.restoreStage('one', 's')).rejects.toThrow('rolling size cap')
    expect(existsSync(big)).toBe(true)
    expect(readFileSync(small, 'utf8')).toBe('a2')
  } finally { await history.close() }
})
