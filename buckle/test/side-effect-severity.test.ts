import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { describeApprovalRequest } from '../common/domain/approval-instruction.js'
import { BUILT_IN_DELETE_POLICY } from '../common/domain/delete-policy.js'
import type { ResolvedEffect } from '../common/domain/effect.js'
import { createPathView } from '../common/domain/path-view.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import { createDestructiveCommandRule } from '../common/domain/permission/rules/destructive-command-rule.js'
import { createDestructivePathRule } from '../common/domain/permission/rules/destructive-path-rule.js'
import { createWriteScopeRule } from '../common/domain/permission/rules/write-scope-rule.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, questionFor } from '../common/services/approvals/approval-service.js'
import { createTerminalConsumer, describeQuestion } from '../cli/terminal-consumer.js'
import { FILE_FLOOR_MARKS } from '../common/domain/permission/decision.js'

const ROOT = '/work/project'
const paths = createPathView({ root: ROOT, mount: null })
const grants = { subjectsFor: () => [ROOT] }
const tree = { counted: true as const, files: 2, folders: 1, more: false }
const moved: ResolvedEffect = { kind: 'delete_path', path: `${ROOT}/src/lib`, directory: `${ROOT}/src`, floor: true, tree, moved: true }
const removed = (path: string, files = 2): ResolvedEffect => ({ kind: 'delete_path', path, directory: path.slice(0, path.lastIndexOf('/')), floor: true, tree: { ...tree, files } })
const engine = (massLimit = 100) => {
  const deletes = { ...BUILT_IN_DELETE_POLICY, massLimit }
  return createPermissionEngine([
    createDestructivePathRule({ paths, strict: false, deletes }),
    createWriteScopeRule({ paths, strict: false, deletes }),
  ])
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('file side effect severity', () => {
  it.each([100, 0])('warns and asks before a whole-folder move with a mass-delete limit of %s', (limit) => {
    expect(engine(limit).evaluate({ tool: 'fs_move', effects: [moved], grants })).toMatchObject({
      kind: 'ask', asks: [{ rule: 'write_scope', subject: `move-tree:${ROOT}/src/lib`, severity: 'warn', offeredScopes: ['once', 'session', 'always'], reason: expect.stringContaining('Moving the folder') }],
    })
  })

  it.each([
    ['a large recursive delete', removed(`${ROOT}/src/generated`, 101)],
    ['a top-level recursive delete', removed(`${ROOT}/build`)],
    ['an unread file emptied', { kind: 'unread_shrink', path: `${ROOT}/src/a.ts`, empties: true }],
    ['many files rewritten', { kind: 'many_rewrites', files: 51 }],
    ['a checkpoint restored', { kind: 'restore_checkpoint', checkpoint: 'cp-1', head: 'cp-2', undoes: 2 }],
  ] satisfies Array<[string, ResolvedEffect]>)('labels %s danger even when ordinary writes are granted', (_name, effect) => {
    expect(engine().evaluate({ tool: 'fs_delete', effects: [effect], grants })).toMatchObject({ kind: 'ask', asks: [{ severity: 'danger' }] })
  })

  it('labels a mass deletion danger while leaving a small nested deletion under its ordinary write grant', () => {
    const many = Array.from({ length: 101 }, (_, index): ResolvedEffect => ({ kind: 'delete_path', path: `${ROOT}/src/${index}.ts`, directory: `${ROOT}/src`, floor: true }))
    expect(engine().evaluate({ tool: 'fs_delete', effects: many, grants })).toMatchObject({ kind: 'ask', asks: [{ subject: `delete-batch:${ROOT}`, severity: 'danger' }] })
    expect(engine().evaluate({ tool: 'fs_delete', effects: [removed(`${ROOT}/src/legacy`)], grants }).kind).toBe('allow')
  })

  it('keeps explicit floor grants and the dangerously-allow switch effective for moves', () => {
    const held = { subjectsFor: () => [ROOT, `move-tree:${ROOT}/src/lib`] }
    expect(engine().evaluate({ tool: 'fs_move', effects: [moved], grants: held }).kind).toBe('allow')
    for (const level of ['command', 'all'] as const) {
      const allowed = withDangerouslyAllow(engine(), { level: () => level, root: () => ROOT })
      expect(allowed.evaluate({ tool: 'fs_move', effects: [moved], grants })).toMatchObject({ kind: 'allow', allowedBy: [`dangerously_allow:${level}:write_scope:move-tree:${ROOT}/src/lib`] })
    }
  })

  it('keeps warned move grants and dangerous recursive-delete grants separate in both directions', () => {
    const moveGrant = { subjectsFor: () => [ROOT, `move-tree:${ROOT}/src/lib`] }
    expect(engine().evaluate({ tool: 'fs_delete', effects: [removed(`${ROOT}/src/lib`, 101)], grants: moveGrant })).toMatchObject({ kind: 'ask', asks: [{ subject: `delete-tree:${ROOT}/src/lib`, severity: 'danger' }] })
    const deleteGrant = { subjectsFor: () => [ROOT, `delete-tree:${ROOT}/src/lib`] }
    expect(engine().evaluate({ tool: 'fs_move', effects: [moved], grants: deleteGrant })).toMatchObject({ kind: 'ask', asks: [{ subject: `move-tree:${ROOT}/src/lib`, severity: 'warn' }] })
  })

  it('offers only the exact move subject outside the workspace and ignores broad delete grants', () => {
    const outside: ResolvedEffect = { ...moved, path: '/srv/data/lib', directory: '/srv/data' }
    const broadDeletes = { subjectsFor: () => ['delete-below:/srv/data'] }
    for (const held of [grants, broadDeletes]) {
      const outcome = engine().evaluate({ tool: 'fs_move', effects: [outside], grants: held })
      expect(outcome).toMatchObject({ kind: 'ask', asks: [{ subject: 'move-tree:/srv/data/lib', severity: 'warn', offeredScopes: ['once', 'session', 'always'] }] })
      if (outcome.kind !== 'ask') throw new Error('Expected an exact approval for the outside folder move')
      expect(outcome.asks[0]).not.toHaveProperty('widerSubject')
    }
  })

  it('labels the existing recursive shell-delete floor danger without changing its scopes', () => {
    const command = createPermissionEngine([createDestructiveCommandRule()])
    expect(command.evaluate({ tool: 'shell_exec', effects: [{ kind: 'exec', command: 'rm', args: ['-rf', 'build'] }], grants: { subjectsFor: () => [] } })).toMatchObject({ kind: 'ask', asks: [{ severity: 'danger', offeredScopes: ['once', 'session'] }] })
  })
})

describe('approval severity delivery', () => {
  it.each(['warn', 'danger'] as const)('keeps %s in durable requests, signed reasons and terminal questions', async (severity) => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-severity-'))
    roots.push(root)
    const filePath = join(root, 'approvals.json')
    const grantStore = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
    const registry = createApprovalRegistry(grantStore, filePath)
    const service = createApprovalService({ registry, workspaceId: 'default', serverId: 'node-1', graceMs: 1, interaction: async () => undefined })
    try {
      const call = { arguments: { from: 'src/lib', to: 'src/old-lib' }, cwd: '/workspace', description: 'Move a folder', effects: ['read /workspace/src/lib', 'write /workspace/src/old-lib'], complete: true as const }
      const issued = await registry.ask({ tool: 'fs_move', sessionId: 's', asks: [{ kind: 'ask', ...FILE_FLOOR_MARKS, rule: 'write_scope', subject: `move-tree:${ROOT}/src/lib`, reason: 'Moving the folder needs approval', offeredScopes: ['once', 'session', 'always'], severity }], call })
      const request = issued.requests[0]!
      expect(request).toMatchObject({ severity, reason: `[${severity}] Moving the folder needs approval` })
      const reopened = createApprovalRegistry(grantStore, filePath)
      expect(reopened.pending()[0]).toMatchObject({ severity })
      const challenge = service.challengeListing().challenges[0]?.challenge
      expect(challenge?.reason).toBe(request.reason)
      expect(challenge).not.toHaveProperty('severity')
      expect(service.listing()[0]).toMatchObject({ severity })
      const question = questionFor({ approval: request, workspaceId: 'default', context: { correlationId: 'c', sessionId: 's', call } })
      expect(question.action.details).toMatchObject({ severity })
      expect(describeQuestion({ ...request, workspaceId: 'default', call })).toContain(`severity: ${severity}`)
      expect(describeApprovalRequest({ request }).join('\n')).toContain(`[${severity}]`)
      const input = new PassThrough()
      const output = new PassThrough()
      let shown = ''
      output.on('data', (chunk: Buffer) => { shown += chunk.toString('utf8') })
      const stop = new AbortController()
      const prompted = createTerminalConsumer({ input, output, onInterrupt: () => {} }).prompt(question, { signal: stop.signal })
      try { await vi.waitFor(() => expect(shown).toContain(`severity: ${severity}`)) }
      finally { stop.abort(); await prompted.catch(() => undefined) }
    } finally { await service.close() }
  })
})


