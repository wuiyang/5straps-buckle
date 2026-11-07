import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyWorkspacePolicy, type InvokeResponse, type JsonObject } from '@5straps/protocol'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { logger, rootLogger } from '../common/runtime/log.js'
import { ToolExecutionError, type FilledSecret, type PreparedCall, type ToolContext } from '../common/domain/tool.js'
import type { JsonValue } from '@5straps/protocol'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { checkSecrets, runWithSecrets } from '../common/services/secrets/call-secrets.js'
import { planSecrets } from '../common/services/secrets/places.js'
import { PLACES_REASON, SHORT_REASON } from '../common/domain/secret-reference.js'
import { COMMAND_WORD_REASON, EXPANSION_REASON, readShellReferences, UNQUOTED_REASON } from '../common/services/secrets/shell-reading.js'
import { createRuntime, type CoreRuntime } from '../common/services/workspaces/workspace-runtime.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { SOURCES } from '../common/types/ports/approval-source.js'

// The secret-references slice, parts 5 and 6 (docs/user/how-to/secrets.md): the rules judge the reference text as written; each
// value is read and put in place only as the tool starts, into the argument list, never the child's environment; and
// every value is shown as [secret:NAME] wherever text leaves Buckle.

const TOKEN = 'decoy-token-0123456789'
const EVIL = 'decoy-evil-0123456789'
const DOTENV = [
  `API_TOKEN=${TOKEN}`,
  'SHORT=abc',
  'SPACED="decoy value with blanks"',
  'QUOTED="decoy\\"quote-0123"',
  'DASHED=-decoy-dashed-0123',
  `EVIL=${EVIL}`,
].join('\n')
const LABEL = '[secret:API_TOKEN]'

const roots: string[] = []
const runtimes: CoreRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) { await runtime.approvalService.close(); await runtime.history.close() }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function node(packs = 'fs,shell'): Promise<{ workspace: string; runtime: CoreRuntime }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-secret-run-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  writeFileSync(join(workspace, '.env.local'), `${DOTENV}\n`)
  const config = configFromEnvironment({
    BUCKLE_WORKSPACE_ROOT: workspace, BUCKLE_STATE_DIR: join(root, 'state'), BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true',
    BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: packs, BUCKLE_APPROVAL_TIMEOUT_MS: '1',
  })
  // The file is listed, so its use needs no ask here; the ask itself is part 4's (secret-ask.test.ts).
  const runtime = await createRuntime({ config: { ...config, secretFiles: ['.env.local'] } })
  runtimes.push(runtime)
  await runtime.grants.grant({ sessionId: 'chat-1', rule: 'write_scope', subject: workspace, scope: 'session' })
  await withPolicy(runtime, () => undefined)
  return { workspace, runtime }
}

/** The owner allows the commands these rows run, a shell's `-c` among them, then changes what `change` does. */
async function withPolicy(runtime: CoreRuntime, change: (policy: ReturnType<typeof emptyWorkspacePolicy>) => void): Promise<void> {
  const policy = emptyWorkspacePolicy()
  policy.commands.allow = ['bash -c *', 'printf *', 'ls *', 'printenv', 'touch *']
  change(policy)
  await runtime.policy.apply(policy)
}

let sequence = 0
function call(runtime: CoreRuntime, tool: string, args: JsonObject): Promise<InvokeResponse> {
  sequence += 1
  return runtime.invoke({ sessionId: 'chat-1', request: { requestId: `secret-run-${sequence}`, tool, args, approvalTokens: [], context: { approvalWait: { mode: 'none' } } } })
}
const shell = (runtime: CoreRuntime, command: string, args: string[]) => call(runtime, 'shell_exec', { command, args })
const output = (response: InvokeResponse): { stdout: string; stderr: string; exitCode: number; truncated: boolean } => {
  if (response.outcome !== 'ok') throw new Error(`expected a run, got ${JSON.stringify(response)}`)
  return response.output as { stdout: string; stderr: string; exitCode: number; truncated: boolean }
}
const refusal = (response: InvokeResponse): string => {
  if (response.outcome !== 'error') throw new Error(`expected a refusal, got ${JSON.stringify(response)}`)
  expect(response.error.code).toBe('PERMISSION_DENIED')
  return response.error.message
}

