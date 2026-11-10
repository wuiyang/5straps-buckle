import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, expect, it } from 'vitest'
import { openChangeHistory } from '../common/services/history/journal.js'
import type { Checkpoint } from '../common/services/history/records.js'
import { shadowGitCheckpoint } from './support/shadow-git-checkpoint.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

for (const engine of ['file tool', 'command', 'legacy shadow git'] as const) it(`restores exact Unicode names and bytes from ${engine}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-unicode-')); roots.push(root)
  const workspace = join(root, 'workspace'); mkdirSync(workspace)
  const directory = join(root, 'history')
  const names = ['supplementary-🦊.bin', 'combining-e\u0301.bin']
  const files = names.map(name => join(workspace, name))
  const originals = [Buffer.from([0, 255, 13, 10, 240, 159, 166, 138]), Buffer.from('before e\u0301\r\n\0')]
  const changed = [Buffer.from('after supplementary\r\n\0'), Buffer.from([255, 0, 10, 13])]
  const modes = process.platform === 'win32' ? [0o644, 0o644] : [0o644, 0o755]
  for (const [index, file] of files.entries()) {
    writeFileSync(file, originals[index]!, { mode: modes[index]! })
    chmodSync(file, modes[index]!)
  }
  const nativeModes = files.map(file => statSync(file).mode & 0o777)
  const execute = async () => { for (const [index, file] of files.entries()) writeFileSync(file, changed[index]!) }
  const legacy = engine === 'legacy shadow git' ? await shadowGitCheckpoint({ directory, roots: [workspace], sessionId: 'unicode', stageId: 'change', execute }) : undefined
  const history = await openChangeHistory({ directory, excluded: [], maxBytes: 16 * 1_048_576 })
  try {
    if (!legacy) await history.run({ sessionId: 'unicode', stageId: 'change', tool: engine === 'file tool' ? 'fs_write_batch' : 'exec', roots: [workspace], ...(engine === 'file tool' ? { scope: files.map(path => ({ path })) } : {}) }, execute)
    const [checkpoint] = await history.list()
    expect(checkpoint).toMatchObject({ restorable: true, paths: [...files].sort() })
    if (legacy) expect(checkpoint!.id).toBe(legacy.id)
    const saved: { checkpoints: Checkpoint[] } = JSON.parse(readFileSync(join(directory, 'checkpoints.json'), 'utf8'))
    const captured = saved.checkpoints.find(record => record.id === checkpoint!.id)!
    for (const [index, file] of files.entries()) {
      expect(captured.before[file]?.mode).toBe(modes[index])
      expect(captured.after?.[file]?.mode).toBe(modes[index])
    }
    for (const [index, file] of files.entries()) expect(readFileSync(file)).toEqual(changed[index])
    await history.restore(checkpoint!.id)
    expect(readdirSync(workspace).sort()).toEqual([...names].sort())
    for (const [index, file] of files.entries()) {
      expect(readFileSync(file)).toEqual(originals[index])
      expect(statSync(file).mode & 0o777).toBe(nativeModes[index])
    }
  } finally { await history.close() }
})
