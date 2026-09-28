import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT, sourceFiles } from './support/sources.js'

// Plan section B, copying Foundation check F54. What Nitro bundles into .output (the layers' server
// code, the custom entry and the error handler) takes values from these packages only, and common
// code as types only; everything else arrives through event.context.services. A second bundled copy
// of common would pull node-pty and dynamic plugin imports into .output, and split error identity.
const BUNDLED_PACKAGES = /^(?:h3|nitro|srvx)(?:\/|$)|^@5straps\/(?:runtime|protocol)(?:\/|$)|^zod$/
const FRAMEWORK = /^(?:nitro|h3|srvx|crossws|hono|@hono\/)/
const IMPORT = /\b(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g
// A dynamic import pulls a value in just as a static one does, and the bundler would inline its target (review L6 of B13-B14).
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

interface Import { file: string; specifier: string; typeOnly: boolean }

function importsIn(text: string, file: string): Import[] {
  const statics = [...text.matchAll(IMPORT)].map(match => ({ file, specifier: match[3]!, typeOnly: match[2] !== undefined }))
  const dynamics = [...text.matchAll(DYNAMIC_IMPORT)].map(match => ({ file, specifier: match[1]!, typeOnly: false }))
  return [...statics, ...dynamics]
}

function importsOf(file: string): Import[] {
  return importsIn(readFileSync(file, 'utf8'), relative(PACKAGE_ROOT, file))
}

function target(item: Import): string {
  return relative(PACKAGE_ROOT, join(dirname(join(PACKAGE_ROOT, item.file)), item.specifier)).replace(/\.js$/, '.ts')
}

function bundledSources(): string[] {
  const layers = sourceFiles('layers').filter(file => relative(PACKAGE_ROOT, file).split('/')[2] === 'server')
  return [...layers, join(PACKAGE_ROOT, 'server', 'entry.ts'), join(PACKAGE_ROOT, 'server', 'error.ts')]
}

describe('the layer boundary', () => {
  it('reads dynamic imports as value imports', () => {
    const found = importsIn("const common = await import('../../../../common/runtime/services.js')\nimport type { X } from './x.js'", 'layers/common/server/routes/probe.ts')
    expect(found).toEqual(expect.arrayContaining([
      { file: 'layers/common/server/routes/probe.ts', specifier: '../../../../common/runtime/services.js', typeOnly: false },
      { file: 'layers/common/server/routes/probe.ts', specifier: './x.js', typeOnly: true },
    ]))
  })

  it('bundles only h3, nitro, srvx, @5straps/runtime, @5straps/protocol and zod into .output', () => {
    const packages = bundledSources().flatMap(importsOf).filter(item => !item.specifier.startsWith('.'))
    expect(packages.length).toBeGreaterThan(0)
    expect(packages.filter(item => !BUNDLED_PACKAGES.test(item.specifier))).toEqual([])
  })

  it('takes common code as types only, and nothing from cli, mcp or the Hono faces', () => {
    const relatives = bundledSources().flatMap(importsOf).filter(item => item.specifier.startsWith('.'))
    const outside = relatives.filter(item => !/^(?:layers|server\/(?:entry|error|built-entry))/.test(target(item)))
    expect(outside.length).toBeGreaterThan(0)
    expect(outside.filter(item => !item.typeOnly || !target(item).startsWith('common/'))).toEqual([])
  })

  it('keeps Nitro, H3 and the HTTP faces out of common, mcp and cli', () => {
    const rules: Array<{ folder: string; reaches: RegExp }> = [
      { folder: 'common', reaches: /^common\// },
      { folder: 'mcp', reaches: /^(?:mcp|common)\// },
      { folder: 'cli', reaches: /^(?:cli|common|mcp)\// },
    ]
    for (const { folder, reaches } of rules) {
      const imports = sourceFiles(folder).flatMap(importsOf)
      expect(imports.filter(item => FRAMEWORK.test(item.specifier)), folder).toEqual([])
      expect(imports.filter(item => item.specifier.startsWith('.') && !reaches.test(target(item))), folder).toEqual([])
    }
  })

  it('asks nobody from a route: questions go through the approval service, never event.context.requestCli (review L7 of B13-B14)', () => {
    const readers = bundledSources().filter(file => /\brequestCli\b/.test(readFileSync(file, 'utf8')))
    expect(readers.map(file => relative(PACKAGE_ROOT, file))).toEqual([])
  })

  it('has no scanned middleware: guards and audit run inside each handler (layers.md, Security boundaries)', () => {
    const layers = readdirSync(join(PACKAGE_ROOT, 'layers'))
    expect(layers.sort()).toEqual(['admin', 'common', 'mcp'])
    expect(layers.filter(layer => existsSync(join(PACKAGE_ROOT, 'layers', layer, 'server', 'middleware')))).toEqual([])
  })
})
