import { describe, expect, it } from 'vitest'
import { createPathView, OUTSIDE_PATH } from '../common/domain/path-view.js'
import { toVirtualUris } from '../common/services/packs/dev/virtual-paths.js'

const ROOT = '/work/project'
const mounted = createPathView({ root: ROOT, mount: '/workspace' })
const unmounted = createPathView({ root: ROOT, mount: null })

/** What a language server answers `textDocument/definition` with. */
const definition = [{
  uri: `file://${ROOT}/src/app.ts`,
  range: { start: { line: 3, character: 9 }, end: { line: 3, character: 16 } },
}]

describe('what a language server answers under a mount', () => {
  it('shows the file the agent asked about at the path the agent knows', () => {
    expect(toVirtualUris(definition, mounted)).toEqual([{
      uri: 'file:///workspace/src/app.ts',
      range: { start: { line: 3, character: 9 }, end: { line: 3, character: 16 } },
    }])
  })

  it('rewrites every reference in a list, not only the first', () => {
    const references = [
      { uri: `file://${ROOT}/src/app.ts` },
      { uri: `file://${ROOT}/test/app.test.ts` },
    ]
    expect(toVirtualUris(references, mounted)).toEqual([
      { uri: 'file:///workspace/src/app.ts' },
      { uri: 'file:///workspace/test/app.test.ts' },
    ])
  })

  it('rewrites the keys of a workspace edit, where the file names are the keys', () => {
    const edit = { changes: { [`file://${ROOT}/src/app.ts`]: [{ newText: 'greeting' }] } }
    expect(toVirtualUris(edit, mounted)).toEqual({
      changes: { 'file:///workspace/src/app.ts': [{ newText: 'greeting' }] },
    })
  })

  it('gives a definition outside the workspace no host path at all', () => {
    const inLibrary = [{ uri: 'file:///usr/lib/node_modules/typescript/lib/lib.dom.d.ts' }]
    expect(toVirtualUris(inLibrary, mounted)).toEqual([{ uri: `file://${OUTSIDE_PATH}` }])
  })

  it('leaves everything that is not a file URI alone', () => {
    const hover = { contents: 'const greeting: string', href: 'https://example.com', line: 3, done: true, none: null }
    expect(toVirtualUris(hover, mounted)).toEqual(hover)
  })
})

describe('what a language server answers with no mount', () => {
  it('is handed back untouched, since the real root is what the agent already names', () => {
    expect(toVirtualUris(definition, unmounted)).toEqual(definition)
  })
})
