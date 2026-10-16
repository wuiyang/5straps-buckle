import { createInterface } from 'node:readline/promises'

/** One question at this process's terminal, on stderr so stdout stays the answer, closed once answered. */
export async function askAtTerminal(question: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stderr })
  try { return await readline.question(question) } finally { readline.close() }
}
