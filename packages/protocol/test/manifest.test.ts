import { describe, expect, it } from 'vitest'
import { HarnessManifestSchema, PROTOCOL_VERSION } from '../src/index.js'

// The fs-verbs brief, slice B: the manifest's limits name what runs a content search in `searcher`, an additive and
// optional field, so a reader written before it, Rings among them, ignores it (protocol version 2026-08-28).

const OLDER_NODE = {
  protocolVersion: PROTOCOL_VERSION, serverId: 'node-1', name: 'node', version: '0.1.7',
  platform: { os: 'linux', arch: 'x64', hostname: 'host' }, sandbox: { mode: 'none', acknowledgedUnsandboxed: true },
  workspaceRoots: ['/workspace'], tools: [], skills: [], packs: [],
  limits: { maxRequestBytes: 1_048_576, defaultTimeoutMs: 30_000, maxTimeoutMs: 300_000 },
  generatedAt: '2026-10-28T00:00:00.000Z',
}

describe('the manifest\'s searcher', () => {
  it('is absent from an older node\'s manifest, which still validates', () => {
    expect(HarnessManifestSchema.parse(OLDER_NODE).limits.searcher).toBeUndefined()
  })

  it.each(['rg', 'builtin'] as const)('names %s', (searcher) => {
    expect(HarnessManifestSchema.parse({ ...OLDER_NODE, limits: { ...OLDER_NODE.limits, searcher } }).limits.searcher).toBe(searcher)
  })

  it('refuses any other searcher', () => {
    expect(HarnessManifestSchema.safeParse({ ...OLDER_NODE, limits: { ...OLDER_NODE.limits, searcher: 'grep' } }).success).toBe(false)
  })
})
