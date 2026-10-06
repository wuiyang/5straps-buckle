import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executableCandidates, findExecutable, isPathReference, rootsOf, trustedSearchPath } from '../common/domain/executable.js'

const root = mkdtempSync(join(tmpdir(), 'buckle-exec-'))

function writeExecutable(name: string): string {
  const path = join(root, name)
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

describe('findExecutable', () => {
  it('finds an executable file on PATH', () => {
    const path = writeExecutable('buckle-real-tool')
    expect(findExecutable('buckle-real-tool', { PATH: root }, 'linux')).toBe(path)
  })

  it('ignores a file on PATH that is not executable', () => {
    writeFileSync(join(root, 'buckle-not-executable'), 'text\n')
    chmodSync(join(root, 'buckle-not-executable'), 0o644)
    expect(findExecutable('buckle-not-executable', { PATH: root }, 'linux')).toBeNull()
  })

  it('ignores a directory that happens to carry the execute bit', () => {
    mkdirSync(join(root, 'buckle-directory'), { recursive: true })
    expect(findExecutable('buckle-directory', { PATH: root }, 'linux')).toBeNull()
  })

  it('returns null rather than throwing when PATH is unset', () => {
    expect(findExecutable('buckle-real-tool', {}, 'linux')).toBeNull()
  })

  it('checks an explicit path directly instead of scanning PATH', () => {
    const path = writeExecutable('buckle-explicit-tool')
    expect(findExecutable(path, { PATH: '' }, 'linux')).toBe(path)
  })
})

describe('isPathReference', () => {
  it('treats a forward slash as a separator everywhere', () => {
    expect(isPathReference('/usr/bin/git', 'linux')).toBe(true)
    expect(isPathReference('C:/tools/agent-browser.exe', 'win32')).toBe(true)
  })

  it('treats a backslash as a separator only on Windows', () => {
    expect(isPathReference('D:\\tools\\agent-browser.exe', 'win32')).toBe(true)
    expect(isPathReference('weird\\name', 'linux')).toBe(false)
  })

  it('treats a bare binary name as a PATH lookup', () => {
    expect(isPathReference('git', 'win32')).toBe(false)
    expect(isPathReference('git', 'linux')).toBe(false)
  })
})

describe('executableCandidates', () => {
  it('leaves a POSIX name alone', () => {
    expect(executableCandidates('git', 'linux')).toEqual(['git'])
  })

  it('suffixes a bare Windows name, because git is stored as git.exe', () => {
    expect(executableCandidates('git', 'win32')).toEqual(['git.exe', 'git.com'])
  })

  it('keeps an explicit Windows extension as written', () => {
    expect(executableCandidates('agent-browser.exe', 'win32')).toEqual(['agent-browser.exe'])
  })

  it('matches an extension case insensitively', () => {
    expect(executableCandidates('AGENT-BROWSER.EXE', 'win32')).toEqual(['AGENT-BROWSER.EXE'])
  })

  it('never offers a batch file, which Node refuses to spawn without a shell', () => {
    const candidates = executableCandidates('agent-browser', 'win32')
    expect(candidates.some(candidate => candidate.endsWith('.cmd'))).toBe(false)
    expect(candidates.some(candidate => candidate.endsWith('.bat'))).toBe(false)
  })
})

// A program Buckle runs on the host inherits PATH: a trusted script that starts `#!/usr/bin/env node` looked `node` up
// where `npx` and `pnpm exec` start it, in a workspace's node_modules/.bin, and ran the agent's.
describe('trustedSearchPath', () => {
  const base = mkdtempSync(join(root, 'search-path-'))
  const workspace = join(base, 'ws')
  const tools = join(base, 'tools')
  for (const directory of [join(workspace, 'node_modules', '.bin'), join(workspace, 'tools'), tools]) mkdirSync(directory, { recursive: true })
  symlinkSync(join(workspace, 'tools'), join(base, 'linked-tools'))
  symlinkSync(join(workspace, 'tools'), join(base, 'hop'))
  symlinkSync(join(base, 'hop'), join(base, 'through-hop'))
  const roots = { untrustedRoots: rootsOf('workspace', [workspace]) }

  it('keeps the entries outside every root, in order, and drops each one inside a root, as named, where it leads, or on the way', () => {
    const entries = [join(workspace, 'node_modules', '.bin'), '/usr/bin', join(base, 'linked-tools'), tools, join(base, 'through-hop', 'sub'), '/bin']
    expect(trustedSearchPath(entries.join(':'), roots, 'linux')).toBe(['/usr/bin', tools, '/bin'].join(':'))
  })

  it('drops an empty or relative entry, which names a folder in whichever directory a program starts in', () => {
    expect(trustedSearchPath(['', '.', 'bin', './node_modules/.bin', '/usr/bin'].join(':'), roots, 'linux')).toBe('/usr/bin')
  })

  it('keeps nothing while the roots are unknown', () => {
    expect(trustedSearchPath('/usr/bin:/bin', { ...roots, rootsUnknown: 'the workspace registry cannot be read' }, 'linux')).toBe('')
  })

  it('reads Windows\' separator, keeps only entries on a drive, and compares as the disk does', () => {
    const windowsRoots = { untrustedRoots: rootsOf('workspace', ['C:/ws']) }
    expect(trustedSearchPath('C:\\WS\\node_modules\\.bin;C:\\Windows\\system32;\\bin;tools;D:\\Tools', windowsRoots, 'win32')).toBe('C:\\Windows\\system32;D:\\Tools')
  })
})
