import { expect } from 'vitest'

// Handle kinds a leaked child, socket, pipe or file handle would leave behind in the test process.
const WATCHED = new Set(['ProcessWrap', 'PipeWrap', 'TCPWrap', 'TCPSocketWrap', 'FSReqCallback', 'FileHandle', 'SignalWrap'])

export function resourceSnapshot(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const kind of process.getActiveResourcesInfo()) if (WATCHED.has(kind)) counts[kind] = (counts[kind] ?? 0) + 1
  return counts
}

export async function expectNoLeakedResources(before: Record<string, number>): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 200))
  const after = resourceSnapshot()
  const grown = Object.entries(after).filter(([kind, count]) => count > (before[kind] ?? 0))
  expect(Object.fromEntries(grown)).toEqual({})
}
