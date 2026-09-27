import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE = fileURLToPath(new URL('..', import.meta.url))
const SOURCES = ['main.ts', 'common', 'cli', 'mcp', 'server', 'scripts']
const NODE_SQLITE = /['"](?:node:)?sqlite['"]/

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return /\.(?:ts|mjs|js)$/.test(path) ? [path] : []
  return readdirSync(path).flatMap(name => sourceFiles(join(path, name)))
}

// Plan section B: every SQLite connection and lock goes through @5straps/runtime/sqlite.
describe('the SQLite boundary', () => {
  it('leaves node:sqlite to @5straps/runtime: no Buckle source imports it', () => {
    const offenders = SOURCES.flatMap(source => sourceFiles(join(PACKAGE, source)))
      .filter(file => NODE_SQLITE.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE, file))
    expect(offenders).toEqual([])
  })
})
