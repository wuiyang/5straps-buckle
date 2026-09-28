import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const script = join(repository, 'scripts/check-runtime-pins.mjs')

function runCheck(root: string): { status: number; output: string } {
  try {
    return { status: 0, output: execFileSync(process.execPath, [script, root], { encoding: 'utf8', stdio: 'pipe' }) }
  } catch (error) {
    const failure = error as { status: number; stderr: string }
    return { status: failure.status, output: failure.stderr }
  }
}

type Manifest = Record<string, Record<string, string>>

function copyRepositoryPinInputs(edit: (manifest: Manifest) => void, editLock: (lock: string) => string = lock => lock, editBuckle: (manifest: Manifest) => void = () => {}): string {
  const root = mkdtempSync(join(tmpdir(), 'pins-'))
  cpSync(join(repository, 'package.json'), join(root, 'package.json'))
  writeFileSync(join(root, 'pnpm-lock.yaml'), editLock(readFileSync(join(repository, 'pnpm-lock.yaml'), 'utf8')))
  for (const [importer, change] of [['packages/runtime', edit], ['harness-rpc', editBuckle]] as const) {
    const manifest = JSON.parse(readFileSync(join(repository, importer, 'package.json'), 'utf8')) as Manifest
    change(manifest)
    mkdirSync(join(root, importer), { recursive: true })
    writeFileSync(join(root, importer, 'package.json'), JSON.stringify(manifest))
  }
  return root
}

describe('F57 runtime pin guard', () => {
  it('accepts the committed manifest and lockfile', () => {
    const result = runCheck(repository)
    expect(result.status).toBe(0)
    expect(result.output).toContain('nitro 3.0.260903-beta')
  })

  it('rejects a caret range on nitro', () => {
    const root = copyRepositoryPinInputs(manifest => { manifest.devDependencies!.nitro = '^3.0.260903-beta' })
    const result = runCheck(root)
    expect(result.status).toBe(1)
    expect(result.output).toContain('nitro must be declared exactly')
  })

  it('rejects a non-optional h3 peer', () => {
    const root = copyRepositoryPinInputs(manifest => { manifest.peerDependenciesMeta = {} })
    expect(runCheck(root).output).toContain('h3 peer must be optional')
  })

  it('L13 rejects a test hookable that differs from the one nitro resolves', () => {
    const root = copyRepositoryPinInputs(() => {}, lock => lock.replace(/(\n {2}packages\/runtime:\n[\s\S]*?\n {6}hookable:\n {8}specifier: )6\.1\.1(\n {8}version: )6\.1\.1/, '$16.1.0$26.1.0'))
    const result = runCheck(root)
    expect(result.status).toBe(1)
    expect(result.output).toContain('runtime tests use hookable 6.1.0 but nitro resolves 6.1.1')
  })

  it('holds Buckle to the same pins: h3 exact in production, nitro and srvx exact for the build only', () => {
    const caret = runCheck(copyRepositoryPinInputs(() => {}, undefined, manifest => { manifest.dependencies!.h3 = '^2.0.1-rc.32' }))
    expect(caret.status).toBe(1)
    expect(caret.output).toContain('harness-rpc: h3 must be a production dependency pinned exactly to 2.0.1-rc.32')
    expect(runCheck(copyRepositoryPinInputs(() => {}, undefined, manifest => { manifest.dependencies!.nitro = '3.0.260903-beta' })).output).toContain('harness-rpc: nitro builds .output and must not be a production dependency')
    expect(runCheck(copyRepositoryPinInputs(() => {}, undefined, manifest => { manifest.devDependencies!.srvx = '1.0.4' })).output).toContain('harness-rpc: srvx must be a devDependency pinned exactly to 1.0.5')
  })

  it('rejects a Buckle lockfile entry that resolves another nitro', () => {
    const root = copyRepositoryPinInputs(() => {}, lock => lock.replace(/(\n {2}harness-rpc:\n[\s\S]*?\n {6}nitro:\n {8}specifier: 3\.0\.260903-beta\n {8}version: )3\.0\.260903-beta/, '$13.0.260801-beta'))
    expect(runCheck(root).output).toContain('lockfile resolves harness-rpc nitro to 3.0.260801-beta, expected 3.0.260903-beta')
  })

  it('rejects better-sqlite3 because the runtime uses node:sqlite', () => {
    const root = copyRepositoryPinInputs(manifest => { manifest.dependencies!['better-sqlite3'] = '13.0.3' })
    expect(runCheck(root).output).toContain('better-sqlite3 is not allowed in dependencies')
  })
})

describe('gate scripts run through a symlinked path (packaging-ci-3)', () => {
  it('still checks instead of exiting 0 silently', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'pins-link-')), 'check-runtime-pins.mjs')
    symlinkSync(script, link)
    const output = execFileSync(process.execPath, [link, repository], { encoding: 'utf8', stdio: 'pipe' })
    expect(output).toContain('Runtime pins verified')
  })
})
