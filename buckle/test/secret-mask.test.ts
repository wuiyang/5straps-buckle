import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFileActionLog } from '../common/adapters/action-log/file-action-log.js'
import { createFileGrantStore } from '../common/adapters/grant-store/file-grant-store.js'
import { logger, rootLogger } from '../common/runtime/log.js'
import { createApprovalRegistry } from '../common/services/approvals/approval-registry.js'
import { createApprovalService } from '../common/services/approvals/approval-service.js'
import { NO_INTERACTION } from '../common/services/approvals/interaction.js'
import { createMasker, holdMasker, maskForms, maskHeld, masksHeld } from '../common/services/secrets/mask.js'
import { fixedInteraction } from './support/interaction.js'

// The secret-references slice, part 6 (docs/secrets.md): every resolved value is shown as [secret:NAME] wherever text
// leaves Buckle, in its common encodings too when they are at least 8 characters, and every log line, audit entry, and
// approval view written while a call holds values is masked by them.

const VALUE = 'decoy+value/0123=:'
const masker = () => createMasker([{ name: 'API_TOKEN', value: VALUE }])
const LABEL = '[secret:API_TOKEN]'

describe('the forms a value is masked in', () => {
  it('holds the value, its URL encodings, its base64 forms, and its JSON escape', () => {
    const forms = maskForms('a b/c"d\\e+f')
    expect(forms).toEqual(expect.arrayContaining(['a b/c"d\\e+f', 'a%20b%2Fc%22d%5Ce%2Bf', 'a+b%2Fc%22d%5Ce%2Bf', 'a%20b%2fc%22d%5ce%2bf', Buffer.from('a b/c"d\\e+f').toString('base64'), Buffer.from('a b/c"d\\e+f').toString('base64url'), 'a b/c\\"d\\\\e+f']))
  })

  it('leaves out a form shorter than 8 characters', () => {
    expect(maskForms('abcdefgh').every(form => form.length >= 8)).toBe(true)
    expect(maskForms('abcdefgh')).not.toContain('')
  })
})

