import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintApprovalKey } from '@5straps/protocol/envelope'
import { createRuntimeOwner } from '@5straps/runtime'
import { runInit } from '../cli/init.js'
import { tokenDigest } from '../common/services/access/tokens.js'
import { holdServe, serviceDirectory } from '../common/services/node-service/serve-record.js'

let root: string
let workspace: string
let out: string
let requests: Array<{ url: string; body: Record<string, unknown> }>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'buckle-pairing-'))
  workspace = join(root, 'workspace')
  out = join(root, 'node.env')
  mkdirSync(workspace)
  vi.stubEnv('BUCKLE_STATE_DIR', join(root, 'state'))
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: { body: string }) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> })
    return new Response(JSON.stringify({ server: { id: 'paired', name: 'Paired' } }), { status: 201, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

function init(extra: string[] = []) {
  return runInit(['--root', workspace, '--out', out, '--name', 'Paired', '--port', '4399', '--yes', ...extra], undefined, { home: root })
}

/** Rings mints a report credential, and since RINGS-D20 an approval key, in its redeem answer, readable that once. */
function ringsMinting(reportToken: string, approvalKey?: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: URL, init: { body: string }) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) as Record<string, unknown> })
    return new Response(JSON.stringify({ server: { id: 'paired', name: 'Paired' }, reportToken, ...(approvalKey === undefined ? {} : { approvalKey }) }), { status: 201, headers: { 'content-type': 'application/json' } })
  }))
}

/** The workspace and token label holding `token`, from the registry, which keeps its digest alone (D83). */
function holderOf(token: unknown): { workspace: string; label: string } | null {
  const registry = JSON.parse(readFileSync(join(root, 'state', 'workspaces.json'), 'utf8')) as { workspaces: { id: string; dir: string; tokens: { sha256: string; label: string }[] }[] }
  for (const workspace of registry.workspaces) {
    const held = workspace.tokens.find(item => typeof token === 'string' && item.sha256 === tokenDigest(token))
    if (held) return { workspace: workspace.dir, label: held.label }
  }
  return null
}

async function initSilently(extra: string[]): Promise<{ exitCode: number; printed: string }> {
  let printed = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
  try {
    return { exitCode: (await init(extra)).exitCode, printed }
  } finally { out.mockRestore(); error.mockRestore() }
}

