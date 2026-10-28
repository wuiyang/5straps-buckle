import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { applyEdits, patchFile } from '../common/services/packs/fs/operations.js'
import { patchInput } from '../common/services/packs/fs/schemas.js'

// fs_patch writes the replacement text exactly as given: a `$` in it is a dollar sign, never a replacement pattern.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const tokens = [
  ['$&', '$&'],
  ['$$', '$$'],
  ['$1', '$1'],
  ['$`', '$`'],
  ["$'", "$'"],
  ['a$$b $& c$1 $` $\' $<name> $0', 'a$$b $& c$1 $` $\' $<name> $0'],
] as const

describe('fs_patch replacement text', () => {
  for (const replaceAll of [false, true]) {
    for (const [newText, expected] of tokens) {
      it(`writes ${JSON.stringify(newText)} literally with replaceAll ${replaceAll}`, () => {
        const text = replaceAll ? 'left OLD middle OLD right' : 'left OLD right'
        const result = applyEdits(text, [{ oldText: 'OLD', newText, replaceAll }])
        expect(result.content).toBe(replaceAll ? `left ${expected} middle ${expected} right` : `left ${expected} right`)
        expect(result.replacements).toEqual([replaceAll ? 2 : 1])
      })
    }
  }

  it('replaces only the first of the occurrences it counted when the text is unique, and counts it once', () => {
    expect(applyEdits('OLD', [{ oldText: 'OLD', newText: '$&$&', replaceAll: false }])).toEqual({ content: '$&$&', replacements: [1] })
  })

  it('applies later edits to what the earlier ones wrote, literally', () => {
    const result = applyEdits('one two', [{ oldText: 'one', newText: '$$', replaceAll: false }, { oldText: '$$', newText: '$&', replaceAll: false }])
    expect(result).toEqual({ content: '$& two', replacements: [1, 1] })
  })

  it('leaves a file with the text it was given', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-fs-patch-'))
    roots.push(root)
    writeFileSync(join(root, 'patch.txt'), 'before OLD after\n')
    const paths = createPathView({ root, mount: null })
    const changed = await patchFile(patchInput.parse({ path: 'patch.txt', edits: [{ oldText: 'OLD', newText: '$& $$ $1 $`' }] }), { paths })
    expect(readFileSync(join(root, 'patch.txt'), 'utf8')).toBe('before $& $$ $1 $` after\n')
    expect(changed).toMatchObject({ replacements: [1] })
  })
})
