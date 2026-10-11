import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PACKAGES, RELEASE_FILES, tarballOf } from '../scripts/release/packages.mjs'
import { scratchDirectory } from './support/release-repository'

// No workflow can run here, so the release workflows are held to their rules by reading them: every
// action pinned to a commit, no expression inside a shell line, only the first-party npm CLI installed
// in the identity job, which runs only what an allowlist names, and the tag made
// before publishing, and the stage loop in step with the release scripts.

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

/** A job's steps, each its trimmed lines from its `- ` to the next step. */
function steps(lines: string[]): string[][] {
  const found: string[][] = []
  for (const line of lines) {
    if (/^ {6}- /.test(line)) found.push([])
    found.at(-1)?.push(line.trim())
  }
  return found
}

/** The step that holds the commit pack reports to this run's, before a job holding a token checks out. */
const SAME_COMMIT = [
  "- name: Require the packed commit to be this run's commit",
  'env:',
  'RELEASE_COMMIT: ${{ needs.pack.outputs.sha }}',
  'run: |',
  'if [ "$RELEASE_COMMIT" != "$GITHUB_SHA" ]; then',
  `echo "::error::The pack job reported another commit than this run's \${GITHUB_SHA}"`,
  'exit 1',
  'fi',
]

// The stage job's allowlist. Its actions are setup-node and download-artifact; its keys are the
// ones it has now, so a `shell:` or an environment variable such as NODE_OPTIONS fails; and each shell
// line is the pinned CLI bootstrap, version or registry check, tarball staging, summary, or plain control.
const STAGE_ACTIONS = ['actions/setup-node', 'actions/download-artifact']
const STAGE_KEYS = new Set(['needs', 'if', 'runs-on', 'timeout-minutes', 'environment', 'permissions', 'id-token', 'outputs', 'all_public', 'steps', 'uses', 'with', 'node-version', 'registry-url', 'package-manager-cache', 'name', 'path', 'run', 'env', 'VERSION', 'id'])
const STAGE_COMMANDS = [
  'npm install --global npm@11.15.0 --ignore-scripts',
  'npm_version="$(npm --version)"',
  `if ! printf '11.15.0\\n%s\\n' "$npm_version" | sort --version-sort --check=quiet; then`,
  `status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "https://registry.npmjs.org/@5straps%2f\${name}/\${VERSION}")"`,
  `npm stage publish "./release/${tarballOf('@5straps/${name}', '${VERSION}')}" --access public | tee -a "$GITHUB_STEP_SUMMARY"`,
  'all_public=true',
  'all_public=false',
  'echo "all_public=${all_public}" >> "$GITHUB_OUTPUT"',
  'echo "All three packages at v${VERSION} are public. The GitHub release can now be created." >> "$GITHUB_STEP_SUMMARY"',
  "printf '%s\\n' 'Approve the staged packages on npmjs.com, or run `npm stage approve <stage-id>` from an authenticated local CLI.' >> \"$GITHUB_STEP_SUMMARY\"",
  'echo "Approve protocol, runtime, then buckle. After all three are public and main still names this release commit, choose Re-run all jobs on this run to create the GitHub release." >> "$GITHUB_STEP_SUMMARY"',
]
const SHELL_CONTROL = [
  /^(?:then|else|fi|done|esac|;;|(?:\d+|\*)\)|exit 1)$/,
  /^for name in [a-z ]+; do$/,
  /^case "\$status" in$/,
  // A test of words and variables: no command substitution, pipe, list, or second command.
  /^if (?:! )?\[ (?:(?!\$\()[^;&|`])* \]; then$/,
  /^if (?:! )?\[\[ (?:(?!\]\]|\$\()[^;&`])* \]\]; then$/,
  /^echo "(?:[^"`$\\]|\$\{?\w+\}?)*"$/,
]

function allowedStageLine(raw: string): boolean {
  // A case branch, `200) ... ;;`, is read for what it runs.
  const line = raw.trim().replace(/^(?:\d+|\*)\) /, '').replace(/ ;;$/, '')
  return line === '' || line.startsWith('#') || STAGE_COMMANDS.includes(line) || SHELL_CONTROL.some(pattern => pattern.test(line))
}

/** What the stage job holds beyond its allowlist; empty when it runs nothing else. */
function stageProblems(workflow: string): string[] {
  const stage = job(workflow, 'stage')
  const used = actions(stage)
  return [
    ...(JSON.stringify(used) === JSON.stringify(STAGE_ACTIONS) ? [] : [`uses ${used.join(', ')}`]),
    ...keys(stage).filter(key => !STAGE_KEYS.has(key)).map(key => `key ${key}`),
    ...runScripts(stage.join('\n')).flatMap(script => script.split('\n')).filter(line => !allowedStageLine(line)).map(line => `runs ${line.trim()}`),
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
    expect(permissions(PREPARE, 'prepare')).toEqual(['contents: read', 'checks: read', 'actions: read'])
    expect(permissions(PREPARE, 'commit')).toEqual(['contents: write'])
    expect(permissions(RELEASE, 'pack')).toEqual(['contents: read', 'checks: read', 'actions: read'])
    expect(permissions(RELEASE, 'confirm-tag')).toEqual(['contents: read'])
    expect(permissions(RELEASE, 'stage')).toEqual(['id-token: write'])
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
    expect(scripts[2]).toContain('git commit --message \"chore(release): v${VERSION} [skip ci]\"')
    expect(scripts[2]).toContain('git tag \"v${VERSION}\"')
    expect(scripts[3]).toContain('git push --atomic')
    expect(scripts[3]).toContain('HEAD:refs/heads/main \"refs/tags/v${VERSION}\"')
    expect(scripts.join('\n')).not.toContain('gh workflow run')
  })

  // Without the lease, a main rewound to an ancestor of the source commit is fast-forwarded back.
  it('pushes the commit and tag atomically, leased on main still naming the source commit', () => {
    const push = steps(commit).find(step => step[0] === '- name: Push the release commit and tag together') ?? []
    expect(push).toContain('GITHUB_SHA: ${{ github.sha }}')
    expect(push[push.indexOf('run: |') + 1]).toBe('git push --atomic --force-with-lease="refs/heads/main:${GITHUB_SHA}" "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" HEAD:refs/heads/main "refs/tags/v${VERSION}"')
    expect(runScripts(commit.join('\n')).join('\n').match(/git push/g)).toHaveLength(1)
  })
})

describe('Release', () => {
  it('requires source CI before generation and keeps tag creation in preparation', () => {
    const scripts = runScripts(job(PREPARE, 'prepare').join('\n'))
    expect(scripts).toContain('node scripts/release/require-ci.mjs --source')
    expect(scripts.indexOf('node scripts/release/require-ci.mjs --source')).toBeLessThan(scripts.indexOf('pnpm install --frozen-lockfile --ignore-scripts'))
    expect(RELEASE).not.toContain('  tag:\n')
    expect(job(RELEASE, 'stage')[0]?.trim()).toBe('needs: [pack, confirm-tag]')
    const confirm = job(RELEASE, 'confirm-tag')
    expect(actions(confirm)).toEqual(['actions/checkout', 'actions/setup-node'])
    expect(runScripts(confirm.join('\n')).slice(1)).toEqual(['node scripts/release/github-release.mjs check-tag'])
    expect(confirm.join('\n')).not.toMatch(/pnpm|node_modules|npm (?:ci|install)|npx/)
    expect(job(RELEASE, 'github-release')[0]?.trim()).toBe('needs: [pack, stage]')
    expect(runScripts(job(RELEASE, 'github-release').join('\n')).slice(1)).toEqual(['node scripts/release/github-release.mjs release'])
  })

  it('takes the release notes from the checkout, never from what pack uploaded', () => {
    const release = job(RELEASE, 'github-release')
    expect(actions(release)).toEqual(['actions/checkout', 'actions/setup-node'])
    expect(release.join('\n')).not.toMatch(/RELEASE_NOTES|notes\.md|download-artifact/)
    expect(release.join('\n')).not.toMatch(/pnpm|node_modules|npm (?:ci|install)|npx/)
  })

  it.each(['confirm-tag', 'github-release'])('%s holds the packed commit to this run\'s, then checks out this run\'s commit', (name) => {
    const [guard, checkout] = steps(job(RELEASE, name))
    expect(guard).toEqual(SAME_COMMIT)
    expect(checkout?.[0]).toMatch(/^- uses: actions\/checkout@/)
    expect(checkout?.slice(1)).toEqual(['with:', 'ref: ${{ github.sha }}', 'persist-credentials: false'])
    expect(job(RELEASE, name).join('\n').match(/needs\.pack\.outputs\.sha/g)).toHaveLength(1)
    expect(job(RELEASE, name).map(line => line.trim())).toContain('RELEASE_COMMIT: ${{ github.sha }}')
  })

  it.each([
    ['passes when pack reports this run\'s commit', 'a'.repeat(40), 0],
    ['fails when pack reports another commit', 'b'.repeat(40), 1],
    ['fails when pack reports nothing', '', 1],
  ])('the same-commit step %s', (_, reported, status) => {
    const script = runScripts(job(RELEASE, 'confirm-tag').join('\n'))[0] ?? ''
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { encoding: 'utf8', env: { ...process.env, RELEASE_COMMIT: reported, GITHUB_SHA: 'a'.repeat(40) } })
    expect(result.status).toBe(status)
  })

  it('stages in the npm environment, skipped on a dry run', () => {
    const stage = job(RELEASE, 'stage').map(line => line.trim())
    expect(stage).toContain('environment: npm')
    expect(stage).toContain('if: ${{ !inputs.dry_run }}')
    expect(stage).toContain("registry-url: 'https://registry.npmjs.org'")
  })

  it('stages from a job that runs only what its allowlist names', () => {
    expect(stageProblems(RELEASE)).toEqual([])
  })

  it('stages with npm 11.15.0 and finalizes only after all packages are public', () => {
    expect(RELEASE).toContain('name: Stage Buckle')
    expect(RELEASE).toContain('npm install --global npm@11.15.0 --ignore-scripts')
    expect(RELEASE).toContain('npm stage publish')
    expect(RELEASE).not.toMatch(/(?:^|\s)npm publish /)
    expect(RELEASE).not.toContain('npm stage approve <stage-id> --')
    expect(job(RELEASE, 'github-release').join('\n')).toContain("if: ${{ !inputs.dry_run && needs.stage.outputs.all_public == 'true' }}")
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.scripts.release).toBeUndefined()
  })

  const STAGE_STEP = '      - name: Stage protocol, runtime, then buckle\n'
  const CASE = '            case "$status" in\n'
  it.each([
    ['a node step', [STAGE_STEP, `      - run: node scripts/release/plan.mjs\n${STAGE_STEP}`]],
    ['an npx step', [STAGE_STEP, `      - run: npx --yes some-tool\n${STAGE_STEP}`]],
    ['an npm run step', [STAGE_STEP, `      - run: npm run build\n${STAGE_STEP}`]],
    ['a bash step', [STAGE_STEP, `      - name: Publish\n        run: |\n          bash scripts/publish.sh\n${STAGE_STEP}`]],
    ['a node line in the stage loop', [CASE, `            node -e 'require("./release/x.js")'\n${CASE}`]],
    ['a command inside an echo', [CASE, `            echo "$(node -e 1)"\n${CASE}`]],
    ['a command after a test', [CASE, `            if [ -f x ]; then node x.js; fi\n${CASE}`]],
    ['a checkout', [STAGE_STEP, `      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n${STAGE_STEP}`]],
    ['a shell that is node', [STAGE_STEP, `      - shell: node {0}\n        run: console.log(1)\n${STAGE_STEP}`]],
    ['NODE_OPTIONS for npm', ['          VERSION: ${{ needs.pack.outputs.version }}\n', '          VERSION: ${{ needs.pack.outputs.version }}\n          NODE_OPTIONS: --require ./release/x.js\n']],
  ] as const)('fails the allowlist once the stage job holds %s', (_, [from, to]) => {
    const workflow = RELEASE.replace(from, to)
    expect(workflow).not.toBe(RELEASE)
    expect(stageProblems(workflow)).not.toEqual([])
  })

  it('stages the tarballs plan.mjs packs, in the order the packages depend on each other', () => {
    const stage = job(RELEASE, 'stage').join('\n')
    expect(stage).toContain(`for name in ${PACKAGES.map(({ name }) => name.replace('@5straps/', '')).join(' ')}; do`)
    expect(stage).toContain(`./release/${tarballOf('@5straps/${name}', '${VERSION}')}`)
  })
})

type Package = 'protocol' | 'runtime' | 'buckle'
interface StageAnswers {
  statuses?: Partial<Record<Package, number>>
  failStage?: Package
  networkFailure?: boolean
  missing?: Package
  version?: string
}

function runStaging(answers: StageAnswers = {}) {
  const root = scratchDirectory('stage-workflow-')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(root, 'release'))
  for (const name of ['protocol', 'runtime', 'buckle']) {
    if (name !== answers.missing) writeFileSync(join(root, `release/5straps-${name}-0.1.2.tgz`), '')
  }
  const executable = (name: string, source: string) => {
    const file = join(bin, name)
    writeFileSync(file, `#!${process.execPath}\n${source}`)
    chmodSync(file, 0o755)
  }
  const callsFile = join(root, 'npm-calls.jsonl')
  executable('npm', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
    const name = /^\\.\\/release\\/5straps-(protocol|runtime|buckle)-0\\.1\\.2\\.tgz$/.exec(args[2] ?? '')?.[1];
    if (args[0] !== 'stage' || args[1] !== 'publish' || args[3] !== '--access' || args[4] !== 'public' || args.length !== 5 || !name) process.exit(99);
    if (name === ${JSON.stringify(answers.failStage ?? '')}) { process.stderr.write('Duplicate pending stage or staging failure\\n'); process.exit(1); }
    process.stdout.write('+ @5straps/' + name + '@0.1.2 (staged with id stage-' + name + ')\\n');
  `)
  executable('curl', `
    if (${answers.networkFailure ?? false}) process.exit(7);
    const statuses = ${JSON.stringify(answers.statuses ?? {})};
    const name = /%2f([^/]+)/.exec(process.argv.at(-1))?.[1];
    process.stdout.write(String(statuses[name] ?? 404));
  `)
  const script = runScripts(job(RELEASE, 'stage').join('\n')).find(value => value.includes('all_public=true'))
  if (!script) throw new Error('No staging shell block')
  const output = join(root, 'output')
  const summary = join(root, 'summary')
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VERSION: answers.version ?? '0.1.2', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
  })
  return {
    ...result,
    output: existsSync(output) ? readFileSync(output, 'utf8') : '',
    summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '',
    calls: existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : [],
  }
}

describe('executing the npm staging shell', () => {
  it('stages the exact tarballs in dependency order and defers GitHub release until approval', () => {
    const result = runStaging()
    expect(result.status).toBe(0)
    expect(result.calls).toEqual(['protocol', 'runtime', 'buckle'].map(name => ['stage', 'publish', `./release/5straps-${name}-0.1.2.tgz`, '--access', 'public']))
    expect(result.output).toBe('all_public=false\n')
    for (const name of ['protocol', 'runtime', 'buckle']) expect(result.summary).toContain(`staged with id stage-${name}`)
    expect(result.summary).toContain('`npm stage approve <stage-id>`')
    expect(result.summary).toContain('main still names this release commit')
    expect(result.summary).toContain('Re-run all jobs')
  })

  it('allows GitHub finalization only when every package version is already public', () => {
    const result = runStaging({ statuses: { protocol: 200, runtime: 200, buckle: 200 } })
    expect(result.status).toBe(0)
    expect(result.calls).toEqual([])
    expect(result.output).toBe('all_public=true\n')
    expect(result.summary).toContain('All three packages at v0.1.2 are public')
  })

  it('skips public packages and stages only the remaining version', () => {
    const result = runStaging({ statuses: { protocol: 200, runtime: 200 } })
    expect(result.status).toBe(0)
    expect(result.calls).toEqual([['stage', 'publish', './release/5straps-buckle-0.1.2.tgz', '--access', 'public']])
    expect(result.output).toBe('all_public=false\n')
  })

  it('keeps earlier stage IDs when a later stage fails and does not finalize', () => {
    const result = runStaging({ failStage: 'runtime' })
    expect(result.status).not.toBe(0)
    expect(result.calls.map(call => call[2])).toEqual(['./release/5straps-protocol-0.1.2.tgz', './release/5straps-runtime-0.1.2.tgz'])
    expect(result.summary).toContain('staged with id stage-protocol')
    expect(result.output).toBe('')
  })

  it('fails on a duplicate pending stage rather than treating its public 404 as success', () => {
    const result = runStaging({ failStage: 'protocol' })
    expect(result.status).not.toBe(0)
    expect(result.calls).toHaveLength(1)
    expect(result.output).toBe('')
  })

  it.each([403, 500])('refuses registry HTTP %s before staging anything', status => {
    const result = runStaging({ statuses: { protocol: status } })
    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual([])
    expect(result.output).toBe('')
  })

  it('refuses a registry network failure before staging anything', () => {
    const result = runStaging({ networkFailure: true })
    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual([])
    expect(result.output).toBe('')
  })

  it.each([
    ['an invalid version', { version: '0.1.2;bad' }],
    ['a missing tarball', { missing: 'buckle' as const }],
  ])('refuses %s before staging anything', (_, answers) => {
    const result = runStaging(answers)
    expect(result.status).not.toBe(0)
    expect(result.calls).toEqual([])
    expect(result.output).toBe('')
  })
})
