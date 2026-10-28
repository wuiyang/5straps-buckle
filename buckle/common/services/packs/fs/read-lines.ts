/** What fs_read answers of a file's text: the lines asked for, with the counts that let a caller page on. */
export interface LinePage {
  content: string
  firstLine: number
  lineCount: number
  totalLines: number
  truncated: boolean
}

/**
 * The lines of `text` from the 1-based `offset` for at most `limit`. A line is text ended by a newline or by the end of
 * the file, so a final newline ends the last line and starts none: `hello world\n` is one line, and an empty file has
 * none. The content is the file's own text, newlines between the lines it holds, and a final one only where the page
 * reaches the end of the file.
 */
export function pageLines(text: string, paging: { offset?: number | undefined; limit?: number | undefined }): LinePage {
  const pieces = text.split('\n')
  const totalLines = text === '' || text.endsWith('\n') ? pieces.length - 1 : pieces.length
  const start = (paging.offset ?? 1) - 1
  const end = paging.limit === undefined ? pieces.length : start + paging.limit
  return {
    content: pieces.slice(start, end).join('\n'),
    firstLine: start + 1,
    lineCount: Math.max(0, Math.min(end, totalLines) - start),
    totalLines,
    truncated: end < totalLines || start > 0,
  }
}
