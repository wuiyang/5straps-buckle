import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { isInside } from '../common/domain/paths.js'
import { CODE_LIMITS, CODE_REFUSALS, createCodeView, readInterpreterCode, type CodeRead } from '../common/services/judge/code-reader.js'

// What the decision AI reads of an interpreter call (D91, addendum B): the code the command line hands the
// interpreter, the scripts it names, and every local file they import, transitively, through the agent's own view.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function workspace(files: Record<string, string | Buffer>, options: { mount?: string | null } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-judge-code-')))
  roots.push(base)
  const root = join(base, 'project')
  mkdirSync(root)
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const paths = createPathView({ root, mount: options.mount === undefined ? '/workspace' : options.mount })
  // The rules' answer with no grant: inside the folder, and never a credential file.
  const view = createCodeView({ paths, canRead: real => isInside(root, real) && basename(real) !== '.env', protectedRoots: [] })
  const read = (...forms: string[][]): CodeRead => readInterpreterCode({ forms, cwd: root, view })
  return { base, root, read }
}

function reading(result: CodeRead) {
  if (result.kind !== 'read') throw new Error(`expected a reading, got ${result.reason}`)
  return result.reading
}

describe('the code a JavaScript or TypeScript call runs', () => {
  it('reads the script and its local imports transitively, a TypeScript source for a .js specifier, index files, JSON, and names bare packages', () => {
    const { read } = workspace({
      'app.mjs': "import { util } from './lib/util.js'\nimport _ from 'lodash'\nconst data = require('./data.json')\nawait import('./late.mjs')\n",
      'lib/util.ts': "export { deep } from '../deep'\nimport { readFile } from 'node:fs/promises'\nexport const util = 1\n",
      'deep/index.ts': "import '@scope/pkg/sub'\nexport const deep = 2\n",
      'data.json': '{"a": 1}\n',
      'late.mjs': 'export {}\n',
    })
    const code = reading(read(['node', 'app.mjs']))
    expect(code.files.map(file => file.path)).toEqual(['/workspace/app.mjs', '/workspace/lib/util.ts', '/workspace/late.mjs', '/workspace/data.json', '/workspace/deep/index.ts'])
    expect(code.packages).toEqual(['@scope/pkg', 'lodash', 'node:fs'])
    expect(code.inline).toBeNull()
    expect(code.files[0]).toMatchObject({ bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), content: expect.stringContaining("from './lib/util.js'") })
  })

  it('reads each file once through an import cycle', () => {
    const { read } = workspace({ 'a.mjs': "import './b.mjs'\n", 'b.mjs': "import './a.mjs'\n" })
    expect(reading(read(['node', 'a.mjs'])).files.map(file => file.path)).toEqual(['/workspace/a.mjs', '/workspace/b.mjs'])
  })

  it('reads inline code\'s imports from the working directory, and the script a runner runs after naming its package', () => {
    const { read } = workspace({ 'helper.cjs': 'module.exports = 1\n', 'scripts/gen.ts': "import './shared.ts'\n", 'scripts/shared.ts': 'export {}\n' })
    expect(reading(read(['node', '-e', "require('./helper.cjs')"]))).toMatchObject({ inline: "require('./helper.cjs')", files: [{ path: '/workspace/helper.cjs' }] })
    expect(reading(read(['npx', 'tsx', 'scripts/gen.ts']))).toMatchObject({ packages: ['tsx'], files: [{ path: '/workspace/scripts/gen.ts' }, { path: '/workspace/scripts/shared.ts' }] })
  })

  it('refuses an import naming no file, so the call asks', () => {
    const { read } = workspace({ 'app.mjs': "import './missing.js'\n" })
    expect(read(['node', 'app.mjs'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.missing, truncated: false })
  })
})

describe('the code a Python call runs', () => {
  it('reads modules beside the script and under the working directory, with each package\'s __init__.py, and names the rest as packages', () => {
    const { read } = workspace({
      'tools/main.py': 'import os, json as j\nimport helpers.text\nfrom pkg import mod, CONSTANT\nfrom . import sibling\n',
      'tools/sibling.py': 'X = 1\n',
      'helpers/__init__.py': '',
      'helpers/text.py': 'import re\n',
      'pkg/__init__.py': 'CONSTANT = 1\n',
      'pkg/mod.py': 'from .inner import y\n',
      'pkg/inner.py': 'y = 2\n',
    })
    const code = reading(read(['python3', 'tools/main.py']))
    expect(code.files.map(file => file.path).sort()).toEqual(['/workspace/helpers/__init__.py', '/workspace/helpers/text.py', '/workspace/pkg/__init__.py', '/workspace/pkg/inner.py', '/workspace/pkg/mod.py', '/workspace/tools/main.py', '/workspace/tools/sibling.py'])
    expect(code.packages).toEqual(['json', 'os', 're'])
  })

  it('takes -c text as inline code and reads what it imports', () => {
    const { read } = workspace({ 'tools.py': 'def run(): pass\n' })
    expect(reading(read(['python3', '-c', 'import tools; tools.run()']))).toMatchObject({ inline: 'import tools; tools.run()', files: [{ path: '/workspace/tools.py' }] })
  })

  it('refuses a relative import naming no module', () => {
    const { read } = workspace({ 'pkg/__init__.py': 'from .gone import x\n' })
    expect(read(['python3', 'pkg/__init__.py'])).toMatchObject({ kind: 'refused', reason: CODE_REFUSALS.missing })
  })
})

