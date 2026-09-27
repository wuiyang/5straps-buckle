import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { emptyWorkspacePolicy, WorkspacePolicySchema } from '@5straps/protocol'
import { createFilePolicyStore } from '../common/adapters/policy-store/file-policy-store.js'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { createFilesystemPolicyRule, projectFilesystemSandbox, resolveFilesystemPermission } from '../common/domain/filesystem-policy.js'
import { policyRevision } from '../common/domain/policy.js'

const roots: string[] = []
function root() { const path = mkdtempSync(join(tmpdir(), 'buckle-path-policy-')); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const policy = (rules: unknown[]) => WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules } })

it('keeps denied ancestors and node ceilings above child allows', () => {
  const own = policy([{ path: '.', read: 'allow', write: 'allow' }, { path: 'private', read: 'deny' }, { path: 'private/file.txt', read: 'allow' }])
  expect(resolveFilesystemPermission({ path: 'private/file.txt', operation: 'read', policy: own })).toBe('deny')
  expect(resolveFilesystemPermission({ path: 'src/index.ts', operation: 'write', policy: own, ceiling: policy([{ path: '.', write: 'deny' }]) })).toBe('deny')
  expect(resolveFilesystemPermission({ path: 'src/index.ts', operation: 'read', policy: own, ceiling: policy([{ path: '.', read: 'ask' }]) })).toBe('ask')
})

it.each(['../secret', '/absolute', 'a/../b', 'a//b', 'a\\b'])('rejects invalid policy path %s', path => {
  expect(() => policy([{ path, read: 'deny' }])).toThrow()
})

it('does not let an old directory grant override an explicit path denial', () => {
  const directory = root()
  const rule = createFilesystemPolicyRule({ root: directory, policy: policy([{ path: 'private', read: 'deny' }]) })
  expect(rule.evaluate({ tool: 'fs_read', effect: { kind: 'read_path', path: join(directory, 'private/file.txt'), directory: join(directory, 'private') }, grants: { subjectsFor: () => [directory] } })).toMatchObject({ kind: 'deny' })
})

it('restricts missing paths through their existing parent and refuses escaping symlink rules', async () => {
  const directory = root()
  mkdirSync(join(directory, 'private'))
  writeFileSync(join(directory, 'private/data.txt'), 'data')
  const view = await projectFilesystemSandbox({ root: directory, policy: policy([{ path: 'private/missing', write: 'deny' }]) })
  expect(view.readOnlyWorkspacePaths).toEqual([join(directory, 'private')])
  symlinkSync(root(), join(directory, 'outside'))
  await expect(projectFilesystemSandbox({ root: directory, policy: policy([{ path: 'outside', read: 'deny' }]) })).rejects.toThrow(/outside/)
})

it('places readonly workspace masks after writable binds', () => {
  const wrapped = createBubblewrapSandbox('bwrap').wrap({ command: 'bash', args: [], cwd: '/source', workspaceRoot: '/source', writableRoots: ['/source'], mount: { root: '/source', at: '/workspace' }, hiddenPaths: [], readOnlyPaths: [], readOnlyWorkspacePaths: ['/source/private'], allowNetwork: false })
  expect(wrapped.args.join(' ')).toContain('--bind /source /workspace --ro-bind /source/private /workspace/private')
})

it('atomically refuses stale policy revisions across separate store instances', () => {
  const filePath = join(root(), 'policies.json')
  const first = createFilePolicyStore({ filePath, workspace: '/workspace' })
  const second = createFilePolicyStore({ filePath, workspace: '/workspace' })
  const revision = policyRevision(null)
  first.write(policy([{ path: '.', write: 'deny' }]), revision)
  expect(() => second.write(policy([{ path: '.', write: 'allow' }]), revision)).toThrow(/changed/)
  expect(first.read()?.filesystem?.rules[0]?.write).toBe('deny')
})
