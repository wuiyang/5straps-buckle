import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JsonObject } from '@5straps/protocol'
import { describe, expect, it } from 'vitest'
import { SETTING_KEYS } from '../cli/workspace-keys.js'
import { createNoneSandbox } from '../common/adapters/sandbox/none-sandbox.js'
import { summarizeEffect } from '../common/domain/effect.js'
import { createPathView } from '../common/domain/path-view.js'
import { maskLabel, MIN_SECRET_LENGTH, PLACES_REASON, PLATFORM_REASON, readReferences, SHORT_REASON } from '../common/domain/secret-reference.js'
import { referenceHint, type ReferenceHintTool } from '../common/domain/secret-reference-hint.js'
import { loadPackSkill } from '../common/services/packs/pack-skill.js'
import { MODE_DESCRIPTIONS } from '../common/services/packs/browser/mode.js'
import { createShellPack } from '../common/services/packs/shell/index.js'
import { createWebPack } from '../common/services/packs/web/index.js'
import { readDotenv } from '../common/services/secrets/dotenv.js'
import { MAX_REFERENCES, MAX_SECRET_FILES, planSecrets } from '../common/services/secrets/places.js'
import { MAX_SECRET_FILE_BYTES } from '../common/services/secrets/secret-file.js'
import { BUILT_IN_SETTINGS } from '../common/services/workspaces/workspace-settings.js'

// The secret references page (docs/secrets.md) and the places that point at it, held to what the code reads and
// prints, so the page cannot drift from the grammar, the reasons, the limits, or the settings it states.

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs')
const page = (name: string) => {
  try { return readFileSync(join(DOCS, name), 'utf8').replace(/\s+/g, ' ') } catch { return '' }
}
const secrets = page('secrets.md')
const LINK = 'https://github.com/wuiyang/5straps-buckle/blob/main/docs/secrets.md'

describe('docs/secrets.md quotes what the code says', () => {
  it('is a page', () => {
    expect(secrets.startsWith('# Secret references ')).toBe(true)
  })

  it('quotes the three reasons a reference is refused with, as an agent reads them', () => {
    for (const reason of [PLATFORM_REASON, PLACES_REASON, SHORT_REASON]) expect(secrets, reason).toContain(`"${reason}"`)
  })

  it('states the limits the code holds: the value floor, the references and files a call may make, and the file size', () => {
    expect(secrets).toContain(`${MIN_SECRET_LENGTH} characters`)
    expect(secrets).toContain(`${MAX_REFERENCES} references to at most ${MAX_SECRET_FILES} files`)
    expect(MAX_SECRET_FILE_BYTES).toBe(1_048_576)
    expect(secrets).toContain('1 MiB')
  })

  it('shows a masked value as the label the masker writes', () => {
    expect(maskLabel('NAME')).toBe('[secret:NAME]')
    expect(secrets).toContain('`[secret:NAME]`')
  })

  it('links the masking page, which says a filled page stays masked in every Buckle process and after a restart', () => {
    expect(secrets).toContain('](secrets-02.md)')
    expect(page('secrets-02.md')).toContain('in any Buckle process and after a restart')
    expect(page('secrets-02.md')).toContain('](secrets.md)')
  })

  it('quotes the approval line a secret file shows, and the strict mode that shortens its answer', () => {
    expect(summarizeEffect({ kind: 'secret_file', path: '/repo/.env.local', written: ['.env.local'], names: ['API_TOKEN'] })).toBe('secrets API_TOKEN from .env.local')
    expect(secrets).toContain('"secrets API_TOKEN from .env.local"')
    expect(secrets).toContain('BUCKLE_STRICT_WRITES=true')
  })

  it('names both settings, their defaults, and where the settings table lists them', () => {
    expect(BUILT_IN_SETTINGS.secrets).toEqual({ enabled: true, files: [] })
    for (const key of ['secrets.enabled', 'secrets.files']) {
      expect(SETTING_KEYS.map(item => item.key), key).toContain(key)
      expect(secrets, key).toContain(`\`${key}\``)
      expect(page('workspaces-02.md'), key).toContain(`| \`${key}\` |`)
    }
  })

  it('reads the dotenv forms it lists: the double-quote escapes, single quotes as written, and no interpolation', () => {
    const reading = readDotenv(['A="a\\nb\\rc\\td\\\\e\\"f"', 'B=\'a\\nb\'', 'C=${A}'].join('\n'))
    expect(reading.values.get('A')).toBe('a\nb\rc\td\\e"f')
    expect(reading.values.get('B')).toBe('a\\nb')
    expect(reading.values.get('C')).toBe('${A}')
    expect(secrets).toContain('`\\n`, `\\r`, `\\t`, `\\\\`, and `\\"`')
    expect(secrets).toContain('`${OTHER}`')
  })

  it('shows each reference it writes in full as one the grammar reads, and each platform form as one it refuses', () => {
    const shown = secrets.match(/\{\{(?:file|env):[^{}\s]*\}\}/g) ?? []
    const concrete = shown.filter(text => !text.includes('<'))
    expect(concrete.length).toBeGreaterThan(3)
    for (const text of concrete) {
      const reading = readReferences(text)
      if (text.startsWith('{{file:')) expect(reading, text).toMatchObject({ references: [{ raw: text }] })
      else expect(reading, text).toHaveProperty('refusal')
    }
    expect(readReferences('{{env:rings:API_TOKEN}}')).toEqual({ refusal: expect.stringContaining(PLATFORM_REASON) })
    expect(secrets).toContain('{{env:rings:API_TOKEN}}')
    expect(secrets).toContain('{{env:API_TOKEN}}')
  })
})