describe('the code a shell applet or awk runs', () => {
  it('follows source and . in shell code, and takes an awk program as inline code', () => {
    const { read } = workspace({ 'build.sh': '#!/bin/sh\nsource ./lib.sh\n. "$HOME/.profile"\n', 'lib.sh': 'echo lib\n', 'env.sh': 'X=1\n', 'data.txt': 'a b\n' })
    expect(reading(read(['busybox', 'sh', 'build.sh'])).files.map(file => file.path)).toEqual(['/workspace/build.sh', '/workspace/lib.sh'])
    expect(reading(read(['busybox', 'sh', '-c', '. ./env.sh && run']))).toMatchObject({ inline: '. ./env.sh && run', files: [{ path: '/workspace/env.sh' }] })
    expect(reading(read(['awk', '{print $1}', 'data.txt']))).toMatchObject({ inline: '{print $1}', files: [{ path: '/workspace/data.txt' }] })
  })
})

describe('what the reader never reads', () => {
  it('refuses a link leaving the workspace, and an import climbing out of the mount', () => {
    const { base, read } = workspace({ 'app.mjs': "import '../outside.mjs'\n" })
    writeFileSync(join(base, 'outside.mjs'), 'export {}\n')
    symlinkSync(join(base, 'outside.mjs'), join(base, 'project', 'link.mjs'))
    expect(read(['node', 'link.mjs'])).toMatchObject({ kind: 'refused', reason: CODE_REFUSALS.unreadable })
    expect(read(['node', 'app.mjs'])).toMatchObject({ kind: 'refused', reason: CODE_REFUSALS.unreadable })
  })

  it('ignores a name outside the mount, which the sandbox does not have, and refuses a file the agent may not read without asking', () => {
    const { base, read } = workspace({ '.env': 'TOKEN=x\n', 'app.mjs': "import './.env'\n" })
    writeFileSync(join(base, 'elsewhere.mjs'), 'export {}\n')
    expect(reading(read(['node', join(base, 'elsewhere.mjs')])).files).toEqual([])
    expect(read(['node', 'app.mjs'])).toMatchObject({ kind: 'refused', reason: CODE_REFUSALS.unreadable })
  })

  it('refuses a file that is not text', () => {
    const { read } = workspace({ 'app.mjs': "import './blob.json'\n", 'blob.json': Buffer.from([0xff, 0xfe, 0x00, 0x80]) })
    expect(read(['node', 'app.mjs'])).toMatchObject({ kind: 'refused', reason: CODE_REFUSALS.binary })
  })

  it('names every file as the sandbox shows it, never by its host path, mounted or not', () => {
    for (const mount of ['/workspace', '/src', null]) {
      const { root, read } = workspace({ 'app.mjs': "import './b.mjs'\n", 'b.mjs': '' }, { mount })
      const code = reading(read(['node', 'app.mjs']))
      expect(code.files.map(file => file.path)).toEqual([`${mount ?? '/workspace'}/app.mjs`, `${mount ?? '/workspace'}/b.mjs`])
      expect(JSON.stringify(code)).not.toContain(root)
    }
  })
})

describe('the reader\'s caps', () => {
  it(`refuses past ${CODE_LIMITS.files} files, marking the reading truncated`, () => {
    const files: Record<string, string> = { 'app.mjs': Array.from({ length: CODE_LIMITS.files }, (_, index) => `import './m${index}.mjs'`).join('\n') }
    for (let index = 0; index < CODE_LIMITS.files; index++) files[`m${index}.mjs`] = ''
    expect(workspace(files).read(['node', 'app.mjs'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.truncated, truncated: true })
    delete files[`m${CODE_LIMITS.files - 1}.mjs`]
    files['app.mjs'] = Array.from({ length: CODE_LIMITS.files - 1 }, (_, index) => `import './m${index}.mjs'`).join('\n')
    expect(reading(workspace(files).read(['node', 'app.mjs'])).files).toHaveLength(CODE_LIMITS.files)
  })

  it(`refuses past ${CODE_LIMITS.bytes} bytes in all`, () => {
    const half = 'x'.repeat(CODE_LIMITS.bytes / 2)
    expect(workspace({ 'a.mjs': `import './b.mjs'\n${half}`, 'b.mjs': half }).read(['node', 'a.mjs'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.truncated, truncated: true })
    expect(reading(workspace({ 'a.mjs': half.slice(20) }).read(['node', 'a.mjs'])).files).toHaveLength(1)
  })
})
