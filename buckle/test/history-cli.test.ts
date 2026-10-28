import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BuckleConfig } from '../common/runtime/config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'

// Slice D, rollback as an agent option, item 3: `buckle history list --last <n>` shows the n checkpoints back from the
// current state, newest first, each with its time, its files, and the agent call that made it, the current one marked.
// Plain `buckle history list` keeps its JSON.

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** A workspace whose history holds the writes `files` names, one call each, made by an agent through the invoker. */
async function workspaceWith(writes: Array<{ requestId: string; files: Record<string, string> }>): Promise<{ config: BuckleConfig; workspace: string }> {
  const root = mkdtempSync(join(tmpdir(), 'buckle-history-cli-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs,history' })
  const runtime = await createRuntime({ config })
  try {
    await runtime.grants.grant({ sessionId: 'chat-1', rule: 'write_scope', subject: runtime.paths().root, scope: 'session' })
    for (const write of writes) {
      const files = Object.entries(write.files).map(([path, content]) => ({ path, content, createParents: true }))
      const response = await runtime.invoke({ sessionId: 'chat-1', request: { requestId: write.requestId, tool: 'fs_write_batch', args: { files } as JsonObject, approvalTokens: [] } })
      expect(response.outcome).toBe('ok')
    }
  } finally { await runtime.approvalService.close(); await runtime.history.close() }
  return { config, workspace }
}

async function history(config: BuckleConfig, argv: string[]): Promise<{ exitCode: number; out: string; err: string }> {
  let out = ''
  let err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err += String(chunk); return true })
  try {
    const result = await runCli({ argv: ['history', ...argv], config, confirm: null })
    return { exitCode: result.exitCode, out, err }
  } finally { vi.restoreAllMocks() }
}

describe('buckle history list --last', () => {
  it('shows that many checkpoints back from the current state, newest first, with time, files, and the call, the current one marked', async () => {
    const { config } = await workspaceWith([
      { requestId: 'w-1', files: { 'a.txt': 'one' } },
      { requestId: 'w-2', files: { 'src/b.txt': 'two' } },
      { requestId: 'w-3', files: { 'a.txt': 'three', 'c.txt': 'four' } },
    ])
    const shown = await history(config, ['list', '--last', '2'])
    expect(shown.exitCode).toBe(0)
    const lines = shown.out.split('\n')
    expect(lines[0]).toBe('The newest 2 checkpoints, from the current state back:')
    expect(lines[2]).toMatch(/^\* change-[0-9a-f-]{36} {2}\d{4}-\d{2}-\d{2}T[\d:.]+Z {2}current$/)
    expect(lines[3]).toBe('    fs_write_batch, session chat-1, request w-3')
    expect(lines.slice(4, 6)).toEqual(['    modified  a.txt', '    created   c.txt'])
    expect(lines[6]).toMatch(/^ {2}change-[0-9a-f-]{36} {2}\S+$/)
    expect(lines[7]).toBe('    fs_write_batch, session chat-1, request w-2')
    expect(lines.slice(8, 10)).toEqual(['    created   src', '    created   src/b.txt'])
    expect(shown.out).toContain('Older checkpoints are kept: buckle history list prints every one.')
    expect(shown.out).not.toContain('w-1')
  })

  it('counts the files past ten, and names a restore by what it undid', async () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${String(index).padStart(2, '0')}.txt`, 'x']))
    const { config } = await workspaceWith([{ requestId: 'w-1', files }])
    const shown = await history(config, ['list', '--last', '5'])
    expect(shown.out).toContain('    created   f09.txt\n    and 2 more files\n')
    expect(shown.out).not.toContain('Older checkpoints')
    expect((await history(config, ['restore', JSON.parse((await history(config, ['list'])).out)[0].id])).exitCode).toBe(0)
    const after = await history(config, ['list', '--last', '1'])
    expect(after.out).toMatch(/\n {4}owner_restore, session chat-1, undid change-[0-9a-f-]{36}\n/)
  })

  it('keeps plain buckle history list as JSON, oldest first, and refuses a count outside 1 to 100', async () => {
    const { config } = await workspaceWith([{ requestId: 'w-1', files: { 'a.txt': 'one' } }, { requestId: 'w-2', files: { 'b.txt': 'two' } }])
    const plain = await history(config, ['list'])
    expect((JSON.parse(plain.out) as Array<{ requestId: string }>).map(item => item.requestId)).toEqual(['w-1', 'w-2'])
    for (const count of ['0', '101', 'two']) {
      const refused = await history(config, ['list', '--last', count])
      expect(refused.exitCode, count).toBe(1)
      expect(refused.err).toContain('--last takes a count of checkpoints, 1 to 100')
    }
  })

  it('escapes what an agent chose, as every rendering of agent text is', async () => {
    const { config } = await workspaceWith([{ requestId: 'w-\u001b[31m', files: { 'a\u0007.txt': 'one' } }])
    const shown = await history(config, ['list', '--last', '1'])
    expect(shown.out).not.toMatch(/[\u0007\u001b]/)
    expect(shown.out).toContain('request w-\\u001b[31m')
  })
})

describe('buckle tools', () => {
  it('names the history tools by buckle call, since buckle history is the owner\'s own command', async () => {
    const { config } = await workspaceWith([])
    let out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true })
    expect((await runCli({ argv: ['tools'], config, confirm: null })).exitCode).toBe(0)
    vi.restoreAllMocks()
    expect(out).toMatch(/\ncall history_list +read /)
    expect(out).toMatch(/\ncall history_restore +write /)
    expect(out).toMatch(/(^|\n)fs read +read /)
  })
})