describe('the value in the argument list, masked in what comes back', () => {
  it('hands the value to the program as an argument and masks it in its output', async () => {
    const { runtime } = await node()
    const response = await shell(runtime, 'printf', ['%s', '{{file:.env.local:API_TOKEN}}'])
    expect(output(response).stdout).toBe(LABEL)
    expect(JSON.stringify(response)).not.toContain(TOKEN)
  })

  it('masks the value in stderr, where a program quotes the argument it failed on', async () => {
    const { runtime } = await node()
    const result = output(await shell(runtime, 'ls', ['{{file:.env.local:API_TOKEN}}']))
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(LABEL)
    expect(result.stderr).not.toContain(TOKEN)
  })

  it('masks the value a command base64-encodes, and a value with blanks as one argument', async () => {
    const { runtime } = await node()
    expect(output(await call(runtime, 'script_run', { runtime: 'bash', script: 'printf "%s" "{{file:.env.local:API_TOKEN}}" | base64' })).stdout.trim()).toBe(LABEL)
    expect(output(await shell(runtime, 'printf', ['<%s>', '{{file:.env.local:SPACED}}'])).stdout).toBe('<[secret:SPACED]>')
  })

  it('masks the base64 of a long value as the base64 command wraps it, across its lines', async () => {
    const { workspace, runtime } = await node()
    const long = 'decoy-long-0123456789-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFGH'
    appendFileSync(join(workspace, '.env.local'), `LONG=${long}\n`)
    const stdout = output(await call(runtime, 'script_run', { runtime: 'bash', script: 'printf "%s" "{{file:.env.local:LONG}}" | base64' })).stdout
    expect(stdout.trim()).toBe('[secret:LONG]')
    expect(stdout).not.toContain(Buffer.from(long).toString('base64').slice(0, 20))
  })

  it('reads the value inside quotes in shell text, and runs it there', async () => {
    const { runtime } = await node()
    expect(output(await shell(runtime, 'bash', ['-c', 'printf "token=%s" "{{file:.env.local:API_TOKEN}}"'])).stdout).toBe(`token=${LABEL}`)
    expect(output(await call(runtime, 'script_run', { runtime: 'bash', script: 'v=\'{{file:.env.local:API_TOKEN}}\'; printf "%s" "${#v}"' })).stdout).toBe(String(TOKEN.length))
  })

  it('masks a value written in two pieces, and one cut where the output reached its bound', async () => {
    const { runtime } = await node()
    expect(output(await shell(runtime, 'bash', ['-c', 'v="{{file:.env.local:API_TOKEN}}"; printf "%s" "${v:0:9}"; sleep 0.2; printf "%s" "${v:9}"'])).stdout).toBe(LABEL)
    const cut = await shell(runtime, 'bash', ['-c', 'printf "%01048570d" 0; printf "%s" "{{file:.env.local:API_TOKEN}}"'])
    const result = output(cut)
    expect(result.truncated).toBe(true)
    expect(result.stdout.endsWith(LABEL)).toBe(true)
    expect(result.stdout).not.toContain(TOKEN.slice(0, 4))
  })

  it('never puts the value in the child\'s environment', async () => {
    const { runtime } = await node()
    const environment = output(await shell(runtime, 'printenv', []))
    expect(environment.stdout).not.toContain('[secret:')
    expect(output(await shell(runtime, 'printf', ['%s', '{{file:.env.local:API_TOKEN}}'])).stdout).toBe(LABEL)
  })

  it('records the call as written, never the value, in the audit log', async () => {
    const { runtime } = await node()
    await shell(runtime, 'printf', ['%s', '{{file:.env.local:API_TOKEN}}'])
    const entries = JSON.stringify(runtime.actions.read(10))
    // The audit keeps each argument's length: the reference's 29 characters, not the value's.
    expect(entries).toContain(`[${'{{file:.env.local:API_TOKEN}}'.length} characters]`)
    expect(entries).not.toContain(`[${TOKEN.length} characters]`)
    expect(entries).not.toContain(TOKEN)
  })

  it('masks a log line the tool writes and an error it throws while it holds the value', async () => {
    const { runtime } = await node()
    const tool = runtime.registry().get('shell_exec')
    const prepare = tool.prepare.bind(tool)
    vi.spyOn(tool, 'prepare').mockImplementation((args) => {
      const prepared = prepare(args)
      return { ...prepared, execute: async () => {
        const word = (args as { args: string[] }).args[0]!
        logger.warn(`the tool saw ${word}`, { word })
        throw new ToolExecutionError(`the tool failed on ${word}`)
      } }
    })
    const warn = vi.spyOn(rootLogger().logger, 'warn')
    const error = vi.spyOn(rootLogger().logger, 'error')
    const response = await shell(runtime, 'printf', ['{{file:.env.local:API_TOKEN}}'])
    expect(response).toMatchObject({ outcome: 'error', error: { message: `the tool failed on ${LABEL}` } })
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls])
    expect(logged).toContain(`the tool saw ${LABEL}`)
    expect(logged).not.toContain(TOKEN)
  })
})

