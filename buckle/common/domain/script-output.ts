/**
 * How code mode cuts what a script returns (owner decision D82): output or a value past its cap keeps its start and
 * its end, half the cap each, around a marker that counts what was left out, so the agent sees both how the script
 * began and how it ended.
 */
export function omitted(count: number): string {
  return `[... ${count} characters omitted ...]`
}

/** Text past `limit` characters, cut in the middle. */
export function keepEndsOfText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  const half = Math.floor(limit / 2)
  return { text: `${text.slice(0, half)}\n${omitted(text.length - 2 * half)}\n${text.slice(text.length - half)}`, truncated: true }
}

/** Lines of output, read as joined one per line, cut in the middle when the joined text passes `limit`. */
export function keepEndsOfLines<T extends { text: string }>(items: readonly T[], limit: number, marker: (text: string) => T): { items: T[]; truncated: boolean } {
  const total = items.reduce((sum, item) => sum + item.text.length + 1, 0) - (items.length > 0 ? 1 : 0)
  if (total <= limit) return { items: [...items], truncated: false }
  const half = Math.floor(limit / 2)
  const head: T[] = []
  let left = half
  for (const item of items) {
    if (left <= 0) break
    head.push(item.text.length <= left ? item : { ...item, text: item.text.slice(0, left) })
    left -= item.text.length + 1
  }
  const tail: T[] = []
  left = half
  for (let index = items.length - 1; index >= 0 && left > 0; index--) {
    const item = items[index]!
    tail.unshift(item.text.length <= left ? item : { ...item, text: item.text.slice(item.text.length - left) })
    left -= item.text.length + 1
  }
  const kept = [...head, ...tail].reduce((sum, item) => sum + item.text.length, 0)
  return { items: [...head, marker(omitted(Math.max(0, total - kept))), ...tail], truncated: true }
}
