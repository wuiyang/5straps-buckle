import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCommand, writeStepOutputs } from '../scripts/release/command.mjs'
import { changelogSection, compareVersions, isPlainVersion, tarballOf } from '../scripts/release/packages.mjs'
import { scratchDirectory } from './support/release-repository'

// What the release scripts share: plain versions and their order, the tarball names pnpm writes,
// a changelog section, the step outputs file, and the command runner whose failures carry stderr.

describe('release versions and names', () => {
  it('takes only plain MAJOR.MINOR.PATCH versions', () => {
    expect(['0.1.0', '1.0.0', '10.20.30'].every(isPlainVersion)).toBe(true)
    expect(['v1.0.0', '1.0', '1.0.0-rc.1', '1.0.0+5', '01.0.0', '1.00.0', '1.0.0 ', 1, null].some(isPlainVersion)).toBe(false)
  })

  it('orders versions part by part, as numbers', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1)
    expect(compareVersions('99999999999999999999.0.0', '99999999999999999998.0.0')).toBe(1)
  })

  it('names a tarball as pnpm pack does: no @, the scope slash made a hyphen', () => {
    expect(tarballOf('@5straps/buckle', '0.2.0')).toBe('5straps-buckle-0.2.0.tgz')
  })
})

describe('a changelog section', () => {
  const changelog = '# Changelog\n\n\n## v0.2.0\n\nnewest\n\n## v0.1.10\n\nmiddle  \n\n### Fixes\n\n- one\n\n## v0.1.1\n\noldest\n'

  it('runs from its heading to the next section, without the heading', () => {
    expect(changelogSection(changelog, '0.2.0')).toBe('newest')
    expect(changelogSection(changelog, '0.1.10')).toBe('middle  \n\n### Fixes\n\n- one')
    expect(changelogSection(changelog, '0.1.1')).toBe('oldest')
  })

  it('is null when the version has no heading or nothing under it', () => {
    expect(changelogSection(changelog, '0.1.0')).toBeNull()
    expect(changelogSection('# Changelog\n\n## v0.3.0\n\n## v0.2.0\n', '0.3.0')).toBeNull()
  })
})

describe('the release command runner', () => {
  it('returns stdout, and on failure throws with the exit status and stderr', () => {
    expect(runCommand(process.execPath, ['-e', 'process.stdout.write("answer")'])).toBe('answer')
    expect(() => runCommand(process.execPath, ['-e', 'process.stderr.write("gh: Not Found (HTTP 404)\\n"); process.exit(3)'])).toThrow(expect.objectContaining({ status: 3, stderr: 'gh: Not Found (HTTP 404)\n' }))
  })

  it('appends name=value lines to the step outputs file, and does nothing without one', () => {
    const file = join(scratchDirectory('release-outputs-'), 'output')
    writeStepOutputs({ version: '0.2.0', sha: 'a'.repeat(40) }, file)
    writeStepOutputs({ next: 'yes' }, file)
    expect(readFileSync(file, 'utf8')).toBe(`version=0.2.0\nsha=${'a'.repeat(40)}\nnext=yes\n`)
    expect(() => writeStepOutputs({ version: '0.2.0' }, '')).not.toThrow()
  })
})
