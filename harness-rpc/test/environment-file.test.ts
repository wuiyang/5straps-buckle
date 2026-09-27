import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { editEnvironmentVariable, setEnvironmentVariable, updateEnvironmentFile, writeEnvironmentFile } from '../cli/environment-file.js'

describe('writing one variable back into an environment file', () => {
  it('fills in the commented placeholder buckle init left, keeping its position', () => {
    const text = 'BUCKLE_PORT=4320\n# Where refused calls are reported.\n# BUCKLE_REPORT_URL=\n# BUCKLE_REPORT_TOKEN=\n'

    const written = setEnvironmentVariable({ text, name: 'BUCKLE_REPORT_URL', value: 'http://rings.test/api/v1/buckle-reports' })

    expect(written).toBe('BUCKLE_PORT=4320\n# Where refused calls are reported.\nBUCKLE_REPORT_URL=http://rings.test/api/v1/buckle-reports\n# BUCKLE_REPORT_TOKEN=\n')
  })

  it('replaces a value that is already set rather than adding a second line for it', () => {
    const text = 'BUCKLE_REPORT_TOKEN=old-value\nBUCKLE_PORT=4320\n'

    const written = setEnvironmentVariable({ text, name: 'BUCKLE_REPORT_TOKEN', value: 'rotated-value' })

    expect(written).toBe('BUCKLE_REPORT_TOKEN=rotated-value\nBUCKLE_PORT=4320\n')
  })

  it('appends when the file names it nowhere, and ends the file with a newline', () => {
    expect(setEnvironmentVariable({ text: 'BUCKLE_PORT=4320', name: 'BUCKLE_REPORT_TOKEN', value: 'minted' }))
      .toBe('BUCKLE_PORT=4320\nBUCKLE_REPORT_TOKEN=minted\n')
  })

  it('writes a credential containing a replacement pattern literally', () => {
    const written = setEnvironmentVariable({ text: '# BUCKLE_REPORT_TOKEN=\n', name: 'BUCKLE_REPORT_TOKEN', value: 'a$&b$1c' })

    expect(written).toBe('BUCKLE_REPORT_TOKEN=a$&b$1c\n')
  })

  it('leaves every other variable exactly as it was', () => {
    const text = 'BUCKLE_AUTH_TOKEN=agent\nBUCKLE_ADMIN_TOKEN=admin\n# BUCKLE_REPORT_URL=\n'

    const written = setEnvironmentVariable({ text, name: 'BUCKLE_REPORT_URL', value: 'http://rings.test/reports' })

    expect(written).toContain('BUCKLE_AUTH_TOKEN=agent\nBUCKLE_ADMIN_TOKEN=admin\n')
  })

  it.each(['\n', '\r', '\0'])('refuses a value holding %j whoever calls it, so no second variable can be set', breaker => {
    const text = 'BUCKLE_ALLOW_SHELL=false\n# BUCKLE_ALLOW_HOST_GIT=true\n# BUCKLE_REPORT_TOKEN=\n'
    const value = `rt-fixture${breaker}BUCKLE_ALLOW_HOST_GIT=true${breaker}BUCKLE_ALLOW_SHELL=true`

    expect(() => setEnvironmentVariable({ text, name: 'BUCKLE_REPORT_TOKEN', value })).toThrow(/line break or NUL/)
    expect(editEnvironmentVariable({ text, name: 'BUCKLE_REPORT_TOKEN', value })).toEqual({ ok: false, reason: 'BUCKLE_REPORT_TOKEN cannot hold a line break or NUL' })
  })
})

describe.skipIf(process.platform === 'win32')('the environment file is owner-only, as RINGS-D20 rules for the approval key it holds', () => {
  const modeOf = (path: string) => statSync(path).mode & 0o777
  const worldReadable = (text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'buckle-env-mode-')), 'node.env')
    writeFileSync(path, text)
    chmodSync(path, 0o644)
    return path
  }

  it('creates a new file owner-only', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'buckle-env-mode-')), 'node.env')
    writeEnvironmentFile(path, 'BUCKLE_PORT=4320\n')
    expect(modeOf(path)).toBe(0o600)
  })

  it('narrows an existing file to owner-only before replacing it', () => {
    const path = worldReadable('BUCKLE_PORT=4320\n')
    writeEnvironmentFile(path, 'BUCKLE_PORT=4321\n')
    expect([readFileSync(path, 'utf8'), modeOf(path)]).toEqual(['BUCKLE_PORT=4321\n', 0o600])
  })

  it('rewrites an edited file owner-only', async () => {
    const path = worldReadable('BUCKLE_PORT=4320\n')
    expect((await updateEnvironmentFile(path, text => editEnvironmentVariable({ text, name: 'BUCKLE_RINGS_APPROVAL_KEY', value: 'fixture' }), { home: dirname(path) })).ok).toBe(true)
    expect(modeOf(path)).toBe(0o600)
  })

  it('narrows the file even when the edit is refused and nothing is written', async () => {
    const path = worldReadable('BUCKLE_PORT=4320\nexport BUCKLE_RINGS_APPROVAL_KEY=hand-written\n')
    expect((await updateEnvironmentFile(path, text => editEnvironmentVariable({ text, name: 'BUCKLE_RINGS_APPROVAL_KEY', value: 'fixture' }), { home: dirname(path) })).ok).toBe(false)
    expect([readFileSync(path, 'utf8'), modeOf(path)]).toEqual(['BUCKLE_PORT=4320\nexport BUCKLE_RINGS_APPROVAL_KEY=hand-written\n', 0o600])
  })
})
