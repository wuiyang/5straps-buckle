/** The three tools that read a secret reference (docs/secrets.md), each told where in its arguments one goes. */
export type ReferenceHintTool = 'shell_exec' | 'browser_command' | 'web_fetch'

const WHERE: Readonly<Record<ReferenceHintTool, { place: string; example: string }>> = {
  shell_exec: { place: 'in an argument', example: '{{file:.env.local:API_TOKEN}}' },
  browser_command: { place: 'as the text of fill or type', example: '{{file:.env.local:LOGIN_PASSWORD}}' },
  web_fetch: { place: 'in a header value', example: '{{file:.env.local:API_TOKEN}}' },
}

/**
 * The sentence a tool's description ends with, so the agent writes a reference in place of a value it would otherwise
 * ask for. It names the grammar and the three places references are read, and what the agent sees in the value's place.
 */
export function referenceHint(tool: ReferenceHintTool): string {
  const { place, example } = WHERE[tool]
  return `To use a value from a dotenv file without seeing it, write {{file:<path>:NAME}} ${place}, such as ${example}, and Buckle puts the value in as the call runs and shows you [secret:NAME] in its place; references are read in shell arguments, browser fill text, and web_fetch headers only.`
}
