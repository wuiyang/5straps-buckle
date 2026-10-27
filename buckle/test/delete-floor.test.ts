import { describe, expect, it } from 'vitest'
import { emptyWorkspacePolicy, type PermissionRuleId } from '@5straps/protocol'
import { summarizeEffect, type ResolvedEffect, type TreeCount } from '../common/domain/effect.js'
import { createFilesystemPolicyRule } from '../common/domain/filesystem-policy.js'
import type { GrantLookup } from '../common/domain/permission/decision.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import { createDestructivePathRule, isFloorSubject } from '../common/domain/permission/rules/destructive-path-rule.js'
import { createSensitivePathRule } from '../common/domain/permission/rules/sensitive-path-rule.js'
import { createWriteScopeRule } from '../common/domain/permission/rules/write-scope-rule.js'
import { createPathView } from '../common/domain/path-view.js'

// The file side of the destructive floor (the fs-verbs brief): every delete asks a person, whatever the folder's write
// grant says, under write_scope subjects no folder grant matches; refusals stay where a write's are.

const WORKSPACE = '/work/project'
const STATE = '/work/project/.state'

function lookup(granted: Partial<Record<PermissionRuleId, string[]>> = {}): GrantLookup {
  return { subjectsFor: rule => granted[rule] ?? [] }
}

function engine(options: { strict?: boolean; mount?: string; readOnly?: string; rules?: Array<{ path: string; read?: 'deny' | 'ask'; write?: 'deny' | 'ask' }> } = {}) {
  const mounts = options.readOnly ? [{ source: options.readOnly, target: '/data', access: 'ro' as const }] : []
  const paths = createPathView({ root: WORKSPACE, mount: options.mount ?? null, mounts })
  const policy = { ...emptyWorkspacePolicy(), filesystem: { rules: options.rules ?? [] } }
  return createPermissionEngine([
    createSensitivePathRule({ protectedRoots: [STATE] }),
    createDestructivePathRule({ paths, strict: options.strict ?? false }),
    createFilesystemPolicyRule({ root: WORKSPACE, policy }),
    createWriteScopeRule({ paths, strict: options.strict ?? false }),
  ])
}

const removed = (path: string, input: { floor?: boolean; tree?: TreeCount } = {}): ResolvedEffect => ({ kind: 'delete_path', path, directory: path.slice(0, path.lastIndexOf('/')) || '/', floor: input.floor ?? true, ...(input.tree ? { tree: input.tree } : {}) })
/** A folder moved whole: the source of an fs_move, read and removed from its place, with a count. */
const movedFolder = (path: string): ResolvedEffect => ({ ...removed(path, { tree: counted(2, 1) }), moved: true } as ResolvedEffect)
/** The landing of a folder moved whole. */
const landedFolder = (path: string): ResolvedEffect => ({ kind: 'write_path', path, directory: path.slice(0, path.lastIndexOf('/')), entry: true, folder: true })
const counted = (files: number, folders: number, more = false): TreeCount => ({ counted: true, files, folders, more })

function evaluate(effects: ResolvedEffect[], granted?: Partial<Record<PermissionRuleId, string[]>>, options?: Parameters<typeof engine>[0]) {
  return engine(options).evaluate({ tool: 'fs_delete', effects, grants: lookup(granted) })
}

