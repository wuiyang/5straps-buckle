import type { CliRequest, PendingInteraction } from '@5straps/runtime'
import type { ConnectionOwner } from '@5straps/runtime/sqlite'

export interface PendingApproval {
  id: string
  summary: string
  correlationId: string
  status: 'pending'
}

// The durable owner queue: a request nobody could answer waits here. Nothing in this fixture approves.
export interface ApprovalQueue {
  persist(request: CliRequest): Promise<PendingInteraction>
  list(): Promise<PendingApproval[]>
}

const SCHEMA = "CREATE TABLE IF NOT EXISTS pending_approvals (id TEXT PRIMARY KEY, summary TEXT NOT NULL, correlation_id TEXT NOT NULL, status TEXT NOT NULL CHECK (status = 'pending'))"

export async function createApprovalQueue(connection: ConnectionOwner): Promise<ApprovalQueue> {
  await connection.run(db => db.exec(SCHEMA))
  return {
    async persist(request) {
      // Idempotent on the request id, so a retried request never queues twice.
      await connection.run(db => db.sql`INSERT OR IGNORE INTO pending_approvals (id, summary, correlation_id, status) VALUES (${request.id}, ${request.action.summary}, ${request.correlationId}, 'pending')`)
      return { id: request.id, instructions: `Pending owner approval ${request.id}; review it with: cli approvals list` }
    },
    list: () => connection.run(async (db) => {
      const { rows } = await db.sql`SELECT id, summary, correlation_id, status FROM pending_approvals ORDER BY rowid`
      return (rows ?? []).map(row => ({ id: String(row.id), summary: String(row.summary), correlationId: String(row.correlation_id), status: 'pending' as const }))
    }),
  }
}
