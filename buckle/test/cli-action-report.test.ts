import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../common/runtime/config.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { runCli } from './support/cli.js'

afterEach(() => { vi.unstubAllGlobals() })

function node(): BuckleConfig {
  const root = mkdtempSync(join(tmpdir(), 'buckle-cli-report-'))
  writeFileSync(join(root, 'note.txt'), 'workspace content')
  return configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: root,
    BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-cli-report-state-')),
    BUCKLE_ALLOW_SHELL: 'false',
    BUCKLE_PACKS: 'fs',
    BUCKLE_REPORT_URL: 'http://rings.test/api/v1/buckle-reports',
    BUCKLE_REPORT_TOKEN: 'cli-report-token-fixture-only',
  })
}

function endpoint() {
  const posts: Array<{ body: { event?: string; reports?: Array<{ requestId: string; tool: string; outcome: string }> }; authorization: string | undefined }> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    posts.push({ body: JSON.parse(String(init.body)), authorization: new Headers(init.headers).get('authorization') ?? undefined })
    return new Response(null, { status: 201 })
  }))
  return posts
}

async function capture(input: { argv: string[]; config: BuckleConfig }): Promise<number> {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  try {
    return (await runCli(input)).exitCode
  } finally { out.mockRestore(); error.mockRestore() }
}

/**
 * `BUCKLE-D06: Buckle reports the full action log`. One CLI command is one process, and the
 * reporter's batch timer is unreferenced so it cannot hold that process open: the entry has to be
 * posted by the time the command answers, or it is posted for no call at all.
 */
describe('a tool call made from the command line', () => {
  it('has reached the report endpoint by the time the command answers', async () => {
    const posts = endpoint()

    expect(await capture({ argv: ['call', 'fs_list', '--json', '{"path":"."}'], config: node() })).toBe(0)

    expect(posts).toHaveLength(1)
    expect(posts[0]?.body.event).toBe('action_log')
    expect(posts[0]?.body.reports?.map(report => [report.tool, report.outcome])).toEqual([['fs_list', 'ok']])
    expect(posts[0]?.authorization).toBe('Bearer cli-report-token-fixture-only')
  }, 30_000)

  it('posts nothing on a node the owner configured no report endpoint for', async () => {
    const posts = endpoint()
    const config = configFromEnvironment({
      BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-cli-report-quiet-')),
      BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-cli-report-quiet-state-')),
      BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs',
    })

    expect(await capture({ argv: ['call', 'fs_list', '--json', '{"path":"."}'], config })).toBe(0)

    expect(posts).toEqual([])
  }, 30_000)
})
