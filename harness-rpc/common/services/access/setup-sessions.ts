import { randomBytes } from 'node:crypto'
import { KeyIdSchema, SETUP_SESSION_IDLE_MS, SetupSessionIdSchema } from '@5straps/protocol/signed-request'
import { z } from 'zod'
import { createJsonFileStore } from '../../adapters/json-file-store.js'

const CLOSED_KEPT_MS = 24 * 60 * 60_000
/** Sessions one key may hold open in one workspace; the one idle longest closes first. */
const OPEN_PER_KEY = 8

const sessionSchema = z.object({
  id: SetupSessionIdSchema,
  keyId: KeyIdSchema,
  workspaceId: z.string(),
  openedAt: z.number().int(),
  lastActivityAt: z.number().int(),
  closedAt: z.number().int().nullable(),
  closedBecause: z.enum(['completed', 'revoked', 'idle', 'replaced']).nullable(),
}).strict()
const fileSchema = z.object({ version: z.literal(1), sessions: z.array(sessionSchema) })
type Session = z.infer<typeof sessionSchema>

export interface SetupSessionView {
  id: string
  workspaceId: string
  keyId: string
  openedAt: string
  lastActivityAt: string
  /** When it closes if no signed request refreshes it first. */
  idleExpiresAt: string
}

/**
 * Setup sessions (approval-proofs.md, Setup activity; owner ruling H4 of 2026-09-28): a person's key
 * opens one with a signed request, and each later setup change carries it with a fresh signed request.
 * Buckle owns lastActivityAt: only a verified, unreplayed request from the session's own key and
 * workspace refreshes it; reads, invalid or replayed requests never reach here. Ten idle minutes close
 * it, with no absolute limit. Every change runs under the file's lock and reads the clock there, so an
 * expired session is never revived and concurrent refreshes only move forward. Completion, logout and
 * the key's revocation close it at once.
 */
export interface SetupSessions {
  open(input: { keyId: string; workspaceId: string }): Promise<SetupSessionView>
  /** A fresh signed request's activity: the session, refreshed, or null when it is not this key's and workspace's open session (an idle one closes here). */
  touch(input: { id: string; keyId: string; workspaceId: string }): Promise<SetupSessionView | null>
  /** Explicit completion or logout: false when it was not this key's open session. */
  close(input: { id: string; keyId: string; workspaceId: string }): Promise<boolean>
  /** A revoked key's sessions close with it. */
  closeForKey(keyId: string): Promise<number>
  /** The sessions still open, for the owner. */
  list(): SetupSessionView[]
}

export function createSetupSessions(input: { filePath: string; now?: () => number; lockDeadlineMs?: number }): SetupSessions {
  const now = input.now ?? Date.now
  const store = createJsonFileStore({ filePath: input.filePath, schema: fileSchema, fallback: { version: 1 as const, sessions: [] }, lockDeadlineMs: input.lockDeadlineMs })

  /** Every change first closes what went idle and drops what closed a day ago. */
  function update<R>(change: (sessions: Session[], at: number) => R): Promise<R> {
    return store.update((state) => {
      const at = now()
      for (const session of state.sessions) if (session.closedAt === null && at - session.lastActivityAt >= SETUP_SESSION_IDLE_MS) close(session, at, 'idle')
      state.sessions = state.sessions.filter(session => session.closedAt === null || at - session.closedAt < CLOSED_KEPT_MS)
      return change(state.sessions, at)
    })
  }

  return {
    open: ({ keyId, workspaceId }) => update((sessions, at) => {
      const mine = sessions.filter(session => session.closedAt === null && session.keyId === keyId && session.workspaceId === workspaceId).sort((left, right) => left.lastActivityAt - right.lastActivityAt)
      for (const oldest of mine.slice(0, Math.max(0, mine.length - OPEN_PER_KEY + 1))) close(oldest, at, 'replaced')
      const session: Session = { id: randomBytes(16).toString('base64url'), keyId, workspaceId, openedAt: at, lastActivityAt: at, closedAt: null, closedBecause: null }
      sessions.push(session)
      return view(session)
    }),
    touch: ({ id, keyId, workspaceId }) => update((sessions, at) => {
      const session = sessions.find(item => item.id === id && item.keyId === keyId && item.workspaceId === workspaceId && item.closedAt === null)
      if (!session) return null
      session.lastActivityAt = Math.max(session.lastActivityAt, at)
      return view(session)
    }),
    close: ({ id, keyId, workspaceId }) => update((sessions, at) => {
      const session = sessions.find(item => item.id === id && item.keyId === keyId && item.workspaceId === workspaceId && item.closedAt === null)
      if (!session) return false
      close(session, at, 'completed')
      return true
    }),
    closeForKey: keyId => update((sessions, at) => {
      const open = sessions.filter(session => session.keyId === keyId && session.closedAt === null)
      for (const session of open) close(session, at, 'revoked')
      return open.length
    }),
    list: () => {
      const at = now()
      return store.read().sessions.filter(session => session.closedAt === null && at - session.lastActivityAt < SETUP_SESSION_IDLE_MS).map(view)
    },
  }
}

function close(session: Session, at: number, because: NonNullable<Session['closedBecause']>): void {
  session.closedAt = at
  session.closedBecause = because
}

function view(session: Session): SetupSessionView {
  return {
    id: session.id, workspaceId: session.workspaceId, keyId: session.keyId,
    openedAt: new Date(session.openedAt).toISOString(), lastActivityAt: new Date(session.lastActivityAt).toISOString(),
    idleExpiresAt: new Date(session.lastActivityAt + SETUP_SESSION_IDLE_MS).toISOString(),
  }
}
