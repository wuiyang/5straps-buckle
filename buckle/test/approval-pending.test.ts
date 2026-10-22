import type { LogEvent } from '@5straps/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupCli } from '../cli/setup.js'
import { configureRootLogger, flushLogs } from '../common/runtime/log.js'
import { renderEvent } from '../common/runtime/log-render.js'
import { questionFor } from '../common/services/approvals/approval-service.js'

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

  it('reads with the [approval] tag on a person\'s console', () => {
    vi.stubEnv('TZ', 'UTC')
    const event: LogEvent = { timestamp: '2026-10-21T14:22:00.000Z', level: 'info', component: 'buckle', message: 'Approval pending', fields: { tool: 'fs_write', rule: 'write_scope', scopes: ['once', 'session'], workspace: 'The site', review: 'buckle approvals --workspace \'The site\'' } }
    expect(renderEvent(event, { verbose: false })).toEqual(['14:22:00 [approval] [The site] action pending approval: write a file (write_scope: once, session); see it with buckle approvals --workspace \'The site\''])
  })
})
