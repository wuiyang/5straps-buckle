import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest, InvokeResponse, JsonObject, JsonValue } from '@5straps/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLACES_REASON } from '../common/domain/secret-reference.js'
import { SECRETS_OFF_REASON } from '../common/services/secrets/places.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { fixedInteraction } from './support/interaction.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// The owner's report of 2026-11-01 (docs/user/how-to/secrets.md): a code_run script could not fill a password through a secret
// reference, as the whole code_run call was refused for the reference in its script. The script is not read for
// references: each call it makes is planned as the same call made directly, so a reference in a nested fill is read
// there, with that call's own ask, and one anywhere else is refused there. The agent-browser here is a stand-in that
// keeps the text a fill handed it as its page.

const TOKEN = 'decoy-script-0123456789'
const LABEL = '[secret:API_TOKEN]'
const REF = '{{file:.env.local:API_TOKEN}}'
/** The stand-in; with `saveTo`, the page also saves the text a fill hands it to that file, as a page's download could. */
const standIn = (saveTo?: string) => `#!/bin/sh
dir="$(dirname "$0")"
case "$1" in
  fill|type) printf '%s' "$3" > "$dir/page.txt";${saveTo ? ` printf '%s' "$3" > '${saveTo}';` : ''} printf '{"success":true,"data":{"filled":"%s"}}' "$3" ;;
  snapshot) printf '{"success":true,"data":{"page":"%s"}}' "$(cat "$dir/page.txt" 2>/dev/null)" ;;
  *) printf '{"success":true,"data":{}}' ;;
esac
`
/** A script that fills the password field through a reference, prints the fill's answer, and returns what the page shows. */
const FILL = `const filled = await tools.browser_command({ command: 'fill', args: ['#password', '${REF}'] })
text(JSON.stringify(filled.result))
const shown = await tools.browser_command({ command: 'snapshot', args: [] })
return { filled: filled.result.data.filled, page: shown.result.data.page }`

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * A node with the browser, code, and file packs; `listed` lists .env.local in secrets.files, so its use needs no ask,
 * `enabled` false turns references off, and `saves` has the page save what a fill hands it to saved.txt in the workspace.
 */
