import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { isInside } from '../common/domain/paths.js'
import { resolveEffects } from '../common/services/invocation/resolve-effects.js'

import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createNetworkEgressRule } from '../common/domain/permission/rules/network-egress-rule.js'
import { createReadScopeRule } from '../common/domain/permission/rules/read-scope-rule.js'
import { createWriteScopeRule } from '../common/domain/permission/rules/write-scope-rule.js'
import { browserEffects } from '../common/services/packs/browser/effects.js'
describe('isInside', () => {
  it('accepts the directory itself and its descendants', () => {
    expect(isInside('/work', '/work')).toBe(true)
    expect(isInside('/work', '/work/src/app.ts')).toBe(true)
  })

  it('rejects escapes and sibling prefixes', () => {
    expect(isInside('/work', '/etc/passwd')).toBe(false)
    expect(isInside('/work', '/work/../etc')).toBe(false)
    expect(isInside('/work', '/work-other/file')).toBe(false)
  })
})

describe('resolveEffects', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'buckle-effects-'))
    await mkdir(join(root, 'workspace'), { recursive: true })
    await mkdir(join(root, 'outside'), { recursive: true })
    await writeFile(join(root, 'outside', 'secret.txt'), 'secret')
    await symlink(join(root, 'outside'), join(root, 'workspace', 'escape'))
    await symlink(join(root, 'outside', 'secret.txt'), join(root, 'workspace', 'link.txt'))
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('resolves a relative path against the workspace', async () => {
    const [effect] = await resolveEffects({
      effects: [{ kind: 'read_path', path: 'notes.md' }],
      paths: createPathView({ root: join(root, 'workspace'), mount: null }),
    })
    expect(effect).toMatchObject({ kind: 'read_path', path: join(root, 'workspace', 'notes.md') })
  })

  it('follows a symlinked file to its real target, so the jail sees where it lands', async () => {
    const [effect] = await resolveEffects({
      effects: [{ kind: 'read_path', path: 'link.txt' }],
      paths: createPathView({ root: join(root, 'workspace'), mount: null }),
    })
    expect(effect?.kind === 'read_path' && effect.path).toBe(join(root, 'outside', 'secret.txt'))
  })

  it('follows a symlinked directory, so a new file cannot be smuggled outside', async () => {
    const [effect] = await resolveEffects({
      effects: [{ kind: 'write_path', path: 'escape/planted.txt' }],
      paths: createPathView({ root: join(root, 'workspace'), mount: null }),
    })
    expect(effect?.kind === 'write_path' && effect.path).toBe(join(root, 'outside', 'planted.txt'))
    expect(effect?.kind === 'write_path' && effect.directory).toBe(join(root, 'outside'))
  })

  it('rejects traversal above the workspace', async () => {
    const [effect] = await resolveEffects({
      effects: [{ kind: 'read_path', path: '../outside/secret.txt' }],
      paths: createPathView({ root: join(root, 'workspace'), mount: null }),
    })
    expect(isInside(join(root, 'workspace'), effect?.kind === 'read_path' ? effect.path : '')).toBe(false)
  })

  it('parses network effects into a URL', async () => {
    const [effect] = await resolveEffects({
      effects: [{ kind: 'network', url: 'https://example.com/a?b=1' }],
      paths: createPathView({ root, mount: null }),
    })
    expect(effect?.kind === 'network' && effect.url.hostname).toBe('example.com')
  })

  it('rejects a malformed URL at resolution time', async () => {
    await expect(resolveEffects({ effects: [{ kind: 'network', url: 'not a url' }], paths: createPathView({ root, mount: null }) }))
      .rejects.toThrow(/Not a valid URL/)
  })
})

