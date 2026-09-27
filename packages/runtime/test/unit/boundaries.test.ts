import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '../../src')
const IMPORT = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sourceFiles(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : [])
}

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(IMPORT)].map(match => match[1] ?? match[2] ?? match[3]!)
}

describe('F54 package entry boundaries (runtime part)', () => {
  it('keeps nitro and h3 out of the root and sqlite entries', () => {
    const offenders = sourceFiles(sourceRoot)
      .filter(file => !relative(sourceRoot, file).startsWith('nitro/'))
      .flatMap(file => importsOf(file).filter(specifier => /^(nitro|h3)(\/|$)/.test(specifier)).map(specifier => `${relative(sourceRoot, file)} -> ${specifier}`))
    expect(offenders).toEqual([])
  })

  it('keeps db0 inside the sqlite entry', () => {
    const offenders = sourceFiles(sourceRoot)
      .filter(file => !relative(sourceRoot, file).startsWith('sqlite/'))
      .flatMap(file => importsOf(file).filter(specifier => specifier.startsWith('db0')).map(specifier => `${relative(sourceRoot, file)} -> ${specifier}`))
    expect(offenders).toEqual([])
  })
})

describe('greenfield public surface (ruling 2)', () => {
  it('exports no internal steps or helpers from the public entries', async () => {
    const internal = ['renderHuman', 'validateServiceGraph', 'cancelledOutcome', 'runRequestInScope']
    const entries = [await import('../../src/index.js'), await import('../../src/sqlite/index.js'), await import('../../src/nitro/index.js')]
    expect(entries.flatMap(entry => Object.keys(entry)).filter(name => internal.includes(name))).toEqual([])
  })
})
