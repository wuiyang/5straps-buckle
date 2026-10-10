import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PACKAGES, RELEASE_FILES, tarballOf } from '../scripts/release/packages.mjs'

// No workflow can run here, so the release workflows are held to their rules by reading them: every
// action pinned to a commit, no expression inside a shell line, no installed dependency in a job that
// can push or publish, the npm identity in a job that runs only what an allowlist names, the tag made
// before publishing, and the publish loop in step with the release scripts.

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

/** The YAML keys of a job's lines, leaving out the shell lines of its run scripts. */
function keys(lines: string[]): string[] {
  const found: string[] = []
  let scalar = -1
  for (const line of lines) {
    if (scalar >= 0 && line.search(/\S/) > scalar) continue
    scalar = -1
    const match = /^(\s*(?:- )?)([\w-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    found.push(match[2] ?? '')
    if (match[2] === 'run' && /^[|>]/.test(match[3] ?? '')) scalar = match[1]?.length ?? 0
  }
  return found
}

// The publish job's allowlist. Its actions are setup-node and download-artifact; its keys are the
// ones it has now, so a `shell:` or an environment variable such as NODE_OPTIONS fails; and each shell
// line is the npm version check, the registry check, npm publish of a packed tarball, or plain control.
const PUBLISH_ACTIONS = ['actions/setup-node', 'actions/download-artifact']
const PUBLISH_KEYS = new Set(['needs', 'if', 'runs-on', 'timeout-minutes', 'environment', 'permissions', 'id-token', 'steps', 'uses', 'with', 'node-version', 'registry-url', 'package-manager-cache', 'name', 'path', 'run', 'env', 'VERSION'])
const PUBLISH_COMMANDS = [
  'npm_version="$(npm --version)"',
  `if ! printf '11.5.1\\n%s\\n' "$npm_version" | sort --version-sort --check=quiet; then`,
  `status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "https://registry.npmjs.org/@5straps%2f\${name}/\${VERSION}")"`,
  `npm publish "./release/${tarballOf('@5straps/${name}', '${VERSION}')}" --access public`,
]
const SHELL_CONTROL = [
  /^(?:then|else|fi|done|esac|;;|\*\)|exit 1)$/,
  /^for name in [a-z ]+; do$/,
  /^case "\$status" in$/,
  // A test of words and variables: no command substitution, pipe, list, or second command.
  /^if (?:! )?\[ (?:(?!\$\()[^;&|`])* \]; then$/,
  /^if (?:! )?\[\[ (?:(?!\]\]|\$\()[^;&`])* \]\]; then$/,
  /^echo "(?:[^"`$\\]|\$\{?\w+\}?)*"$/,
]

function allowedPublishLine(raw: string): boolean {
  // A case branch, `200) ... ;;`, is read for what it runs.
  const line = raw.trim().replace(/^(?:\d+|\*)\) /, '').replace(/ ;;$/, '')
  return line === '' || line.startsWith('#') || PUBLISH_COMMANDS.includes(line) || SHELL_CONTROL.some(pattern => pattern.test(line))
}

/** What the publish job holds beyond its allowlist; empty when it runs nothing else. */
function publishProblems(workflow: string): string[] {
  const publish = job(workflow, 'publish')
  const used = actions(publish)
  return [
    ...(JSON.stringify(used) === JSON.stringify(PUBLISH_ACTIONS) ? [] : [`uses ${used.join(', ')}`]),
    ...keys(publish).filter(key => !PUBLISH_KEYS.has(key)).map(key => `key ${key}`),
    ...runScripts(publish.join('\n')).flatMap(script => script.split('\n')).filter(line => !allowedPublishLine(line)).map(line => `runs ${line.trim()}`),
  ]
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
    expect(permissions(RELEASE, 'pack')).toEqual(['contents: read', 'checks: read', 'actions: read'])
    expect(permissions(RELEASE, 'tag')).toEqual(['contents: write'])
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

  it('infers the version without an input and binds the commit check to that output', () => {
    expect(PREPARE).not.toContain('inputs.version')
    expect(block(PREPARE, 'on', 0).map(line => line.trim())).toEqual(['workflow_dispatch:'])
    expect(prepare.join('\n')).toContain('version: ${{ steps.prepare.outputs.version }}')
    expect(prepare.join('\n')).toContain('id: prepare')
    expect(commit.join('\n')).toContain('RELEASE_VERSION: ${{ needs.prepare.outputs.version }}')
  })

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
  it('tags the packed commit before publishing, in a job that installs nothing, skipped on a dry run', () => {
    const tag = job(RELEASE, 'tag')
    expect(tag.slice(0, 2).map(line => line.trim())).toEqual(['needs: pack', 'if: ${{ !inputs.dry_run }}'])
    expect(actions(tag)).toEqual(['actions/checkout', 'actions/setup-node'])
    expect(runScripts(tag.join('\n'))).toEqual(['node scripts/release/github-release.mjs tag'])
    expect(job(RELEASE, 'publish')[0]?.trim()).toBe('needs: [pack, tag]')
    expect(job(RELEASE, 'github-release')[0]?.trim()).toBe('needs: [pack, publish]')
    expect(runScripts(job(RELEASE, 'github-release').join('\n'))).toEqual(['RELEASE_NOTES="$RUNNER_TEMP/release/notes.md" node scripts/release/github-release.mjs release'])
  })

  it('publishes in the npm environment, skipped on a dry run', () => {
    const publish = job(RELEASE, 'publish').map(line => line.trim())
    expect(publish).toContain('environment: npm')
    expect(publish).toContain('if: ${{ !inputs.dry_run }}')
    expect(publish).toContain("registry-url: 'https://registry.npmjs.org'")
  })

  it('publishes from a job that runs only what its allowlist names', () => {
    expect(publishProblems(RELEASE)).toEqual([])
  })

  const PUBLISH_STEP = '      - name: Publish protocol, runtime, then buckle\n'
  const CASE = '            case "$status" in\n'
  it.each([
    ['a node step', [PUBLISH_STEP, `      - run: node scripts/release/plan.mjs\n${PUBLISH_STEP}`]],
    ['an npx step', [PUBLISH_STEP, `      - run: npx --yes some-tool\n${PUBLISH_STEP}`]],
    ['an npm run step', [PUBLISH_STEP, `      - run: npm run build\n${PUBLISH_STEP}`]],
    ['a bash step', [PUBLISH_STEP, `      - name: Publish\n        run: |\n          bash scripts/publish.sh\n${PUBLISH_STEP}`]],
    ['a node line in the publish loop', [CASE, `            node -e 'require("./release/x.js")'\n${CASE}`]],
    ['a command inside an echo', [CASE, `            echo "$(node -e 1)"\n${CASE}`]],
    ['a command after a test', [CASE, `            if [ -f x ]; then node x.js; fi\n${CASE}`]],
    ['a checkout', [PUBLISH_STEP, `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n${PUBLISH_STEP}`]],
    ['a shell that is node', [PUBLISH_STEP, `      - shell: node {0}\n        run: console.log(1)\n${PUBLISH_STEP}`]],
    ['NODE_OPTIONS for npm', ['          VERSION: ${{ needs.pack.outputs.version }}\n', '          VERSION: ${{ needs.pack.outputs.version }}\n          NODE_OPTIONS: --require ./release/x.js\n']],
  ] as const)('fails the allowlist once the publish job holds %s', (_, [from, to]) => {
    const workflow = RELEASE.replace(from, to)
    expect(workflow).not.toBe(RELEASE)
    expect(publishProblems(workflow)).not.toEqual([])
  })

  it('publishes the tarballs plan.mjs packs, in the order the packages depend on each other', () => {
    const publish = job(RELEASE, 'publish').join('\n')
    expect(publish).toContain(`for name in ${PACKAGES.map(({ name }) => name.replace('@5straps/', '')).join(' ')}; do`)
    expect(publish).toContain(`./release/${tarballOf('@5straps/${name}', '${VERSION}')}`)
  })
})
