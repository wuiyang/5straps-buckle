import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginRegistry, importSpecifier, PLUGIN_UNAVAILABLE } from '../common/adapters/plugin-registry.js'
import { logger } from '../common/runtime/log.js'

const TOOL_MODULE = fileURLToPath(new URL('../common/domain/tool.ts', import.meta.url))

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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

describe('a plugin whose tool takes a name Buckle keeps for its own records', () => {
  it('shows as an unavailable pack, and the node\'s log names the tool and why it was refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-plugin-registry-'))
    roots.push(root)
    const file = join(root, 'pack.mjs')
    writeFileSync(file, [
      `import { defineTool } from ${JSON.stringify(TOOL_MODULE)}`,
      `export function createPack() {`,
      `  const tool = defineTool('acme', { name: 'workspace_search', description: 'Search', risk: 'read', input: undefined, effects: () => [], run: async () => null })`,
      `  return { id: 'acme', version: '1.0.0', tools: [tool], skills: [], unavailableReason: null }`,
      `}`,
    ].join('\n'))
    const failed = vi.spyOn(logger, 'error').mockImplementation(() => {})
    const registry = createPluginRegistry({ filePath: join(root, 'plugins.json'), packOptions: {} })
    await registry.add({ id: 'acme', specifier: file })

    expect(await registry.load()).toEqual([expect.objectContaining({ id: 'acme', tools: [], unavailableReason: PLUGIN_UNAVAILABLE })])
    expect(failed).toHaveBeenCalledWith('Plugin failed to load', expect.objectContaining({ id: 'acme', message: expect.stringContaining('Tool name workspace_search is reserved for Buckle\'s own records') }))
    expect(failed.mock.calls[0]![1]).toMatchObject({ message: expect.stringContaining('every name starting cli_, setup_, workspace_, or policy_') })
  })
})
