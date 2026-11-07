import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogEvent } from '@5straps/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupCli } from '../cli/setup.js'
import { configureRootLogger, flushLogs } from '../common/runtime/log.js'
import { renderEvent } from '../common/runtime/log-render.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService, questionFor } from '../common/services/approvals/approval-service.js'
import { setupServer } from '../server/setup-server.js'
import { PLAIN_MARKS } from '../common/domain/permission/decision.js'

// The CLI display slice, C5: a node with nobody at a prompt logs one line for each question it cannot ask, saying what
// the ask is about and where to see it whole, and carrying no subject, description, or token, which no log line does.

afterEach(() => {
  configureRootLogger({})
  vi.unstubAllEnvs()
})

const call = { arguments: { path: '/outside/report.md', content: 'quarterly figures' }, cwd: '/workspace', description: 'Write 17 bytes to "/outside/report.md"', effects: ['write /outside/report.md'], complete: true as const }

function ask(token: string) {
  return questionFor({
    approval: { token, rule: 'write_scope', subject: '/outside/report.md', reason: 'Writing to /outside is not yet approved', tool: 'fs_write', offeredScopes: ['once', 'session'], expiresAt: new Date(Date.now() + 600_000).toISOString() },
    workspaceId: 'w-1', workspaceName: 'The site', node: 'node-1', context: { correlationId: `c-${token}`, sessionId: 's', call },
  })
}

/** The JSON lines a run logs on stderr, which is no terminal here. */
async function logged(run: () => Promise<unknown>): Promise<LogEvent[]> {
  let text = ''
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { text += String(chunk); return true })
  try {
    await run()
    await flushLogs()
  } finally {
    spy.mockRestore()
  }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as LogEvent)
}

describe('a pending approval on a node with no terminal', () => {
  it('logs one Approval pending line per question nobody can be asked: the tool, rule, scopes, workspace, and the command that shows it', async () => {
    configureRootLogger({})
    const lines = await logged(() => setupCli({ terminal: null, logPending: true }).requestCli(ask('t-pending-1')))
    expect(lines).toEqual([expect.objectContaining({ level: 'info', message: 'Approval pending', fields: { tool: 'fs_write', rule: 'write_scope', scopes: ['once', 'session'], workspace: 'The site', review: 'buckle approvals --workspace \'The site\'' } })])
  })

  it('carries no subject, description, reason, argument, or token', async () => {
    configureRootLogger({})
    const lines = await logged(() => setupCli({ terminal: null, logPending: true }).requestCli(ask('t-pending-2')))
    expect(lines.map(line => line.message)).toEqual(['Approval pending'])
    for (const hidden of ['/outside/report.md', 'Write 17 bytes', 'not yet approved', 'quarterly figures', 't-pending-2']) expect(JSON.stringify(lines)).not.toContain(hidden)
  })

  // The MCP asks brief, item 4: a call that made two asks names both, not only its first, so one approval never leaves
  // the call waiting on an ask nobody was told of.
  it('logs one Approval pending line for every ask of a call, not only its first', async () => {
    configureRootLogger({})
    const root = mkdtempSync(join(tmpdir(), 'buckle-pending-asks-'))
    const registry = createApprovalRegistry(createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root }), join(root, 'approvals.json'), root, 20)
    const cli = setupCli({ terminal: null, logPending: true })
    const service = createApprovalService({ registry, workspaceId: 'w-1', workspaceName: 'The site', serverId: 'node-1', graceMs: 20, interaction: async () => ({ hold: 'grace', requestCli: cli.requestCli }) })
    const asks = ['/outside/one', '/outside/two'].map(subject => ({ kind: 'ask' as const, ...PLAIN_MARKS, rule: 'write_scope' as const, subject, reason: 'outside', offeredScopes: ['once' as const] }))
    try {
      const lines = await logged(async () => {
        await service.request({ sessionId: 's', requestId: 'r-two', tool: 'fs_delete', asks, call: { ...call, complete: true } })
        await service.close()
      })
      expect(lines.filter(line => line.message === 'Approval pending')).toHaveLength(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('logs none for a question dropped as the process stops', async () => {
    configureRootLogger({})
    const cli = setupCli({ terminal: null, logPending: true })
    await cli.close()
    expect(await logged(() => cli.requestCli(ask('t-closed')))).toEqual([])
  })

  it('logs none for a one-shot command, which relays the ask itself', async () => {
    configureRootLogger({})
    expect(await logged(() => setupCli({ terminal: null }).requestCli(ask('t-cli')))).toEqual([])
  })

  // Fix brief 1, H6: HTTP's requester, once the app's one cli:call listener is gone, finds no listener and logs the line too.
  it('logs one Approval pending line for a question HTTP asks where the app has no listener', async () => {
    configureRootLogger({})
    const built = mkdtempSync(join(tmpdir(), 'buckle-pending-entry-'))
    const entryPath = join(built, 'index.mjs')
    // The two things a built entry exports, with the hooks the runtime's requester calls its observers through.
    writeFileSync(entryPath, 'export const nitroApp = { hooks: { callHook: async () => {} } }\nexport const middleware = () => {}\n')
    const common = { owner: { onClose: () => {} }, services: {} }
    try {
      const server = await setupServer({ common: common as never, logger: { info: vi.fn(), warn: vi.fn() } as never, requestCli: async request => ({ status: 'unavailable', requestId: request.id, reason: 'no_consumer' }), entryPath })
      server.release()
      const lines = await logged(() => server.requestCli(ask('t-http')))
      expect(lines).toEqual([expect.objectContaining({ level: 'info', message: 'Approval pending', fields: expect.objectContaining({ tool: 'fs_write', workspace: 'The site' }) })])
    } finally {
      rmSync(built, { recursive: true, force: true })
    }
  })

  it('reads with the [approval] tag on a person\'s console', () => {
    vi.stubEnv('TZ', 'UTC')
    const event: LogEvent = { timestamp: '2026-10-21T14:22:00.000Z', level: 'info', component: 'buckle', message: 'Approval pending', fields: { tool: 'fs_write', rule: 'write_scope', scopes: ['once', 'session'], workspace: 'The site', review: 'buckle approvals --workspace \'The site\'' } }
    expect(renderEvent(event, { verbose: false })).toEqual(['14:22:00 [approval] [The site] action pending approval: write a file (write_scope: once, session); see it with buckle approvals --workspace \'The site\''])
  })
})
