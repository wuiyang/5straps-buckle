import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { findNames } from '../common/services/packs/fs/operations.js'
import { findInput } from '../common/services/packs/fs/schemas.js'
import { invokePinnedWorkbenchFile } from '../common/services/workbench/safe-files.js'

// The name search and the staged editor match globs as node:path does: a `*` leaves dot names out, a leading `!` is
// literal, and on Windows and macOS case is ignored, as their volumes ignore it. The platform each takes imitates both.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'buckle-globs-'))
  roots.push(root)
  for (const name of ['.env', 'a.txt', '!x', 'x']) writeFileSync(join(root, name), name)
  return root
}

async function found(pattern: string, platform: NodeJS.Platform): Promise<string[]> {
  const root = workspace()
  const result = await findNames(findInput.parse({ pattern }), { paths: createPathView({ root, mount: null }), platform }) as { matches: string[] }
  return result.matches.sort()
}

function staged(tool: string, args: Record<string, string>, platform: NodeJS.Platform): { matches: Array<string | { path: string }> } {
  return invokePinnedWorkbenchFile({ root: workspace(), tool, args, permitted: () => true, platform }) as { matches: Array<string | { path: string }> }
}

describe('fs_find_names', () => {
  it('leaves dot names out of `*` and reads a leading `!` as part of the name', async () => {
    expect(await found('*', 'linux')).toEqual(['!x', 'a.txt', 'x'])
    expect(await found('!x', 'linux')).toEqual(['!x'])
  })

  it('finds a.txt by *.TXT on Windows and macOS, and not on Linux', async () => {
    for (const platform of ['win32', 'darwin'] as const) expect(await found('*.TXT', platform)).toEqual(['a.txt'])
    expect(await found('*.TXT', 'linux')).toEqual([])
  })
})

describe.runIf(process.platform === 'linux')('the staged editor', () => {
  it('matches as fs_find_names does', () => {
    expect(staged('fs_find_names', { pattern: '*' }, 'linux').matches.sort()).toEqual(['!x', 'a.txt', 'x'])
    expect(staged('fs_find_names', { pattern: '!x' }, 'linux').matches).toEqual(['!x'])
    for (const platform of ['win32', 'darwin'] as const) expect(staged('fs_find_names', { pattern: '*.TXT' }, platform).matches).toEqual(['a.txt'])
    expect(staged('fs_find_names', { pattern: '*.TXT' }, 'linux').matches).toEqual([])
  })

  it('searches the files a glob names, ignoring case on Windows', () => {
    expect(staged('fs_search_content', { pattern: 'a.txt', glob: '*.TXT' }, 'win32').matches.map(match => typeof match === 'string' ? match : match.path)).toEqual(['a.txt'])
    expect(staged('fs_search_content', { pattern: 'a.txt', glob: '*.TXT' }, 'linux').matches).toEqual([])
  })
})
