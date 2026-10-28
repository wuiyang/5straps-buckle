import { describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy, type PermissionRuleId } from '@5straps/protocol'
import { describeCall } from '../common/domain/describe-call.js'
import type { DeletePolicy } from '../common/domain/delete-policy.js'
import { summarizeEffect, type ResolvedEffect } from '../common/domain/effect.js'
import { createFilesystemPolicyRule } from '../common/domain/filesystem-policy.js'
import type { GrantLookup } from '../common/domain/permission/decision.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { judgeable, quickCovers } from '../common/domain/permission/judged.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import { createDestructivePathRule, isFloorSubject } from '../common/domain/permission/rules/destructive-path-rule.js'
import { createSensitivePathRule } from '../common/domain/permission/rules/sensitive-path-rule.js'
import { createWriteScopeRule } from '../common/domain/permission/rules/write-scope-rule.js'
import { createPathView } from '../common/domain/path-view.js'

// Slice D, rollback as an agent option: a restore of the change history asks a person at the destructive floor every
// time, under `restore:<checkpoint>..<newest>`, whatever the folders' write grants say, offering once alone. Each path it
// puts back is judged beside it as a write is, so it is refused where a write is refused, and it raises no folder ask.

const WORKSPACE = '/work/project'
const STATE = '/work/project/.state'
const DELETES: DeletePolicy = { inWorkspace: 'allow', massLimit: 100 }
const CHECKPOINT = 'change-00000000-0000-4000-8000-000000000001'
const HEAD = 'change-00000000-0000-4000-8000-000000000003'

function lookup(granted: Partial<Record<PermissionRuleId, string[]>> = {}): GrantLookup {
  return { subjectsFor: rule => granted[rule] ?? [] }
}

function engine(options: { strict?: boolean; mount?: string; readOnly?: string; rules?: Array<{ path: string; write?: 'deny' | 'ask' }> } = {}) {
  const mounts = options.readOnly ? [{ source: options.readOnly, target: '/data', access: 'ro' as const }] : []
  const paths = createPathView({ root: WORKSPACE, mount: options.mount ?? null, mounts })
  const policy = { ...emptyWorkspacePolicy(), filesystem: { rules: options.rules ?? [] } }
  return createPermissionEngine([
    createSensitivePathRule({ protectedRoots: [STATE] }),
    createDestructivePathRule({ paths, strict: options.strict ?? false, deletes: DELETES }),
    createFilesystemPolicyRule({ root: WORKSPACE, policy }),
    createWriteScopeRule({ paths, strict: options.strict ?? false, deletes: DELETES }),
  ])
}

const restore = (undoes = 3): ResolvedEffect => ({ kind: 'restore_checkpoint', checkpoint: CHECKPOINT, head: HEAD, undoes })
const restored = (path: string, kind: 'created' | 'modified' | 'deleted' = 'modified'): ResolvedEffect => ({ kind: 'write_path', path, directory: path.slice(0, path.lastIndexOf('/')), entry: true, restore: kind })

function evaluate(effects: ResolvedEffect[], granted?: Partial<Record<PermissionRuleId, string[]>>, options?: Parameters<typeof engine>[0]) {
  return engine(options).evaluate({ tool: 'history_restore', effects, grants: lookup(granted) })
}