describe('the rules judge the reference as written', () => {
  it('refuses at the gate a call a deny rule meets as written', async () => {
    const { runtime } = await node()
    await withPolicy(runtime, (policy) => { policy.commands.deny = ['printf %s *API_TOKEN*'] })
    const message = refusal(await shell(runtime, 'printf', ['%s', '{{file:.env.local:API_TOKEN}}']))
    expect(message).toContain('Refused by the workspace command policy')
    expect(message).not.toContain('change how Buckle reads')
  })

  it('shows the reference, never the value, where a person is asked', async () => {
    const { runtime } = await node()
    await withPolicy(runtime, (policy) => { policy.commands.destructive = ['printf *'] })
    const response = await shell(runtime, 'printf', ['%s', '{{file:.env.local:API_TOKEN}}'])
    expect(response.outcome).toBe('approval_required')
    const waiting = JSON.stringify(runtime.approvalService.waiting())
    expect(waiting).toContain('{{file:.env.local:API_TOKEN}}')
    expect(waiting).not.toContain(TOKEN)
  })

  it('refuses a call whose value would move what a rule matched, and runs nothing', async () => {
    const { workspace, runtime } = await node()
    await withPolicy(runtime, (policy) => { policy.commands.deny = ['touch *evil*'] })
    const message = refusal(await shell(runtime, 'touch', ['{{file:.env.local:EVIL}}']))
    expect(message).toContain('change how Buckle reads the command')
    expect(message).not.toContain(EVIL)
    expect(() => realpathSync(join(workspace, EVIL))).toThrow()
    expect(output(await shell(runtime, 'touch', ['{{file:.env.local:API_TOKEN}}'])).exitCode).toBe(0)
  })

  it.each([
    ['an unquoted reference in shell text', 'bash', ['-c', 'printf %s {{file:.env.local:API_TOKEN}}'], UNQUOTED_REASON],
    ['a reference after $', 'bash', ['-c', 'printf "%s" "${{file:.env.local:API_TOKEN}}"'], EXPANSION_REASON],
    ['a reference as the program behind a wrapper', 'env', ['{{file:.env.local:API_TOKEN}}'], COMMAND_WORD_REASON],
    ['a reference as the name an assignment sets', 'bash', ['-c', '{{file:.env.local:API_TOKEN}}=x printenv'], COMMAND_WORD_REASON],
    ['a reference in an interpreter\'s call', 'node', ['-e', '"{{file:.env.local:API_TOKEN}}"'], PLACES_REASON],
  ])('refuses %s before anyone is asked', async (_what, command, args, said) => {
    const { runtime } = await node()
    expect(refusal(await shell(runtime, command, args))).toContain(said)
    expect(runtime.approvals.pending()).toEqual([])
  })
})

