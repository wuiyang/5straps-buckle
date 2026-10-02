import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT, sourceFiles } from './support/sources.js'

const SOURCES = ['main.ts', 'common', 'cli', 'mcp', 'server', 'layers', 'scripts', 'nitro.config.ts']
const NODE_SQLITE = /['"](?:node:)?sqlite['"]/

// Plan section B: every SQLite connection and lock goes through @5straps/runtime/sqlite.
describe('the SQLite boundary', () => {
  it('leaves node:sqlite to @5straps/runtime: no Buckle source imports it', () => {
    const offenders = sourceFiles(...SOURCES)
      .filter(file => NODE_SQLITE.test(readFileSync(file, 'utf8')))
      .map(file => relative(PACKAGE_ROOT, file))
    expect(offenders).toEqual([])
  })
})
