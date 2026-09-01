import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isInside } from '../src/domain/paths.js'
import { resolveEffects } from '../src/services/resolve-effects.js'

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
      cwd: join(root, 'workspace'),
    })
    expect(effect).toMatchObject({ kind: 'read_path', path: join(root, 'workspace', 'notes.md') })
  })

  it('follows a symlinked file to its real target, so the jail sees where it lands', async () => {
    const [effect] = await resolveEffects({
      effects: [{ kind: 'read_path', path: 'link.txt' }],
      cwd: join(root, 'workspace'),
    })
    expect(effect?.kind === 'read_path' && effect.path).toBe(join(root, 'outside', 'secret.txt'))
  })

  it('follows a symlinked directory, so a new file cannot be smuggled outside', async () => {
    const [effect] = await resolveEffects({
      effects: [{ kind: 'write_path', path: 'escape/planted.txt' }],
      cwd: join(root, 'workspace'),
    })
    expect(effect?.kind === 'write_path' && effect.path).toBe(join(root, 'outside', 'planted.txt'))
    expect(effect?.kind === 'write_path' && effect.directory).toBe(join(root, 'outside'))
  })

  it('rejects traversal above the workspace', async () => {
    const [effect] = await resolveEffects({
      effects: [{ kind: 'read_path', path: '../outside/secret.txt' }],
      cwd: join(root, 'workspace'),
    })
    expect(isInside(join(root, 'workspace'), effect?.kind === 'read_path' ? effect.path : '')).toBe(false)
  })

  it('parses network effects into a URL', async () => {
    const [effect] = await resolveEffects({
      effects: [{ kind: 'network', url: 'https://example.com/a?b=1' }],
      cwd: root,
    })
    expect(effect?.kind === 'network' && effect.url.hostname).toBe('example.com')
  })

  it('rejects a malformed URL at resolution time', async () => {
    await expect(resolveEffects({ effects: [{ kind: 'network', url: 'not a url' }], cwd: root }))
      .rejects.toThrow(/Not a valid URL/)
  })
})