async function node(listed = true, enabled = true, saves = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-secret-code-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const bin = join(root, 'bin')
  mkdirSync(workspace)
  mkdirSync(bin)
  mkdirSync(join(root, 'state'), { mode: 0o700 })
  writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}\n`)
  writeFileSync(join(bin, 'agent-browser'), standIn(saves ? join(workspace, 'saved.txt') : undefined))
  chmodSync(join(bin, 'agent-browser'), 0o755)
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_ALLOW_SHELL: 'false', BUCKLE_PACKS: 'browser,code,fs',
    BUCKLE_AGENT_BROWSER_COMMAND: join(bin, 'agent-browser'),
  })
  const runtime = await createRuntime({ config: { ...config, ...listed ? { secretFiles: ['.env.local'] } : {}, ...enabled ? {} : { secretsEnabled: false } }, interaction: fixedInteraction() })
  runtimes.push(runtime)
  const page = () => (existsSync(join(bin, 'page.txt')) ? readFileSync(join(bin, 'page.txt'), 'utf8') : null)
  return { root, workspace, runtime, page }
}

let sequence = 0
function call(runtime: CoreRuntime, tool: string, args: JsonObject): Promise<InvokeResponse> {
  return runtime.invoke({ sessionId: 'chat-1', approvalWait: { mode: 'none' }, request: { requestId: `secret-code-${++sequence}`, tool, args, approvalTokens: [] } })
}
const codeRun = (runtime: CoreRuntime, script: string) => call(runtime, 'code_run', { script })

/** What code_run returned, once it ran. */
function ran(response: InvokeResponse): { ok: boolean; value?: JsonValue; output: string; calls: Array<{ tool: string; status: string }> } {
  if (response.outcome !== 'ok') throw new Error(`expected code_run to run, got ${JSON.stringify(response)}`)
  return response.output as never
}

function secretAsk(response: InvokeResponse): ApprovalRequest {
  if (response.outcome !== 'approval_required') throw new Error(`expected an ask, got ${JSON.stringify(response)}`)
  const ask = response.approvals.find(approval => approval.rule === 'sensitive_path')
  if (!ask) throw new Error('expected a secret file ask')
  return ask
}

/** Every file Buckle keeps under its state folder, its replay records and audit log among them, as text. */
function stateText(root: string): string {
  const directory = join(root, 'state')
  return readdirSync(directory, { recursive: true, encoding: 'utf8' }).map(name => join(directory, name)).filter(path => statSync(path).isFile()).map(path => readFileSync(path, 'utf8')).join('\n')
}

/** What the process logs to stderr while `run` runs. */
async function logged(run: () => Promise<void>): Promise<string> {
  let text = ''
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { text += String(chunk); return true })
  try { await run() } finally { write.mockRestore() }
  return text
}

describe('a code_run script that passes a reference to a fill', () => {
  it('runs: the fill is handed the value, and the script, its output, its result, the log, and the audit see only the label', async () => {
    const { root, runtime, page } = await node()
    let response: InvokeResponse | undefined
    const log = await logged(async () => { response = await codeRun(runtime, FILL) })
    const result = ran(response!)
    expect(result).toMatchObject({ ok: true, value: { filled: LABEL, page: LABEL } })
    expect(result.output).toContain(LABEL)
    expect(result.calls.map(item => [item.tool, item.status])).toEqual([['browser_command', 'ok'], ['browser_command', 'ok']])
    expect(page()).toBe(TOKEN)
    // The log is the process's own, as the spy saw it: it names the calls, and never the value.
    expect(log).toContain('Tool call completed')
    const audit = runtime.actions.read(50)
    expect(audit.filter(entry => entry.event === 'result').map(entry => [entry.tool, entry.outcome])).toEqual([['browser_command', 'ok'], ['browser_command', 'ok'], ['code_run', 'ok']])
    expect(JSON.stringify([response, audit, log, stateText(root)])).not.toContain(TOKEN)
  })

  it('treats a reference the script builds by joining text as one it writes whole', async () => {
    const built = `const reference = '{{file:' + '.env.local:' + ['API', 'TOKEN'].join('_') + '}}'
const filled = await tools.browser_command({ command: 'type', args: ['#password', reference] })
return filled.result.data.filled`
    const whole = `const filled = await tools.browser_command({ command: 'type', args: ['#password', '${REF}'] })
return filled.result.data.filled`
    for (const script of [whole, built]) {
      const { runtime, page } = await node()
      const response = await codeRun(runtime, script)
      expect(ran(response)).toMatchObject({ ok: true, value: LABEL })
      expect(page()).toBe(TOKEN)
      expect(JSON.stringify([response, runtime.actions.read(50)])).not.toContain(TOKEN)
    }
  })

  it('reads no file for reference text the script holds but passes to no call', async () => {
    // .env.local is not listed, so a use of it would ask, and missing.env does not exist, so a read of it would refuse.
    const { runtime } = await node(false)
    const response = await codeRun(runtime, `// {{file:missing.env:API_TOKEN}} and {{env:API_TOKEN}} are text here
const note = '${REF}'
return note`)
    expect(ran(response)).toMatchObject({ ok: true, value: REF })
    expect(runtime.approvals.pending()).toEqual([])
    expect(JSON.stringify(response)).not.toContain(TOKEN)
  })
})

describe('a reference a script passes anywhere else', () => {
  it('refuses that call alone with the places reason, written whole or built, and the script goes on', async () => {
    const { workspace, runtime } = await node()
    const response = await codeRun(runtime, `const codes = []