describe('the pages that point at docs/secrets.md', () => {
  it.each(['policy.md', 'sandbox-and-tools.md', 'workspaces-02.md', 'approvals.md'])('%s links to it', (name) => {
    expect(page(name)).toContain('](secrets.md')
  })

  it('approvals.md gives a secret file\'s ask the scopes it offers, and says the dangerously-allow switch leaves it asking', () => {
    expect(page('approvals.md')).toContain('| once (a [secret reference](secrets.md)\'s file: once, session, always) |')
    expect(page('approvals.md')).toContain('commands included, except a secret reference\'s file.')
  })

  it.each(['browser', 'web', 'shell'])('the %s skill links to it by its address on GitHub, which a shipped skill must use', (pack) => {
    expect(loadPackSkill(pack).content).toContain(`](${LINK}`)
  })
})

const stub = async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false })
const shellPack = createShellPack({
  paths: createPathView({ root: '/work', mount: null }),
  runProcess: stub,
  sandbox: createNoneSandbox(),
  writableRoots: ['/work'],
  hiddenPaths: [],
  readOnlyPaths: [],
  unavailableReason: null,
})
const descriptionOf = (pack: { tools: ReadonlyArray<{ capability: { name: string; description: string } }> }, tool: string) => pack.tools.find(item => item.capability.name === tool)!.capability.description

/** Where the tool's own example reference goes in its arguments, and the place kind the reader files it under. */
const PLACES: ReadonlyArray<{ tool: ReferenceHintTool; pack: string; kind: string; args: (reference: string) => JsonObject }> = [
  { tool: 'shell_exec', pack: 'shell', kind: 'argv', args: reference => ({ command: 'deploy-tool', args: ['--token', reference] }) },
  { tool: 'browser_command', pack: 'browser', kind: 'fill', args: reference => ({ command: 'fill', args: ['@e5', reference] }) },
  { tool: 'web_fetch', pack: 'web', kind: 'header', args: reference => ({ url: 'https://api.example.test', headers: { Authorization: `Bearer ${reference}` } }) },
]

describe('the sentence each tool description ends with', () => {
  const descriptions: Record<ReferenceHintTool, string[]> = {
    shell_exec: [descriptionOf(shellPack, 'shell_exec')],
    browser_command: Object.values(MODE_DESCRIPTIONS),
    web_fetch: [descriptionOf(createWebPack({ approved: null }), 'web_fetch')],
  }

  it.each(PLACES)('is on every description of $tool', ({ tool }) => {
    expect(descriptions[tool].length).toBeGreaterThan(0)
    for (const description of descriptions[tool]) expect(description.endsWith(referenceHint(tool))).toBe(true)
  })

  it.each(PLACES)('gives $tool an example the reader reads in the place the sentence names', ({ tool, pack, kind, args }) => {
    const hint = referenceHint(tool)
    const example = hint.match(/such as (\{\{file:[^{}\s]*\}\})/)![1]!
    const outcome = planSecrets({ tool, pack, args: args(example), enabled: true })
    expect(outcome).toMatchObject({ plan: { places: [{ kind, references: [{ raw: example }] }] } })
  })

  it.each(PLACES)('names the grammar, the three places, and what the agent sees, in one sentence for $tool', ({ tool }) => {
    const hint = referenceHint(tool)
    expect(hint).toContain('{{file:<path>:NAME}}')
    expect(hint).toContain('[secret:NAME]')
    expect(hint).toContain('shell arguments, browser fill text, and web_fetch headers only')
    expect(hint.match(/\.\s/g)).toBeNull()
    expect(hint.endsWith('.')).toBe(true)
  })
})
