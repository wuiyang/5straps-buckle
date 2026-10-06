import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PACKAGES, RELEASE_FILES, tarballOf } from '../scripts/release/packages.mjs'

// No workflow can run here, so the release workflows are held to their rules by reading them: every
// action pinned to a commit, no expression inside a shell line, no installed dependency in a job that
// can push, the npm identity only in a job that runs no repository code, and the publish loop in step
// with the release scripts.

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

const job = (text: string, name: string) => block(text, name, 2)
const permissions = (text: string, name: string) => block(job(text, name).join('\n'), 'permissions', 4).map(line => line.trim())
/** The actions a job uses, each named without its `@` and what follows. */
const actions = (lines: string[]) => lines.flatMap(line => /^\s*(?:- )?uses:\s*(\S+)/.exec(line)?.[1]?.split('@')[0] ?? [])
/** The trimmed lines of the first `key: |` block scalar in a job. */
function scalar(lines: string[], key: string): string[] {
  const start = lines.findIndex(line => line.trim() === `${key}: |`)
  if (start === -1) throw new Error(`no ${key}: | block`)
  const column = lines[start]?.search(/\S/) ?? 0
  const end = lines.findIndex((line, at) => at > start && line.search(/\S/) <= column)
  return lines.slice(start + 1, end === -1 ? undefined : end).map(line => line.trim())
}

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

  it('grants nothing at the top of either workflow, and each job only what it needs', () => {
    for (const text of [RELEASE, PREPARE]) expect(text).toContain('\npermissions: {}\n')
    expect(permissions(PREPARE, 'prepare')).toEqual(['contents: read'])
    expect(permissions(PREPARE, 'commit')).toEqual(['contents: write', 'actions: write'])
    expect(permissions(RELEASE, 'pack')).toEqual(['contents: read', 'checks: read'])
    expect(permissions(RELEASE, 'publish')).toEqual(['id-token: write'])
    expect(permissions(RELEASE, 'github-release')).toEqual(['contents: write'])
  })

  it('shares one concurrency group that never cancels a run in progress', () => {
    for (const text of [RELEASE, PREPARE]) expect(block(text, 'concurrency', 0).map(line => line.trim())).toEqual(['group: release', 'cancel-in-progress: false'])
  })
})

describe('Prepare release', () => {
  const prepare = job(PREPARE, 'prepare')
  const commit = job(PREPARE, 'commit')

  it('runs changelogen with read access, no install script, no stored credential, and hands over the four files', () => {
    expect(prepare.join('\n')).toContain('persist-credentials: false')
    expect(runScripts(prepare.join('\n'))).toContain('pnpm install --frozen-lockfile --ignore-scripts')
    expect(prepare.join('\n')).toContain('name: prepared')
    expect(scalar(prepare, 'path')).toEqual([...RELEASE_FILES])
  })

  it('pushes from a job that installs nothing and takes only the four files over a checkout of the same commit', () => {
    expect(commit[0]?.trim()).toBe('needs: prepare')
    expect(actions(commit)).toEqual(['actions/checkout', 'actions/setup-node', 'actions/download-artifact'])
    expect(commit.join('\n')).not.toMatch(/pnpm|node_modules|npm (?:ci|install)|npx/)
    expect(commit.join('\n')).toMatch(/ref: \$\{\{ github\.sha \}\}\n\s+persist-credentials: false/)
    expect(commit.join('\n')).toContain('path: ${{ runner.temp }}/prepared')
    const scripts = runScripts(commit.join('\n'))
    expect(scripts[0]).toContain(`for file in ${RELEASE_FILES.join(' ')}; do`)
    expect(scripts[1]).toBe('node scripts/release/check-prepared.mjs')
    expect(scripts[2]).toContain(`git add -- ${RELEASE_FILES.join(' ')}\n`)
    expect(scripts.slice(3).join('\n')).toMatch(/git push .* HEAD:refs\/heads\/main\n[^]*gh workflow run release-check\.yml --ref main/)
  })
})

describe('Release', () => {
  it('publishes from a job with no checkout, no install, and no repository script, skipped on a dry run', () => {
    const publish = job(RELEASE, 'publish').join('\n')
    expect(publish).toContain('if: ${{ !inputs.dry_run }}')
    expect(publish).not.toMatch(/actions\/checkout|pnpm|scripts\/|npm (?:ci|install)/)
    expect(publish).toContain("registry-url: 'https://registry.npmjs.org'")
  })

  it('publishes the tarballs plan.mjs packs, in the order the packages depend on each other', () => {
    const publish = job(RELEASE, 'publish').join('\n')
    expect(publish).toContain(`for name in ${PACKAGES.map(({ name }) => name.replace('@5straps/', '')).join(' ')}; do`)
    expect(publish).toContain(`./release/${tarballOf('@5straps/${name}', '${VERSION}')}`)
  })
})
