import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

function copyRepositoryPinInputs(edit: (manifest: Record<string, Record<string, string>>) => void, editLock: (lock: string) => string = lock => lock): string {
  const root = mkdtempSync(join(tmpdir(), 'pins-'))
  mkdirSync(join(root, 'packages/runtime'), { recursive: true })
  cpSync(join(repository, 'package.json'), join(root, 'package.json'))
  writeFileSync(join(root, 'pnpm-lock.yaml'), editLock(readFileSync(join(repository, 'pnpm-lock.yaml'), 'utf8')))
  const manifest = JSON.parse(readFileSync(join(repository, 'packages/runtime/package.json'), 'utf8'))
  edit(manifest)
  writeFileSync(join(root, 'packages/runtime/package.json'), JSON.stringify(manifest))
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

  it('rejects better-sqlite3 because the runtime uses node:sqlite', () => {
    const root = copyRepositoryPinInputs(manifest => { manifest.dependencies!['better-sqlite3'] = '13.0.3' })
    expect(runCheck(root).output).toContain('better-sqlite3 is not allowed in dependencies')
  })
})