describe('a call\'s masker', () => {
  it('masks the value, its URL encoding, and its base64 wherever they stand in text', () => {
    const mask = masker().text
    expect(mask(`token ${VALUE} again ${VALUE}`)).toBe(`token ${LABEL} again ${LABEL}`)
    expect(mask(`https://x.test/?key=${encodeURIComponent(VALUE)}&b=1`)).toBe(`https://x.test/?key=${LABEL}&b=1`)
    expect(mask(`echoed ${Buffer.from(VALUE).toString('base64')}.`)).toBe(`echoed ${LABEL}.`)
    expect(mask(`{"token":${JSON.stringify(`${VALUE}"`)}}`)).not.toContain('0123=')
  })

  it('masks a value base64 encoded after other bytes, as a Basic authorization holds it', () => {
    for (const user of ['u:', 'us:', 'use:']) {
      const header = `Authorization: Basic ${Buffer.from(`${user}${VALUE}`).toString('base64')}`
      const masked = masker().text(header)
      expect(masked).toContain(LABEL)
      // What is left of the encoded run is the user's own characters, and at most the characters the bytes around the
      // value also decide: never a run of the value's own.
      const [before, after] = masked.slice('Authorization: Basic '.length).split(LABEL)
      expect(before!.length).toBeLessThanOrEqual(Math.ceil((user.length * 8) / 6))
      expect(after!.replace(/=+$/, '').length).toBeLessThanOrEqual(1)
    }
  })

  it('masks the base64 of a long value wrapped across lines, as the base64 command, openssl, and MIME write it', () => {
    const long = 'decoy-long-0123456789-abcdefghijklmnopqrstuvwxyz-0123456789-ABCDEFGH'
    const mask = createMasker([{ name: 'LONG', value: long }]).text
    const wrapped = (text: string, width: number, end = '\n') => `${text.match(new RegExp(`.{1,${width}}`, 'g'))!.join(end)}${end}`
    const encoded = Buffer.from(long).toString('base64')
    expect(mask(wrapped(encoded, 76))).toBe('[secret:LONG]\n')
    expect(mask(`out:\n${wrapped(encoded, 64)}done`)).toBe('out:\n[secret:LONG]\ndone')
    expect(mask(wrapped(encoded, 76, '\r\n'))).toBe('[secret:LONG]\r\n')
    // Inside a longer run, as `echo "user:$TOKEN" | base64` writes a Basic authorization's value, wrapped.
    const header = wrapped(Buffer.from(`user:${long}`).toString('base64'), 76)
    const masked = mask(header)
    expect(masked).toContain('[secret:LONG]')
    const [before, after] = masked.split('[secret:LONG]')
    expect(before!.replace(/\s/g, '').length).toBeLessThanOrEqual(Math.ceil((5 * 8) / 6))
    expect(after!.replace(/[\s=]/g, '').length).toBeLessThanOrEqual(1)
    // Lines of other text are left as they are.
    expect(mask('abcdefgh\nijklmnop\n')).toBe('abcdefgh\nijklmnop\n')
  })

  it('masks a value cut at the end of a text, where a stream reached its bound', () => {
    const mask = masker()
    expect(mask.text(`output ${VALUE.slice(0, 6)}`)).toBe(`output ${LABEL}`)
    expect(mask.text(`output ${VALUE.slice(0, 3)}`)).toBe(`output ${VALUE.slice(0, 3)}`)
    // Where the result says its output was cut, even a value's first character at the end is masked.
    expect(mask.json({ stdout: `output ${VALUE.slice(0, 2)}`, stderr: 'plain', truncated: true })).toEqual({ stdout: `output ${LABEL}`, stderr: 'plain', truncated: true })
    expect(mask.text(`output ${VALUE.slice(0, 9)}\uFFFD`)).toBe(`output ${LABEL}\uFFFD`)
  })

  it('masks every string of a value, its keys and errors included', () => {
    const masked = masker().json({ [VALUE]: [VALUE, { deeper: `x${VALUE}y` }], count: 3, error: new Error(`failed with ${VALUE}`) })
    expect(JSON.stringify(masked)).not.toContain(VALUE)
    expect(masked).toMatchObject({ [LABEL]: [LABEL, { deeper: `x${LABEL}y` }], count: 3 })
    expect((masked.error as Error).message).toBe(`failed with ${LABEL}`)
  })

  it('masks the longer of two values that hold each other whole', () => {
    const mask = createMasker([{ name: 'SHORT', value: 'abcdefgh' }, { name: 'LONG', value: 'abcdefgh-ijklmnop' }]).text
    expect(mask('abcdefgh-ijklmnop and abcdefgh')).toBe('[secret:LONG] and [secret:SHORT]')
  })

  it('masks a value URL-encoded by an encoder that escapes other characters than encodeURIComponent', () => {
    const value = 'decoy!tok~en(0123)*xyz \'q'
    const mask = createMasker([{ name: 'PUNCT', value }]).text
    const label = '[secret:PUNCT]'
    const escaped = (keep: RegExp, hex: (code: string) => string) => [...Buffer.from(value)].map(byte => keep.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${hex(byte.toString(16).padStart(2, '0'))}`).join('')
    // A form post (URLSearchParams), RFC 3986 as curl and jq @uri write it, and every character but a letter or digit,
    // in either case of hex, with + for a blank.
    expect(mask(`k=${new URLSearchParams({ k: value }).toString().slice(2)}&n=1`)).toBe(`k=${label}&n=1`)
    expect(mask(`k=${escaped(/[A-Za-z0-9\-._~]/, code => code.toUpperCase())}`)).toBe(`k=${label}`)
    expect(mask(`k=${escaped(/[A-Za-z0-9]/, code => code.toUpperCase())}`)).toBe(`k=${label}`)
    expect(mask(`k=${escaped(/[A-Za-z0-9]/, code => code).replace(/%20/g, '+')}`)).toBe(`k=${label}`)
    // Python's quote leaves / as it is.
    const slashed = createMasker([{ name: 'SLASHED', value: 'decoy/slash+key/0123456789' }]).text
    expect(slashed('decoy/slash%2Bkey/0123456789')).toBe('[secret:SLASHED]')
    // A non-ASCII character as the UTF-8 bytes it is written in.
    const accented = createMasker([{ name: 'ACCENTED', value: 'decoy-café-0123' }]).text
    expect(accented('q=decoy%2Dcaf%C3%A9%2D0123')).toBe('q=[secret:ACCENTED]')
  })

  it('masks a URL-encoded value beside text it does not hold, and leaves a part of it alone', () => {
    const mask = createMasker([{ name: 'PUNCT', value: 'decoy!tok~en(0123)*xyz' }]).text
    expect(mask('a%21 decoy%21tok%7Een%280123%29*xyz+%7E plain')).toBe('a%21 [secret:PUNCT]+%7E plain')
    expect(mask('decoy%21tok%7Een%280123%29*xy end')).toBe('decoy%21tok%7Een%280123%29*xy end')
  })

  it('masks a value JSON-escaped as PHP, Go, and Python write it, and as HTML entities', () => {
    // PHP's json_encode writes / as \/; Go's encoding/json and Rails write & < > as & < >; Python's json
    // writes a character beyond ASCII as \u escapes, a pair of them beyond the first plane.
    const slashed = createMasker([{ name: 'SLASHED', value: 'decoy/slash+key/0123456789' }]).text
    expect(slashed('{"received":"decoy\\/slash+key\\/0123456789"}')).toBe('{"received":"[secret:SLASHED]"}')
    const marked = createMasker([{ name: 'MARKED', value: 'decoy&amp<key>0123456789' }]).text
    expect(marked('{"k":"decoy\\u0026amp\\u003ckey\\u003E0123456789"}')).toBe('{"k":"[secret:MARKED]"}')
    const accented = createMasker([{ name: 'ACCENTED', value: 'decoy-café-\u{1F600}-0123' }]).text
    expect(accented('{"k": "decoy-caf\\u00e9-\\ud83d\\ude00-0123"}')).toBe('{"k": "[secret:ACCENTED]"}')
    // An HTML page, or a value attribute get html shows, by named and numbered entities.
    expect(marked('<input value="decoy&amp;amp&lt;key&gt;0123456789">')).toBe('<input value="[secret:MARKED]">')
    expect(marked('decoy&#38;amp&#x3C;key&#062;0123456789')).toBe('[secret:MARKED]')
    const quoted = createMasker([{ name: 'QUOTED', value: 'decoy"it\'s"0123' }]).text
    expect(quoted('value="decoy&quot;it&#39;s&quot;0123"')).toBe('value="[secret:QUOTED]"')
    expect(quoted('value=\'decoy"it&apos;s"0123\'')).toBe('value=\'[secret:QUOTED]\'')
  })

  it('masks nothing once dropped', () => {
    const mask = masker()
    mask.drop()
    expect(mask.text(VALUE)).toBe(VALUE)
  })
})

describe('while a call holds values', () => {
  const roots: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('masks each log line and its fields as it is written, and nothing once released', () => {
    const warn = vi.spyOn(rootLogger().logger, 'warn').mockImplementation(() => undefined)
    const release = holdMasker(masker())
    expect(masksHeld()).toBe(true)
    logger.warn(`could not reach ${VALUE}`, { url: `https://x.test/${encodeURIComponent(VALUE)}`, error: new Error(`refused ${VALUE}`) })
    release()
    expect(masksHeld()).toBe(false)
    logger.warn(`plain ${VALUE}`)
    const [message, fields] = warn.mock.calls[0]!
    expect(message).toBe(`could not reach ${LABEL}`)
    expect(fields).toMatchObject({ url: `https://x.test/${LABEL}` })
    expect(((fields as { error: Error }).error).message).toBe(`refused ${LABEL}`)
    expect(warn.mock.calls[1]![0]).toBe(`plain ${VALUE}`)
    expect(maskHeld(VALUE)).toBe(VALUE)
  })

  it('masks an audit entry before it reaches the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-secret-mask-'))
    roots.push(root)
    const log = createFileActionLog(join(root, 'actions.jsonl'))
    const release = holdMasker(masker())
    try {
      await log.record({ at: new Date().toISOString(), requestId: 'r1', sessionId: 's1', tool: 'shell_exec', outcome: 'error', durationMs: 1, effects: [], args: { args: [VALUE] }, event: 'result', detail: `x${VALUE}` })
    } finally { release() }
    const text = readFileSync(join(root, 'actions.jsonl'), 'utf8')
    expect(text).not.toContain(VALUE)
    expect(text).toContain(LABEL)
  })

  it('masks what a person reads of an ask, and keeps the subject a grant binds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'buckle-secret-mask-'))
    roots.push(root)
    const grants = createFileGrantStore({ filePath: join(root, 'grants.json'), workspace: root })
    const registry = createApprovalRegistry(grants, join(root, 'approvals.json'), root, 15_000)
    const service = createApprovalService({ registry, workspaceId: 'default', serverId: 'test-node', graceMs: 15_000, interaction: fixedInteraction(NO_INTERACTION) })
    const release = holdMasker(masker())
    try {
      await service.request({ sessionId: 'chat-1', requestId: 'request-1', tool: 'shell_exec', asks: [{ kind: 'ask', rule: 'write_scope', subject: '/w/out', reason: `writes ${VALUE}`, offeredScopes: ['once'] }], call: { arguments: { args: [VALUE] }, cwd: '/w', description: `runs ${VALUE}`, effects: [`exec echo ${VALUE}`], complete: true } })
    } finally { release() }
    const waiting = service.waiting()
    expect(JSON.stringify(waiting)).not.toContain(VALUE)
    expect(waiting[0]).toMatchObject({ request: { subject: '/w/out', reason: `writes ${LABEL}` }, call: { arguments: { args: [LABEL] }, description: `runs ${LABEL}`, effects: [`exec echo ${LABEL}`] } })
    await service.close()
  })
})