describe('a restore of the change history', () => {
  it('asks at the floor under a subject naming what it undoes, whatever the folders\' write grants say, and raises no folder ask', () => {
    const outcome = evaluate([restore(), restored(`${WORKSPACE}/src/a.ts`), restored(`${WORKSPACE}/docs/b.md`)], { write_scope: [WORKSPACE] })
    expect(outcome).toMatchObject({ kind: 'ask', asks: [{ rule: 'write_scope', subject: `restore:${CHECKPOINT}..${HEAD}`, offeredScopes: ['once'] }] })
    if (outcome.kind !== 'ask') return
    expect(outcome.asks).toHaveLength(1)
    expect(outcome.asks[0]!.reason).toBe(`Restoring the workspace to before checkpoint ${CHECKPOINT} undoes it and the 2 checkpoints after it, the newest ${HEAD}, so a person decides, whatever the folders' write grants say`)
    expect(evaluate([restored(`${WORKSPACE}/src/a.ts`)])).toMatchObject({ kind: 'allow' })
  })

  it('offers once alone in either mode, and an approval covers that restore alone, never one that undoes more', () => {
    const newest = (): ResolvedEffect => ({ kind: 'restore_checkpoint', checkpoint: HEAD, head: HEAD, undoes: 1 })
    expect(evaluate([newest()], {}, { strict: true })).toMatchObject({ kind: 'ask', asks: [{ subject: `restore:${HEAD}`, offeredScopes: ['once'] }] })
    expect(evaluate([newest()], { write_scope: [`restore:${HEAD}`] })).toMatchObject({ kind: 'allow', allowedBy: [`write_scope:restore:${HEAD}`] })
    expect(evaluate([restore()], { write_scope: [`restore:${CHECKPOINT}`, `restore:${CHECKPOINT}..change-older-head`] }).kind).toBe('ask')
    const outcome = evaluate([newest()])
    expect(outcome.kind === 'ask' ? outcome.asks[0]!.reason : '').toBe(`Restoring the workspace to before checkpoint ${HEAD} undoes it alone, so a person decides, whatever the folders' write grants say`)
  })

  it('names no folder a write grant covers, and no folder grant is read from its subject', () => {
    expect(isFloorSubject(`restore:${CHECKPOINT}`)).toBe(true)
    const write: ResolvedEffect = { kind: 'write_path', path: `${WORKSPACE}/a.txt`, directory: WORKSPACE }
    expect(evaluate([write], { write_scope: [`restore:${CHECKPOINT}`] }).kind).toBe('ask')
  })

  it('is refused where it would put a path back in a read-only mount, beyond the mount, in Buckle\'s state, or where the policy denies the write', () => {
    expect(evaluate([restore(), restored('/srv/data/a.txt')], {}, { mount: '/workspace', readOnly: '/srv/data' })).toMatchObject({ kind: 'deny', denial: { rule: 'write_scope' } })
    expect(evaluate([restore(), restored('/etc/hosts')], {}, { mount: '/workspace' })).toMatchObject({ kind: 'deny', denial: { rule: 'write_scope' } })
    expect(evaluate([restore(), restored(`${STATE}/grants.json`)])).toMatchObject({ kind: 'deny', denial: { rule: 'sensitive_path' } })
    expect(evaluate([restore(), restored(`${WORKSPACE}/.github/workflows/ci.yml`)], {}, { rules: [{ path: '.github/workflows', write: 'deny' }] })).toMatchObject({ kind: 'deny', denial: { rule: 'filesystem_policy' } })
  })

  it('asks the policy\'s own ask beside the floor\'s where a rule asks for that path', () => {
    const outcome = evaluate([restore(), restored(`${WORKSPACE}/drafts/a.md`)], {}, { rules: [{ path: 'drafts', write: 'ask' }] })
    expect(outcome.kind === 'ask' ? outcome.asks.map(item => item.rule).sort() : []).toEqual(['filesystem_policy', 'write_scope'])
  })

  it('is never answered by the dangerously-allow switch at either level, nor rated by the decision AI', () => {
    // Review M1 of the Slice D tests review: a subject read as a path is resolved against the working folder, so the switch
    // is also tried with the root a node started in the project's own folder has, where `restore:...` lies inside it.
    for (const root of [WORKSPACE, process.cwd()]) for (const level of ['command', 'all'] as const) {
      const allowed = withDangerouslyAllow(engine(), { level: () => level, root: () => root })
      expect(allowed.evaluate({ tool: 'history_restore', effects: [restore(), restored(`${root}/a.txt`)], grants: lookup() })).toMatchObject({ kind: 'ask', asks: [{ subject: `restore:${CHECKPOINT}..${HEAD}` }] })
    }
    const outcome = evaluate([restore()])
    const ask = outcome.kind === 'ask' ? outcome.asks[0]! : null
    expect(ask && [judgeable(ask), quickCovers('all', ask), quickCovers('asks', ask)]).toEqual([false, false, false])
  })

  it('reads to its approver as the checkpoint it goes back to and each path it puts back', () => {
    expect(summarizeEffect(restore())).toBe(`restore the workspace to before checkpoint ${CHECKPOINT}, undoing it and the 2 checkpoints after it, to ${HEAD} the newest`)
    expect(summarizeEffect(restored(`${WORKSPACE}/a.txt`))).toBe(`restore ${WORKSPACE}/a.txt`)
    // Review m4 of the Slice D rules review: a path the restore removes does not read as one it writes back (owner rulings D9, D17).
    expect(summarizeEffect(restored(`${WORKSPACE}/b.txt`, 'created'))).toBe(`remove ${WORKSPACE}/b.txt (it was created after that checkpoint)`)
    expect(summarizeEffect(restored(`${WORKSPACE}/c.txt`, 'deleted'))).toBe(`restore ${WORKSPACE}/c.txt (it was deleted after that checkpoint)`)
    expect(describeCall({ tool: 'history_restore', args: { steps: 2 }, cwd: '/workspace' })).toBe('Restore the workspace 2 checkpoints back in "/workspace"')
    expect(describeCall({ tool: 'history_restore', args: { id: CHECKPOINT }, cwd: '/workspace' })).toBe(`Restore the workspace to before checkpoint "${CHECKPOINT}" in "/workspace"`)
    expect(describeCall({ tool: 'history_list', args: { last: 5 }, cwd: '/workspace' })).toBe('List the newest 5 checkpoints of the change history in "/workspace"')
  })
})