describe('approval risk changes while a request waits', () => {
  it.each([['warn', 'danger'], ['danger', 'warn'], [undefined, 'warn']] as const)('refuses to join %s severity to %s under the same requestId', async (before, after) => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-severity-join-'))
    roots.push(root)
    const grantStore = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
    const registry = createApprovalRegistry(grantStore, join(root, 'approvals.json'))
    const item = { kind: 'ask' as const, ...FILE_FLOOR_MARKS, rule: 'write_scope' as const, subject: `move-tree:${ROOT}/src/lib`, reason: 'A folder changes', offeredScopes: ['once' as const] }
    const call = { arguments: { from: 'src/lib', to: 'src/old-lib' }, cwd: '/workspace', description: 'Move a folder', effects: ['write /workspace/src/old-lib'], complete: true as const }
    const base = { tool: 'fs_move', sessionId: 's', requestId: 'same-action', call }
    const asks = [{ ...item, ...(before === undefined ? {} : { severity: before }) }]
    const first = await registry.ask({ ...base, asks })
    expect((await registry.ask({ ...base, asks })).requests[0]?.token).toBe(first.requests[0]?.token)
    await expect(registry.ask({ ...base, asks: [{ ...item, severity: after }] })).rejects.toThrow('different asks')
    expect(registry.pending()).toHaveLength(1)
  })
})
