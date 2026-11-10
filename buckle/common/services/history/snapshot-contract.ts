import { z } from 'zod'

/**
 * Two kinds are recorded without content, and history never restores, removes or rewrites one: each is left out of
 * every change set, listed as not restorable when it changes, and a restore that would remove a directory holding one
 * is a conflict. `excluded`: a hard-linked file under a node_modules directory below a snapshot root (pnpm links its
 * store there), or, in history, an entry whose name holds a backslash on Linux or macOS, which pathe would read as
 * another path, or ends in a dot or a space on Windows, which a program there reads as another name (isPlainName); its
 * key is its directory and its name joined as listed. `unreadable`: on Windows, a file another
 * program held open without read sharing (EBUSY), so its content could not be read. A command's checkpoint records a
 * nested repository git keeps as one commit id, reason `nested`: its files are that repository's own. Before a command,
 * a folder below one git listed as holding nothing it stored, which git's listings cannot say stood there, is recorded
 * `unreadable`, reason `unlisted`: absent then, or a folder holding no file (R2.2 of the Codex recheck). Not restorable
 * itself, it hides nothing below it, as no file stood in it. A file or link a command changed whose earlier content the
 * folder's own repository held, and no longer held when history came to copy it, is `unreadable`, reason `source-gone`
 * (Slice F3).
 */
export const entrySchema = z.object({ kind: z.enum(['file', 'directory', 'symlink', 'excluded', 'unreadable']), mode: z.number(), size: z.number().optional(), mtime: z.number().optional(), reason: z.enum(['ignored', 'size', 'special', 'limit', 'nested', 'unlisted', 'source-gone']).optional(), hash: z.string().optional(), target: z.string().optional() })
export const snapshotSchema = z.record(z.string(), entrySchema)
export type Snapshot = z.infer<typeof snapshotSchema>
export type Entry = z.infer<typeof entrySchema>
