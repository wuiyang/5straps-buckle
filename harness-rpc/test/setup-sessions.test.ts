import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateSigningKey, SETUP_SESSION_IDLE_MS } from '@5straps/protocol/signed-request'
import { afterEach, describe, expect, it } from 'vitest'
import { createSetupSessions } from '../common/services/access/setup-sessions.js'

// B24, approval-proofs.md (Setup activity): ten idle minutes close a setup session, with no absolute
// limit; only a fresh signed request of its own key refreshes it; expiry and refresh are serialized,
// so an expired session is never revived; completion and revocation close it at once.

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const owner = generateSigningKey().keyId
const other = generateSigningKey().keyId
const MINUTE = 60_000

function sessions() {
  const root = mkdtempSync(join(tmpdir(), 'buckle-setup-sessions-'))
  roots.push(root)
  const clock = { now: 1_800_000_000_000 }
  return { clock, store: createSetupSessions({ filePath: join(root, 'setup-sessions.json'), now: () => clock.now }) }
}

describe('a setup session', () => {
  it('stays open through twenty minutes of activity every five, since only inactivity closes it', async () => {
    const { clock, store } = sessions()
    const opened = await store.open({ keyId: owner, workspaceId: 'default' })
    for (let minute = 5; minute <= 25; minute += 5) {
      clock.now += 5 * MINUTE
      expect(await store.touch({ id: opened.id, keyId: owner, workspaceId: 'default' }), `minute ${minute}`).toMatchObject({ lastActivityAt: new Date(clock.now).toISOString() })
    }
    expect(store.list().map(session => session.id)).toEqual([opened.id])
  })

  it('closes after ten idle minutes, and a later request does not revive it', async () => {
    const { clock, store } = sessions()
    const opened = await store.open({ keyId: owner, workspaceId: 'default' })
    clock.now += SETUP_SESSION_IDLE_MS - 1
    expect(await store.touch({ id: opened.id, keyId: owner, workspaceId: 'default' })).not.toBeNull()
    clock.now += SETUP_SESSION_IDLE_MS
    expect(await store.touch({ id: opened.id, keyId: owner, workspaceId: 'default' })).toBeNull()
    // Back to a moment that would have been inside the window: the session stays closed.
    clock.now -= SETUP_SESSION_IDLE_MS
    expect(await store.touch({ id: opened.id, keyId: owner, workspaceId: 'default' })).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('settles a refresh and the expiry racing at the idle limit one way, in lock order', async () => {
    const { clock, store } = sessions()
    const opened = await store.open({ keyId: owner, workspaceId: 'default' })
    clock.now += SETUP_SESSION_IDLE_MS
    const results = await Promise.all([
      store.touch({ id: opened.id, keyId: owner, workspaceId: 'default' }),
      store.touch({ id: opened.id, keyId: owner, workspaceId: 'default' }),
      store.touch({ id: opened.id, keyId: owner, workspaceId: 'default' }),
    ])
    expect(results).toEqual([null, null, null])
    const second = await store.open({ keyId: owner, workspaceId: 'default' })
    clock.now += SETUP_SESSION_IDLE_MS - 1
    const racing = await Promise.all([1, 2, 3].map(() => store.touch({ id: second.id, keyId: owner, workspaceId: 'default' })))
    expect(racing.every(session => session !== null)).toBe(true)
    // Concurrent refreshes only move forward.
    expect(new Set(racing.map(session => session!.lastActivityAt)).size).toBe(1)
  })

  it('answers only its own key and workspace: another key or workspace naming it neither uses nor refreshes it', async () => {
    const { clock, store } = sessions()
    const opened = await store.open({ keyId: owner, workspaceId: 'default' })
    clock.now += 5 * MINUTE
    expect(await store.touch({ id: opened.id, keyId: other, workspaceId: 'default' })).toBeNull()
    expect(await store.touch({ id: opened.id, keyId: owner, workspaceId: 'child' })).toBeNull()
    expect(store.list()[0]!.lastActivityAt).toBe(opened.lastActivityAt)
    expect(await store.close({ id: opened.id, keyId: other, workspaceId: 'default' })).toBe(false)
  })

  it('closes at once on completion, and every session of a key when the key is revoked', async () => {
    const { store } = sessions()
    const first = await store.open({ keyId: owner, workspaceId: 'default' })
    const second = await store.open({ keyId: owner, workspaceId: 'child' })
    const others = await store.open({ keyId: other, workspaceId: 'default' })
    expect(await store.close({ id: first.id, keyId: owner, workspaceId: 'default' })).toBe(true)
    expect(await store.close({ id: first.id, keyId: owner, workspaceId: 'default' })).toBe(false)
    expect(await store.touch({ id: first.id, keyId: owner, workspaceId: 'default' })).toBeNull()
    expect(await store.closeForKey(owner)).toBe(1)
    expect(await store.touch({ id: second.id, keyId: owner, workspaceId: 'child' })).toBeNull()
    expect(store.list().map(session => session.id)).toEqual([others.id])
  })

  it('keeps at most eight open per key and workspace, closing the one idle longest', async () => {
    const { clock, store } = sessions()
    const opened = []
    for (let index = 0; index < 9; index++) {
      clock.now += 1_000
      opened.push(await store.open({ keyId: owner, workspaceId: 'default' }))
    }
    expect(store.list()).toHaveLength(8)
    expect(await store.touch({ id: opened[0]!.id, keyId: owner, workspaceId: 'default' })).toBeNull()
  })
})
