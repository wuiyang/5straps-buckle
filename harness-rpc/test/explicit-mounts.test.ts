import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseSandboxMounts, validateSandboxMounts, type SandboxMount } from '../src/domain/sandbox-mounts.js'
import { createBubblewrapSandbox } from '../src/adapters/sandbox/bubblewrap-sandbox.js'
import { createNoneSandbox } from '../src/adapters/sandbox/none-sandbox.js'
import { createShellPack } from '../src/packs/shell/index.js'
import { createPathView } from '../src/domain/path-view.js'
import type { ProcessRunner } from '../src/ports/process-runner.js'

let root: string
let workspace: string
let state: string
let source: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'buckle-explicit-mounts-'))
  workspace = join(root, 'workspace'); mkdirSync(workspace)
  state = join(root, 'state'); mkdirSync(state)
  const docker = join(root, '.docker'); mkdirSync(docker)
  source = join(docker, 'config.json'); writeFileSync(source, '{"auths":{}}')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const target = '/tmp/home/.docker/config.json'
function mounts(path = source, destination = target): SandboxMount[] { return [{ source: path, target: destination, readOnly: true }] }
function validate(entries = mounts()) { return validateSandboxMounts(entries, { protectedRoots: [state], workspaceRoots: [workspace], workspaceTarget: '/workspace' }) }

it('parses explicit file and folder mounts and expands the service account home', () => {
  expect(parseSandboxMounts('[{"source":"~/.docker/config.json","target":"/tmp/home/.docker/config.json"}]')).toEqual(mounts(join(homedir(), '.docker/config.json')))
  expect(validate()[0]!.source).toBe(source)
  expect(validate(mounts(join(root, '.docker'), '/srv/auth'))[0]!.target).toBe('/srv/auth')
})
it.each(['not json', '[{"source":"relative","target":"/srv/auth"}]', '[{"source":"/a","target":"/srv/auth","readOnly":false}]', '[{"source":"/a","target":"/srv/../etc"}]'])('refuses malformed or writable mount configuration: %s', raw => {
  expect(() => parseSandboxMounts(raw)).toThrow('BUCKLE_MOUNTS')
})
it.each(['/workspace/auth', '/workspace', '/etc/docker', '/usr/bin/docker', '/proc/x', '/tmp', '/tmp/home', '/'])('refuses reserved destination %s', destination => {
  expect(() => validate(mounts(source, destination))).toThrow('reserved')
})
it('refuses state, workspace aliases and parent directories containing them', () => {
  for (const path of [state, workspace, root]) expect(() => validate(mounts(path, '/srv/auth'))).toThrow('overlaps')
  expect(() => validate([...mounts(source, '/srv/auth'), ...mounts(source, '/srv/auth/config.json')])).toThrow('overlap')
})
it.skipIf(process.platform === 'win32')('resolves source symlinks before checking protected paths', () => {
  const alias = join(root, 'alias'); symlinkSync(state, alias)
  expect(() => validate(mounts(alias))).toThrow('protected')
})
it('refuses a missing source instead of silently ignoring the mount', () => {
  expect(() => validate(mounts(join(root, 'missing')))).toThrow()
})
it('passes explicit credentials after home creation while keeping workspace secrets masked', async () => {
  writeFileSync(join(workspace, '.env'), 'SYNTHETIC=true')
  const runProcess = vi.fn<ProcessRunner>(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false }))
  const pack = createShellPack({ paths: createPathView({ root: workspace, mount: '/workspace' }), runProcess,
    sandbox: createBubblewrapSandbox('/usr/bin/bwrap'), writableRoots: [workspace], hiddenPaths: [state], readOnlyPaths: [], mounts: mounts(), unavailableReason: null })
  await pack.tools[0]!.prepare({ command: 'docker', args: ['version'], cwd: '/workspace' }).execute({ requestId: 'mount-test', sessionId: 'test', timeoutMs: 1000, signal: AbortSignal.timeout(1000) })
  const args = runProcess.mock.calls[0]![0].args
  const offset = args.indexOf(source)
  expect(args.slice(offset - 1, offset + 2)).toEqual(['--ro-bind', source, target])
  expect(offset).toBeGreaterThan(args.indexOf('/tmp/home'))
  expect(args).toContain('/workspace/.env')
  expect(args).toContain('--unshare-net')
})
it('does not execute explicit mounts without bubblewrap', async () => {
  const runProcess = vi.fn<ProcessRunner>()
  const pack = createShellPack({ paths: createPathView({ root: workspace, mount: null }), runProcess,
    sandbox: createNoneSandbox(), writableRoots: [workspace], hiddenPaths: [state], readOnlyPaths: [], mounts: mounts(), unavailableReason: null })
  await expect(pack.tools[0]!.prepare({ command: 'true' }).execute({ requestId: 'mount-test', sessionId: 'test', timeoutMs: 1000, signal: AbortSignal.timeout(1000) })).rejects.toThrow('bubblewrap')
  expect(runProcess).not.toHaveBeenCalled()
})
