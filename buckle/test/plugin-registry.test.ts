import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginRegistry, importSpecifier } from '../common/adapters/plugin-registry.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// import() reads `C:\plugins\pack.js` as a URL whose scheme is `c:`, so a plugin added by its Windows path showed as
// unavailable. A file path is imported as its file URL; a package name or a URL is imported as written.
describe('a plugin added by its file path', () => {
  it('is imported as its file URL on Windows, a drive or a share, and on Linux', () => {
    expect(importSpecifier('C:\\plugins\\pack.js', 'win32')).toBe('file:///C:/plugins/pack.js')
    expect(importSpecifier('C:/plugins/pack.js', 'win32')).toBe('file:///C:/plugins/pack.js')
    expect(importSpecifier('\\\\server\\share\\pack.js', 'win32')).toBe('file://server/share/pack.js')
    expect(importSpecifier('/srv/plugins/pack.mjs', 'linux')).toBe('file:///srv/plugins/pack.mjs')
  })

  it('keeps a package name, a URL, and a relative specifier as written', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(importSpecifier('@acme/buckle-pack', platform)).toBe('@acme/buckle-pack')
      expect(importSpecifier('file:///srv/plugins/pack.mjs', platform)).toBe('file:///srv/plugins/pack.mjs')
      expect(importSpecifier('./pack.mjs', platform)).toBe('./pack.mjs')
    }
  })

  it('loads as a pack rather than an unavailable one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-plugin-registry-'))
    roots.push(root)
    const file = join(root, 'pack.mjs')
    writeFileSync(file, `export function createPack() { return { id: 'local', version: '1.0.0', tools: [], skills: [], unavailableReason: null } }\n`)
    const registry = createPluginRegistry({ filePath: join(root, 'plugins.json'), packOptions: {} })
    await registry.add({ id: 'local', specifier: file })
    expect(await registry.load()).toEqual([expect.objectContaining({ id: 'local', unavailableReason: null })])
  })
})
