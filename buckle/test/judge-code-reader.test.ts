import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { isInside } from '../common/domain/paths.js'
import { baseCommand } from '../common/domain/argv.js'
import { allForms, commandFormsOf } from '../common/domain/command-forms.js'
import { CODE_LIMITS, CODE_REFUSALS, createCodeView, readInterpreterCode, type CodeRead } from '../common/services/judge/code-reader.js'
import { SHELL_TEXT_REFUSAL, simpleStatement } from '../common/services/judge/shell-statement.js'
import { judgeCacheKey } from '../common/services/judge/judge-cache.js'

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
  // A whole call as the gate reads it: its forms as the rules read them, the interpreter ones read, with its chain.
  const call = (command: string, ...args: string[]): CodeRead => {
    const forms = commandFormsOf({ command, args })
    const running = allForms(forms).filter(([word = '']) => forms.interpreters.includes(word) || forms.interpreters.includes(baseCommand(word)))
    return readInterpreterCode({ forms: running, chain: forms.chain, typed: [command, ...args], pieces: forms.pieces, cwd: root, view })
  }
  const shell = (text: string, program = 'bash'): CodeRead => call(program, '-c', text)
  return { base, root, read, call, shell, view }
}

const shellRefusal = { kind: 'refused', reason: SHELL_TEXT_REFUSAL, truncated: false }
const paths = (result: CodeRead) => reading(result).files.map(file => file.path)

function reading(result: CodeRead) {
  if (result.kind !== 'read') throw new Error(`expected a reading, got ${result.reason}`)
  return result.reading
}

