import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bundledAdvisories, readBundled } from '../scripts/release/audit-bundled.mjs'

// B21 (plan section G): an advisory for a package the Buckle build bundled into .output fails the
// release audit, which `pnpm audit --prod` cannot see. Fixtures only: no network.

const SCRIPT = fileURLToPath(new URL('../scripts/release/audit-bundled.mjs', import.meta.url))

/** `pnpm audit --json` output in the npm v6 shape pnpm writes. */
function audit(advisories: Array<{ id: number; module_name: string; versions: string[]; severity?: string }>) {
  return {
    actions: [], muted: [],
    advisories: Object.fromEntries(advisories.map(item => [String(item.id), {
      id: item.id, module_name: item.module_name, severity: item.severity ?? 'high', title: `${item.module_name} fixture advisory`,
      url: `https://github.com/advisories/GHSA-fixture-${item.id}`, vulnerable_versions: '<99', findings: item.versions.map(version => ({ version, paths: ['harness-rpc>nitro'] })),
    }])),
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: advisories.length, critical: 0 } },
  }
}

const BUNDLED = ['hookable@6.1.1', 'nitro@3.0.260903-beta', 'srvx@1.0.5']

describe('the bundled-package audit', () => {
  it('names each advisory for a bundled package at its bundled version', () => {
    expect(bundledAdvisories({ audit: audit([{ id: 1, module_name: 'srvx', versions: ['1.0.5'] }]), bundled: BUNDLED })).toEqual([
      { package: 'srvx@1.0.5', id: 1, severity: 'high', title: 'srvx fixture advisory', url: 'https://github.com/advisories/GHSA-fixture-1' },
    ])
  })

  it('ignores an advisory for another version of a bundled package, and one for a package that is not bundled', () => {
    expect(bundledAdvisories({ audit: audit([{ id: 2, module_name: 'srvx', versions: ['1.0.4'] }, { id: 3, module_name: 'left-pad', versions: ['1.3.0'] }]), bundled: BUNDLED })).toEqual([])
    expect(bundledAdvisories({ audit: { advisories: {} }, bundled: BUNDLED })).toEqual([])
  })

  it('reads the build\'s lists, and refuses a missing or malformed one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'audit-bundled-'))
    writeFileSync(join(directory, 'good.json'), JSON.stringify(BUNDLED))
    writeFileSync(join(directory, 'bad.json'), JSON.stringify({ packages: BUNDLED }))
    expect(readBundled([join(directory, 'good.json')])).toEqual(BUNDLED)
    expect(() => readBundled([join(directory, 'bad.json')])).toThrow('is not a list of package@version')
    expect(() => readBundled([join(directory, 'missing.json')])).toThrow('build the server first')
  })

  it('exits 1 naming the package and the advisory, and 0 when nothing bundled is affected', () => {
    const directory = mkdtempSync(join(tmpdir(), 'audit-bundled-'))
    writeFileSync(join(directory, 'bundled.json'), JSON.stringify(BUNDLED))
    writeFileSync(join(directory, 'affected.json'), JSON.stringify(audit([{ id: 4, module_name: 'nitro', versions: ['3.0.260903-beta'], severity: 'critical' }])))
    writeFileSync(join(directory, 'clean.json'), JSON.stringify(audit([{ id: 5, module_name: 'nitro', versions: ['2.0.0'] }])))
    const run = (auditFile: string) => {
      try {
        return { code: 0, output: execFileSync(process.execPath, [SCRIPT, '--bundled', join(directory, 'bundled.json'), '--audit', join(directory, auditFile)], { encoding: 'utf8', stdio: 'pipe' }) }
      } catch (error) {
        const failed = error as { status: number; stderr: string }
        return { code: failed.status, output: failed.stderr }
      }
    }
    const affected = run('affected.json')
    expect(affected.code).toBe(1)
    expect(affected.output).toContain('nitro@3.0.260903-beta is bundled into .output and has advisory 4 (critical)')
    const clean = run('clean.json')
    expect(clean).toEqual({ code: 0, output: expect.stringContaining('Bundled packages audited: 3') })
  })
})
