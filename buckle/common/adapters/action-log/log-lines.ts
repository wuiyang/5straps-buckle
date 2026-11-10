import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/** Each whole line of the log from `offset` on, parsed. A torn line stays in the file, and readers skip it, as here. */
export async function* entriesFrom(filePath: string, offset: number): AsyncGenerator<unknown> {
  const stream = createReadStream(filePath, { start: offset })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const value = parsedLine(line)
      if (value !== undefined) yield value
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

function parsedLine(line: string): unknown {
  try { return JSON.parse(line) as unknown } catch { return undefined }
}

export function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const found: unknown = Reflect.get(value, field)
  return typeof found === 'string' ? found : undefined
}