describe('a delete at the destructive floor', () => {
  it('asks inside a folder whose writes are granted, naming the entry, under a subject no folder grant matches', () => {
    const outcome = evaluate([removed(`${WORKSPACE}/src/a.ts`)], { write_scope: [WORKSPACE] })
    expect(outcome).toMatchObject({ kind: 'ask', asks: [{ rule: 'write_scope', subject: `delete:${WORKSPACE}/src`, offeredScopes: ['once', 'session', 'always'] }] })
    if (outcome.kind !== 'ask') return
    expect(outcome.asks[0]!.reason).toBe(`Deleting ${WORKSPACE}/src/a.ts always asks a person, whatever the folder's write grant says`)
  })

  it('asks once for two entries of one folder, and once per folder otherwise', () => {
    const outcome = evaluate([removed(`${WORKSPACE}/a.txt`), removed(`${WORKSPACE}/b.txt`), removed(`${WORKSPACE}/sub/c.txt`)])
    expect(outcome.kind === 'ask' ? outcome.asks.map(item => item.subject) : []).toEqual([`delete:${WORKSPACE}`, `delete:${WORKSPACE}/sub`])
  })

  it('runs once its own grant is held, for that folder alone and never one beneath it', () => {
    expect(evaluate([removed(`${WORKSPACE}/a.txt`)], { write_scope: [`delete:${WORKSPACE}`] })).toMatchObject({ kind: 'allow', allowedBy: [`write_scope:delete:${WORKSPACE}`] })
    expect(evaluate([removed(`${WORKSPACE}/sub/a.txt`)], { write_scope: [`delete:${WORKSPACE}`] }).kind).toBe('ask')
  })

  it('names a folder removed whole with what it holds, and asks under its own subject', () => {
    const outcome = evaluate([removed(`${WORKSPACE}/build`, { tree: counted(12, 3) })], { write_scope: [`delete:${WORKSPACE}`] })
    expect(outcome).toMatchObject({ kind: 'ask', asks: [{ subject: `delete-tree:${WORKSPACE}/build` }] })
    if (outcome.kind !== 'ask') return
    expect(outcome.asks[0]!.reason).toContain('and everything in it (12 files and 3 folders)')
    expect(summarizeEffect(removed(`${WORKSPACE}/build`, { tree: counted(1, 1) }))).toBe(`delete ${WORKSPACE}/build and everything in it (1 file and 1 folder)`)
    expect(summarizeEffect(removed(`${WORKSPACE}/build`, { tree: counted(10_000, 0, true) }))).toContain('more than 10000 entries')
  })

  it('offers once alone in strict mode', () => {
    expect(evaluate([removed(`${WORKSPACE}/a.txt`)], {}, { strict: true })).toMatchObject({ kind: 'ask', asks: [{ offeredScopes: ['once'] }] })
  })

  it('never reads a floor subject as a folder grant for a write', () => {
    const write: ResolvedEffect = { kind: 'write_path', path: `${WORKSPACE}/a.txt`, directory: WORKSPACE }
    expect(evaluate([write], { write_scope: [`delete:${WORKSPACE}`, `delete-tree:${WORKSPACE}`] }).kind).toBe('ask')
    expect(isFloorSubject(`delete:${WORKSPACE}`)).toBe(true)
    expect(isFloorSubject(WORKSPACE)).toBe(false)
  })

  it('is judged as a write to its folder when it is a move\'s source and stands off the floor', () => {
    expect(evaluate([removed(`${WORKSPACE}/a.txt`, { floor: false })], { write_scope: [WORKSPACE] }).kind).toBe('allow')
    expect(evaluate([removed(`${WORKSPACE}/a.txt`, { floor: false })])).toMatchObject({ kind: 'ask', asks: [{ subject: WORKSPACE }] })
  })
})

describe('a delete is refused where a write is', () => {
  it('in Buckle\'s state, and for a folder holding it', () => {
    expect(evaluate([removed(`${STATE}/grants.json`)])).toMatchObject({ kind: 'deny', denial: { rule: 'sensitive_path' } })
    expect(evaluate([removed(WORKSPACE, { tree: counted(1, 1) })])).toMatchObject({ kind: 'deny' })
  })

  it('beyond the mount, in a read-only mount, and for the workspace\'s own folder or a mount\'s', () => {
    expect(evaluate([removed('/etc/passwd')], {}, { mount: '/workspace' })).toMatchObject({ kind: 'deny', denial: { rule: 'write_scope' } })
    expect(evaluate([removed('/srv/data/a.txt')], {}, { mount: '/workspace', readOnly: '/srv/data' })).toMatchObject({ kind: 'deny', denial: { rule: 'write_scope' } })
    expect(evaluate([removed('/srv/data', { tree: counted(1, 0) })], {}, { mount: '/workspace', readOnly: '/srv/data' })).toMatchObject({ kind: 'deny' })
    expect(evaluate([removed('/work', { tree: counted(1, 1) })], { write_scope: ['delete-tree:/work'] })).toMatchObject({ kind: 'deny' })
    const own = createPermissionEngine([createWriteScopeRule({ paths: createPathView({ root: WORKSPACE, mount: null }), strict: false })])
    expect(own.evaluate({ tool: 'fs_delete', effects: [removed('/work', { tree: counted(1, 1) })], grants: lookup() })).toMatchObject({ kind: 'deny', denial: { rule: 'write_scope', reason: '/work is or holds /work/project, a folder the workspace shows or a read-only mount, which no tool removes or moves' } })
  })

  it('where the workspace policy denies a write on the entry or on a path beneath the folder', () => {
    const rules = [{ path: 'secrets', write: 'deny' as const }, { path: 'docs/draft.md', write: 'ask' as const }]
    expect(evaluate([removed(`${WORKSPACE}/secrets/a.txt`)], {}, { rules })).toMatchObject({ kind: 'deny', denial: { rule: 'filesystem_policy' } })
    expect(evaluate([removed(`${WORKSPACE}/secrets`, { tree: counted(1, 0) })], {}, { rules })).toMatchObject({ kind: 'deny' })
    const docs = evaluate([removed(`${WORKSPACE}/docs`, { tree: counted(1, 0) })], {}, { rules })
    expect(docs.kind === 'ask' ? docs.asks.map(item => item.rule).sort() : []).toEqual(['filesystem_policy', 'write_scope'])
  })
})

