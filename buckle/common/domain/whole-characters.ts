/**
 * The first `length` UTF-16 units of `text`, one fewer where the last would be the first half of a surrogate pair, so a
 * cut never leaves an unpaired surrogate (a character outside the Basic Multilingual Plane, such as an emoji).
 */
export function wholeCharacters(text: string, length: number): string {
  const end = /[\uD800-\uDBFF]/.test(text.charAt(length - 1)) ? length - 1 : length
  return text.slice(0, end)
}
