import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalsPath, grantsPath } from '../common/runtime/config.js'
import { NO_INTERACTION, type Interaction } from '../common/runtime/interaction.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { openSettingsFile, settingsPath, WorkspaceSettingsSchema } from '../common/services/workspaces/workspace-settings.js'
import { openForms } from '../mcp/open-forms.js'
import { createMcpServer } from '../mcp/server.js'
import { auditEntries, settleAuditLogs } from './support/action-log-writer.js'
import { fixedInteraction } from './support/interaction.js'
import { hostTool, type HostToolResult } from './support/mcp-host-tool.js'
import { configFromEnvironment } from './support/workspace-config.js'

// The owner's ruling on a grant that fails to save, over MCP forms: an approval whose lasting part did not save, or a
// lasting denial that did not, draws one save form, retry or skip, before the call is invoked, so the call's once stays
// unspent until it is answered. The answer comes under save:<token>, and the call sent again joins the first call's
// ask, so the call that asked runs once, on its once or on the saved grant.

// The renames onto `rename` to fail, `count` times.
const failing = vi.hoisted(() => ({ rename: undefined as string | undefined, count: 0 }))
vi.mock('../common/adapters/replace-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/adapters/replace-file.js')>()
  return {
    ...actual,
    replaceFile: async (from: string, to: string, io?: Parameters<typeof actual.replaceFile>[2]) => {
      if (failing.rename === to && failing.count > 0) {
        failing.count -= 1
        throw Object.assign(new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`), { code: 'EACCES' })
      }
      return actual.replaceFile(from, to, io)
    },
  }
})

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  Object.assign(failing, { rename: undefined, count: 0 })
  for (const runtime of runtimes.splice(0)) { runtime.closeWatchers(); await runtime.approvalService.close(); await runtime.history.close() }
  await settleAuditLogs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** No terminal, a hold only while this process asks: a gated call answers at once. */
const NOBODY: Interaction = { requestCli: NO_INTERACTION.requestCli, hold: 'prompt' }
const STDIO = 'mcp-stdio'

/** A stdio face with forms on, whose next `failures` grant writes fail as a locked grants file fails them. */
async function stdioNode(failures: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-save-form-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, 'one'), { recursive: true })
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  const config = configFromEnvironment({ BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'fs', BUCKLE_APPROVAL_TIMEOUT_MS: '60000' })
  const settings = openSettingsFile({ filePath: settingsPath(config.nodeStateDirectory ?? config.stateDirectory, config.workspaceId), fallback: () => WorkspaceSettingsSchema.parse({ version: 1 }) })
  const setForms = (forms: boolean) => settings.update(current => ({ ...current, approval: { ...current.approval, forms } }))
  await setForms(true)
  const runtime = await createRuntime({ config, interaction: fixedInteraction(NOBODY) })
  runtimes.push(runtime)
  Object.assign(failing, { rename: grantsPath(config), count: failures })
  const server = createMcpServer({ runtime, serverName: 'save-form-mcp', version: '0', followToolChanges: false, forms: openForms(runtime, { face: 'stdio' }) })
  const ledger = () => JSON.parse(readFileSync(approvalsPath(config), 'utf8')) as { once: unknown[]; resolved: Array<{ request?: { token: string }; grant?: { save: string } }> }
  const results = async (tool = 'fs_write') => (await auditEntries(runtime.actions, 200)).filter(entry => entry.tool === tool && entry.event === 'result')
  return { workspace, config, runtime, setForms, ledger, results, write: hostTool(server, 'fs_write'), read: hostTool(server, 'fs_read'), waitingTokens: () => runtime.approvalService.pending().map(asked => asked.token) }
}

const ARGS = { path: 'one/a.md', content: 'a' }
const accept = (key: string, content: Record<string, unknown>) => ({ [key]: { action: 'accept', content } })
const formsOf = (result: HostToolResult) => Object.keys(result.inputRequests ?? {})
const messageOf = (result: HostToolResult, key: string) => (result.inputRequests?.[key] as { params: { message: string } }).params.message

/** The first two rounds: the approval form, then a session answer whose grant does not save, which draws the save form. */
async function approvedUnsaved(node: Awaited<ReturnType<typeof stdioNode>>) {
  expect(await node.write({ args: ARGS, actor: STDIO })).toMatchObject({ resultType: 'input_required' })
  const [token] = node.waitingTokens()
  const saving = await node.write({ args: ARGS, responses: accept(token!, { approve: true, scope: 'session' }), actor: STDIO })
  return { token: token!, saving }
}

describe('the MCP save form, over stdio', () => {
  it('draws a save form after an approval whose grant did not save and runs nothing yet; a retry saves the grant, and the call that asked runs once', async () => {
    const node = await stdioNode(1)
    const { token, saving } = await approvedUnsaved(node)
    expect(formsOf(saving)).toEqual([`save:${token}`])
    expect(messageOf(saving, `save:${token}`)).toContain('Approved for this call; saving it for the session failed: permission denied.')
    expect(existsSync(join(node.workspace, 'one', 'a.md'))).toBe(false)
    expect(node.ledger().once).toHaveLength(1)
    expect((await node.results()).map(entry => entry.outcome)).toEqual(['approval_required'])

    const ran = await node.write({ args: ARGS, responses: accept(`save:${token}`, { save: 'retry' }), actor: STDIO })
    expect(ran.isError).toBeUndefined()
    expect(readFileSync(join(node.workspace, 'one', 'a.md'), 'utf8')).toBe('a')
    expect(node.runtime.grants.list()).toEqual([expect.objectContaining({ rule: 'write_scope', scope: 'session' })])
    const results = await node.results()
    expect(results.map(entry => entry.outcome)).toEqual(['approval_required', 'ok'])
    expect(results[1]!.requestId).toBe(results[0]!.requestId)
  })

  it('skips the save on a decline: the call that asked runs once on its once, and the next identical call asks again', async () => {
    const node = await stdioNode(1)
    const { token } = await approvedUnsaved(node)
    expect((await node.write({ args: ARGS, responses: { [`save:${token}`]: { action: 'decline' } }, actor: STDIO })).isError).toBeUndefined()
    expect(readFileSync(join(node.workspace, 'one', 'a.md'), 'utf8')).toBe('a')
    expect(node.runtime.grants.list()).toEqual([])
    expect(node.ledger().resolved.find(entry => entry.request?.token === token)?.grant?.save).toBe('skipped')
    expect(await node.write({ args: ARGS, actor: STDIO })).toMatchObject({ resultType: 'input_required' })
  })

  it('leaves the grant owed on a cancel, and the call runs once on its once', async () => {
    const node = await stdioNode(1)
    const { token } = await approvedUnsaved(node)
    expect((await node.write({ args: ARGS, responses: { [`save:${token}`]: { action: 'cancel' } }, actor: STDIO })).isError).toBeUndefined()
    expect(readFileSync(join(node.workspace, 'one', 'a.md'), 'utf8')).toBe('a')
    expect(node.runtime.grants.list()).toEqual([])
    expect(node.ledger().resolved.find(entry => entry.request?.token === token)?.grant?.save).toBe('owed')
  })

  it('draws no third form when the retry fails again: the call runs once on its once, its grant still owed', async () => {
    const node = await stdioNode(2)
    const { token } = await approvedUnsaved(node)
    const ran = await node.write({ args: ARGS, responses: accept(`save:${token}`, { save: 'retry' }), actor: STDIO })
    expect(ran.resultType).not.toBe('input_required')
    expect(ran.isError).toBeUndefined()
    expect(readFileSync(join(node.workspace, 'one', 'a.md'), 'utf8')).toBe('a')
    expect(node.ledger().resolved.find(entry => entry.request?.token === token)?.grant?.save).toBe('owed')
  })

  it('draws a save form for a lasting denial that did not save, while its ask still waits, and its skip denies the call once', async () => {
    const node = await stdioNode(1)
    writeFileSync(join(node.workspace, '.env'), 'KEY=value\n')
    const args = { path: '.env' }
    expect(await node.read({ args, actor: STDIO })).toMatchObject({ resultType: 'input_required' })
    const [token] = node.waitingTokens()
    const saving = await node.read({ args, responses: accept(token!, { action: 'deny_session' }), actor: STDIO })
    expect(formsOf(saving)).toEqual([`save:${token}`])
    expect(messageOf(saving, `save:${token}`)).toContain('Not denied for the session: saving failed: permission denied; the call still waits.')
    expect(node.waitingTokens()).toEqual([token])

    const denied = await node.read({ args, responses: accept(`save:${token}`, { save: 'skip' }), actor: STDIO })
    expect(denied.isError).toBe(true)
    expect(node.waitingTokens()).toEqual([])
    expect(node.runtime.grants.list()).toEqual([])
  })

  it('reads no save answer once forms are off: the call runs once on its once, and the grant stays owed', async () => {
    const node = await stdioNode(1)
    const { token } = await approvedUnsaved(node)
    await node.setForms(false)
    const answers = vi.spyOn(node.runtime.approvalService, 'answer')
    expect((await node.write({ args: ARGS, responses: accept(`save:${token}`, { save: 'retry' }), actor: STDIO })).isError).toBeUndefined()
    expect(answers).not.toHaveBeenCalled()
    expect(readFileSync(join(node.workspace, 'one', 'a.md'), 'utf8')).toBe('a')
    expect(node.ledger().resolved.find(entry => entry.request?.token === token)?.grant?.save).toBe('owed')
  })
})