describe('a folder moved whole meets the workspace rules beneath it', () => {
  const rules = [{ path: '.github/workflows', write: 'deny' as const }, { path: 'config/secret.json', read: 'deny' as const }, { path: 'notes/private.md', read: 'ask' as const }, { path: 'drafts/a.md', write: 'ask' as const }]

  it('denies a landing that would put files where the rules deny a write, and one that would ask', () => {
    expect(evaluate([landedFolder(`${WORKSPACE}/.github`)], {}, { rules })).toMatchObject({ kind: 'deny', denial: { rule: 'filesystem_policy', subject: `write:${WORKSPACE}/.github` } })
    const asked = evaluate([landedFolder(`${WORKSPACE}/drafts`)], { write_scope: [WORKSPACE] }, { rules })
    expect(asked).toMatchObject({ kind: 'ask', asks: [{ rule: 'filesystem_policy', subject: `write:${WORKSPACE}/drafts`, offeredScopes: ['once'] }] })
    expect(evaluate([landedFolder(`${WORKSPACE}/elsewhere`)], { write_scope: [WORKSPACE] }, { rules }).kind).toBe('allow')
  })

  it('does not read a file landing as a folder', () => {
    const file: ResolvedEffect = { kind: 'write_path', path: `${WORKSPACE}/.github`, directory: WORKSPACE, entry: true }
    expect(evaluate([file], { write_scope: [WORKSPACE] }, { rules }).kind).toBe('allow')
  })

  it('denies a source that holds a file the rules deny reading, and asks where one asks', () => {
    expect(evaluate([movedFolder(`${WORKSPACE}/config`)], { write_scope: [`delete-tree:${WORKSPACE}/config`] }, { rules })).toMatchObject({ kind: 'deny', denial: { rule: 'filesystem_policy', subject: `read:${WORKSPACE}/config` } })
    const asked = evaluate([movedFolder(`${WORKSPACE}/notes`)], {}, { rules })
    expect(asked.kind === 'ask' ? asked.asks.map(item => `${item.rule}:${item.subject}`).sort() : []).toEqual([`filesystem_policy:read:${WORKSPACE}/notes`, `write_scope:delete-tree:${WORKSPACE}/notes`])
  })

  it('leaves a folder removed, not moved, to the write rules alone: deleting a file reads nothing', () => {
    expect(evaluate([removed(`${WORKSPACE}/config`, { tree: counted(2, 1) })], {}, { rules }).kind).toBe('ask')
    expect(evaluate([removed(`${WORKSPACE}/config`, { tree: counted(2, 1) })], {}, { rules })).not.toMatchObject({ kind: 'deny' })
  })

  it('is not turned by the dangerously-allow switch, which answers an ask and never a deny', () => {
    const allowed = withDangerouslyAllow(engine({ rules }), { level: () => 'all', root: () => WORKSPACE })
    expect(allowed.evaluate({ tool: 'fs_move', effects: [landedFolder(`${WORKSPACE}/.github`)], grants: lookup() }).kind).toBe('deny')
    expect(allowed.evaluate({ tool: 'fs_move', effects: [movedFolder(`${WORKSPACE}/config`)], grants: lookup() }).kind).toBe('deny')
  })
})

describe('the dangerously-allow switch', () => {
  it('answers a delete inside the workspace and leaves one outside it to a person', () => {
    const allowed = withDangerouslyAllow(engine(), { level: () => 'command', root: () => WORKSPACE })
    expect(allowed.evaluate({ tool: 'fs_delete', effects: [removed(`${WORKSPACE}/a.txt`)], grants: lookup() })).toMatchObject({ kind: 'allow', allowedBy: [`dangerously_allow:command:write_scope:delete:${WORKSPACE}`] })
    expect(allowed.evaluate({ tool: 'fs_delete', effects: [removed('/tmp/elsewhere/a.txt')], grants: lookup() }).kind).toBe('ask')
  })
})
