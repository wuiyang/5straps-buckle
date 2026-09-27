import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mintApprovalKey } from '@5straps/protocol/envelope'
import { runInit } from '../cli/init.js'

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

async function initSilently(extra: string[]): Promise<{ exitCode: number; printed: string }> {
  let printed = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
  const error = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { printed += String(chunk); return true })
  try {
    return { exitCode: (await init(extra)).exitCode, printed }
  } finally { out.mockRestore(); error.mockRestore() }
}

describe('buckle init --pair', () => {
  it('sends the node URL, both credentials and the manifest in one body, never in argv', async () => {
    expect((await init(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001', '--url', 'http://node.test:4399'])).exitCode).toBe(0)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('http://rings.test:3001/api/v1/harness-servers/pairing/redeem')
    const written = parseEnv(readFileSync(out, 'utf8'))
    expect(requests[0]!.body).toMatchObject({
      code: 'ABCD-EFGH-JKMN',
      name: 'Paired',
      baseUrl: 'http://node.test:4399',
      authToken: written.BUCKLE_AUTH_TOKEN,
      adminToken: written.BUCKLE_ADMIN_TOKEN,
    })
    expect((requests[0]!.body.manifest as { serverId: string }).serverId).toBe(written.BUCKLE_SERVER_ID)
    expect(process.argv.join(' ')).not.toContain(written.BUCKLE_AUTH_TOKEN)
  })

  it('defaults the node URL to this host and refuses a code with no Rings to redeem it at', async () => {
    expect((await init(['--pair', 'ABCD-EFGH-JKMN'])).exitCode).toBe(1)
    expect(requests).toHaveLength(0)

    expect((await init(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001', '--force'])).exitCode).toBe(0)
    expect(requests[0]!.body.baseUrl).toBe('http://127.0.0.1:4399')
  })

  it('re-pairs a configured node with its existing credentials and the URL it moved to', async () => {
    await init()
    const before = readFileSync(out, 'utf8')

    expect((await init(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001', '--url', 'http://moved.test:4399'])).exitCode).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe(before)
    expect(requests[0]!.body).toMatchObject({ baseUrl: 'http://moved.test:4399', authToken: parseEnv(before).BUCKLE_AUTH_TOKEN })
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

  it('takes the rotated credential when a configured node pairs again, and keeps its own two', async () => {
    ringsMinting('first-report-token-fixture-value')
    await initSilently(['--pair', 'ABCD-EFGH-JKMN', '--rings', 'http://rings.test:3001'])
    const first = parseEnv(readFileSync(out, 'utf8'))

    ringsMinting('rotated-report-token-fixture-value')
    await initSilently(['--pair', 'PQRS-TVWX-YZ23', '--rings', 'http://rings.test:3001'])

    const second = parseEnv(readFileSync(out, 'utf8'))
    expect(second.BUCKLE_REPORT_TOKEN).toBe('rotated-report-token-fixture-value')
    expect(second.BUCKLE_AUTH_TOKEN).toBe(first.BUCKLE_AUTH_TOKEN)
    expect(second.BUCKLE_ADMIN_TOKEN).toBe(first.BUCKLE_ADMIN_TOKEN)
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
    // The state directory is made first, so only the directory holding the environment file refuses writes.
    mkdirSync(join(root, 'state'))
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
