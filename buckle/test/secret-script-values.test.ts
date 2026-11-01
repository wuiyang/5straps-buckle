import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { masksHeld } from '../common/services/secrets/mask.js'
import { createScriptSecrets } from '../common/services/secrets/script-secrets.js'

// The values a code_run script's calls resolve (Codex review of the code mode secret fix, finding S1): they mask every
// later answer the script is handed, errors included, are held for log lines while the script runs, and its record keeps
// each by file, NAME, and digest alone, which a resumed run reads again.

const VALUE = 'decoy-unit-0123456789'
const LABEL = '[secret:API_TOKEN]'
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(value = VALUE) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-script-values-')))
  roots.push(root)
  const real = join(root, '.env.local')
  writeFileSync(real, `API_TOKEN=${value}\n`)
  return { root, real, secrets: createScriptSecrets({ protectedRoots: [], roots: [root] }) }
}

describe('the values a script\'s calls resolve', () => {
  it('mask every string of a later answer, an error\'s message and an encoded form included, and are held until dropped', () => {
    const { real, secrets } = workspace()
    const failed = { requestId: 'r', outcome: 'error', error: { code: 'X', message: `failed on ${VALUE}`, retryable: false } } as const
    expect(secrets.json(failed)).toBe(failed)
    expect(masksHeld()).toBe(false)
    secrets.add([{ real, written: '.env.local', name: 'API_TOKEN', value: VALUE }])
    expect(masksHeld()).toBe(true)
    expect(secrets.json(failed)).toEqual({ ...failed, error: { ...failed.error, message: `failed on ${LABEL}` } })
    expect(secrets.json({ output: { content: Buffer.from(VALUE).toString('base64') } })).toEqual({ output: { content: LABEL } })
    expect(secrets.records()).toEqual([{ real, written: '.env.local', name: 'API_TOKEN', digest: digest(VALUE) }])
    secrets.drop()
    expect(masksHeld()).toBe(false)
    expect(secrets.json(failed)).toBe(failed)
  })

  it('are read again from a record, which refuses where the file is gone or reads as another value, naming the file and NAME', () => {
    const { root, real, secrets } = workspace()
    const record = { real, written: '.env.local', name: 'API_TOKEN', digest: digest(VALUE) }
    secrets.restore([record])
    expect(secrets.json({ content: VALUE })).toEqual({ content: LABEL })
    secrets.drop()
    const refusalOf = () => { try { createScriptSecrets({ protectedRoots: [], roots: [root] }).restore([record]) } catch (error) { return error as Error & { code?: string } } return null }
    const changed = 'decoy-changed-9876543210'
    writeFileSync(real, `API_TOKEN=${changed}\n`)
    const refusal = refusalOf()
    expect(refusal).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('API_TOKEN in .env.local') })
    rmSync(real)
    const gone = refusalOf()
    expect(gone).toMatchObject({ code: 'PERMISSION_DENIED', message: expect.stringContaining('API_TOKEN in .env.local') })
    for (const message of [refusal!.message, gone!.message]) expect(message).not.toMatch(new RegExp(`${VALUE}|${changed}`))
    expect(masksHeld()).toBe(false)
  })
})
