import type { ConnectionOwner } from '@5straps/runtime/sqlite'

export interface Note {
  id: number
  text: string
  actor: string
}

export interface NoteRepository {
  add(input: { text: string; actor: string }): Promise<Note>
  list(): Promise<Note[]>
}

const SCHEMA = 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, actor TEXT NOT NULL)'

export async function createNoteRepository(connection: ConnectionOwner): Promise<NoteRepository> {
  await connection.run(db => db.exec(SCHEMA))
  return {
    add: ({ text, actor }) => connection.transaction(async (tx) => {
      const { rows } = await tx.sql`INSERT INTO notes (text, actor) VALUES (${text}, ${actor}) RETURNING id, text, actor`
      return toNote(rows?.[0])
    }),
    list: () => connection.run(async (db) => {
      const { rows } = await db.sql`SELECT id, text, actor FROM notes ORDER BY id`
      return (rows ?? []).map(toNote)
    }),
  }
}

function toNote(row: Record<string, unknown> | undefined): Note {
  if (!row) throw new Error('notes row missing')
  return { id: Number(row.id), text: String(row.text), actor: String(row.actor) }
}
