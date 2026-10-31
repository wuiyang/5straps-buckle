import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessManifestSchema } from '@5straps/protocol'
import { readBuildInfo, writeBuildInfo } from '../scripts/build-info.mjs'
import { BUCKLE_BUILD, BUCKLE_VERSION, buildStampOf, stampedVersion } from '../common/runtime/version.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'

const made: string[] = []
afterEach(() => { for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function scratch(prefix: string): string { const directory = mkdtempSync(join(tmpdir(), prefix)); made.push(directory); return directory }

/** A repository of one commit, its git isolated from the machine's own configuration. */
function repository(): { root: string; git: (...args: string[]) => string } {
  const root = scratch('buckle-stamp-repo-')
  const env = { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-config'), GIT_AUTHOR_NAME: 'Stamp', GIT_AUTHOR_EMAIL: 'stamp@example.invalid', GIT_COMMITTER_NAME: 'Stamp', GIT_COMMITTER_EMAIL: 'stamp@example.invalid' }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' })
  git('init', '--quiet')
  writeFileSync(join(root, 'file.txt'), 'one\n')
  git('add', 'file.txt'); git('commit', '--quiet', '-m', 'one')
  return { root, git }
}

describe('the build stamp', () => {
  it('names the commit, and .dirty past an uncommitted change, beside the version', () => {
    expect(stampedVersion('0.1.8', { commit: '670f1dc2', dirty: false })).toBe('0.1.8+670f1dc2')
    expect(stampedVersion('0.1.8', { commit: '670f1dc2', dirty: true })).toBe('0.1.8+670f1dc2.dirty')
    expect(stampedVersion('0.1.8', null)).toBe('0.1.8')
  })

  it('reads the commit and the state of the tree from git at build time', () => {
    const { root, git } = repository()
    const head = git('rev-parse', '--short=8', 'HEAD').trim()
    expect(readBuildInfo({ cwd: root, version: '0.1.8' })).toMatchObject({ commit: head, dirty: false, builtAt: expect.any(String) })
    writeFileSync(join(root, 'file.txt'), 'two\n')
    expect(readBuildInfo({ cwd: root, version: '0.1.8' })).toMatchObject({ commit: head, dirty: true })
    writeFileSync(join(root, 'file.txt'), 'one\n')
    writeFileSync(join(root, 'new.ts'), 'export {}\n')
    expect(readBuildInfo({ cwd: root, version: '0.1.8' })).toMatchObject({ dirty: true })
  })

  it('stamps nothing on a clean build of the release tag, so a published package shows the plain version', () => {
    const { root, git } = repository()
    git('tag', 'v0.1.8')
    expect(readBuildInfo({ cwd: root, version: '0.1.8' })).toBeNull()
    expect(readBuildInfo({ cwd: root, version: '0.1.9' })).toMatchObject({ dirty: false })
    writeFileSync(join(root, 'file.txt'), 'changed\n')
    expect(readBuildInfo({ cwd: root, version: '0.1.8' })).toMatchObject({ dirty: true })
  })

  it('stamps nothing outside a git checkout', () => {
    expect(readBuildInfo({ cwd: scratch('buckle-stamp-plain-'), version: '0.1.8' })).toBeNull()
  })

  it('writes the stamp beside the build, and removes an earlier one when there is none', () => {
    const out = scratch('buckle-stamp-out-')
    writeBuildInfo(out, { commit: '670f1dc2', dirty: true, builtAt: '2026-11-01T00:00:00.000Z' })
    const file = join(out, 'build-info.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ commit: '670f1dc2', dirty: true, builtAt: '2026-11-01T00:00:00.000Z' })
    expect(buildStampOf(file)).toEqual({ commit: '670f1dc2', dirty: true, builtAt: '2026-11-01T00:00:00.000Z' })
    writeBuildInfo(out, null)
    expect(existsSync(file)).toBe(false)
    expect(buildStampOf(file)).toBeNull()
  })

  it('reads a malformed stamp as none, never as part of the version', () => {
    const out = scratch('buckle-stamp-bad-')
    const file = join(out, 'build-info.json')
    for (const content of ['not json', JSON.stringify({ commit: '../../x', dirty: false }), JSON.stringify({ commit: '670f1dc2', dirty: 'yes' }), JSON.stringify(['670f1dc2'])]) {
      writeFileSync(file, content)
      expect(buildStampOf(file)).toBeNull()
    }
  })

  it('serves the stamped version in the manifest beside the plain one', async () => {
    const root = scratch('buckle-stamp-workspace-')
    const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: root, BUCKLE_STATE_DIR: scratch('buckle-stamp-state-') })
    const runtime = await createRuntime({ config })
    try {
      const manifest = HarnessManifestSchema.parse(runtime.manifest())
      expect(manifest.version).toBe(BUCKLE_VERSION)
      expect(manifest.build).toBe(BUCKLE_BUILD)
      expect(BUCKLE_BUILD.startsWith(BUCKLE_VERSION)).toBe(true)
    } finally { runtime.closeWatchers(); await runtime.history.close() }
  })
})
