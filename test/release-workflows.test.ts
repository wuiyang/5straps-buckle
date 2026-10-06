import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PACKAGES, tarballOf } from '../scripts/release/packages.mjs'

// No workflow can run here, so the release workflows are held to their rules by reading them: every
// action pinned to a commit, no expression inside a shell line, the npm identity only in a job that
// runs no repository code, and the publish loop in step with the release scripts.

const WORKFLOWS = fileURLToPath(new URL('../.github/workflows/', import.meta.url))
const read = (file: string) => readFileSync(join(WORKFLOWS, file), 'utf8')
const RELEASE = read('release.yml')
const PREPARE = read('release-prepare.yml')
const CHECK = read('release-check.yml')

/** The lines under `key:` at `indent` spaces, up to the next line at that indentation or less. */
function block(text: string, key: string, indent: number): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line === `${' '.repeat(indent)}${key}:`)
  if (start === -1) throw new Error(`no ${key} at indentation ${indent}`)
  const end = lines.findIndex((line, index) => index > start && line.trim() !== '' && line.search(/\S/) <= indent)
  return lines.slice(start + 1, end === -1 ? undefined : end).filter(line => line.trim() !== '' && !line.trim().startsWith('#'))
}

const permissions = (job: string) => block(block(RELEASE, job, 2).join('\n'), 'permissions', 4).map(line => line.trim())

/** Each run script: a one-line value, or the lines of a block scalar indented under its key. */
function runScripts(text: string): string[] {
  const lines = text.split('\n')
  return lines.flatMap((line, index) => {
    const match = /^(\s*(?:- )?)run:\s*(.*)$/.exec(line)
    if (!match) return []
    if (!/^[|>]/.test(match[2] ?? '')) return [match[2] ?? '']
    const column = match[1]?.length ?? 0
    const end = lines.findIndex((next, at) => at > index && next.trim() !== '' && next.search(/\S/) <= column)
    return [lines.slice(index + 1, end === -1 ? undefined : end).join('\n')]
  })
}

describe('the release workflows', () => {
  it.each([['release.yml', RELEASE], ['release-prepare.yml', PREPARE], ['release-check.yml', CHECK]])('%s pins every action to a full commit, with its version beside it', (_, text) => {
    const uses = text.split('\n').filter(line => /^\s*(?:- )?uses:/.test(line))
    expect(uses.length).toBeGreaterThan(0)
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)
  })

  it.each(readdirSync(WORKFLOWS).filter(file => file.endsWith('.yml')))('%s keeps every expression out of its shell lines', (file) => {
    const scripts = runScripts(read(file))
    expect(scripts.length).toBeGreaterThan(0)
    for (const script of scripts) expect(script).not.toContain('${{')
  })

  it('gives prepare only contents and actions write, and the release jobs only what each needs', () => {
    expect(block(PREPARE, 'permissions', 0).map(line => line.trim())).toEqual(['contents: write', 'actions: write'])
    expect(RELEASE).toContain('\npermissions: {}\n')
    expect(permissions('pack')).toEqual(['contents: read', 'checks: read'])
    expect(permissions('publish')).toEqual(['id-token: write'])
    expect(permissions('github-release')).toEqual(['contents: write'])
  })

  it('publishes from a job with no checkout, no install, and no repository script, skipped on a dry run', () => {
    const publish = block(RELEASE, 'publish', 2).join('\n')
    expect(publish).toContain('if: ${{ !inputs.dry_run }}')
    expect(publish).not.toMatch(/actions\/checkout|pnpm|scripts\/|npm (?:ci|install)/)
    expect(publish).toContain("registry-url: 'https://registry.npmjs.org'")
  })

  it('publishes the tarballs plan.mjs packs, in the order the packages depend on each other', () => {
    const publish = block(RELEASE, 'publish', 2).join('\n')
    expect(publish).toContain(`for name in ${PACKAGES.map(({ name }) => name.replace('@5straps/', '')).join(' ')}; do`)
    expect(publish).toContain(`./release/${tarballOf('@5straps/${name}', '${VERSION}')}`)
  })

  it('shares one concurrency group that never cancels a run in progress', () => {
    for (const text of [RELEASE, PREPARE]) expect(block(text, 'concurrency', 0).map(line => line.trim())).toEqual(['group: release', 'cancel-in-progress: false'])
  })
})