describe('a path leaving a mounted workspace', () => {
  let root: string
  let mounted: ReturnType<typeof createPathView>

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'buckle-mount-'))
    await mkdir(join(root, 'workspace'), { recursive: true })
    await mkdir(join(root, 'outside'), { recursive: true })
    await writeFile(join(root, 'outside', 'secret.txt'), 'secret')
    await symlink(join(root, 'outside'), join(root, 'workspace', 'escape'))
    await symlink(join(root, 'outside', 'secret.txt'), join(root, 'workspace', 'link.txt'))
    mounted = createPathView({ root: join(root, 'workspace'), mount: '/workspace' })
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function scopeEngine() {
    return createPermissionEngine([
      createReadScopeRule({ paths: mounted }),
      createWriteScopeRule({ paths: mounted, strict: false }),
    ])
  }

  it('is refused when the agent names a real host path, before any rule runs', async () => {
    await expect(resolveEffects({ effects: [{ kind: 'read_path', path: '/etc/hosts' }], paths: mounted }))
      .rejects.toThrow('/etc/hosts is outside the mounted workspace')
  })

  it('is refused when a symlink inside the workspace lands outside it', async () => {
    const effects = await resolveEffects({ effects: [{ kind: 'read_path', path: 'link.txt' }], paths: mounted })
    const outcome = scopeEngine().evaluate({ tool: 'fs_read', effects, grants: { subjectsFor: () => [] } })
    expect(outcome.kind).toBe('deny')
  })

  it('names the mount when it refuses, and hides the host path the symlink landed on', async () => {
    const effects = await resolveEffects({ effects: [{ kind: 'read_path', path: 'link.txt' }], paths: mounted })
    const outcome = scopeEngine().evaluate({ tool: 'fs_read', effects, grants: { subjectsFor: () => [] } })
    if (outcome.kind !== 'deny') throw new Error('expected a refusal')
    expect(outcome.denial.reason).toContain('/workspace')
    expect(outcome.denial.reason).not.toContain(root)
  })

  it('cannot be unlocked by a standing grant, since a denial is not a question', async () => {
    const effects = await resolveEffects({ effects: [{ kind: 'write_path', path: 'escape/planted.txt' }], paths: mounted })
    const outcome = scopeEngine().evaluate({
      tool: 'fs_write',
      effects,
      grants: { subjectsFor: () => [join(root, 'outside')] },
    })
    expect(outcome.kind).toBe('deny')
  })

  it('still asks, rather than refusing, for a write inside the workspace', async () => {
    const effects = await resolveEffects({ effects: [{ kind: 'write_path', path: 'notes.md' }], paths: mounted })
    expect(scopeEngine().evaluate({ tool: 'fs_write', effects, grants: { subjectsFor: () => [] } }).kind).toBe('ask')
  })
})

describe('a browser command reaching for a local file', () => {
  it('is refused by the egress rule, because navigation is declared as a network effect', async () => {
    const declared = browserEffects('open', ['file:///etc/shadow'])
    const resolved = await resolveEffects({ effects: declared, paths: createPathView({ root: process.cwd(), mount: null }) })
    const engine = createPermissionEngine([createNetworkEgressRule()])

    const outcome = engine.evaluate({
      tool: 'browser_command',
      effects: resolved,
      grants: { subjectsFor: () => [] },
    })

    expect(outcome.kind).toBe('deny')
  })

  it('cannot be unlocked by granting the subject, since a denial is not a question', async () => {
    const resolved = await resolveEffects({
      effects: browserEffects('open', ['file:///etc/shadow']),
      paths: createPathView({ root: process.cwd(), mount: null }),
    })
    const engine = createPermissionEngine([createNetworkEgressRule()])

    const outcome = engine.evaluate({
      tool: 'browser_command',
      effects: resolved,
      grants: { subjectsFor: () => ['file:', '/etc/shadow', 'etc'] },
    })

    expect(outcome.kind).toBe('deny')
  })

  it('lets an ordinary public page through untouched', async () => {
    const resolved = await resolveEffects({
      effects: browserEffects('open', ['https://example.com']),
      paths: createPathView({ root: process.cwd(), mount: null }),
    })
    const engine = createPermissionEngine([createNetworkEgressRule()])

    expect(engine.evaluate({
      tool: 'browser_command',
      effects: resolved,
      grants: { subjectsFor: () => [] },
    }).kind).toBe('allow')
  })
})
