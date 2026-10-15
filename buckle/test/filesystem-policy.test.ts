import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { emptyWorkspacePolicy, WorkspacePolicySchema } from '@5straps/protocol'
import { openSettingsFile } from '../common/services/workspaces/workspace-settings.js'
import { createBubblewrapSandbox } from '../common/adapters/sandbox/bubblewrap-sandbox.js'
import { createFilesystemPolicyRule, projectFilesystemSandbox, resolveFilesystemPermission } from '../common/domain/filesystem-policy.js'
import { policyRevision } from '../common/domain/policy.js'

const roots: string[] = []
function root() { const path = mkdtempSync(join(tmpdir(), 'buckle-path-policy-')); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const policy = (rules: unknown[]) => WorkspacePolicySchema.parse({ ...emptyWorkspacePolicy(), filesystem: { rules } })

it('keeps denied ancestors above child allows', () => {
  const own = policy([{ path: '.', read: 'allow', write: 'allow' }, { path: 'private', read: 'deny' }, { path: 'private/file.txt', read: 'allow' }])
  expect(resolveFilesystemPermission({ path: 'private/file.txt', operation: 'read', policy: own })).toBe('deny')
  expect(resolveFilesystemPermission({ path: 'src/index.ts', operation: 'write', policy: own })).toBe('allow')
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

it('atomically refuses stale settings revisions across separate file instances', async () => {
  const filePath = join(root(), 'workspace.json')
  const first = openSettingsFile({ filePath })
  const second = openSettingsFile({ filePath })
  const revision = first.read().revision
  await first.update(settings => ({ ...settings, policy: policy([{ path: '.', write: 'deny' }]) }), revision)
  await expect(second.update(settings => ({ ...settings, policy: policy([{ path: '.', write: 'allow' }]) }), revision)).rejects.toThrow(/changed/)
  expect(first.read().policy.filesystem?.rules[0]?.write).toBe('deny')
})

// Review H2 of the second proof-of-possession re-review: on macOS a case variant of an owner-denied
// directory names that directory, so a new file there was judged by its spelling and allowed. A
// restriction now meets every spelling the volume folds; an allow meets only its own.
const judged = (input: { rules: unknown[]; path: string; kind?: 'read_path' | 'write_path'; caseInsensitive: boolean }) => {
  const directory = '/Users/owner/project'
  const rule = createFilesystemPolicyRule({ root: directory, policy: policy(input.rules), caseInsensitive: input.caseInsensitive })
  const path = join(directory, input.path)
  return rule.evaluate({ tool: 'fs_write', effect: { kind: input.kind ?? 'write_path', path, directory: join(path, '..') }, grants: { subjectsFor: () => [] } })
}

it.each([
  [[{ path: 'secrets', write: 'deny' }], 'SECRETS/new.json'],
  [[{ path: 'secrets', write: 'deny' }], 'Secrets/deeper/new.json'],
  [[{ path: '.git', write: 'deny' }], '.GIT/hooks/pre-commit'],
  [[{ path: 'Private', write: 'deny' }], 'private/notes.md'],
])('denies a new file under a case variant of an owner-denied directory where the volume ignores case (%j, %s)', (rules, path) => {
  expect(judged({ rules, path, caseInsensitive: true })).toMatchObject({ kind: 'deny', rule: 'filesystem_policy' })
  // Where the volume keeps case, the variant is another directory the rule does not name.
  expect(judged({ rules, path, caseInsensitive: false })).toBeNull()
})

it('folds an ask rule the same way', () => {
  expect(judged({ rules: [{ path: 'docs', read: 'ask' }], path: 'DOCS/plan.md', kind: 'read_path', caseInsensitive: true })).toMatchObject({ kind: 'ask', rule: 'filesystem_policy' })
})

it('folds the long s as case folding does, so .5ſtraps meets a .5straps deny', () => {
  expect(judged({ rules: [{ path: '.5straps', write: 'deny' }], path: '.5ſtraps/buckle/plugins.json', caseInsensitive: true })).toMatchObject({ kind: 'deny' })
})

it('lets an allow cover its own spelling only, so a case-sensitive sibling is not allowed by it', () => {
  const rules = policy([{ path: 'docs', write: 'allow' }])
  expect(resolveFilesystemPermission({ path: 'docs/a.md', operation: 'write', policy: rules, caseInsensitive: true })).toBe('allow')
  expect(resolveFilesystemPermission({ path: 'DOCS/a.md', operation: 'write', policy: rules, caseInsensitive: true })).toBe('inherit')
})