describe('buckle init --pair', () => {
  it('sends the node URL, the workspace\'s token, the admin credential and the manifest in one body, never in argv', async () => {
    expect((await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001', '--url', 'http://node.test:4399'])).exitCode).toBe(0)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('http://rings.test:3001/api/v1/harness-servers/pairing/redeem')
    const written = parseEnv(readFileSync(out, 'utf8'))
    expect(requests[0]!.body).toMatchObject({
      code: 'ABCD-EFGH-JKMN',
      name: 'Paired',
      baseUrl: 'http://node.test:4399',
      adminToken: written.BUCKLE_ADMIN_TOKEN,
    })
    // D83: Rings calls /mcp and /v1 with the token of the workspace init just set up, which serve that workspace.
    const authToken = requests[0]!.body.authToken as string
    expect(holderOf(authToken)).toEqual({ workspace, label: 'buckle init' })
    expect(written.BUCKLE_AUTH_TOKEN).toBeUndefined()
    expect((requests[0]!.body.manifest as { serverId: string }).serverId).toBe(written.BUCKLE_SERVER_ID)
    expect(process.argv.join(' ')).not.toContain(authToken)
  })

  it('defaults the node URL to this host and refuses a code with no Rings to redeem it at', async () => {
    expect((await init(['--pair', 'ABCD-EFGH-JKMN'])).exitCode).toBe(1)
    expect(requests).toHaveLength(0)

    expect((await init(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001', '--force'])).exitCode).toBe(0)
    expect(requests[0]!.body.baseUrl).toBe('http://127.0.0.1:4399')
  })

  it('re-pairs a configured node with its admin credential, a token minted for Rings, and the URL it moved to', async () => {
    await initSilently([])
    const before = readFileSync(out, 'utf8')

    expect((await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001', '--url', 'http://moved.test:4399'])).exitCode).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe(before)
    expect(requests[0]!.body).toMatchObject({ baseUrl: 'http://moved.test:4399', adminToken: parseEnv(before).BUCKLE_ADMIN_TOKEN })
    // The workspace's first token was shown once and is kept as its digest alone, so Rings gets one of its own.
    expect(holderOf(requests[0]!.body.authToken)).toEqual({ workspace, label: 'Rings' })
  })

  it('writes the report credential Rings minted into the environment file, and never prints it', async () => {
    const reportToken = 'rings-minted-report-token-fixture'
    ringsMinting(reportToken)

    const result = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])

    expect(result.exitCode).toBe(0)
    const written = parseEnv(readFileSync(out, 'utf8'))
    expect(written.BUCKLE_REPORT_TOKEN).toBe(reportToken)
    expect(written.BUCKLE_REPORT_URL).toBe('http://rings.test:3001/api/v1/buckle-reports')
    expect(written.BUCKLE_APPROVAL_WEBHOOK).toBe('http://rings.test:3001/api/v1/buckle-approvals')
    expect(result.printed).not.toContain(reportToken)
    expect(result.printed).toContain('Restart any running Buckle service')
    expect(process.argv.join(' ')).not.toContain(reportToken)
  })

  // Phase 3, item 7: where a service runs the node, the restart that loads the credential is buckle service restart.
  it.skipIf(process.platform !== 'linux')('names buckle service restart for the new credential where a service runs this node', async () => {
    ringsMinting('service-report-token-fixture')
    const config = join(root, 'config')
    mkdirSync(join(config, 'systemd', 'user'), { recursive: true })
    writeFileSync(join(config, 'systemd', 'user', 'buckle.service'), `[Service]\nExecStart="/usr/bin/node" "/opt/main.js" serve --service systemd --state-dir "${join(root, 'state')}"\n`)
    vi.stubEnv('XDG_CONFIG_HOME', config)
    const result = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])
    expect(result.exitCode).toBe(0)
    expect(result.printed).toContain('Restart the node with buckle service restart to load the new credential.')
    expect(result.printed).not.toContain('Restart any running Buckle service')
  })

  it('takes the rotated credential when a configured node pairs again, and keeps its own two', async () => {
    ringsMinting('first-report-token-fixture-value')
    await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])
    const first = parseEnv(readFileSync(out, 'utf8'))

    ringsMinting('rotated-report-token-fixture-value')
    await initSilently(['--pair', 'PQRS-TVWX-YZ23', '--rings', 'http://rings.test:3001'])

    const second = parseEnv(readFileSync(out, 'utf8'))
    expect(second.BUCKLE_REPORT_TOKEN).toBe('rotated-report-token-fixture-value')
    expect(second.BUCKLE_ADMIN_TOKEN).toBe(first.BUCKLE_ADMIN_TOKEN)
    expect(holderOf(requests[0]!.body.authToken)).toEqual({ workspace, label: 'buckle init' })
    expect(holderOf(requests[1]!.body.authToken)).toEqual({ workspace, label: 'Rings' })
  })

  it.each([
    ['a line break that would set node settings', 'rt-fixture-value-0001\nBUCKLE_ALLOW_HOST_GIT=true\nBUCKLE_ALLOW_SHELL=true'],
    ['a carriage return', 'rt-fixture-value-0001\rBUCKLE_ALLOW_HOST_GIT=true'],
    ['a space and a comment', 'rt-fixture-value-0001 # note'],
    ['a quote', 'rt-fixture"value-0001'],
    ['too few characters', 'short'],
  ])('refuses a report credential holding %s, and writes nothing', async (_, reportToken) => {
    await init()
    const before = readFileSync(out, 'utf8')
    ringsMinting(reportToken)

    const result = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])

    expect(result.exitCode).toBe(1)
    expect(result.printed).toContain('report credential Buckle does not accept')
    expect(result.printed).not.toContain(reportToken)
    expect(readFileSync(out, 'utf8')).toBe(before)
    const written = parseEnv(before)
    expect(written.BUCKLE_ALLOW_HOST_GIT).not.toBe('true')
    expect(written.BUCKLE_REPORT_TOKEN).toBeUndefined()
  })

  it('asks for an approval key and writes the one Rings minted to the environment file, never printing it', async () => {
    const approvalKey = mintApprovalKey()
    ringsMinting('rings-minted-report-token-fixture', approvalKey)

    const result = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])

    expect(result.exitCode).toBe(0)
    expect(requests[0]!.body.approvalEnvelope).toBe(1)
    expect(parseEnv(readFileSync(out, 'utf8')).BUCKLE_RINGS_APPROVAL_KEY).toBe(approvalKey)
    expect(result.printed).not.toContain(approvalKey)
  })

  it('rotates the key on a re-pair, and drops it when Rings mints none', async () => {
    ringsMinting('first-report-token-fixture-value', mintApprovalKey())
    await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])
    const rotated = mintApprovalKey()
    ringsMinting('second-report-token-fixture-value', rotated)
    await initSilently(['--pair', 'PQRS-TVWX-YZ23', '--rings', 'http://rings.test:3001'])
    expect(parseEnv(readFileSync(out, 'utf8')).BUCKLE_RINGS_APPROVAL_KEY).toBe(rotated)

    ringsMinting('third-report-token-fixture-value')
    await initSilently(['--pair', 'ABCD-EFGH-JKM2', '--rings', 'http://rings.test:3001'])
    expect(parseEnv(readFileSync(out, 'utf8')).BUCKLE_RINGS_APPROVAL_KEY).toBeUndefined()
  })

  it.each([
    ['a line break that would set node settings', `${'a'.repeat(43)}\nBUCKLE_ALLOW_HOST_GIT=true`],
    ['the wrong length', 'a'.repeat(42)],
    ['a character outside base64url', `${'a'.repeat(42)}+`],
  ])('refuses an approval key holding %s, and writes nothing', async (_, approvalKey) => {
    await init()
    const before = readFileSync(out, 'utf8')
    ringsMinting('rings-minted-report-token-fixture', approvalKey)

    const result = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])

    expect(result.exitCode).toBe(1)
    expect(result.printed).toContain('approval key Buckle does not accept')
    expect(readFileSync(out, 'utf8')).toBe(before)
  })

  it('keeps every other line and leaves the file owner-only when it writes the credential (RINGS-D20)', async () => {
    await init()
    chmodSync(out, 0o640)
    const before = readFileSync(out, 'utf8')
    ringsMinting('rings-minted-report-token-fixture')

    expect((await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])).exitCode).toBe(0)

    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600)
    const after = readFileSync(out, 'utf8')
    const untouched = (text: string) => text.split('\n').filter(line => !/^#?\s*BUCKLE_(REPORT_URL|REPORT_TOKEN|APPROVAL_WEBHOOK)=/.test(line))
    expect(untouched(after)).toEqual(untouched(before))
  })

  it('names the environment file in the start command after pairing a custom --out file', async () => {
    const result = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])

    expect(result.exitCode).toBe(0)
    expect(result.printed).toContain(`Start it with: BUCKLE_ENV_FILE=${out} buckle serve`)
  })

  // Fix brief 6, item 11 (finding 33 of recheck 4): the last line named `buckle serve`, which is refused beside a running node.
  it('ends with buckle service start where a unit for the node is installed, and says nothing to start where a node runs', async () => {
    await init()
    const state = join(root, 'state')
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'))
    mkdirSync(join(root, 'config', 'systemd', 'user'), { recursive: true })
    writeFileSync(join(root, 'config', 'systemd', 'user', 'buckle.service'), `[Service]\nExecStart="/usr/bin/node" "/opt/buckle/dist/main.js" serve --service systemd --state-dir "${state}"\n`)

    const installed = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])
    expect(installed.exitCode).toBe(0)
    expect(installed.printed).toContain(`Start it with: BUCKLE_ENV_FILE=${out} buckle service start`)
    expect(installed.printed).not.toContain('buckle serve')

    const owner = createRuntimeOwner({ name: 'fake-node', services: [] })
    await holdServe({ stateDirectory: state, owner })
    writeFileSync(join(serviceDirectory(state), 'serve.json'), JSON.stringify({ pid: 424_244, manager: 'systemd', version: '0.1.4', host: '127.0.0.1', port: 4399, startedAt: '2026-10-16T00:00:00.000Z' }))
    try {
      const running = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])
      expect(running.exitCode).toBe(0)
      expect(running.printed).toContain('Rings will reach it at http://127.0.0.1:4399.')
      expect(running.printed).not.toContain('Start it with')
    } finally { await owner.close() }
  })

  it('pairs a node whose file is buckle.env in its state directory: written there owner-only, and named in the messages', async () => {
    ringsMinting('rings-minted-report-token-fixture')
    let printed = ''
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
    try {
      expect((await runInit(['--root', workspace, '--name', 'Paired', '--port', '4399', '--yes', '--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'], undefined, { home: root })).exitCode).toBe(0)
    } finally { stdout.mockRestore() }

    const file = join(root, 'state', 'buckle.env')
    expect(parseEnv(readFileSync(file, 'utf8')).BUCKLE_REPORT_TOKEN).toBe('rings-minted-report-token-fixture')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(printed).toContain(`written to ${file}`)
    expect(printed).toContain(`Start it with: BUCKLE_STATE_DIR=${join(root, 'state')} buckle serve`)
  })

  it('stays paired when Rings mints nothing, leaving the report settings to the operator', async () => {
    const result = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])

    expect(result.exitCode).toBe(0)
    expect(parseEnv(readFileSync(out, 'utf8')).BUCKLE_REPORT_TOKEN).toBeUndefined()
  })

  it('fails the pairing when the environment file holds a key line Buckle does not edit, without printing the key (RINGS-D20)', async () => {
    await init()
    const handWritten = mintApprovalKey()
    writeFileSync(out, `${readFileSync(out, 'utf8')}export BUCKLE_RINGS_APPROVAL_KEY=${handWritten}\n`)
    const before = readFileSync(out, 'utf8')
    const approvalKey = mintApprovalKey()
    ringsMinting('rings-minted-report-token-fixture', approvalKey)

    const result = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])

    expect(result.exitCode).toBe(1)
    expect(result.printed).toContain('The report credential and approval key Rings minted for this node were not saved')
    expect(result.printed).toContain('issue a new pairing code for this node in Rings and run buckle init --pair <code> --rings <Rings URL> again')
    expect(result.printed).not.toContain('Start it with')
    for (const secret of [approvalKey, handWritten, 'rings-minted-report-token-fixture']) expect(result.printed).not.toContain(secret)
    expect(readFileSync(out, 'utf8')).toBe(before)
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('fails the pairing when the environment file cannot be written, without printing the key (RINGS-D20)', async () => {
    await init()
    const approvalKey = mintApprovalKey()
    ringsMinting('rings-minted-report-token-fixture', approvalKey)
    // The first init made the state directory, so only the directory holding the environment file refuses writes.
    chmodSync(root, 0o500)
    try {
      const result = await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])

      expect(result.exitCode).toBe(1)
      expect(result.printed).toContain(`were not saved, and Rings already holds them, so reports and approvals between Rings and this node fail until it is paired again. ${out} could not be written`)
      expect(result.printed).not.toContain(approvalKey)
      expect(parseEnv(readFileSync(out, 'utf8')).BUCKLE_RINGS_APPROVAL_KEY).toBeUndefined()
    } finally { chmodSync(root, 0o700) }
  })

  it('reports a refusal from Rings and keeps the environment file it wrote', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'That pairing code is unknown, already used or expired.' }), { status: 400, headers: { 'content-type': 'application/json' } })))
    expect((await init(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])).exitCode).toBe(1)
    expect(readFileSync(out, 'utf8')).toContain('BUCKLE_ADMIN_TOKEN=')
  })
})
