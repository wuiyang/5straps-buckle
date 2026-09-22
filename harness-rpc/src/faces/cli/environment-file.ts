/**
 * Sets one variable in an environment file's text, in place where it is already there: the line
 * that sets it is replaced, otherwise the commented placeholder `buckle init` wrote is filled in,
 * otherwise it is appended. Keeping the file's shape is what lets a credential be written back
 * beside the ones already in it without an operator's comments or ordering being lost.
 *
 * The replacement goes through a function, so a `$&` in a credential is a literal.
 */
export function setEnvironmentVariable(input: { text: string; name: string; value: string }): string {
  const assignment = `${input.name}=${input.value}`
  const set = new RegExp(`^${input.name}=.*$`, 'm')
  if (set.test(input.text)) return input.text.replace(set, () => assignment)

  const placeholder = new RegExp(`^#\\s*${input.name}=.*$`, 'm')
  if (placeholder.test(input.text)) return input.text.replace(placeholder, () => assignment)

  return `${input.text.endsWith('\n') ? input.text : `${input.text}\n`}${assignment}\n`
}