describe('each value checked for where it goes', () => {
  it.each([
    ['a value under 8 characters', ['%s', '{{file:.env.local:SHORT}}'], SHORT_REASON],
    ['a value a program would read as an option', ['{{file:.env.local:DASHED}}'], 'starts with -'],
    ['a NAME the file does not define', ['{{file:.env.local:MISSING}}'], 'The secret file .env.local does not define MISSING'],
  ])('refuses %s, naming the reference', async (_what, args, said) => {
    const { runtime } = await node()
    const message = refusal(await shell(runtime, 'printf', args))
    expect(message).toContain(said)
    expect(message).not.toContain('decoy')
  })

  it('refuses a value holding a quote in shell text, and takes it as a whole argument', async () => {
    const { runtime } = await node()
    expect(refusal(await shell(runtime, 'bash', ['-c', 'printf "%s" "{{file:.env.local:QUOTED}}"']))).toContain('a character a shell reads as syntax')
    expect(output(await shell(runtime, 'printf', ['%s', '{{file:.env.local:QUOTED}}'])).stdout).toBe('[secret:QUOTED]')
  })

  it('takes a value holding blanks inside quotes in shell text, where it stays one word', async () => {
    const { runtime } = await node()
    expect(output(await shell(runtime, 'bash', ['-c', 'printf "<%s>" "{{file:.env.local:SPACED}}"'])).stdout).toBe('<[secret:SPACED]>')
  })

  // A shell splits and globs the value of an unquoted parameter expansion, ${x:-word} among them, while the command reader
  // reads the expansion as one word, so a stand-in holding only a blank read the same there (review of 6de734c).
  it.each([
    ['a default', 'printf "<%s>" ${x:-{{file:.env.local:SPACED}}}'],
    ['an assigned default', 'printf "<%s>" ${x:={{file:.env.local:SPACED}}}'],
    ['an alternative', 'y=1; printf "<%s>" ${y:+{{file:.env.local:SPACED}}}'],
    ['a replacement', 'x=abc; printf "<%s>" ${x/b/{{file:.env.local:SPACED}}}'],
    ['a loop\'s word list', 'for w in ${x:-{{file:.env.local:SPACED}}}; do printf "<%s>" "$w"; done'],
    ['a nested default', 'printf "<%s>" ${x:-${y:-{{file:.env.local:SPACED}}}}'],
    ['a parameter\'s name', 'printf "<%s>" ${{{file:.env.local:SPACED}}}'],
    ['a default inside a quoted command substitution', 'printf "<%s>" "$(printf "[%s]" ${x:-{{file:.env.local:SPACED}}})"'],
  ])('refuses a reference unquoted in %s, which a shell would split', async (_what, body) => {
    const { runtime } = await node()
    expect(refusal(await shell(runtime, 'bash', ['-c', body]))).toContain(UNQUOTED_REASON)
    expect(refusal(await call(runtime, 'script_run', { runtime: 'bash', script: body }))).toContain(UNQUOTED_REASON)
  })

  it('refuses a reference after more ${ than its probe is bounded to, and reads one at the bound', () => {
    const body = (count: number) => 'v="' + '${a}'.repeat(count) + '"; printf "%s" "{{file:.env.local:API_TOKEN}}"'
    const read = (count: number) => {
      const text = body(count)
      const planned = planSecrets({ tool: 'shell_exec', pack: 'shell', args: { command: 'bash', args: ['-c', text] }, enabled: true })
      if (!('plan' in planned) || !planned.plan) throw new Error('expected a plan')
      return () => readShellReferences({ call: { command: 'bash', args: ['-c', text] }, places: [{ index: 1, references: planned.plan!.places[0]!.references }], shellText: false })
    }
    expect(read(65_536)()).toEqual(new Map([[1, 'shell']]))
    expect(read(65_537)).toThrow('than Buckle checks them against (65536 in all)')
  })

  it('runs no recursive delete a value split inside an unquoted default would make', async () => {
    const { workspace, runtime } = await node()
    appendFileSync(join(workspace, '.env.local'), 'SPLIT="decoy-file -rf decoy-dir"\n')
    mkdirSync(join(workspace, 'decoy-dir', 'inner'), { recursive: true })
    writeFileSync(join(workspace, 'decoy-file'), 'marker')
    expect(refusal(await shell(runtime, 'bash', ['-c', 'rm ${x:-{{file:.env.local:SPLIT}}}']))).toContain(UNQUOTED_REASON)
    expect(realpathSync(join(workspace, 'decoy-dir', 'inner'))).toBe(join(workspace, 'decoy-dir', 'inner'))
  })

  it.each([
    ['a default the whole expansion quotes', 'printf "<%s>" "${x:-{{file:.env.local:SPACED}}}"'],
    ['a nested default the whole expansion quotes', 'printf "<%s>" "${x:-${y:-{{file:.env.local:SPACED}}}}"'],
    ['a default whose word quotes it', 'printf "<%s>" ${x:-"{{file:.env.local:SPACED}}"}'],
    ['a default whose word single-quotes it', `printf "<%s>" \${x:-'{{file:.env.local:SPACED}}'}`],
  ])('takes a reference in %s, where it stays one word', async (_what, body) => {
    const { runtime } = await node()
    expect(output(await shell(runtime, 'bash', ['-c', body])).stdout).toBe('<[secret:SPACED]>')
  })

  it('reads the file as the call runs, not as it was judged', async () => {
    const { workspace, runtime } = await node()
    const tool = runtime.registry().get('shell_exec')
    const prepare = tool.prepare.bind(tool)
    let rewritten = false
    vi.spyOn(tool, 'prepare').mockImplementation((args) => {
      if (!rewritten) {
        rewritten = true
        writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}-changed\n`)
      }
      return prepare(args)
    })
    expect(output(await shell(runtime, 'printf', ['%s', '{{file:.env.local:API_TOKEN}}'])).stdout).toBe(LABEL)
  })
})

describe('a browser fill', () => {
  const context = (): ToolContext => ({ requestId: 'r', sessionId: 's', timeoutMs: 1_000, signal: new AbortController().signal })
  const NO_RULES = createPermissionEngine([])

  async function setup() {
    const { workspace } = await node()
    const real = join(workspace, '.env.local')
    // What the browser pack records of each call's secretFills, as its sessions.json holds them.
    const held: FilledSecret[] = []
    const filled = { list: async () => held }
    const seen: JsonObject[] = []
    const browserCall = (args: JsonObject, page: (args: JsonObject) => JsonValue) => {
      const planned = planSecrets({ tool: 'browser_command', pack: 'browser', args, enabled: true })
      if ('refusal' in planned) throw new Error(planned.refusal)
      const effects = planned.plan ? [...planned.plan.files].map(([written, names]) => ({ kind: 'secret_file' as const, path: real, written: [written], names })) : []
      const checked = planned.plan ? checkSecrets({ tool: 'browser_command', args, plan: planned.plan, effects }) : null
      const prepare = (passed: JsonObject): PreparedCall => ({ effects: [], execute: async (ran) => { held.push(...ran.secretFills ?? []); seen.push(passed); return page(passed) } })
      return runWithSecrets({ checked, filled, tool: 'browser_command', args, prepare, execute: prepare(args).execute, permissions: NO_RULES, context: context(), protectedRoots: [], roots: [workspace] })
    }
    return { workspace, filled, seen, browserCall }
  }

  it('enters the value, masks what the browser answers, and masks the page in every later browser call', async () => {
    const { filled, seen, browserCall } = await setup()
    const filledPage = await browserCall({ command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] }, passed => ({ filled: (passed.args as string[])[1]! }))
    expect((seen[0]!.args as string[])[1]).toBe(TOKEN)
    expect(filledPage).toEqual({ filled: LABEL })
    expect(await filled.list()).toMatchObject([{ written: '.env.local', name: 'API_TOKEN' }])
    const snapshot = await browserCall({ command: 'snapshot', args: [] }, () => ({ result: `textbox "Token": ${TOKEN}`, eval: Buffer.from(TOKEN).toString('base64') }))
    expect(snapshot).toEqual({ result: `textbox "Token": ${LABEL}`, eval: LABEL })
  })

  it('refuses a later browser call whose filled value can no longer be read, as its result could not be masked', async () => {
    const { workspace, browserCall } = await setup()
    await browserCall({ command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] }, () => 'ok')
    writeFileSync(join(workspace, '.env.local'), 'OTHER=decoy-other-0123\n')
    await expect(browserCall({ command: 'snapshot', args: [] }, () => TOKEN)).rejects.toThrow('can no longer be read, so this browser call\'s result could not be masked')
  })

  it('refuses a later browser call once the filled value changed in its file, as the page still holds the old one', async () => {
    const { workspace, browserCall } = await setup()
    await browserCall({ command: 'fill', args: ['@e5', '{{file:.env.local:API_TOKEN}}'] }, () => 'ok')
    writeFileSync(join(workspace, '.env.local'), `API_TOKEN=${TOKEN}-rotated\n`)
    await expect(browserCall({ command: 'snapshot', args: [] }, () => TOKEN)).rejects.toThrow('changed since this browser was filled with it')
  })

  it('refuses fill text a program would read as an option', async () => {
    const { seen, browserCall } = await setup()
    await expect(browserCall({ command: 'fill', args: ['@e5', '{{file:.env.local:DASHED}}'] }, () => 'ok')).rejects.toThrow('starts with -')
    expect(seen).toEqual([])
  })
})

describe('a web_fetch header', () => {
  let first: Server
  let second: Server
  let ports: [number, number]
  const seen: IncomingHttpHeaders[] = []
  beforeAll(async () => {
    const listen = async (server: Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return (server.address() as AddressInfo).port }
    second = createServer((request, response) => { seen.push(request.headers); response.end('second') })
    first = createServer((request, response) => {
      seen.push(request.headers)
      if (request.url === '/away') {
        response.writeHead(302, { location: `http://127.0.0.1:${ports[1]}/` })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json', 'x-echo': String(request.headers['x-api-key']) })
      response.end(JSON.stringify({ received: request.headers['x-api-key'] }))
    })
    ports = [await listen(first), await listen(second)]
  })
  afterAll(() => { first.close(); second.close() })

  async function approvedFetch(runtime: CoreRuntime, path: string): Promise<InvokeResponse> {
    const args = { url: `http://127.0.0.1:${ports[0]}${path}`, headers: { 'X-Api-Key': '{{file:.env.local:API_TOKEN}}' } }
    let response = await call(runtime, 'web_fetch', args)
    for (let round = 0; round < 3 && response.outcome === 'approval_required'; round++) {
      for (const approval of response.approvals) await runtime.approvalService.answer({ decision: { token: approval.token, approved: true, scope: 'session' }, source: SOURCES.cli })
      response = await call(runtime, 'web_fetch', args)
    }
    return response
  }

  it('sends the value in the header and masks the echo in the response headers and body', async () => {
    const { runtime } = await node('fs,web')
    seen.length = 0
    const response = await approvedFetch(runtime, '/')
    expect(seen.at(-1)?.['x-api-key']).toBe(TOKEN)
    expect(response).toMatchObject({ outcome: 'ok', output: { headers: { 'x-echo': LABEL }, body: JSON.stringify({ received: LABEL }) } })
    expect(JSON.stringify(response)).not.toContain(TOKEN)
  })

  it('drops the header on a hop to another origin', async () => {
    const { runtime } = await node('fs,web')
    await withPolicy(runtime, (policy) => { policy.network.allow = [`http://127.0.0.1:${ports[0]}`, `http://127.0.0.1:${ports[1]}`] })
    seen.length = 0
    const response = await approvedFetch(runtime, '/away')
    expect(response).toMatchObject({ outcome: 'ok', output: { body: 'second' } })
    expect(seen.at(-2)?.['x-api-key']).toBe(TOKEN)
    expect(seen.at(-1)?.['x-api-key']).toBeUndefined()
  })
})
