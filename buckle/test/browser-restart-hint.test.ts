import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createPathView } from '../common/domain/path-view.js'
import { createBrowserPack, type BrowserPackOptions } from '../common/services/packs/browser/index.js'
import { logger } from '../common/runtime/log.js'

// Phase 3, item 7: the browser's "restart every Buckle process" warning, which a process logs once, names
// buckle service restart where a service runs this node. Its own file, as the warning is logged once per process.

it('names buckle service restart beside every Buckle process where a service runs this node', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'buckle-browser-restart-hint-'))
  const call = async (options: Partial<BrowserPackOptions>) => {
    const pack = createBrowserPack({ cwd: '/work', paths: createPathView({ root: '/work', mount: null }), agentBrowserCommand: 'agent-browser', sessionDirectory: directory, headed: false, agentBrowser: { path: 'agent-browser', argv0: 'agent-browser', args: [] }, approvedLists: [], runProcess: async () => ({ exitCode: 0, signal: null, stdout: '{"success":true}', stderr: '', truncated: false, timedOut: false }), browser: { mode: { kind: 'profile', directory: '/owner/profile' } }, ...options })
    await pack.tools[0]!.prepare({ command: 'snapshot', args: [] }).execute({ requestId: 'r1', sessionId: 's1', timeoutMs: 1000, signal: new AbortController().signal })
  }
  await call({})
  // A live sibling process wrote the folder's session under other settings.
  const store = join(directory, 'sessions.json')
  const state = JSON.parse(readFileSync(store, 'utf8')) as { writers: Record<string, number> }
  for (const key of Object.keys(state.writers)) state.writers[key] = process.ppid
  writeFileSync(store, JSON.stringify(state))
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  try {
    await call({ launchArgs: '--lang=en-GB', serviceInstalled: () => true })
    const warned = warn.mock.calls.filter(([message]) => message.startsWith('Another Buckle process on this node'))
    expect(warned).toHaveLength(1)
    expect(warned[0]![0]).toMatch(/Restart every Buckle process on the node after changing them: buckle service restart for the service, and each buckle mcp through its client$/)
  } finally {
    warn.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
