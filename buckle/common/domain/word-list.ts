/**
 * Items as a sentence names them, with the Oxford comma the pages use: `A`, `A and B`, `A, B, and C`. Empty for none.
 */
export function wordList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(' and ')
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}
