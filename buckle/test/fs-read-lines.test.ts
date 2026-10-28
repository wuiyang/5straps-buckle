import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { readFileEntry } from '../common/services/packs/fs/operations.js'
import { readInput } from '../common/services/packs/fs/schemas.js'

// A line is text ended by a newline, or by the end of the file: a final newline ends the last line and does not start
// another, so `hello world\n` is one line, as an editor and wc -l count it, and an empty file has none. fs_read said two
// for it (the 0.1.8 publish test). The content it returns is the file's own text, trailing newline kept.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function read(text: string, paging: { offset?: number; limit?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'buckle-read-lines-'))
  roots.push(root)
  writeFileSync(join(root, 'f.txt'), text)
  return readFileEntry(readInput.parse({ path: 'f.txt', ...paging }), { paths: createPathView({ root, mount: null }) })
}

describe('fs_read counts lines as a file has them', () => {
  it.each([
    ['one line ending in a newline', 'hello world\n', 1],
    ['one line with no newline', 'hello world', 1],
    ['an empty file', '', 0],
    ['a blank line after a line', 'a\n\n', 2],
    ['three lines ending in a newline', 'a\nb\nc\n', 3],
    ['three lines with no final newline', 'a\nb\nc', 3],
    ['a lone newline', '\n', 1],
  ])('%s', async (_name, text, lines) => {
    expect(await read(text)).toMatchObject({ content: text, firstLine: 1, lineCount: lines, totalLines: lines, truncated: false })
  })

  it('counts the lines a page returns, and marks a page that leaves lines out', async () => {
    expect(await read('a\nb\nc\n', { offset: 2, limit: 1 })).toMatchObject({ content: 'b', firstLine: 2, lineCount: 1, totalLines: 3, truncated: true })
    expect(await read('a\nb\nc\n', { offset: 2 })).toMatchObject({ content: 'b\nc\n', firstLine: 2, lineCount: 2, totalLines: 3, truncated: true })
    expect(await read('a\nb\nc\n', { limit: 2 })).toMatchObject({ content: 'a\nb', lineCount: 2, totalLines: 3, truncated: true })
  })

  it('does not call a page truncated when it holds every line, though the file ends in a newline', async () => {
    expect(await read('a\nb\n', { limit: 2 })).toMatchObject({ content: 'a\nb\n', lineCount: 2, totalLines: 2, truncated: false })
    expect(await read('a\nb\n', { offset: 2, limit: 1 })).toMatchObject({ content: 'b\n', firstLine: 2, lineCount: 1, totalLines: 2, truncated: true })
    expect(await read('a\nb', { limit: 2 })).toMatchObject({ content: 'a\nb', lineCount: 2, totalLines: 2, truncated: false })
    expect(await read('a\nb\n', { limit: 50 })).toMatchObject({ content: 'a\nb\n', lineCount: 2, totalLines: 2, truncated: false })
  })

  it('returns no lines for an offset past the end', async () => {
    expect(await read('a\n', { offset: 5 })).toMatchObject({ content: '', firstLine: 5, lineCount: 0, totalLines: 1, truncated: true })
  })
})