for (const content of ['token=${REF}', 'token={{file:' + '.env.local:API_TOKEN}}']) {
  try { await tools.fs_write({ path: 'notes.txt', content }) } catch (error) { codes.push([error.code, error.message]) }
}
return codes`)
    const result = ran(response)
    expect(result.ok).toBe(true)
    const refusals = result.value as Array<[string, string]>
    expect(refusals).toHaveLength(2)
    for (const [code, message] of refusals) {
      expect(code).toBe('PERMISSION_DENIED')
      expect(message.startsWith(`PERMISSION_DENIED: ${PLACES_REASON}; this one is in content`)).toBe(true)
    }
    expect(existsSync(join(workspace, 'notes.txt'))).toBe(false)
    expect(runtime.actions.read(50).filter(entry => entry.event === 'result' && entry.tool === 'fs_write').map(entry => entry.outcome)).toEqual(['denied', 'denied'])
    // Refused before it is judged, as a direct call is: nobody is asked about the write or the file.
    expect(runtime.approvals.pending()).toEqual([])
  })
})

describe('a nested reference while references are off', () => {
  it('refuses the fill as a direct fill is refused, and fills nothing', async () => {
    const { runtime, page } = await node(true, false)
    const direct = await call(runtime, 'browser_command', { command: 'fill', args: ['#password', REF] })
    expect(direct).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining(SECRETS_OFF_REASON) } })
    const result = ran(await codeRun(runtime, `try { await tools.browser_command({ command: 'fill', args: ['#password', '${REF}'] }) } catch (error) { return [error.code, error.message] }`))
    expect(result.value).toEqual(['PERMISSION_DENIED', expect.stringContaining(SECRETS_OFF_REASON)])
    expect(page()).toBeNull()
  })
})

describe('the ask a nested reference makes', () => {
  it('is the same ask a direct fill makes, shows the reference and never a value, and the same script runs once it is answered', async () => {
    const { root, workspace, runtime, page } = await node(false)
    const direct = secretAsk(await call(runtime, 'browser_command', { command: 'fill', args: ['#password', REF] }))
    const first = await codeRun(runtime, FILL)
    const nested = secretAsk(first)
    expect(nested).toMatchObject({ tool: 'browser_command', rule: 'sensitive_path', subject: direct.subject, offeredScopes: direct.offeredScopes })
    expect(nested.subject).toBe(`secret-file:${join(workspace, '.env.local')}`)
    expect(page()).toBeNull()
    const waiting = runtime.approvalService.waiting().find(entry => entry.request.token === nested.token)!
    expect(waiting.call).toMatchObject({
      arguments: { command: 'fill', args: ['#password', REF] },
      description: expect.stringContaining('Called by a "code_run" script'),
      effects: expect.arrayContaining(['secrets API_TOKEN from .env.local']),
    })
    expect(JSON.stringify([first, runtime.approvalService.waiting(), runtime.actions.read(50), stateText(root)])).not.toContain(TOKEN)

    expect((await runtime.approvalService.answer({ decision: { token: nested.token, approved: true, scope: 'once' }, source: SOURCES.cli })).ok).toBe(true)
    const second = await codeRun(runtime, FILL)
    expect(ran(second)).toMatchObject({ ok: true, value: { filled: LABEL, page: LABEL } })
    expect(page()).toBe(TOKEN)
    expect(JSON.stringify([second, runtime.actions.read(50), stateText(root)])).not.toContain(TOKEN)
  })
})

// Codex review of fix 1, finding S1: a value a script's call resolved can come back through a later call that has no
// reference of its own, such as an fs_read of a file the page saved the value to. Every call a script makes is masked
// by every value its calls resolved, before the script, its record, or the audit sees it, across an ask too.
describe('a value a script\'s fill leaves in a file', () => {
  /** Fills through a reference, reads the file the page saved, prints it, types it elsewhere, and returns it. */
  const SAVE_AND_READ = `await tools.browser_command({ command: 'fill', args: ['#password', '${REF}'] })
