import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { isInside } from '../common/domain/paths.js'
import { CODE_LIMITS, CODE_REFUSALS, createCodeView, readInterpreterCode, type CodeRead } from '../common/services/judge/code-reader.js'
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
  return { base, root, read, view }
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
    expect(reading(read(['node', '.'])).files.map(file => file.path)).toEqual(['/workspace/index.js', '/workspace/build.js'])
    expect(reading(read(['deno', 'run', '-A', 'gen'])).files.map(file => file.path)).toEqual(['/workspace/gen.ts'])
    expect(reading(read(['npx', 'tsx', 'gen'])).files.map(file => file.path)).toEqual(['/workspace/gen.ts'])
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

  it('refuses an absolute main outside the workspace, and reads a .node addon as a file, which is no text', () => {
    const { base, read } = workspace({ 'addon/package.json': '{"main":"build/addon.node"}', 'addon/build/addon.node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0x00]), 'addon/index.js': 'nope\n', 'abs/index.js': 'nope\n' })
    writeFileSync(join(base, 'evil.js'), 'evil()\n')
    writeFileSync(join(base, 'project', 'abs', 'package.json'), JSON.stringify({ main: join(base, 'evil.js') }))
    expect(read(['node', 'abs'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unreadable, truncated: false })
    expect(read(['node', 'addon'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.binary, truncated: false })
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
    expect(reading(read(['python3', '-m', 'pytest']))).toMatchObject({ files: [], packages: [{ name: 'pytest' }] })
  })

  it('finds each preload as the script is found, names a bare one as a package, and refuses one naming nothing (fix brief 2, H7)', () => {
    const { read } = workspace({ 'build.js': 'console.log(1)\n', 'setup.js': "require('./lib')\n", 'lib/index.js': 'evil()\n', 'pre.ts': 'export {}\n' })
    const files = (form: string[]) => reading(read(form)).files.map(file => file.path)
    expect(files(['node', '-r', './setup', 'build.js'])).toEqual(['/workspace/setup.js', '/workspace/build.js', '/workspace/lib/index.js'])
    expect(files(['node', '--require=./setup', 'build.js'])).toEqual(['/workspace/setup.js', '/workspace/build.js', '/workspace/lib/index.js'])
    expect(reading(read(['node', '-r', 'dotenv/config', 'build.js']))).toMatchObject({ files: [{ path: '/workspace/build.js' }], packages: [{ name: 'dotenv' }] })
    expect(files(['bun', '--preload', './pre', 'build.js'])).toEqual(['/workspace/pre.ts', '/workspace/build.js'])
    expect(read(['node', '--import', './missing.mjs', 'build.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    expect(read(['node', '--import', 'data:text/javascript,evil()', 'build.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
  })

  it('is a folder\'s __main__.py for Python', () => {
    const { read } = workspace({ 'tool/__main__.py': 'from . import helper\n', 'tool/helper.py': 'X = 1\n' })
    expect(reading(read(['python3', 'tool'])).files.map(file => file.path)).toEqual(['/workspace/tool/__main__.py', '/workspace/tool/helper.py'])
  })

  it('is the file shell text redirects into the interpreter\'s input', () => {
    const { root, view } = workspace({ 'evil.py': 'import helper\n', 'helper.py': 'X = 1\n', 'x.js': 'console.log(1)\n' })
    const fed = (text: string, program: string) => readInterpreterCode({ forms: [[program]], shellForms: [['bash', '-c', text]], cwd: root, view })
    expect(reading(fed('python3 < evil.py', 'python3')).files.map(file => file.path)).toEqual(['/workspace/evil.py', '/workspace/helper.py'])
    expect(reading(fed('cd . && node 0<x.js', 'node')).files.map(file => file.path)).toEqual(['/workspace/x.js'])
    expect(fed('python3 < gone.py', 'python3')).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    expect(fed('python3 < "$SCRIPT"', 'python3')).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    expect(reading(fed('cat evil.py > out.txt; python3 -c 1', 'python3')).files).toEqual([])
  })

  it('reads <> as <, and refuses a duplicated descriptor or input another command takes first (fix brief 2, H6)', () => {
    const { root, view } = workspace({ 'evil.py': 'import os\n', 'build.js': 'console.log(1)\n', 'list.txt': 'evil.py\n' })
    const fed = (text: string, form: string[] = ['python3']) => readInterpreterCode({ forms: [form], shellForms: [['bash', '-c', text]], cwd: root, view })
    expect(reading(fed('python3 <> evil.py')).files.map(file => file.path)).toEqual(['/workspace/evil.py'])
    expect(reading(fed('python3 0<>evil.py')).files.map(file => file.path)).toEqual(['/workspace/evil.py'])
    expect(fed('exec 3<evil.py; python3 <&3')).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    expect(fed('python3 0<&3 3<evil.py')).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
    expect(reading(fed('node build.js <&3', ['node', 'build.js'])).files.map(file => file.path)).toEqual(['/workspace/build.js'])
    for (const text of ['xargs python3 <<< evil.py', 'xargs python3 < list.txt', 'xargs python3 <<EOF\nevil.py\nEOF']) {
      expect(fed(text), text).toEqual({ kind: 'refused', reason: 'the code the interpreter runs comes from another command', truncated: false })
    }
    // A pipe stays the documented limit: the stage reads the shell text alone.
    expect(reading(fed('cat evil.py | python3')).files).toEqual([])
  })

  it('takes the input as data where the interpreter names a script, inline code, or a module (fix brief 2, R7)', () => {
    const { root, view } = workspace({ 'build.js': 'console.log(1)\n', 'job.py': 'print(1)\n', 'data.bin': Buffer.from([0xff, 0xfe, 0x00]), 'evil.py': 'import os\n' })
    const fed = (text: string, form: string[]) => readInterpreterCode({ forms: [form], shellForms: [['bash', '-c', text]], cwd: root, view })
    expect(reading(fed('node build.js < /dev/null', ['node', 'build.js'])).files.map(file => file.path)).toEqual(['/workspace/build.js'])
    expect(reading(fed('python3 job.py < data.bin', ['python3', 'job.py'])).files.map(file => file.path)).toEqual(['/workspace/job.py'])
    expect(reading(fed('python3 job.py < "$IN"', ['python3', 'job.py'])).files.map(file => file.path)).toEqual(['/workspace/job.py'])
    expect(reading(fed('python3 -c 1 < data.bin', ['python3', '-c', '1'])).files).toEqual([])
    expect(reading(fed('python3 - < evil.py', ['python3', '-'])).files.map(file => file.path)).toEqual(['/workspace/evil.py'])
  })

  it('reads the redirected file where a stdin marker names the script, and names the words after it arguments (fix brief 3, R7)', () => {
    const { root, view } = workspace({ 'from-stdin.py': 'import helper\n', 'from-stdin.js': 'console.log(1)\n', 'second.pl': '1;\n', 'other.php': "<?php echo 1;\n", 'other.csh': 'echo 1\n', 'helper.py': 'X = 1\n', 'job.py': 'print(1)\n', 'build.js': 'console.log(1)\n', 'notes.txt': 'x\n' })
    const fed = (text: string, form: string[]) => readInterpreterCode({ forms: [form], shellForms: [['bash', '-c', text]], cwd: root, view })
    const files = (text: string, form: string[]) => reading(fed(text, form)).files.map(file => file.path)
    // A lone `-`, `/dev/stdin`, php's `--`, and csh/tcsh `-s` each make the `<` file the script; the operand after it is an argument, not a file the reader reads.
    expect(files('python3 - job.py < from-stdin.py', ['python3', '-', 'job.py'])).toEqual(['/workspace/from-stdin.py', '/workspace/helper.py'])
    expect(files('node - build.js < from-stdin.js', ['node', '-', 'build.js'])).toEqual(['/workspace/from-stdin.js'])
    expect(files('node /dev/stdin < from-stdin.js', ['node', '/dev/stdin'])).toEqual(['/workspace/from-stdin.js'])
    expect(files('perl - notes.txt < second.pl', ['perl', '-', 'notes.txt'])).toEqual(['/workspace/second.pl'])
    expect(files('php -- data.txt < other.php', ['php', '--', 'data.txt'])).toEqual(['/workspace/other.php'])
    expect(files('tcsh -s x < other.csh', ['tcsh', '-s', 'x'])).toEqual(['/workspace/other.csh'])
    // A missing redirected file refuses, since the script is required.
    expect(fed('python3 - job.py < gone.py', ['python3', '-', 'job.py'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
  })

  it('refuses an interpreter option the reader does not model, and reads the redirect past a value option it does (fix brief 3, R7)', () => {
    const { root, view } = workspace({ 'build.js': 'console.log(1)\n', 'from-stdin.js': 'console.log(2)\n', 'job.py': 'print(1)\n' })
    const fed = (text: string, form: string[]) => readInterpreterCode({ forms: [form], shellForms: [['bash', '-c', text]], cwd: root, view })
    const read = (...forms: string[][]): CodeRead => readInterpreterCode({ forms, cwd: root, view })
    // --run runs a package.json script the reader cannot follow, so it is left out of node's tables and refuses.
    expect(read(['node', '--run', 'build.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unknownOption, truncated: false })
    expect(read(['node', '--env-file=.env', 'build.js'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unknownOption, truncated: false })
    expect(read(['python3', '-Zzz', 'job.py'])).toEqual({ kind: 'refused', reason: CODE_REFUSALS.unknownOption, truncated: false })
    // --redirect-warnings takes a value, so its value is not the script; the redirected file is.
    expect(reading(fed('node --redirect-warnings notes.txt < from-stdin.js', ['node', '--redirect-warnings', 'notes.txt'])).files.map(file => file.path)).toEqual(['/workspace/from-stdin.js'])
    // A known flag and a self-contained --opt=value are read, not refused.
    expect(reading(read(['node', '--enable-source-maps', 'build.js'])).files.map(file => file.path)).toEqual(['/workspace/build.js'])
    expect(reading(read(['node', '--input-type=module', 'build.js'])).files.map(file => file.path)).toEqual(['/workspace/build.js'])
    expect(reading(read(['python3', '-B', 'job.py'])).files.map(file => file.path)).toEqual(['/workspace/job.py'])
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

  it('keeps today\'s reading where no operand or inline code names a script', () => {
    const { read } = workspace({ 'data.txt': 'x\n' })
    expect(reading(read(['node', '--version']))).toMatchObject({ inline: null, files: [] })
    expect(reading(read(['python3', '-m', 'pip', 'install', 'requests']))).toMatchObject({ files: [], packages: [{ name: 'pip' }] })
    expect(reading(read(['node', '-e', '1', 'missing']))).toMatchObject({ inline: '1', files: [] })
    expect(reading(read(['bun', 'test']))).toMatchObject({ files: [] })
    expect(reading(read(['npx', 'eslint', 'missing']))).toMatchObject({ files: [], packages: [{ name: 'eslint' }] })
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
    expect(reading(read(['python3', '-m', 'pytest', '-q', 'data.txt']))).toMatchObject({ files: [{ path: '/workspace/data.txt' }], packages: [{ name: 'pytest', version: null }] })
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

  it('refuses a relative import naming no module', () => {
    const { read } = workspace({ 'pkg/__init__.py': 'from .gone import x\n' })
    expect(read(['python3', 'pkg/__init__.py'])).toMatchObject({ kind: 'refused', reason: CODE_REFUSALS.missing })
  })
})

describe('the code a here-string hands an interpreter', () => {
  it('reads a here-string in bash, zsh, or ksh text as inline code, with what it imports, and nothing a shell without them runs', () => {
    const { root, view } = workspace({ 'helper.py': 'X = 1\n' })
    const read = (shell: string, text: string, program = 'python3') => readInterpreterCode({ forms: [[program]], shellForms: [[shell, '-c', text]], cwd: root, view })
    expect(reading(read('bash', "python3 <<< 'import helper'"))).toMatchObject({ inline: 'import helper', files: [{ path: '/workspace/helper.py' }] })
    expect(reading(read('/usr/bin/zsh', 'FOO=1 node 0<<<"console.log(1)"', 'node'))).toMatchObject({ inline: 'console.log(1)', files: [] })
    expect(reading(read('ksh', 'cd x && python3 - <<<"$CODE"'))).toMatchObject({ inline: '$CODE' })
    expect(reading(read('sh', "python3 <<< 'print(1)'")).inline).toBeNull()
    expect(reading(read('bash', "cat <<< 'print(1)' | python3")).inline).toBeNull()
  })

  it('finds the interpreter behind a wrapper, as env, timeout, and exec name it', () => {
    const { root, view } = workspace({ 'helper.py': 'X = 1\n' })
    const read = (text: string) => readInterpreterCode({ forms: [['python3']], shellForms: [['bash', '-c', text]], cwd: root, view })
    for (const text of ["env python3 <<< 'import helper'", "timeout 5 python3 <<< 'import helper'", "exec python3 <<< 'import helper'", "FOO=1 env -i nice -n 5 python3 - <<< 'import helper'"]) {
      expect(reading(read(text)), text).toMatchObject({ inline: 'import helper', files: [{ path: '/workspace/helper.py' }] })
    }
  })

  it('reads a heredoc\'s body as inline code, each time the statement stands in the text, and refuses one it cannot place', () => {
    const { root, view } = workspace({ 'helper.py': 'X = 1\n' })
    const read = (text: string, program = 'python3') => readInterpreterCode({ forms: [[program]], shellForms: [['bash', '-c', text]], cwd: root, view })
    expect(reading(read("python3 - <<'EOF'\nimport helper\nprint(1)\nEOF\necho done"))).toMatchObject({ inline: 'import helper\nprint(1)', files: [{ path: '/workspace/helper.py' }] })
    expect(reading(read('cd . && node <<EOF\nconsole.log(1)\nEOF', 'node')).inline).toBe('console.log(1)')
    expect(reading(read('python3 <<-EOF\n\timport helper\n\tEOF')).inline).toBe('import helper')
    expect(reading(read('python3 <<EOF\nprint(1)\nEOF\npython3 <<EOF\nimport shutil\nEOF')).inline).toBe('print(1)\nimport shutil')
    expect(read('cat <<A; python3 <<B\nB\nA\nimport shutil\nB')).toEqual({ kind: 'refused', reason: CODE_REFUSALS.notFound, truncated: false })
  })
})

describe('heredocs in a long text (fix brief 2, R9)', () => {
  it('reads 4,000 repeated heredoc statements in one pass, well inside 200 ms', () => {
    const { root, view } = workspace({ 'helper.py': 'X = 1\n' })
    const text = 'python3 <<E\nE\n'.repeat(4_000)
    const started = performance.now()
    const result = readInterpreterCode({ forms: [['python3']], shellForms: [['bash', '-c', text]], cwd: root, view })
    expect(performance.now() - started).toBeLessThan(200)
    expect(reading(result).inline).toBe('')
  })

  it('refuses, marking the reading truncated, once the bodies walked run past the read budget', () => {
    const { root, view } = workspace({ 'helper.py': 'X = 1\n' })
    // 6,000 heredocs left open: each body runs to the end of the text, about 216 million characters in all, far past
    // READ_BUDGET, so the walk stops at the budget rather than reading every body.
    const text = 'python3 <<E\n'.repeat(6_000)
    const started = performance.now()
    expect(readInterpreterCode({ forms: [['python3']], shellForms: [['bash', '-c', text]], cwd: root, view })).toEqual({ kind: 'refused', reason: CODE_REFUSALS.truncated, truncated: true })
    expect(performance.now() - started).toBeLessThan(1_000)
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