describe('the code a JavaScript or TypeScript call runs', () => {
  it('reads the script and its local imports transitively under tsx: a TypeScript source for a .js specifier, index files, JSON, and bare packages named', () => {
    const { read } = workspace({
      'app.mjs': "import { util } from './lib/util.js'\nimport _ from 'lodash'\nconst data = require('./data.json')\nawait import('./late.mjs')\n",
      'lib/util.ts': "export { deep } from '../deep'\nimport { readFile } from 'node:fs/promises'\nexport const util = 1\n",
      'deep/index.ts': "import '@scope/pkg/sub'\nexport const deep = 2\n",
      'data.json': '{"a": 1}\n',
      'late.mjs': 'export {}\n',
    })
    // tsx resolves a .js specifier to its TypeScript source and tries extensions and index files; node does neither (fix brief 3, F1).
    const code = reading(read(['tsx', 'app.mjs']))
    expect(code.files.map(file => file.path)).toEqual(['/workspace/app.mjs', '/workspace/lib/util.ts', '/workspace/late.mjs', '/workspace/data.json', '/workspace/deep/index.ts'])
    expect(code.packages.map(item => item.name)).toEqual(['@scope/pkg', 'lodash', 'node:fs'])
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
    expect(reading(read(['npx', 'tsx', 'scripts/gen.ts']))).toMatchObject({ packages: [{ name: 'tsx', version: null, socket: null }], files: [{ path: '/workspace/scripts/gen.ts' }, { path: '/workspace/scripts/shared.ts' }] })
  })

  it('resolves a file\'s imports by node\'s own rules under node: require as CommonJS, import by the exact name (fix brief 3, F1)', () => {
    const { read } = workspace({
      'uses-require.js': "require('./lib')\n", 'lib.mjs': 'export {}\n', 'lib/index.js': 'module.exports = 1\n',
      'uses-main.js': "require('./tool')\n", 'tool/package.json': '{"main":"run.js"}', 'tool/run.js': 'module.exports = 2\n', 'tool/index.js': 'nope\n',
      'folder.mjs': "import './lib'\n", 'bare-name.mjs': "import './other'\n", 'other.js': 'export {}\n',
      'exact.mjs': "import './other.js'\nawait import('./lib.mjs')\n",
      'esm/package.json': '{"type":"module"}', 'esm/app.js': "import './dep.js'\n", 'esm/dep.js': 'export {}\n', 'esm/loose.js': "import './dep'\n",
      'uses-ts.js': "require('./util')\n", 'util.ts': 'export {}\n',
    })
    const files = (form: string[]) => reading(read(form)).files.map(file => file.path)
    // node's require tries lib.js, lib.json, lib.node, then the folder: it never loads lib.mjs, so lib/index.js is shown.
    expect(files(['node', 'uses-require.js'])).toEqual(['/workspace/uses-require.js', '/workspace/lib/index.js'])
    expect(files(['node', 'uses-main.js'])).toEqual(['/workspace/uses-main.js', '/workspace/tool/run.js'])
    // An ES module import tries no extension, index, or folder, so a name that is no file refuses.
    expect(read(['node', 'folder.mjs'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.missing, truncated: false })
    expect(read(['node', 'bare-name.mjs'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.missing, truncated: false })
    expect(files(['node', 'exact.mjs'])).toEqual(['/workspace/exact.mjs', '/workspace/other.js', '/workspace/lib.mjs'])
    // A .js file under "type": "module" is read the same way: its import names the file exactly.
    expect(files(['node', 'esm/app.js'])).toEqual(['/workspace/esm/app.js', '/workspace/esm/dep.js'])
    expect(read(['node', 'esm/loose.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.missing, truncated: false })
    // The runtime is carried with each file: node loads no TypeScript source, so the require names nothing and refuses;
    // tsx, which keeps the wider list, loads util.ts.
    expect(read(['node', 'uses-ts.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.missing, truncated: false })
    expect(files(['tsx', 'uses-ts.js'])).toEqual(['/workspace/uses-ts.js', '/workspace/util.ts'])
  })

  it('refuses an import naming no file, so the call asks', () => {
    const { read } = workspace({ 'app.mjs': "import './missing.js'\n" })
    expect(read(['node', 'app.mjs'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.missing, truncated: false })
  })
})

describe('the script an interpreter finds by its own rules', () => {
  it('is found as node finds it: with an extension, a folder\'s package.json main, else its index file, and after a runner\'s package', () => {
    const { read } = workspace({
      'build.js': 'console.log(1)\n', 'tool/package.json': '{"main":"lib/start"}', 'tool/lib/start.ts': 'export {}\n', 'tool/index.js': 'nope\n',
      'plain/index.mjs': 'export {}\n', 'package.json': '{"name":"site"}', 'index.js': "require('./build')\n", 'gen.ts': 'export {}\n',
    })
    expect(reading(read(['node', 'build'])).files.map(file => file.path)).toEqual(['/workspace/build.js'])
    // node tries no TypeScript sibling of main: it runs the folder's index.js, after the module it requires first.
    expect(reading(read(['node', '--require', './build.js', 'tool'])).files.map(file => file.path)).toEqual(['/workspace/build.js', '/workspace/tool/index.js'])
    expect(reading(read(['tsx', 'tool'])).files.map(file => file.path)).toEqual(['/workspace/tool/lib/start.ts'])
    expect(reading(read(['tsx', 'plain'])).files.map(file => file.path)).toEqual(['/workspace/plain/index.mjs'])
    // `node .` tries `<folder>.js` first, which at the workspace root lies beyond the view, so it refuses (fix brief 4, H1).
    expect(read(['node', '.'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unreadable, truncated: false })
    expect(reading(read(['deno', 'run', '-A', 'gen'])).files.map(file => file.path)).toEqual(['/workspace/gen.ts'])
    expect(reading(read(['npx', 'tsx', 'gen'])).files.map(file => file.path)).toEqual(['/workspace/gen.ts'])
  })

  it('resolves a name and its main as node\'s path.resolve does, so a dot or a trailing slash names what node runs (fix brief 4, H1)', () => {
    const { root, read, view } = workspace({
      'tool.js': 'module.exports = 1\n', 'tool/package.json': '{"main":"."}', 'tool/index.js': 'nope\n', 'tool/a.js': "require('.')\n", 'tool/b.js': "require('./')\n",
      'a.js': 'module.exports = 2\n', 'a/b/package.json': '{"main":".."}', 'a/b/index.js': 'nope\n', 'a/index.js': 'nope\n',
      'lib2.js': 'module.exports = 3\n', 'lib2/index.js': 'module.exports = 4\n', 'lib2/.js': 'decoy\n', 'uses.js': "require('./lib2/')\n",
      'bs/package.json': '{"main":"lib\\\\x"}', 'bs/index.js': 'nope\n', 'build.js': 'console.log(1)\n',
    })
    const at = (folder: string, form: string[]) => readInterpreterCode({ forms: [form], cwd: join(root, folder), view })
    expect(paths(read(['node', 'tool/a.js']))).toEqual(['/workspace/tool/a.js', '/workspace/tool.js'])
    expect(paths(read(['node', 'tool/b.js']))).toEqual(['/workspace/tool/b.js', '/workspace/tool.js'])
    // `node .` resolves to the folder, so node tries the file beside it first, then the folder's main.
    expect(paths(at('tool', ['node', '.']))).toEqual(['/workspace/tool.js'])
    expect(paths(at('a/b', ['node', '.']))).toEqual(['/workspace/a.js'])
    // The entry drops a trailing slash first; a require keeps it and goes to the folder.
    expect(paths(read(['node', 'lib2/']))).toEqual(['/workspace/lib2.js'])
    expect(paths(read(['node', 'uses.js']))).toEqual(['/workspace/uses.js', '/workspace/lib2/index.js'])
    // A backslash is part of a file's name here, which pathe would read as a separator.
    expect(read(['node', 'bs'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.config, truncated: false })
    expect(read(['node', 'tool\\a.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unreadable, truncated: false })
    expect(paths(read(['node', 'build.js', 'a\\b']))).toEqual(['/workspace/build.js'])
  })

  it('follows node\'s own order for node, never a decoy it would not run (fix brief 2, H1)', () => {
    const { read } = workspace({
      'tool/package.json': '{"main":"start"}', 'tool/start.mjs': 'export {}\n', 'tool/start.ts': 'export {}\n', 'tool/index.js': 'evil()\n',
      'exact/package.json': '{"main":"start.mjs"}', 'exact/start.mjs': 'export {}\n', 'exact/index.js': 'nope\n',
      'gone/package.json': '{"main":"start.mjs"}', 'gone/index.js': 'evil()\n',
      'bare/package.json': '{"main":"start.mjs"}', 'bare/index.mjs': 'export {}\n',
      'build.ts': 'export {}\n', 'build.mjs': 'export {}\n', 'build/index.js': 'evil()\n',
      'decoy/index.ts': 'export {}\n', 'decoy/index.js': 'evil()\n',
      'nested/package.json': '{"main":"lib"}', 'nested/lib/index.js': 'evil()\n', 'nested/index.js': 'nope\n',
      'abs/package.json': '{"main":"/workspace/lib/run.js"}', 'abs/index.js': 'nope\n', 'lib/run.js': 'evil()\n',
    })
    const files = (form: string[]) => reading(read(form)).files.map(file => file.path)
    expect(files(['node', 'tool'])).toEqual(['/workspace/tool/index.js'])
    expect(files(['node', 'exact'])).toEqual(['/workspace/exact/start.mjs'])
    expect(files(['node', 'gone'])).toEqual(['/workspace/gone/index.js'])
    expect(files(['node', 'build'])).toEqual(['/workspace/build/index.js'])
    expect(files(['node', 'decoy'])).toEqual(['/workspace/decoy/index.js'])
    expect(files(['node', 'nested'])).toEqual(['/workspace/nested/lib/index.js'])
    expect(files(['npx', 'node', 'tool'])).toEqual(['/workspace/tool/index.js'])
    // An absolute main is a path as written, here the sandbox's name for a file in the workspace.
    expect(files(['node', 'abs'])).toEqual(['/workspace/lib/run.js'])
    expect(read(['node', 'bare'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
  })

  it('resolves main as node\'s path.resolve does: a trailing slash or a final /. dropped, .. resolved (fix brief 3, H1)', () => {
    const { base, read } = workspace({
      'slash/package.json': '{"main":"lib/"}', 'slash/lib/index.js': 'module.exports = 1\n',
      'dot/package.json': '{"main":"./lib/."}', 'dot/lib/index.js': 'module.exports = 1\n',
      'sibling/package.json': '{"main":"lib/"}', 'sibling/lib.js': 'module.exports = 2\n', 'sibling/lib/index.js': 'module.exports = 1\n',
      'sibling-dot/package.json': '{"main":"./lib/."}', 'sibling-dot/lib.js': 'module.exports = 2\n', 'sibling-dot/lib/index.js': 'module.exports = 1\n',
      'package.json': '{"main":"../other"}', 'index.js': 'module.exports = 3\n',
    })
    writeFileSync(join(base, 'other.js'), 'module.exports = 4\n')
    const files = (form: string[]) => reading(read(form)).files.map(file => file.path)
    expect(files(['node', 'slash'])).toEqual(['/workspace/slash/lib/index.js'])
    expect(files(['node', 'dot'])).toEqual(['/workspace/dot/lib/index.js'])
    // node tries lib.js before the folder, so the sibling file is the one that runs.
    expect(files(['node', 'sibling'])).toEqual(['/workspace/sibling/lib.js'])
    expect(files(['node', 'sibling-dot'])).toEqual(['/workspace/sibling-dot/lib.js'])
    // A main climbing out of the workspace lands beyond the agent's view, so the call asks.
    expect(read(['node', '.'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unreadable, truncated: false })
  })

  it('refuses an absolute main outside the workspace, and reads a .node addon as a file, which is no text', () => {
    const { base, read } = workspace({ 'addon/package.json': '{"main":"build/addon.node"}', 'addon/build/addon.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0x00]), 'addon/index.js': 'nope\n', 'abs/index.js': 'nope\n' })
    writeFileSync(join(base, 'evil.js'), 'evil()\n')
    writeFileSync(join(base, 'project', 'abs', 'package.json'), JSON.stringify({ main: join(base, 'evil.js') }))
    expect(read(['node', 'abs'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unreadable, truncated: false })
    expect(read(['node', 'addon'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.binary, truncated: false })
  })

  it('refuses a data word holding a backslash and a slash, which it cannot resolve as node does, but leaves a bare one as data (fix brief 5, H1b)', () => {
    const { read } = workspace({ 'build.js': 'console.log(1)\n' })
    expect(read(['node', 'build.js', '/elsewhere\\x.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unreadable, truncated: false })
    expect(read(['node', 'build.js', '../x\\y.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unreadable, truncated: false })
    // A bare word with a backslash and no slash is left unread as data, so the script alone is shown.
    expect(paths(read(['node', 'build.js', 'a\\b']))).toEqual(['/workspace/build.js'])
  })

  it('refuses a python script whose name holds a backslash, never showing the file pathe would place there (fix brief 6, B10)', () => {
    const { read, shell } = workspace({ 'a/b.py': 'print(0)\n', 'job.py': 'print(1)\n' })
    const unreadable = { kind: 'refused', reason: CODE_REFUSALS.unreadable, truncated: false }
    expect(read(['python3', 'a\\b.py'])).toEqual(unreadable)
    expect(read(['python3', '--', 'a\\b.py'])).toEqual(unreadable)
    expect(shell("python3 'a\\b.py'")).toEqual(unreadable)
    expect(paths(read(['python3', 'job.py']))).toEqual(['/workspace/job.py'])
  })

  it('is the word after a leading --, found the same way, and a namespace package\'s __main__.py for python -m (fix brief 2, H5)', () => {
    const { read } = workspace({ 'build.js': 'evil()\n', 'tool/index.js': 'evil()\n', 'pkg/__main__.py': 'import os\n', 'tools/__main__.py': 'import json\n', 'deep/inner/__main__.py': 'import re\n' })
    const files = (form: string[]) => reading(read(form)).files.map(file => file.path)
    expect(files(['node', '--', 'build'])).toEqual(['/workspace/build.js'])
    expect(files(['node', '--', 'tool'])).toEqual(['/workspace/tool/index.js'])
    expect(files(['python3', '--', 'pkg'])).toEqual(['/workspace/pkg/__main__.py'])
    expect(files(['python3', '-m', 'tools'])).toEqual(['/workspace/tools/__main__.py'])
    expect(files(['python3', '-m', 'deep.inner'])).toEqual(['/workspace/deep/inner/__main__.py'])
    expect(read(['node', '--', 'missing'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    expect(read(['python3', '--', 'missing.py'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    expect(reading(read(['node', 'build.js', '--', 'missing'])).files.map(file => file.path)).toEqual(['/workspace/build.js'])
    expect(reading(read(['python3', '-m', 'black']))).toMatchObject({ files: [], packages: [{ name: 'black' }] })
  })

  it('finds each preload as the script is found, names a bare one as a package, and refuses one naming nothing (fix brief 2, H7)', () => {
    const { read } = workspace({ 'build.js': 'console.log(1)\n', 'setup.js': "require('./lib')\n", 'lib/index.js': 'evil()\n', 'pre.ts': 'export {}\n' })
    const files = (form: string[]) => reading(read(form)).files.map(file => file.path)
    expect(files(['node', '-r', './setup', 'build.js'])).toEqual(['/workspace/setup.js', '/workspace/build.js', '/workspace/lib/index.js'])
    expect(files(['node', '--require=./setup', 'build.js'])).toEqual(['/workspace/setup.js', '/workspace/build.js', '/workspace/lib/index.js'])
    expect(reading(read(['node', '-r', 'dotenv/config', 'build.js']))).toMatchObject({ files: [{ path: '/workspace/build.js' }], packages: [{ name: 'dotenv' }] })
    expect(files(['bun', '--preload', './pre', 'build.js'])).toEqual(['/workspace/pre.ts', '/workspace/build.js'])
    expect(read(['node', '--import', './missing.mjs', 'build.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    expect(read(['node', '--import', 'data:text/javascript,evil()', 'build.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unmodelledImport, truncated: false })
  })

  it('refuses an import the reader does not model under every runtime, and resolves node\'s --import and loaders as ES modules (fix brief 4, F1 and G5)', () => {
    const decoys = { 'target.mjs': 'evil()\n', 'target.mjs?v=1': 'export {}\n', '%74arget.mjs': 'export {}\n', 'target.mjs#frag': 'export {}\n', 'build.js': 'console.log(1)\n', 'dir/index.js': 'module.exports = 1\n' }
    const unmodelled = { kind: 'refused', reason: CODE_REFUSALS.unmodelledImport, truncated: false }
    for (const statement of ["import './target.mjs?v=1'", "export * from './%74arget.mjs'", "await import('./target.mjs#frag')", "import 'file:///workspace/target.mjs'", "require('./target.mjs?v=1')"]) {
      const { read } = workspace({ ...decoys, 'a.mjs': `${statement}\n` })
      expect(read(['node', 'a.mjs']), statement).toEqual(unmodelled)
      expect(read(['tsx', 'a.mjs']), statement).toEqual(unmodelled)
    }
    const { read } = workspace({ ...decoys, 'b.mjs': "import 'node:fs'\nimport { test } from 'bun:test'\n" })
    expect(reading(read(['node', 'b.mjs'])).packages.map(item => item.name)).toEqual(['bun:test', 'node:fs'])
    for (const option of ['--import', '--loader', '--experimental-loader']) {
      expect(read(['node', option, './target.mjs?v=1', 'build.js']), option).toEqual(unmodelled)
      // node's ES module resolver tries no folder index, as require does.
      expect(read(['node', option, './dir', 'build.js']), option).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    }
    expect(paths(read(['node', '-r', './dir', 'build.js']))).toEqual(['/workspace/dir/index.js', '/workspace/build.js'])
    expect(paths(read(['node', '--import=./target.mjs', 'build.js']))).toEqual(['/workspace/target.mjs', '/workspace/build.js'])
  })

  it('refuses an ES module specifier an URL parse would change, while require stays exact (fix brief 5, F1b)', () => {
    const unmodelled = { kind: 'refused', reason: CODE_REFUSALS.unmodelledImport, truncated: false }
    // node 24 and tsx strip a leading or trailing space, and remove a tab or a C0 control, so an import holding one runs
    // another file than the reader would show; it refuses under an ES module resolution. Each specifier holds a real
    // space, tab, or control character inside the statement, not an escape.
    for (const specifier of ['./target.mjs ', ' ./target.mjs', './tar\tget.mjs', './target.mjs\u0001', './target.mjs\u007f']) {
      const importer = { 'a.mjs': `import '${specifier}'\n`, 'b.mjs': `export * from '${specifier}'\n`, 'c.mjs': `await import('${specifier}')\n` }
      const { read } = workspace({ 'target.mjs': 'export {}\n', ...importer })
      expect(read(['node', 'a.mjs']), JSON.stringify(specifier)).toEqual(unmodelled)
      expect(read(['node', 'b.mjs']), JSON.stringify(specifier)).toEqual(unmodelled)
      expect(read(['tsx', 'c.mjs']), JSON.stringify(specifier)).toEqual(unmodelled)
    }
    // --import resolves as an ES module too, so a trailing space refuses.
    expect(workspace({ 'build.js': 'console.log(1)\n', 'target.mjs': 'export {}\n' }).read(['node', '--import', './target.mjs ', 'build.js'])).toEqual(unmodelled)
    // CommonJS require takes the name as written: a file literally named with a trailing space is read.
    const cjs = workspace({ 'e.cjs': "require('./target.mjs ')\n", 'target.mjs ': 'module.exports = 1\n' })
    expect(paths(cjs.read(['node', 'e.cjs']))).toEqual(['/workspace/e.cjs', '/workspace/target.mjs '])
    // A runner's preloads resolve with the package's runtime, so node's -r is a require: it reads lib/index.js, not lib.mjs (fix brief 5, F1b, pin).
    const runner = workspace({ 'lib.mjs': 'export {}\n', 'lib/index.js': 'module.exports = 1\n', 'build.js': 'console.log(1)\n' })
    expect(paths(runner.read(['npx', 'node', '-r', './lib', 'build.js']))).toEqual(['/workspace/lib/index.js', '/workspace/build.js'])
    // An absolute specifier holding ?, #, or % refuses too (fix brief 5, F1b, pin).
    const abs = workspace({ 'a.mjs': "import '/workspace/target.mjs?v=1'\n", 'target.mjs?v=1': 'export {}\n', 'target.mjs': 'evil()\n' })
    expect(abs.read(['node', 'a.mjs'])).toEqual(unmodelled)
  })

  it('refuses a specifier holding a control, a tab, or an edge space before it reads a scheme or a package, so a hidden URL refuses (fix brief 6, B8)', () => {
    const unmodelled = { kind: 'refused', reason: CODE_REFUSALS.unmodelledImport, truncated: false }
    // node 24.21.0 strips the edge space and removes the tab before it reads the scheme, so the first four run the URL
    // (recheck 5, live); the rest pin an absolute specifier and an inner control or U+007F. Each holds the real character.
    for (const specifier of [' file:///workspace/target.mjs', 'fi\tle:///workspace/target.mjs', ' data:text/javascript,console.log(1)', '\tdata:text/javascript,console.log(1)', '/workspace/target.mjs ', './tar\u0001get.mjs', './tar\u007fget.mjs', 'decoy-package ']) {
      const { read } = workspace({ 'target.mjs': 'export {}\n', 'a.mjs': `import '${specifier}'\n`, 'build.js': 'console.log(1)\n' })
      expect(read(['node', 'a.mjs']), JSON.stringify(specifier)).toEqual(unmodelled)
      expect(read(['tsx', 'a.mjs']), JSON.stringify(specifier)).toEqual(unmodelled)
      expect(read(['node', '--import', specifier, 'build.js']), JSON.stringify(specifier)).toEqual(unmodelled)
    }
    // A plain file and a plain package still read.
    const plain = workspace({ 'target.mjs': 'export {}\n', 'a.mjs': "import './target.mjs'\nimport 'decoy-package'\n" })
    expect(reading(plain.read(['node', 'a.mjs']))).toMatchObject({ files: [{ path: '/workspace/a.mjs' }, { path: '/workspace/target.mjs' }], packages: [{ name: 'decoy-package' }] })
  })

  it('reads each preload bunfig.toml lists for bun, and refuses a config the reader cannot parse (fix brief 3, R15)', () => {
    const files = (config: string, form: string[] = ['bun', 'run.ts']) => {
      const { read } = workspace({ 'bunfig.toml': config, 'run.ts': 'export {}\n', 'pre.ts': 'export {}\n', 'second.ts': 'export {}\n', 'conf/bunfig.toml': 'preload = "./local.ts"\n', 'conf/local.ts': 'export {}\n', 'local.ts': 'export {}\n' })
      const result = read(form)
      return result.kind === 'read' ? result.reading.files.map(file => file.path) : result.reason
    }
    expect(files('# runtime\npreload = [\n  "./pre.ts", # first\n  \'./second.ts\',\n]\nsmol = true\n')).toEqual(['/workspace/pre.ts', '/workspace/second.ts', '/workspace/run.ts'])
    expect(files('[install]\nexact = true\n[run]\npreload = "./pre.ts"\n')).toEqual(['/workspace/pre.ts', '/workspace/run.ts'])
    expect(files('[test]\npreload = ["./second.ts"]\ncoverage = { enabled = true }\n')).toEqual(['/workspace/second.ts', '/workspace/run.ts'])
    expect(files('run.preload = ["./pre.ts"]\n')).toEqual(['/workspace/pre.ts', '/workspace/run.ts'])
    // --config= names the config, whose preloads resolve from the working directory as bun resolves them (fix brief 4,
    // R15); the config itself is read as data, as any value naming a file is. Any other spelling of the option refuses.
    expect(files('preload = ["./pre.ts"]\n', ['bun', '--config=conf/bunfig.toml', 'run.ts'])).toEqual(['/workspace/local.ts', '/workspace/run.ts', '/workspace/conf/bunfig.toml'])
    for (const form of [['bun', '-c', 'conf/bunfig.toml', 'run.ts'], ['bun', '--config', 'conf/bunfig.toml', 'run.ts'], ['bun', '-c=conf/bunfig.toml', 'run.ts']]) {
      expect(files('preload = ["./pre.ts"]\n', form), form.join(' ')).toBe(CODE_REFUSALS.unknownOption)
    }
    for (const config of ['preload = [1]\n', 'preload = { a = "./pre.ts" }\n', 'preload = """./pre.ts"""\n', 'preload = ["./pre.ts"\n', 'not toml at all\n', 'preload = "./pre.ts" trailing\n']) {
      expect(files(config), config).toBe(CODE_REFUSALS.config)
    }
    expect(files('preload = ["./gone.ts"]\n')).toBe(CODE_REFUSALS.notFound)
    // An inline table is its table: its preload is read, nested ones too, and one holding anything else refuses (fix brief 4, G9).
    expect(files('test = { preload = "./pre.ts" }\n')).toEqual(['/workspace/pre.ts', '/workspace/run.ts'])
    expect(files('run = { preload = ["./second.ts"], smol = true }\n')).toEqual(['/workspace/second.ts', '/workspace/run.ts'])
    expect(files('test = { coverage = { enabled = true } }\n')).toEqual(['/workspace/run.ts'])
    expect(files('test = { preload = 1 }\n')).toBe(CODE_REFUSALS.config)
  })

  it('is a folder\'s __main__.py for Python', () => {
    const { read } = workspace({ 'tool/__main__.py': 'from . import helper\n', 'tool/helper.py': 'X = 1\n' })
    expect(reading(read(['python3', 'tool'])).files.map(file => file.path)).toEqual(['/workspace/tool/__main__.py', '/workspace/tool/helper.py'])
  })

  it('is the file shell text redirects into the interpreter\'s input', () => {
    const { shell } = workspace({ 'evil.py': 'import helper\n', 'helper.py': 'X = 1\n', 'x.js': 'console.log(1)\n' })
    expect(paths(shell('python3 < evil.py'))).toEqual(['/workspace/evil.py', '/workspace/helper.py'])
    expect(paths(shell('node 0<x.js'))).toEqual(['/workspace/x.js'])
    expect(shell('python3 < gone.py')).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    // An expansion, and a second statement, are text the grammar does not rate whole (fix brief 4, P).
    expect(shell('python3 < "$SCRIPT"')).toEqual(shellRefusal)
    expect(shell('cat evil.py > out.txt; python3 -c 1')).toEqual(shellRefusal)
  })

  it('reads <> as <, and refuses a duplicated descriptor, an input on another descriptor, xargs, and a pipe (fix brief 2, H6; fix brief 4, P)', () => {
    const { shell } = workspace({ 'evil.py': 'import os\n', 'build.js': 'console.log(1)\n', 'list.txt': 'evil.py\n' })
    expect(paths(shell('python3 <> evil.py'))).toEqual(['/workspace/evil.py'])
    expect(paths(shell('python3 0<>evil.py'))).toEqual(['/workspace/evil.py'])
    for (const text of ['exec 3<evil.py; python3 <&3', 'python3 0<&3 3<evil.py', 'node build.js <&3', 'python3 3< evil.py', 'xargs python3 <<< evil.py', 'xargs python3 < list.txt', 'xargs python3 <<EOF\nevil.py\nEOF', 'cat evil.py | python3']) {
      expect(shell(text), text).toEqual(shellRefusal)
    }
  })

  it('takes the input as data where the interpreter names a script, inline code, or a module (fix brief 2, R7)', () => {
    const { shell } = workspace({ 'build.js': 'console.log(1)\n', 'job.py': 'print(1)\n', 'data.bin': Buffer.from([0xff, 0xfe, 0x00]), 'evil.py': 'import os\n' })
    expect(paths(shell('node build.js < /dev/null'))).toEqual(['/workspace/build.js'])
    expect(paths(shell('python3 job.py < data.bin'))).toEqual(['/workspace/job.py'])
    expect(shell('python3 job.py < "$IN"')).toEqual(shellRefusal)
    expect(paths(shell('python3 -c 1 < data.bin'))).toEqual([])
    expect(paths(shell('python3 - < evil.py'))).toEqual(['/workspace/evil.py'])
  })

  it('reads the redirected file where a stdin marker names the script, and names the words after it arguments (fix brief 3, R7)', () => {
    const { shell } = workspace({ 'from-stdin.py': 'import helper\n', 'from-stdin.js': 'console.log(1)\n', 'second.pl': '1;\n', 'other.php': "<?php echo 1;\n", 'other.csh': 'echo 1\n', 'helper.py': 'X = 1\n', 'job.py': 'print(1)\n', 'build.js': 'console.log(1)\n', 'notes.txt': 'x\n' })
    const files = (text: string) => paths(shell(text))
    // A lone `-`, `/dev/stdin`, php's `--`, and csh/tcsh `-s` each make the `<` file the script; the operand after it is an argument, not a file the reader reads.
    expect(files('python3 - job.py < from-stdin.py')).toEqual(['/workspace/from-stdin.py', '/workspace/helper.py'])
    expect(files('node - build.js < from-stdin.js')).toEqual(['/workspace/from-stdin.js'])
    expect(files('node /dev/stdin < from-stdin.js')).toEqual(['/workspace/from-stdin.js'])
    expect(files('perl - notes.txt < second.pl')).toEqual(['/workspace/second.pl'])
    expect(files('php -- data.txt < other.php')).toEqual(['/workspace/other.php'])
    expect(files('tcsh -s x < other.csh')).toEqual(['/workspace/other.csh'])
    // A missing redirected file refuses, since the script is required.
    expect(shell('python3 - job.py < gone.py')).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
  })

  it('reads a stdin marker after a leading --, never a planted file named -, and php\'s lone - as that file (fix brief 4, R7)', () => {
    const { shell } = workspace({ '-': 'planted\n', 'other.py': 'print(1)\n', 'other.js': 'console.log(1)\n', 'other.pl': '1;\n', 'other.rb': 'p 1\n', 'data.php': '<?php echo 1;\n' })
    expect(paths(shell('python3 -- - < other.py'))).toEqual(['/workspace/other.py'])
    expect(paths(shell('node -- - < other.js'))).toEqual(['/workspace/other.js'])
    expect(paths(shell('perl -- - < other.pl'))).toEqual(['/workspace/other.pl'])
    expect(paths(shell('ruby -- - < other.rb'))).toEqual(['/workspace/other.rb'])
    // php opens a lone - as a file of that name, so the redirected file is data.
    expect(paths(shell('php - x < data.php'))).toEqual(['/workspace/-'])
    expect(workspace({ 'data.php': '<?php echo 1;\n' }).shell('php - x < data.php')).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
  })

  it('reads lua\'s and luajit\'s - after -- as a file of that name, not stdin, but a lone - still as stdin (fix brief 5, R7b)', () => {
    // lua.c 5.4.6 handle_script opens a file literally named `-` when it follows `--`
    // (`if (strcmp(fname, "-") == 0 && strcmp(argv[-1], "--") != 0) fname = NULL;`); luajit.c has the same test.
    const { shell } = workspace({ '-': 'print(0)\n', 'other.lua': 'print(1)\n' })
    expect(paths(shell('lua -- - < other.lua'))).toEqual(['/workspace/-'])
    expect(paths(shell('luajit -- - < other.lua'))).toEqual(['/workspace/-'])
    // A lone `-` with no `--` before it is still stdin, so the redirected file is the script.
    expect(paths(shell('lua - < other.lua'))).toEqual(['/workspace/other.lua'])
  })

  it('reads lua\'s and luajit\'s /dev/stdin after -- as the redirected file, which they open with fopen (fix brief 6, B7)', () => {
    const { shell } = workspace({ '-': 'print(0)\n', 'other.lua': 'print(1)\n' })
    expect(paths(shell('lua -- /dev/stdin < other.lua'))).toEqual(['/workspace/other.lua'])
    expect(paths(shell('luajit -- /dev/stdin < other.lua'))).toEqual(['/workspace/other.lua'])
    expect(paths(shell('lua -- - < other.lua'))).toEqual(['/workspace/-'])
  })

  it('reads a C shell\'s options as clusters: s, i, or t reads the script from its input, b ends the options, c is text never rated (fix brief 4, R7)', () => {
    const { read, shell } = workspace({ 'other.csh': 'echo 1\n', 'x': 'echo 2\n', '-x.csh': 'echo 3\n' })
    expect(paths(shell('tcsh -fs x < other.csh'))).toEqual(['/workspace/other.csh'])
    expect(paths(shell('csh -sf x < other.csh'))).toEqual(['/workspace/other.csh'])
    expect(paths(shell('tcsh -fi < other.csh'))).toEqual(['/workspace/other.csh'])
    expect(paths(read(['tcsh', '-fb', '-x.csh']))).toEqual(['/workspace/-x.csh'])
    expect(read(['tcsh', '-fz', 'x'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unknownOption, truncated: false })
    expect(read(['tcsh', '-fc', 'echo 1'])).toEqual(shellRefusal)
  })

  it('refuses an interpreter option the reader does not model, and reads the redirect past a value option it does (fix brief 3, R7)', () => {
    const { read, shell } = workspace({ 'build.js': 'console.log(1)\n', 'from-stdin.js': 'console.log(2)\n', 'job.py': 'print(1)\n' })
    // --run runs a package.json script the reader cannot follow, so it is left out of node's tables and refuses.
    expect(read(['node', '--run', 'build.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unknownOption, truncated: false })
    expect(read(['node', '--env-file=.env', 'build.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unknownOption, truncated: false })
    expect(read(['python3', '-Zzz', 'job.py'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unknownOption, truncated: false })
    // --redirect-warnings takes a value, so its value is not the script; the redirected file is.
    expect(paths(shell('node --redirect-warnings notes.txt < from-stdin.js'))).toEqual(['/workspace/from-stdin.js'])
    // node reads underscores as dashes in an option's name, and so does every table lookup (fix brief 4, G1).
    expect(paths(shell('node --redirect_warnings notes.txt - < from-stdin.js'))).toEqual(['/workspace/from-stdin.js'])
    expect(paths(shell('node --redirect_warnings notes.txt < from-stdin.js'))).toEqual(['/workspace/from-stdin.js'])
    expect(read(['node', '--experimental_loader', './missing.mjs', 'build.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    expect(reading(read(['node', '--input_type', 'module', '-e', '1']))).toMatchObject({ inline: '1', files: [] })
    // A known flag and a self-contained --opt=value are read, not refused.
    expect(reading(read(['node', '--enable-source-maps', 'build.js'])).files.map(file => file.path)).toEqual(['/workspace/build.js'])
    expect(reading(read(['node', '--input-type=module', 'build.js'])).files.map(file => file.path)).toEqual(['/workspace/build.js'])
    expect(reading(read(['python3', '-B', 'job.py'])).files.map(file => file.path)).toEqual(['/workspace/job.py'])
  })

  it('reads a manifest node reads past a byte order mark, and refuses one it cannot parse or whose main is no string (fix brief 4, G6)', () => {
    const tool = { 'tool/run.js': 'module.exports = 1\n', 'tool/index.js': 'module.exports = 2\n', 'uses.js': "require('./tool')\n" }
    const config = { kind: 'refused', reason: CODE_REFUSALS.config, truncated: false }
    const bom = workspace({ ...tool, 'tool/package.json': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"main":"run.js"}')]) })
    expect(paths(bom.read(['node', 'tool']))).toEqual(['/workspace/tool/run.js'])
    expect(paths(bom.read(['node', 'uses.js']))).toEqual(['/workspace/uses.js', '/workspace/tool/run.js'])
    for (const manifest of ['{"main":', '{"main": 5}', '["run.js"]']) {
      const { read } = workspace({ ...tool, 'tool/package.json': manifest })
      expect(read(['node', 'tool']), manifest).toEqual(config)
      expect(read(['node', 'uses.js']), manifest).toEqual(config)
      expect(read(['tsx', 'tool']), manifest).toEqual(config)
    }
    // A manifest naming no main still falls back to the folder's index, as node does.
    expect(paths(workspace({ ...tool, 'tool/package.json': '{"name":"tool"}' }).read(['node', 'tool']))).toEqual(['/workspace/tool/index.js'])
  })

  it('refuses an interactive flag, which runs standard input as code after the script or inline code (fix brief 4, G2)', () => {
    const { read, shell } = workspace({ 'job.py': 'print(1)\n', 'second.py': 'print(2)\n', 'job.js': 'console.log(1)\n', 'second.js': 'console.log(2)\n', 'x.lua': 'print(1)\n', 'x.php': '<?php echo 1;\n' })
    const interactive = { kind: 'refused', reason: CODE_REFUSALS.interactive, truncated: false }
    for (const text of ['python3 -i job.py < second.py', 'python3 -iu job.py < second.py', 'python3 -i -c 1 < second.py', 'node -i -e 1 < second.js', 'node --interactive --eval 1 < second.js']) {
      expect(shell(text), text).toEqual(interactive)
    }
    expect(read(['python3', '-i', '-m', 'json.tool'])).toEqual(interactive)
    expect(read(['node', '-i'])).toEqual(interactive)
    expect(read(['lua', '-i', 'x.lua'])).toEqual(interactive)
    expect(read(['php', '-a'])).toEqual(interactive)
    // node ignores -i once it has a script, so that script is the code that runs.
    expect(paths(shell('node -i job.js < second.js'))).toEqual(['/workspace/job.js'])
  })

  it('refuses php -a after -f, a debugger fed from standard input, and node\'s inspect and debug (fix brief 5, G2b and G2c)', () => {
    const { read, shell } = workspace({ 'x.php': '<?php echo 1;\n', 'job.py': 'print(1)\n', 'job.js': 'console.log(1)\n', 'cmds': 'c\n' })
    const interactive = { kind: 'refused', reason: CODE_REFUSALS.interactive, truncated: false }
    const subcommand = { kind: 'refused', reason: CODE_REFUSALS.subcommand, truncated: false }
    // php keeps parsing after -f <file>, and -a or --interactive then runs its shell in place of the script (php_cli.c).
    expect(shell('php -f x.php -a < cmds')).toEqual(interactive)
    expect(shell('php -f x.php --interactive < cmds')).toEqual(interactive)
    // pdb reads its debugger commands from the fed input, which the reader cannot show.
    expect(shell('python3 -m pdb job.py < cmds')).toEqual(interactive)
    // node's inspect and debug start the debugger, a subcommand the reader does not follow.
    expect(shell('node inspect job.js < cmds')).toEqual(subcommand)
    expect(read(['node', 'debug', 'job.js'])).toEqual(subcommand)
  })

  it('refuses python -m of a debugger or a console, fed or not, and of a module that discovers or evaluates code, and reads any other (fix brief 6, B3)', () => {
    const { read, shell } = workspace({ 'job.py': 'print(1)\n', 'second.py': 'print(2)\n', '.pdbrc': 'import marker\n', 'test_decoy.py': 'print(3)\n', 'data.json': '{}\n' })
    const interactive = { kind: 'refused', reason: CODE_REFUSALS.interactive, truncated: false }
    const discovering = { kind: 'refused', reason: CODE_REFUSALS.discoveringModule, truncated: false }
    // pdb runs a planted .pdbrc whatever its input is, and code, asyncio, and idlelib run what they are fed (python 3.12).
    for (const module of ['pdb', 'code', 'asyncio', 'idlelib']) {
      expect(read(['python3', '-m', module, 'job.py']), module).toEqual(interactive)
      expect(shell(`python3 -m ${module} job.py < second.py`), module).toEqual(interactive)
    }
    // unittest and pytest import test files the reader never lists, and timeit runs its arguments as code.
    for (const module of ['unittest', 'pytest', 'timeit']) {
      expect(read(['python3', '-m', module]), module).toEqual(discovering)
      expect(shell(`python3 -m ${module} < second.py`), module).toEqual(discovering)
    }
    expect(read(['python3', '-m', 'timeit', 'print(1)'])).toEqual(discovering)
    expect(read(['python3', '-m', 'idlelib.idle'])).toEqual(interactive)
    // Any other module reads as before, its input data.
    expect(reading(read(['python3', '-m', 'json.tool', 'data.json']))).toMatchObject({ files: [{ path: '/workspace/data.json' }], packages: [{ name: 'json' }] })
    expect(reading(shell('python3 -m json.tool < data.json'))).toMatchObject({ files: [], packages: [{ name: 'json' }] })
  })

  it('reads a runner\'s words with the tables of the runtime its package names, and refuses an option it cannot place (fix brief 4, G11)', () => {
    const { read, shell } = workspace({ 'job.ts': 'console.log(1)\n', 'other.js': 'console.log(2)\n', 'x.txt': 'notes\n', 'src/a.js': '1\n' })
    const unknown = { kind: 'refused', reason: CODE_REFUSALS.unknownOption, truncated: false }
    expect(read(['npx', 'tsx', '--experimental-default-config-file', 'job.ts'])).toEqual(unknown)
    expect(read(['pnpx', 'tsx', '--experimental-default-config-file', 'job.ts'])).toEqual(unknown)
    expect(read(['bunx', 'tsx', '--experimental-default-config-file', 'job.ts'])).toEqual(unknown)
    expect(read(['npx', '--yes', 'tsx', 'job.ts'])).toEqual(unknown)
    // A package naming no runtime takes no option before its operand.
    expect(read(['npx', 'eslint', '--fix', 'src'])).toEqual(unknown)
    expect(reading(read(['npx', 'eslint', 'src', '--fix']))).toMatchObject({ packages: [{ name: 'eslint' }] })
    // node's value option takes its value, so the redirected file is the script.
    expect(paths(shell('npx node --redirect-warnings x.txt < other.js'))).toEqual(['/workspace/x.txt', '/workspace/other.js'])
    expect(paths(read(['npx', 'tsx', 'job.ts']))).toEqual(['/workspace/job.ts'])
  })

  it('reads bunfig preloads for a runner that starts bun, as the direct form does (fix brief 5, G11b)', () => {
    const tree = { 'bunfig.toml': 'preload = ["./pre.ts"]\n', 'pre.ts': 'export {}\n', 'job.ts': 'export {}\n' }
    for (const runner of ['bunx', 'npx', 'pnpx']) {
      expect(paths(workspace(tree).read([runner, 'bun', 'job.ts'])), runner).toEqual(['/workspace/pre.ts', '/workspace/job.ts'])
    }
    // The direct form shows the same preload and script.
    expect(paths(workspace(tree).read(['bun', 'job.ts']))).toEqual(['/workspace/pre.ts', '/workspace/job.ts'])
  })

  it('refuses, so the call asks, where the script operand names nothing, rather than rating the command line alone', () => {
    const { read } = workspace({ 'data.txt': 'x\n' })
    for (const form of [['node', 'missing'], ['python3', 'missing'], ['python3', '-W', 'ignore', 'missing.py'], ['bun', 'run', 'missing'], ['npx', 'tsx', 'missing']]) {
      expect(read(form)).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    }
  })

  it('requires the script of perl, ruby, php, lua, luajit, tcsh, csh, and awk -f, past the values their options take (fix brief 2, H8)', () => {
    const { read } = workspace({ 'x.pl': '1;\n', 'x.rb': 'p 1\n', 'x.php': '<?php echo 1;\n', 'x.lua': 'print(1)\n', 'x.csh': 'echo 1\n', 'prog.awk': '{print}\n', 'data.txt': 'a\n' })
    for (const program of ['perl', 'ruby', 'php', 'lua', 'luajit', 'tcsh', 'csh']) {
      expect(read([program, 'missing']), program).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    }
    expect(read(['php', '-f', 'missing.php'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    expect(read(['awk', '-f', 'missing.awk', 'data.txt'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    const files = (form: string[]) => reading(read(form)).files.map(file => file.path)
    expect(files(['perl', '-I', 'lib', 'x.pl'])).toEqual(['/workspace/x.pl'])
    expect(files(['ruby', '-r', 'json', 'x.rb'])).toEqual(['/workspace/x.rb'])
    expect(files(['php', '-d', 'memory_limit=1G', 'x.php'])).toEqual(['/workspace/x.php'])
    expect(files(['php', '-f', 'x.php'])).toEqual(['/workspace/x.php'])
    expect(files(['lua', '-l', 'socket', 'x.lua'])).toEqual(['/workspace/x.lua'])
    expect(files(['tcsh', 'x.csh'])).toEqual(['/workspace/x.csh'])
    expect(files(['awk', '-f', 'prog.awk', 'data.txt'])).toEqual(['/workspace/prog.awk', '/workspace/data.txt'])
    expect(reading(read(['perl', '-e', 'print 1', 'missing']))).toMatchObject({ inline: 'print 1', files: [] })
  })

  it('refuses a subcommand that runs code the reader does not follow, and reads an inert one (fix brief 4, G8)', () => {
    const { read } = workspace({ 'a.test.ts': 'import "./evil"\n', 'evil.ts': 'export {}\n', 'deno.json': '{"tasks":{"build":"deno run -A build.ts"}}' })
    const subcommand = { kind: 'refused', reason: CODE_REFUSALS.subcommand, truncated: false }
    for (const form of [['bun', 'test'], ['deno', 'test'], ['deno', 'task', 'build'], ['bun', 'x', 'cowsay'], ['deno', 'bench'], ['bun', 'install'], ['deno', 'jupyter']]) {
      expect(read(form), form.join(' ')).toEqual(subcommand)
    }
    expect(read(['deno', 'run', 'https://example.com/x.ts'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unmodelledImport, truncated: false })
    expect(reading(read(['deno', 'fmt']))).toMatchObject({ files: [] })
    expect(reading(read(['bun', 'why', 'lodash']))).toMatchObject({ files: [] })
  })

  it('keeps today\'s reading where no operand or inline code names a script', () => {
    const { call, read } = workspace({ 'data.txt': 'x\n' })
    // A version call runs no code, so the rules hand the reader no form to read.
    expect(reading(call('node', '--version'))).toMatchObject({ inline: null, files: [] })
    expect(reading(read(['python3', '-m', 'pip', 'install', 'requests']))).toMatchObject({ files: [], packages: [{ name: 'pip' }] })
    expect(reading(read(['node', '-e', '1', 'missing']))).toMatchObject({ inline: '1', files: [] })
    expect(reading(read(['bun', 'outdated']))).toMatchObject({ files: [] })
    expect(reading(read(['npx', 'eslint', 'missing']))).toMatchObject({ files: [], packages: [{ name: 'eslint' }] })
  })

  it('refuses where the interpreter runs code from an input nothing on its statement feeds (fix brief 4, G4)', () => {
    const { read, shell } = workspace({ 'f.py': 'print(1)\n', 'data.txt': 'x\n' })
    const stdin = { kind: 'refused', reason: CODE_REFUSALS.stdin, truncated: false }
    for (const form of [['python3', '-'], ['node', '-'], ['python3', '-B'], ['perl', '-w'], ['npx', 'tsx'], ['deno', 'run'], ['pwsh', '-NoProfile']]) {
      expect(read(form), form.join(' ')).toEqual(stdin)
    }
    expect(shell('python3 -')).toEqual(stdin)
    expect(shell('python3 - 2>/dev/null')).toEqual(stdin)
    expect(paths(shell('python3 - < f.py'))).toEqual(['/workspace/f.py'])
    // awk's input, and a package's that is no runtime, is data.
    expect(reading(read(['awk', '{print}']))).toMatchObject({ inline: '{print}', files: [] })
    expect(reading(read(['npx', 'eslint']))).toMatchObject({ files: [], packages: [{ name: 'eslint' }] })
  })
})

describe('the packages the code imports', () => {
  it('names each with the version installed for its importer, scoped names included, and null where none is installed', () => {
    const { read } = workspace({
      'app.mjs': "import _ from 'lodash'\nimport x from '@scope/pkg/sub'\nimport 'missing-pkg'\nimport fs from 'node:fs'\n",
      'node_modules/lodash/package.json': '{"name":"lodash","version":"4.17.21"}',
      'node_modules/@scope/pkg/package.json': '{"name":"@scope/pkg","version":"1.2.3"}',
      'sub/node_modules/lodash/package.json': '{"version":"3.0.0"}',
      'sub/b.mjs': "import 'lodash'\n",
    })
    expect(reading(read(['node', 'app.mjs'])).packages).toEqual([
      { name: '@scope/pkg', version: '1.2.3', socket: null },
      { name: 'lodash', version: '4.17.21', socket: null },
      { name: 'missing-pkg', version: null, socket: null },
      { name: 'node:fs', version: null, socket: null },
    ])
    expect(reading(read(['node', 'sub/b.mjs'])).packages).toEqual([{ name: 'lodash', version: '3.0.0', socket: null }])
  })

  it('names a package once per version its importers get, so a nested copy of another version is shown and keyed too', () => {
    const files = {
      'app.mjs': "import _ from 'lodash'\nimport './sub/b.mjs'\n",
      'node_modules/lodash/package.json': '{"version":"4.17.21"}',
      'sub/node_modules/lodash/package.json': '{"version":"3.0.0"}',
      'sub/b.mjs': "import 'lodash'\n",
    }
    const first = workspace(files)
    const code = reading(first.read(['node', 'app.mjs']))
    expect(code.packages).toEqual([{ name: 'lodash', version: '3.0.0', socket: null }, { name: 'lodash', version: '4.17.21', socket: null }])
    const keyOf = (packages: typeof code.packages) => judgeCacheKey({ provider: 'p', model: 'm', policyUpdatedAt: null, asked: { command: 'node app.mjs', argv: [], interpreters: [], inline: null, env: [], files: code.files, packages, packagesTruncated: false, truncated: false, standardScript: false, policy: { allow: [], deny: [], destructive: [], allowedInterpreters: [] }, cwd: '/workspace', mounts: [], description: null, reason: null } })
    const upgraded = reading(workspace({ ...files, 'sub/node_modules/lodash/package.json': '{"version":"3.1.0"}' }).read(['node', 'app.mjs']))
    expect(keyOf(upgraded.packages)).not.toBe(keyOf(code.packages))
  })

  it('never reads a node_modules folder outside the workspace, nor one a link takes out of it', () => {
    const { base, root, read } = workspace({ 'app.mjs': "import 'outer'\nimport 'linked'\n" })
    mkdirSync(join(base, 'node_modules', 'outer'), { recursive: true })
    writeFileSync(join(base, 'node_modules', 'outer', 'package.json'), '{"version":"9.9.9"}')
    mkdirSync(join(base, 'elsewhere'))
    writeFileSync(join(base, 'elsewhere', 'package.json'), '{"version":"6.6.6"}')
    mkdirSync(join(root, 'node_modules'))
    symlinkSync(join(base, 'elsewhere'), join(root, 'node_modules', 'linked'))
    expect(reading(read(['node', 'app.mjs'])).packages).toEqual([{ name: 'linked', version: null, socket: null }, { name: 'outer', version: null, socket: null }])
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
    expect(code.packages).toEqual(['json', 'os', 're'].map(name => ({ name, version: null, socket: null })))
  })

  it('takes -c text as inline code and reads what it imports', () => {
    const { read } = workspace({ 'tools.py': 'def run(): pass\n' })
    expect(reading(read(['python3', '-c', 'import tools; tools.run()']))).toMatchObject({ inline: 'import tools; tools.run()', files: [{ path: '/workspace/tools.py' }] })
  })

  it('reads the module python -m runs, with its package\'s __main__.py, and names one it cannot find as a package', () => {
    const { read } = workspace({ 'tools/__init__.py': '', 'tools/gen.py': 'import os\n', 'app/__init__.py': '', 'app/__main__.py': 'import json\n', 'data.txt': 'x\n' })
    expect(reading(read(['python3', '-m', 'tools.gen']))).toMatchObject({ files: [{ path: '/workspace/tools/__init__.py' }, { path: '/workspace/tools/gen.py' }], packages: [{ name: 'os', version: null }] })
    expect(reading(read(['python3', '-m', 'app'])).files.map(file => file.path)).toEqual(['/workspace/app/__init__.py', '/workspace/app/__main__.py'])
    expect(reading(read(['python3', '-m', 'black', '-q', 'data.txt']))).toMatchObject({ files: [{ path: '/workspace/data.txt' }], packages: [{ name: 'black', version: null }] })
  })

  it('reads imports after a semicolon or a compound statement\'s colon', () => {
    const { read } = workspace({ 'helper.py': 'def run(): pass\n' })
    expect(reading(read(['python3', '-c', 'import os; import helper']))).toMatchObject({ files: [{ path: '/workspace/helper.py' }], packages: [{ name: 'os' }] })
    expect(reading(read(['python3', '-c', 'import os; from helper import run']))).toMatchObject({ files: [{ path: '/workspace/helper.py' }] })
    expect(reading(read(['python3', '-c', 'try: import helper\nexcept ImportError: pass']))).toMatchObject({ files: [{ path: '/workspace/helper.py' }] })
  })

  it('reads parenthesised from-imports across lines, comments among the names', () => {
    const { read } = workspace({
      'helper.py': 'def run(): pass\n', 'pkg/__init__.py': '', 'pkg/mod.py': 'X = 1\n',
      'main.py': 'from helper import (\n    run,  # the entry\n    other,\n)\nfrom pkg import (\n    mod,\n)\n',
      'gone/__init__.py': 'from . import (\n    missing,\n)\n',
    })
    expect(reading(read(['python3', 'main.py'])).files.map(file => file.path).sort()).toEqual(['/workspace/helper.py', '/workspace/main.py', '/workspace/pkg/__init__.py', '/workspace/pkg/mod.py'])
    expect(read(['python3', 'gone/__init__.py'])).toMatchObject({ kind: 'refused', reason: CODE_REFUSALS.missing })
  })

  it('never reads a parenthesised group across a docstring, a comment, or a string, and reads past a ) in a comment (fix brief 2, R8)', () => {
    const { read } = workspace({
      'helper.py': 'def run(): pass\n', 'pkg/__init__.py': '', 'pkg/mod.py': 'X = 1\n', 'pkg/other.py': 'Y = 2\n',
      'doc.py': '"""Usage:\n    from mylib import (\n"""\nfrom helper import run\nrun()\n',
      'note.py': '# Old style was: from compat import (\nfrom helper import run\nrun()\n',
      'list.py': 'from pkg import (\n    mod,  # see run()\n    other,\n)\n',
      'open.py': 'from pkg import (mod,\n' + 'x = 1\n'.repeat(70) + ')\nimport helper\n',
    })
    const files = (script: string) => reading(read(['python3', script])).files.map(file => file.path).sort()
    expect(files('doc.py')).toEqual(['/workspace/doc.py', '/workspace/helper.py'])
    expect(files('note.py')).toEqual(['/workspace/helper.py', '/workspace/note.py'])
    expect(files('list.py')).toEqual(['/workspace/list.py', '/workspace/pkg/__init__.py', '/workspace/pkg/mod.py', '/workspace/pkg/other.py'])
    expect(files('open.py')).toEqual(['/workspace/helper.py', '/workspace/open.py', '/workspace/pkg/__init__.py', '/workspace/pkg/mod.py'])
  })

  it('reads a parenthesised from-import across up to 200 lines, and refuses one it cannot close in that bound (fix brief 3, R8)', () => {
    const submodules: Record<string, string> = {}
    for (let index = 0; index < 70; index++) submodules[`big/m${index}.py`] = ''
    const { read } = workspace({
      'pkg/__init__.py': '', 'pkg/mod.py': 'X = 1\n', 'pkg/other.py': 'Y = 2\n', 'big/__init__.py': '', ...submodules,
      'mid.py': `from pkg import (\n${'    mod,\n'.repeat(60)}    other,\n)\n`,
      'long.py': `from pkg import (\n${'    mod,\n'.repeat(201)})\n`,
      'unclosed.py': 'from pkg import (\n    mod,\n',
      'many.py': `from big import (\n${Array.from({ length: 70 }, (_, index) => `    m${index},\n`).join('')})\n`,
    })
    // A 61-name group is read whole, every named module with it.
    expect(reading(read(['python3', 'mid.py'])).files.map(file => file.path).sort()).toEqual(['/workspace/mid.py', '/workspace/pkg/__init__.py', '/workspace/pkg/mod.py', '/workspace/pkg/other.py'])
    // Past the bound, or with no `)` before the code ends, the list is not guessed at: the call asks.
    expect(read(['python3', 'long.py'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.importList, truncated: false })
    expect(read(['python3', 'unclosed.py'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.importList, truncated: false })
    // A group naming 70 local submodules runs past the 50-file cap, as before the bound.
    expect(read(['python3', 'many.py'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.truncated, truncated: true })
  })

  it('refuses where compiled Python may run in place of a source it would show (fix brief 4, G12)', () => {
    const compiled = Buffer.from([0x00, 0x0d, 0x0d, 0x0a])
    const tree = { 'job.py': 'import helper\n', 'helper.py': 'X = 1\n', 'uses.py': 'import pkg\n', 'pkg/__init__.py': '', 'tool/__init__.py': '', 'tool/__main__.py': 'print(1)\n' }
    const refusal = { kind: 'refused', reason: CODE_REFUSALS.compiledPython, truncated: false }
    // A clean tree reads, each module from its source.
    expect(paths(workspace(tree).read(['python3', 'job.py']))).toEqual(['/workspace/job.py', '/workspace/helper.py'])
    for (const name of ['__pycache__/helper.cpython-312.pyc', 'helper.pyc', 'helper.cpython-312-x86_64-linux-gnu.so', 'helper.so', 'helper.pyd']) {
      expect(workspace({ ...tree, [name]: compiled }).read(['python3', 'job.py']), name).toEqual(refusal)
    }
    // A module whose only form is compiled, a package's __init__, a -m module's __main__, and the script itself.
    expect(workspace({ 'job.py': 'import helper\n', 'helper.pyc': compiled }).read(['python3', 'job.py'])).toEqual(refusal)
    expect(workspace({ ...tree, 'pkg/__pycache__/__init__.cpython-312.pyc': compiled }).read(['python3', 'uses.py'])).toEqual(refusal)
    expect(workspace({ ...tree, 'tool/__pycache__/__main__.cpython-312.pyc': compiled }).read(['python3', '-m', 'tool'])).toEqual(refusal)
    expect(workspace({ ...tree, '__pycache__/job.cpython-312.pyc': compiled }).read(['python3', 'job.py'])).toEqual(refusal)
  })

  it('takes a package folder before a module file of the same name, as Python\'s finder does', () => {
    const { read } = workspace({ 'uses.py': 'import pkg\n', 'pkg/__init__.py': 'X = 1\n', 'pkg.py': 'Y = 2\n' })
    expect(paths(read(['python3', 'uses.py']))).toEqual(['/workspace/uses.py', '/workspace/pkg/__init__.py'])
  })

  it('refuses where a __pycache__ cannot be listed, since a pyc may hide there (fix brief 5, G12b)', () => {
    const { view, root } = workspace({ 'job.py': 'import helper\n', 'helper.py': 'X = 1\n' })
    const refusal = { kind: 'refused', reason: CODE_REFUSALS.compiledPython, truncated: false }
    // A folder the reader cannot list throws anything but "not there"; the compiled check then fails closed.
    const blocked = { ...view, names: (folder: string) => { if (folder.endsWith('__pycache__')) { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EACCES'; throw error } return view.names(folder) } }
    expect(readInterpreterCode({ forms: [['python3', 'job.py']], cwd: root, view: blocked })).toEqual(refusal)
    // A missing folder (ENOENT) stays empty, so a clean tree still reads.
    expect(readInterpreterCode({ forms: [['python3', 'job.py']], cwd: root, view }).kind).toBe('read')
  })

  it('refuses a __pycache__ the process cannot list, with a planted pyc, unless it runs as root (fix brief 5, G12b)', () => {
    if (process.getuid?.() === 0) return
    const ws = workspace({ 'job.py': 'import helper\n', 'helper.py': 'X = 1\n', '__pycache__/helper.cpython-312.pyc': Buffer.from([0x00, 0x0d, 0x0d, 0x0a]) })
    const cache = join(ws.root, '__pycache__')
    chmodSync(cache, 0o311)
    try {
      expect(ws.read(['python3', 'job.py'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.compiledPython, truncated: false })
    } finally {
      chmodSync(cache, 0o755)
    }
  })

  it('refuses a symlinked __main__.py whose compiled form sits beside the link, for -m and a folder script (fix brief 5, G12b)', () => {
    const compiled = Buffer.from([0x00, 0x0d, 0x0d, 0x0a])
    const refusal = { kind: 'refused', reason: CODE_REFUSALS.compiledPython, truncated: false }
    // CPython looks for <pkg>/__pycache__/__main__.pyc beside the folder as named, before following the __main__ link.
    const pkg = workspace({ 'tool/__init__.py': '', 'tool/real_main.py': 'print(1)\n', 'tool/__pycache__/__main__.cpython-312.pyc': compiled })
    symlinkSync('real_main.py', join(pkg.root, 'tool', '__main__.py'))
    expect(pkg.read(['python3', '-m', 'tool'])).toEqual(refusal)
    const app = workspace({ 'app/real_main.py': 'print(1)\n', 'app/__pycache__/__main__.cpython-312.pyc': compiled })
    symlinkSync('real_main.py', join(app.root, 'app', '__main__.py'))
    expect(app.read(['python3', 'app'])).toEqual(refusal)
  })

  it('checks a folder script\'s __main__ beside the folder as the view names it, for an absolute operand too (fix brief 6, B4)', () => {
    const compiled = Buffer.from([0x00, 0x0d, 0x0d, 0x0a])
    const refusal = { kind: 'refused', reason: CODE_REFUSALS.compiledPython, truncated: false }
    // A link beside its own target, and one into another folder; each with the compiled __main__ planted beside the link.
    const near = { 'app/real_main.py': 'print(1)\n', 'app/__pycache__/__main__.cpython-312.pyc': compiled }
    const far = { 'real/entry.py': 'print(1)\n', 'app/__pycache__/__main__.cpython-312.pyc': compiled }
    for (const [tree, target] of [[near, 'real_main.py'], [far, '../real/entry.py']] as const) {
      const mounted = workspace(tree)
      symlinkSync(target, join(mounted.root, 'app', '__main__.py'))
      expect(mounted.read(['python3', '/workspace/app']), target).toEqual(refusal)
      expect(mounted.read(['python3', 'app']), target).toEqual(refusal)
      const bare = workspace(tree, { mount: null })
      symlinkSync(target, join(bare.root, 'app', '__main__.py'))
      expect(bare.read(['python3', join(bare.root, 'app')]), target).toEqual(refusal)
    }
    // With no compiled __main__ beside the link, the absolute operand reads the linked source.
    const clean = workspace({ 'real/entry.py': 'print(1)\n', 'app/.keep': '' })
    symlinkSync('../real/entry.py', join(clean.root, 'app', '__main__.py'))
    expect(paths(clean.read(['python3', '/workspace/app']))).toEqual(['/workspace/real/entry.py'])
  })

  it('refuses -X pycache_prefix and any unknown -X value, and reads a known one (fix brief 5, G12b)', () => {
    const { read } = workspace({ 'job.py': 'print(1)\n' })
    const unknown = { kind: 'refused', reason: CODE_REFUSALS.unknownOption, truncated: false }
    expect(read(['python3', '-X', 'pycache_prefix=/tmp/pc', 'job.py'])).toEqual(unknown)
    expect(read(['python3', '-X', 'nonesuch', 'job.py'])).toEqual(unknown)
    // frozen_modules=off makes -m import runpy from the working directory, so a planted runpy.py would run (fix brief 6, B4).
    expect(read(['python3', '-X', 'frozen_modules=off', '-m', 'json.tool'])).toEqual(unknown)
    expect(read(['python3', '-X', 'frozen_modules', 'job.py'])).toEqual(unknown)
    expect(paths(read(['python3', '-X', 'dev', 'job.py']))).toEqual(['/workspace/job.py'])
    expect(paths(read(['python3', '-X', 'int_max_str_digits=640', 'job.py']))).toEqual(['/workspace/job.py'])
  })

  it('lists each folder at most once while checking for compiled Python (fix brief 5, G12b)', () => {
    const { view, root } = workspace({ 'job.py': 'import a\nimport b\n', 'a.py': 'X = 1\n', 'b.py': 'Y = 2\n' })
    const seen = new Map<string, number>()
    const counted = { ...view, names: (folder: string) => { seen.set(folder, (seen.get(folder) ?? 0) + 1); return view.names(folder) } }
    expect(readInterpreterCode({ forms: [['python3', 'job.py']], cwd: root, view: counted }).kind).toBe('read')
    expect([...seen.values()].every(count => count === 1)).toBe(true)
  })

  it('reads a one-name group that spells the word unparsed, the refusal being no string (fix brief 4, R8)', () => {
    const { read } = workspace({ 's.py': 'from pkg import (unparsed)\n', 'pkg/__init__.py': '', 'pkg/unparsed.py': 'X = 1\n' })
    expect(paths(read(['python3', 's.py']))).toEqual(['/workspace/s.py', '/workspace/pkg/__init__.py', '/workspace/pkg/unparsed.py'])
  })

  it('refuses a relative import naming no module', () => {
    const { read } = workspace({ 'pkg/__init__.py': 'from .gone import x\n' })
    expect(read(['python3', 'pkg/__init__.py'])).toMatchObject({ kind: 'refused', reason: CODE_REFUSALS.missing })
  })
})

describe('an interpreter named by a path (fix brief 6, B1)', () => {
  // The program that runs is the file at the path, which the agent may have written, not the interpreter its basename
  // names; only a path outside the workspace and every mount is one the agent cannot have placed.
  const planted = '#!/bin/sh\necho planted\n'
  const local = { kind: 'refused', reason: CODE_REFUSALS.localInterpreter, truncated: false }

  it('refuses a planted program inside the workspace, typed directly, behind a wrapper, or in shell text', () => {
    const { call, shell } = workspace({ 'job.py': 'print(1)\n', 'x.ts': 'console.log(1)\n', 'x.js': 'console.log(2)\n', 'fv/bin/python3': planted, 'node_modules/.bin/tsx': planted, 'tools/node': planted })
    expect(call('./fv/bin/python3', 'job.py')).toEqual(local)
    expect(call('fv/bin/python3', 'job.py')).toEqual(local)
    expect(call('/workspace/fv/bin/python3', 'job.py')).toEqual(local)
    expect(call('env', './fv/bin/python3', 'job.py')).toEqual(local)
    expect(call('timeout', '5', 'node_modules/.bin/tsx', 'x.ts')).toEqual(local)
    expect(call('/workspace/tools/node', 'x.js')).toEqual(local)
    expect(shell('./fv/bin/python3 job.py')).toEqual(local)
    expect(shell('node_modules/.bin/tsx x.ts')).toEqual(local)
    expect(shell('env /workspace/tools/node x.js')).toEqual(local)
  })

  it('refuses a path that names nothing, and a link inside the workspace whatever it points to', () => {
    const { call, root } = workspace({ 'job.py': 'print(1)\n', 'fv/pyvenv.cfg': 'home = /usr/bin\n' })
    expect(call('./gone/python3', 'job.py')).toEqual(local)
    // A link beside a pyvenv.cfg runs the real interpreter with that venv's settings, read from the link's own folder.
    mkdirSync(join(root, 'fv', 'bin'))
    symlinkSync(process.execPath, join(root, 'fv', 'bin', 'python3'))
    expect(call('fv/bin/python3', 'job.py')).toEqual(local)
  })

  it('rates a path outside the workspace and every mount, as the interpreter its basename names', () => {
    const { call, shell } = workspace({ 'job.py': 'print(1)\n' })
    expect(paths(call('/usr/bin/python3', 'job.py'))).toEqual(['/workspace/job.py'])
    expect(paths(shell('/usr/bin/python3 job.py'))).toEqual(['/workspace/job.py'])
    expect(paths(call('env', '/usr/bin/python3', 'job.py'))).toEqual(['/workspace/job.py'])
    expect(paths(call('python3', 'job.py'))).toEqual(['/workspace/job.py'])
  })
})

describe('the code a here-string hands an interpreter', () => {
  it('reads a here-string in bash, zsh, or ksh text as inline code, with what it imports, and refuses one a shell without them, or an expansion, would change', () => {
    const { call } = workspace({ 'helper.py': 'X = 1\n' })
    expect(reading(call('bash', '-c', "python3 <<< 'import helper'"))).toMatchObject({ inline: 'import helper', files: [{ path: '/workspace/helper.py' }] })
    expect(reading(call('/usr/bin/zsh', '-c', 'FOO=1 node 0<<<"console.log(1)"'))).toMatchObject({ inline: 'console.log(1)', files: [] })
    expect(call('ksh', '-c', 'python3 - <<<"$CODE"')).toEqual(shellRefusal)
    expect(call('sh', '-c', "python3 <<< 'print(1)'")).toEqual(shellRefusal)
    expect(call('bash', '-c', "cat <<< 'print(1)' | python3")).toEqual(shellRefusal)
  })

  it('finds the interpreter behind a wrapper, as env, timeout, and exec name it, and no other', () => {
    const { shell } = workspace({ 'helper.py': 'X = 1\n' })
    for (const text of ["env python3 <<< 'import helper'", "timeout 5 python3 <<< 'import helper'", "exec python3 <<< 'import helper'", "FOO=1 env -i nice -n 5 python3 - <<< 'import helper'"]) {
      expect(reading(shell(text)), text).toMatchObject({ inline: 'import helper', files: [{ path: '/workspace/helper.py' }] })
    }
    expect(shell("sudo python3 <<< 'import helper'")).toEqual(shellRefusal)
  })

  it('skips only a piece split inside a quoted word; any other form from the text that does not match the statement refuses (fix brief 6, B5)', () => {
    const { shell, root, view } = workspace({ 'decoy.js': 'console.log(1)\n', 'build.js': 'console.log(2)\n', 'job.py': 'print(1)\n' })
    // A heredoc body a shell reads as its script is a statement the rules read, not a piece: the grammar's statement
    // (`busybox sh`, fed the body) does not show it, so the call refuses.
    expect(shell("busybox sh <<'EOF'\nnode decoy.js\nEOF")).toEqual(shellRefusal)
    expect(shell("tcsh <<'EOF'\nnode decoy.js\nEOF")).toEqual(shellRefusal)
    // The rules read `node` alone where the grammar reads `node build.js` (an `&` splits the rules' statement): no match.
    expect(shell('node &> out.log build.js')).toEqual(shellRefusal)
    // A piece is skipped, but a reading where no form matches the statement still refuses: the rules and the grammar
    // must agree on the statement's interpreter form.
    const forms = commandFormsOf({ command: 'bash', args: ['-c', 'python3 -c "import os; print(1)"'] })
    const piece = forms.pieces.find(([word]) => word === 'python3')!
    expect(piece).toEqual(['python3', '-c', 'import os'])
    expect(readInterpreterCode({ forms: [piece], chain: forms.chain, pieces: forms.pieces, cwd: root, view })).toEqual(shellRefusal)
    expect(reading(shell('python3 -c "import os; print(1)"'))).toMatchObject({ inline: 'import os; print(1)', files: [] })
  })

  it('refuses flock -c text, which runs through $SHELL -c rather than sh (fix brief 5, P3)', () => {
    const { call } = workspace({ 'helper.py': 'X = 1\n', '7.py': 'print(1)\n', 'build.js': 'console.log(1)\n' })
    expect(call('flock', 'lk', '-c', 'python3 - < 7.py')).toEqual(shellRefusal)
    expect(call('flock', 'lk', '-c', "python3 <<< 'import helper'")).toEqual(shellRefusal)
    // flock running a command directly, with no -c, still reads it (the shell is not involved).
    expect(paths(call('flock', '-w', '5', 'lk', 'node', 'build.js'))).toEqual(['/workspace/build.js'])
  })

  it('reads flock\'s -c only as the word right after the lock operand, as util-linux does (fix brief 6, B6)', () => {
    const { call } = workspace({ '7.py': 'print(1)\n', 'build.js': 'console.log(1)\n' })
    // A -c after the command is that command's own (util-linux flock 2.39: `flock -c 'echo x' lk` exits 64).
    expect(reading(call('flock', 'lk', 'python3', '-c', 'print(1)'))).toMatchObject({ inline: 'print(1)', files: [] })
    expect(paths(call('flock', 'lk', 'node', 'build.js', '-c'))).toEqual(['/workspace/build.js'])
    expect(paths(call('flock', 'lk', 'node', 'build.js', '--command'))).toEqual(['/workspace/build.js'])
    // Right after the lock operand, past any options and their values, it runs through $SHELL -c.
    for (const words of [['lk', '-c', 'python3 7.py'], ['lk', '--command', 'python3 7.py'], ['-w', '5', 'lk', '-c', 'python3 7.py'], ['-nw5', 'lk', '-c', 'python3 7.py'], ['--wait', '5', 'lk', '-c', 'python3 7.py'], ['--timeout=5', 'lk', '-c', 'python3 7.py'], ['-E', '9', '--', 'lk', '-c', 'python3 7.py']]) {
      expect(call('flock', ...words), words.join(' ')).toEqual(shellRefusal)
    }
  })

  it('refuses a wrapper that sets the program name, which points an interpreter at a venv unseen (fix brief 5, N1)', () => {
    // A venv fixture with neutral names: pyvenv.cfg beside a fv/bin the agent never writes, and a .pth file that runs at
    // startup. exec -a and env --argv0 make CPython take argv[0] as its executable path and read these before the script.
    const { call, shell } = workspace({ 'job.py': 'print("JOB")\n', 'fv/pyvenv.cfg': 'home = /usr/bin\n', 'fv/lib/python3.12/site-packages/x.pth': 'import sys\n' })
    for (const text of ['exec -a fv/bin/python3 python3 job.py', 'exec -afv/bin/python3 python3 job.py', 'exec -c -a fv/bin/python3 python3 job.py', 'env --argv0=fv/bin/python3 python3 job.py', 'env -a fv/bin/python3 python3 job.py']) {
      expect(shell(text), text).toEqual(shellRefusal)
    }
    // The same wrappers typed directly refuse too, with a reason that names no shell text (fix brief 6, B2).
    const programName = { kind: 'refused', reason: CODE_REFUSALS.programName, truncated: false }
    expect(call('env', '--argv0=fv/bin/python3', 'python3', 'job.py')).toEqual(programName)
    expect(call('env', '-a', 'fv/bin/python3', 'python3', 'job.py')).toEqual(programName)
    // Plain exec and env, with no such option, still read the script.
    expect(paths(shell('exec python3 job.py'))).toEqual(['/workspace/job.py'])
    expect(paths(call('env', 'python3', 'job.py'))).toEqual(['/workspace/job.py'])
  })

  it('refuses env\'s --argv0 by any prefix getopt_long takes, and env -S, whose split words the reader does not read again (fix brief 6, B2)', () => {
    const { call, shell } = workspace({ 'job.py': 'print("JOB")\n', 'fv/pyvenv.cfg': 'home = /usr/bin\n' })
    const programName = { kind: 'refused', reason: CODE_REFUSALS.programName, truncated: false }
    const split = { kind: 'refused', reason: CODE_REFUSALS.splitWords, truncated: false }
    // GNU env's getopt_long takes any unambiguous prefix of --argv0, and no other env long option starts with a.
    expect(call('env', '--argv=fv/bin/python3', 'python3', 'job.py')).toEqual(programName)
    expect(call('env', '--a', 'fv/bin/python3', 'python3', 'job.py')).toEqual(programName)
    expect(call('timeout', '5', 'env', '--argv=fv/bin/python3', 'python3', 'job.py')).toEqual(programName)
    expect(call('env', '-ia', 'fv/bin/python3', 'python3', 'job.py')).toEqual(programName)
    expect(shell('env --ar fv/bin/python3 python3 job.py')).toEqual(shellRefusal)
    // env -S splits its value into more words, options among them, which the reader does not re-parse.
    expect(call('env', '-S', '-i -a fv/bin/python3', 'python3', 'job.py')).toEqual(split)
    expect(call('env', '--split-string=python3 job.py')).toEqual(split)
    expect(call('env', '-S', 'python3 job.py')).toEqual(split)
    expect(shell("env -S '-i -a fv/bin/python3' python3 job.py")).toEqual(shellRefusal)
    expect(call('env', '-a', 'x', 'python3', 'job.py')).not.toEqual(shellRefusal)
    // env with neither still reads.
    expect(paths(call('env', '-i', 'FOO=1', 'python3', 'job.py'))).toEqual(['/workspace/job.py'])
  })

  it('reads a heredoc\'s body as inline code, and refuses one a shell would expand, one left open, and a text with more than one statement', () => {
    const { shell } = workspace({ 'helper.py': 'X = 1\n' })
    expect(reading(shell("python3 - <<'EOF'\nimport helper\nprint(1)\nEOF\n"))).toMatchObject({ inline: 'import helper\nprint(1)', files: [{ path: '/workspace/helper.py' }] })
    expect(reading(shell('node <<EOF\nconsole.log(1)\nEOF')).inline).toBe('console.log(1)')
    expect(reading(shell('python3 <<-EOF\n\timport helper\n\tEOF')).inline).toBe('import helper')
    for (const text of ["python3 - <<'EOF'\nimport helper\nEOF\necho done", 'python3 <<EOF\nprint("$HOME")\nEOF', 'python3 <<EOF\nprint(1)\n', 'python3 <<EOF\nprint(1)\nEOF\npython3 <<EOF\nimport shutil\nEOF', 'cat <<A; python3 <<B\nB\nA\nimport shutil\nB']) {
      expect(shell(text), text).toEqual(shellRefusal)
    }
  })
})

describe('the single-statement grammar (fix brief 4, P)', () => {
  it('refuses a list, a group, a pipe, a substitution, and a C shell\'s text, so a person decides', () => {
    const { call, shell } = workspace({ 'a.py': 'print(1)\n', 'b.py': 'print(2)\n', 'other.py': 'print(3)\n', 'x.py': 'print(4)\n', 'sub/x.js': 'console.log(1)\n' })
    for (const text of ['python3 a.py && python3 b.py', 'cd sub && node x.js', '{ python3 - a; } < other.py', 'cat a.py | python3', 'python3 $(echo a).py', 'python3 `echo a`.py', 'python3 a.py & python3 b.py', 'python3 a.py\npython3 b.py', '(python3 a.py)', 'python3 <(cat a.py)', 'python3 a.py # note', 'python3 *.py', 'python3 ~/a.py', 'python3 {a,b}.py', 'if true; then python3 a.py; fi']) {
      expect(shell(text), text).toEqual(shellRefusal)
    }
    expect(call('tcsh', '-c', 'python3 x.py')).toEqual(shellRefusal)
    expect(call('fish', '-c', 'python3 x.py')).toEqual(shellRefusal)
    // A shell option that runs startup files or exports assignments anywhere is one the grammar does not model.
    expect(call('bash', '-i', '-c', 'python3 x.py')).toEqual(shellRefusal)
    expect(call('bash', '-k', '-c', 'python3 x.py')).toEqual(shellRefusal)
    // -x makes bash expand a trace prompt the environment may set, which runs what it substitutes.
    expect(call('bash', '-x', '-c', 'python3 x.py')).toEqual(shellRefusal)
  })

  it('rates one simple command as its direct form: leading assignments, one feed, and any output redirections', () => {
    const { call, shell } = workspace({ 'job.py': 'import helper\n', 'helper.py': 'X = 1\n', 'data.bin': 'x\n', 'build.js': 'console.log(1)\n', 'f.py': 'print(1)\n' })
    expect(paths(shell('FOO=1 python3 job.py < data.bin'))).toEqual(['/workspace/job.py', '/workspace/helper.py'])
    expect(reading(shell('timeout 5 python3 <<< "import helper"'))).toMatchObject({ inline: 'import helper', files: [{ path: '/workspace/helper.py' }] })
    expect(paths(shell('node build.js 2>err.log'))).toEqual(['/workspace/build.js'])
    expect(paths(shell('python3 - >/dev/null 2>&1 < f.py'))).toEqual(['/workspace/f.py'])
    expect(paths(shell('node build.js &> out.log'))).toEqual(['/workspace/build.js'])
    expect(paths(call('bash', '-ec', 'python3 job.py\n'))).toEqual(['/workspace/job.py', '/workspace/helper.py'])
    // dash reads `&>` as a background job, so its text with one is not one statement.
    expect(call('dash', '-c', 'node build.js &> out.log')).toEqual(shellRefusal)
  })

  it('rates one command holding inline code, whose quoted word the rules also split into pieces, with that code shown (fix brief 5, P1)', () => {
    const { shell } = workspace({ 'a.py': 'print(1)\n', 'b.py': 'print(2)\n' })
    expect(reading(shell('python3 -c "print(1)"'))).toMatchObject({ inline: 'print(1)', files: [] })
    expect(reading(shell('python3 -c "import os; print(1)"'))).toMatchObject({ inline: 'import os; print(1)', files: [] })
    expect(reading(shell("node -e 'console.log(1); console.log(2)'"))).toMatchObject({ inline: 'console.log(1); console.log(2)', files: [] })
    // Compound text still refuses, quoted code in it or not.
    for (const text of ['python3 a.py && python3 -c "print(1)"', 'python3 -c "print(1)" | python3 b.py', 'python3 $(echo a).py -c "x;y"', '{ python3 -c "print(1)"; }']) {
      expect(shell(text), text).toEqual(shellRefusal)
    }
  })

  it('refuses a < in zsh text that zsh reads as a numeric glob, and reads a plain feed (fix brief 5, P2)', () => {
    // zsh's lexer reads `<` followed by digits, `-`, digits, and `>` as one numeric glob word, with no option check
    // (zsh Src/lex.c: isnumglob, called in gettok's LX1_INANG case and gettokstr's LX2_INANG case), so
    // `python3 <0-9>.py` runs `python3 7.py`, not a feed from 0-9. zsh is not installed here; this follows that source.
    const { call } = workspace({ '0-9': 'print(0)\n', '7.py': 'print(7)\n', 'job.py': 'print(1)\n' })
    for (const text of ['python3 <0-9>.py', 'python3 <5->.py', 'python3 <-9>.py', 'python3 <->.py', 'python3 0<0-9>.py', 'python3 a<0-9>.py']) {
      expect(call('zsh', '-c', text), text).toEqual(shellRefusal)
    }
    expect(paths(call('zsh', '-c', 'python3 < job.py'))).toEqual(['/workspace/job.py'])
    // bash has no numeric glob: the same text feeds 0-9.
    expect(paths(call('bash', '-c', 'python3 <0-9>.py'))).toEqual(['/workspace/0-9'])
  })

  it('removes quotes as a shell does, and refuses an expansion inside double quotes', () => {
    expect(simpleStatement(`python3 "my job.py" 'a b' c\\ d -c "print(\\"x\\")"`, 'bash')).toEqual({ words: ['python3', 'my job.py', 'a b', 'c d', '-c', 'print("x")'], feed: null })
    expect(simpleStatement('A=1 B="x y" node build.js < in.txt', 'sh')).toEqual({ words: ['node', 'build.js'], feed: { kind: 'file', name: 'in.txt' } })
    expect(simpleStatement('node "$X"', 'bash')).toBeNull()
    expect(simpleStatement("node 'x", 'bash')).toBeNull()
    expect(simpleStatement('python3 < a.py < b.py', 'bash')).toBeNull()
  })
})

describe('long shell text (fix brief 4, P)', () => {
  it('refuses a 1 MiB text with 64 heredoc statements inside 300 ms, where a per-statement index once took seconds (fix brief 4, R9)', () => {
    const { root, view } = workspace({ 'helper.py': 'X = 1\n' })
    const statements = Array.from({ length: 64 }, (_, index) => (index % 2 === 0 ? `python3 <<P${index}\nimport helper\nP${index}\n` : `lua <<L${index}\nprint(1)\nL${index}\n`)).join('')
    const text = `: '${'<'.repeat(1_000_000)}'\n${statements}`
    // The call's forms are the permission pipeline's own reading, shared with every rule, so they are not the reader's cost.
    const forms = commandFormsOf({ command: 'bash', args: ['-c', text] })
    const running = allForms(forms).filter(([word = '']) => forms.interpreters.includes(baseCommand(word)))
    const started = performance.now()
    const result = readInterpreterCode({ forms: running, chain: forms.chain, cwd: root, view })
    expect(performance.now() - started).toBeLessThan(300)
    expect(result).toEqual(shellRefusal)
  })


  it('refuses 4,000 statements at once, and reads one statement with a long heredoc body', () => {
    const { shell } = workspace({ 'helper.py': 'X = 1\n' })
    const started = performance.now()
    expect(shell('python3 <<E\nE\n'.repeat(4_000))).toEqual(shellRefusal)
    expect(performance.now() - started).toBeLessThan(200)
    const body = `import helper\n${'x = 1\n'.repeat(20_000)}`
    expect(reading(shell(`python3 <<'E'\n${body}E\n`)).files.map(file => file.path)).toEqual(['/workspace/helper.py'])
  })
})

describe('the code a shell applet or awk runs', () => {
  it('follows source and . in shell code, and takes an awk program as inline code', () => {
    const { read } = workspace({ 'build.sh': '#!/bin/sh\nsource ./lib.sh\n. "$HOME/.profile"\n', 'lib.sh': 'echo lib\n', 'env.sh': 'X=1\n', 'data.txt': 'a b\n' })
    expect(reading(read(['busybox', 'sh', 'build.sh'])).files.map(file => file.path)).toEqual(['/workspace/build.sh', '/workspace/lib.sh'])
    // A busybox shell applet's -c text is never rated: the grammar reads POSIX-family shells only (fix brief 4, P).
    expect(read(['busybox', 'sh', '-c', '. ./env.sh'])).toEqual(shellRefusal)
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

  it('refuses a script argument beyond every mount, and a file the agent may not read without asking', () => {
    const { base, read } = workspace({ '.env': 'TOKEN=x\n', 'app.mjs': "import './.env'\n" })
    writeFileSync(join(base, 'elsewhere.mjs'), 'export {}\n')
    expect(read(['node', join(base, 'elsewhere.mjs')])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unreadable, truncated: false })
    expect(read(['python3', '../elsewhere.py'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unreadable, truncated: false })
    expect(read(['node', 'app.mjs'])).toMatchObject({ kind: 'refused', reason: CODE_REFUSALS.unreadable })
  })

  it('rates nothing, naming no path, where reading a file throws', () => {
    const { root } = workspace({ 'app.mjs': 'export {}\n' })
    const paths = createPathView({ root, mount: '/workspace' })
    const failing = createCodeView({ paths, canRead: () => true, protectedRoots: [] })
    const view = { ...failing, read: () => { throw Object.assign(new Error(`EACCES: permission denied, open '${root}/app.mjs'`), { code: 'EACCES' }) } }
    expect(readInterpreterCode({ forms: [['node', 'app.mjs']], cwd: root, view })).toEqual({ kind: 'refused', reason: CODE_REFUSALS.failed, truncated: false })
  })

  it('refuses a hard link on the disk that holds Buckle\'s state, rather than failing the call', () => {
    const { root } = workspace({ 'app.mjs': 'export {}\n' })
    linkSync(join(root, 'app.mjs'), join(root, 'other.mjs'))
    const paths = createPathView({ root, mount: '/workspace' })
    const view = createCodeView({ paths, canRead: () => true, protectedRoots: [root] })
    expect(readInterpreterCode({ forms: [['node', 'app.mjs']], cwd: root, view })).toEqual({ kind: 'refused', reason: CODE_REFUSALS.failed, truncated: false })
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

  it(`counts inline code toward the ${CODE_LIMITS.bytes} bytes`, () => {
    const half = 'x'.repeat(CODE_LIMITS.bytes / 2)
    const { read } = workspace({ 'b.mjs': half })
    expect(read(['node', '-e', `// ${'y'.repeat(CODE_LIMITS.bytes)}`])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.truncated, truncated: true })
    expect(read(['node', '-e', `import './b.mjs'\n// ${half}`])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.truncated, truncated: true })
    expect(reading(read(['node', '-e', `import './b.mjs'\n// ${half.slice(40)}`])).files).toHaveLength(1)
  })
})