const read = await tools.fs_read({ path: 'saved.txt' })
text(read.content)
await tools.browser_command({ command: 'type', args: ['#search', read.content] })
return read.content`

  it('reads as the label in every later call, its output, its result, the log, the audit, and the record, and a call that reuses it is handed the label', async () => {
    const { root, workspace, runtime, page } = await node(true, true, true)
    let response: InvokeResponse | undefined
    const log = await logged(async () => { response = await codeRun(runtime, SAVE_AND_READ) })
    const result = ran(response!)
    expect(result).toMatchObject({ ok: true, value: LABEL })
    expect(result.output).toBe(LABEL)
    expect(result.calls.map(item => [item.tool, item.status])).toEqual([['browser_command', 'ok'], ['fs_read', 'ok'], ['browser_command', 'ok']])
    // The type was handed the label the read showed the script, never the value, and the page saved that.
    expect(page()).toBe(LABEL)
    expect(readFileSync(join(workspace, 'saved.txt'), 'utf8')).toBe(LABEL)
    expect(JSON.stringify([response, runtime.actions.read(50), log, stateText(root)])).not.toContain(TOKEN)
  })

  const ACROSS_ASK = `await tools.browser_command({ command: 'fill', args: ['#password', '${REF}'] })
const before = await tools.fs_read({ path: 'saved.txt' })
await tools.fs_write({ path: 'one/out.md', content: 'x', createParents: true })
const after = await tools.fs_read({ path: 'saved.txt' })
return { before: before.content, after: after.content }`

  /** Sends ACROSS_ASK, which stops at the write's ask, checks nothing holds the value, and answers the ask. */
  async function stopAtAsk() {
    const setup = await node(true, true, true)
    const first = await codeRun(setup.runtime, ACROSS_ASK)
    if (first.outcome !== 'approval_required') throw new Error(`expected an ask, got ${JSON.stringify(first)}`)
    const ask = first.approvals.find(approval => approval.rule === 'write_scope')!
    expect(ask).toMatchObject({ tool: 'fs_write' })
    // The record holds the read's result for the resumed run, masked.
    expect(JSON.stringify([first, setup.runtime.actions.read(50), stateText(setup.root)])).not.toContain(TOKEN)
    expect((await setup.runtime.approvalService.answer({ decision: { token: ask.token, approved: true, scope: 'once' }, source: SOURCES.cli })).ok).toBe(true)
    return setup
  }

  it('stays masked once the script resumes after an ask: a call before it is replayed masked, and one after it reads the label', async () => {
    const { root, workspace, runtime } = await stopAtAsk()
    const second = await codeRun(runtime, ACROSS_ASK)
    expect(ran(second)).toMatchObject({ ok: true, value: { before: LABEL, after: LABEL } })
    expect(readFileSync(join(workspace, 'one', 'out.md'), 'utf8')).toBe('x')
    expect(JSON.stringify([second, runtime.actions.read(50), stateText(root)])).not.toContain(TOKEN)
  })

  it('refuses the resumed script where a value its calls used before the ask no longer reads as it did, and runs it once the file is back', async () => {
    const { root, workspace, runtime } = await stopAtAsk()
    const other = 'decoy-changed-9876543210'
    writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${other}\n`)
    const refused = await codeRun(runtime, ACROSS_ASK)
    expect(refused).toMatchObject({ outcome: 'error', error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('API_TOKEN in .env.local') } })
    // Nothing after the ask ran, so the old value the file saved never reached a call the script could not mask.
    expect(existsSync(join(workspace, 'one', 'out.md'))).toBe(false)
    expect(JSON.stringify([refused, runtime.actions.read(50), stateText(root)])).not.toMatch(new RegExp(`${TOKEN}|${other}`))
    writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}\n`)
    expect(ran(await codeRun(runtime, ACROSS_ASK))).toMatchObject({ ok: true, value: { before: LABEL, after: LABEL } })
  })
})
