export const RESULT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  fs_read: '{ path, encoding, hash, content: string, size, firstLine?, lineCount?, totalLines?, truncated? }',
  fs_read_batch: '{ files: Array<{ path, encoding, hash, content: string, size, truncated? }> }',
  fs_write: '{ path, size, hash }',
  fs_write_batch: '{ files: Array<{ path, size, hash }> }',
  fs_patch: '{ path, replacements: number[], size }',
  fs_apply_patch: '{ files: Array<{ path, change: "modified" | "created" | "deleted", size? }> }',
  fs_move: '{ from, to, replaced: boolean, copied?, leftOver? }',
  fs_delete: '{ removed: number, results: Array<{ path, removed: boolean, missing?, refused?, code?, notAttempted? }> }',
  fs_list: '{ path, entries: Array<{ path (inside the listed path), name, type: "file" | "directory" | "symlink", size, modifiedAt }>, truncated }',
  fs_find_names: '{ path, matches: string[], truncated }',
  fs_search_content: '{ matches: Array<{ path, line, text, ranges }>, truncated, excludedFiles, skipped?: Array<{ path, reason }>, skippedMore?: number }',
}
