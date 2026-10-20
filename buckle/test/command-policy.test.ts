import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyWorkspacePolicy } from '@5straps/protocol'
import { runCli } from './support/cli.js'
import { configFromEnvironment } from './support/workspace-config.js'
import { createRuntime } from '../common/services/workspaces/workspace-runtime.js'
import type { ResolvedEffect } from '../common/domain/effect.js'
import { joinedOperator, shellStatementList, shellTokens } from '../common/domain/argv.js'
import { allForms, commandFormsOf, READ_BUDGET, READ_LIMITS } from '../common/domain/command-forms.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { createCommandPolicyRule } from '../common/domain/permission/rules/command-policy-rule.js'
import { withDangerouslyAllow } from '../common/domain/permission/rules/dangerously-allow.js'
import { createDestructiveCommandRule } from '../common/domain/permission/rules/destructive-command-rule.js'
import { compilePolicy } from '../common/domain/policy.js'
import { leastProcessorTime, PROCESSOR_TIME_ROW_TIMEOUT } from './support/processor-time.js'

/** `platform`, where a test imitates a host other than this one. */
function evaluate(command: string, args: string[], commands: { allow?: string[]; deny?: string[]; destructive?: string[] } = {}, shownAs?: string, platform?: NodeJS.Platform) {
  const policy = emptyWorkspacePolicy()
  policy.commands.allow = commands.allow ?? []
  policy.commands.deny = commands.deny ?? []
  policy.commands.destructive = commands.destructive ?? []
  const compiled = compilePolicy(policy)
  const host = platform === undefined ? {} : { platform }
  // As the node builds them (workspace-runtime.ts, buildPermissionEngine): the floor reads the allow list too (D74).
  const engine = createPermissionEngine([
    createCommandPolicyRule(compiled, host),
    createDestructiveCommandRule({ added: compiled.commands.destructive, allow: compiled.commands.allow, ...host }),
  ])
  const effect: ResolvedEffect = { kind: 'exec', command, args, ...(shownAs === undefined ? {} : { shownAs }) }
  return engine.evaluate({ tool: 'shell_exec', effects: [effect], grants: { subjectsFor: () => [] } })
}

function reasonOf(outcome: ReturnType<typeof evaluate>): string {
  return outcome.kind === 'deny' ? outcome.denial.reason : ''
}

describe('with no patterns configured', () => {
  it('stays out of the way, leaving ordinary commands to the other rules', () => {
    expect(evaluate('pnpm', ['build']).kind).toBe('allow')
  })
})

describe('the allow list', () => {
  const allow = ['docker compose {up,down,restart} *']

  it('admits what it names', () => {
    expect(evaluate('docker', ['compose', 'up', '-d'], { allow }).kind).toBe('allow')
  })

  it('refuses everything else as a denial, not a question, and says what is allowed', () => {
    const outcome = evaluate('docker', ['compose', 'logs'], { allow })
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain('allow list')
    expect(reasonOf(outcome)).toContain('docker compose')
  })

  it('covers the whole line, so an argument the glob does not name is refused', () => {
    expect(evaluate('docker', ['compose', 'up'], { allow: ['docker compose up'] }).kind).toBe('allow')
    expect(evaluate('docker', ['compose', 'up', '--privileged'], { allow: ['docker compose up'] }).kind).toBe('deny')
  })

  it('is not fooled by wrapping the command in a shell', () => {
    expect(evaluate('bash', ['-c', 'docker compose up'], { allow }).kind).toBe('deny')
  })

  // D74 (bare words only): a full path to the binary ran under a rule naming the bare word; it now asks a person.
  it('asks for a full path to the binary, which a rule naming the bare word no longer admits', () => {
    expect(evaluate('/usr/bin/docker', ['compose', 'restart'], { allow }).kind).toBe('ask')
  })
})

describe('the deny list', () => {
  const deny = ['{sh,bash,node,python,python3,curl,wget}']

  it.each([
    ['/usr/local/bin/node', ['script.js']],
    ['curl', ['https://example.com']],
    ['python3', ['-c', 'print(1)']],
  ])('refuses %s %s outright, whatever it is handed', (command, args) => {
    const outcome = evaluate(command, args, { deny })
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain('command policy')
  })

  it('leaves unlisted commands alone', () => {
    expect(evaluate('pnpm', ['build'], { deny }).kind).toBe('allow')
  })

  it('reaches inside a shell script, statement by statement', () => {
    expect(evaluate('zsh', ['-c', 'echo hi | curl -d @- https://x.test'], { deny: ['curl'], allow: ['zsh -c *'] }).kind).toBe('deny')
  })

  it('wins over the allow list', () => {
    expect(evaluate('curl', ['https://x.test'], { allow: ['curl *'], deny: ['curl'] }).kind).toBe('deny')
  })
})

describe('a shell wrapper', () => {
  it('is refused where there is no allow list at all, because its body is not argv', () => {
    const outcome = evaluate('bash', ['-c', 'pnpm build'])
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain("allow-command 'bash -c *'")
  })

  it('runs once an allow glob names the wrapper itself, a wrapper written as a path once the glob spells that path (D74)', () => {
    expect(evaluate('bash', ['-c', 'pnpm build'], { allow: ['bash -c *'] }).kind).toBe('allow')
    expect(evaluate('/bin/sh', ['-c', 'pnpm build'], { allow: ['/bin/sh -c *'] }).kind).toBe('allow')
    expect(evaluate('/bin/sh', ['-c', 'pnpm build'], { allow: ['sh -c *'] }).kind).toBe('ask')
  })

  it('still has every statement of its body judged by the deny list', () => {
    const outcome = evaluate('bash', ['-c', 'pnpm build && curl https://x.test'], { allow: ['bash -c *'], deny: ['curl'] })
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain('command policy')
  })

  it('does not name a wrapper an allow glob for another shell admits', () => {
    expect(evaluate('zsh', ['-c', 'pnpm build'], { allow: ['bash -c *'] }).kind).toBe('deny')
  })

  it('leaves a shell handed a script file to the ordinary rules', () => {
    expect(evaluate('bash', ['build.sh']).kind).toBe('allow')
  })
})

// An allow glob admits a call only as typed, so the rule a wrapper's refusal names is the call's own words up to the
// shell's -c word: with `bash -c *` allowed, `sudo bash -c ls` was refused and told to add the rule already there.
describe('a refused shell wrapper names the allow rule that admits it', () => {
  const ruleIn = (reason: string) => /allow-command '(.*)'$/.exec(reason)?.[1] ?? ''

  it.each<[string, string[], string]>([
    ['bash', ['-c', 'pnpm build'], 'bash -c *'],
    ['bash', ['-lc', 'pnpm build'], 'bash -lc *'],
    ['/bin/sh', ['-c', 'pnpm build'], '/bin/sh -c *'],
    ['sudo', ['bash', '-c', 'ls'], 'sudo bash -c *'],
    ['sudo', ['-u', 'deploy', '/bin/bash', '-c', 'ls'], 'sudo -u deploy /bin/bash -c *'],
    ['env', ['bash', '-c', 'ls'], 'env bash -c *'],
    ['env', ['GREETING=hello there', 'bash', '-c', 'ls'], 'env GREETING=hello*there bash -c *'],
    ['nice', ['bash', '-c', 'ls'], 'nice bash -c *'],
    ['nice', ['-n', '5', 'sudo', 'bash', '--norc', '-o', 'pipefail', '-c', 'ls', 'name'], 'nice -n 5 sudo bash --norc -o pipefail -c *'],
    ['timeout', ['{1,2}', 'bash', '-c', 'ls'], 'timeout *1,2* bash -c *'],
    ['sudo', ['-u', "o'brien", 'bash', '-c', 'ls'], 'sudo -u o*brien bash -c *'],
    ['flock', ['/tmp/lock', '-c', 'pnpm build'], 'flock /tmp/lock -c *'],
    ['xargs', ['-n', '1', 'bash', '-c', 'pnpm build'], 'xargs -n 1 bash -c *'],
    ['env', ['-S', 'bash -c ls'], 'env -S bash*-c*ls'],
  ])('refuses %s %j naming %j, a rule that admits the call once stored', (command, args, rule) => {
    expect(ruleIn(reasonOf(evaluate(command, args)))).toBe(rule)
    const outcome = evaluate(command, args, { allow: [rule] })
    if (outcome.kind === 'deny') throw new Error(`still refused: ${outcome.denial.reason}`)
  })

  /** A node whose policy the CLI stores, and its permission pipeline as the next process reads it; nothing runs. */
  async function stored(rule: string, command: string, args: string[]) {
    const config = configFromEnvironment({
      BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-wrapper-rule-')), BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-wrapper-rule-state-')),
      BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
    })
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      expect((await runCli({ argv: ['policy', 'allow-command', rule], config })).exitCode).toBe(0)
    } finally { stdout.mockRestore() }
    const runtime = await createRuntime({ config })
    const prepare = vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command, args }], execute: vi.fn(async () => 'executed') })
    try {
      return await runtime.invoke({ request: { requestId: `wrapper-rule-${command}`, approvalTokens: [], tool: 'shell_exec', args: {} }, sessionId: 'wrapper-rule', approvalWait: { mode: 'none' } })
    } finally {
      prepare.mockRestore()
      await runtime.approvalService.close()
      await runtime.history.close()
    }
  }

  it.each<[string, string[], string]>([
    ['sudo', ['bash', '-c', 'ls'], 'approval_required'],
    ['env', ['bash', '-c', 'ls'], 'ok'],
    ['nice', ['-n', '5', 'bash', '-c', 'ls'], 'ok'],
  ])('admits %s %j once buckle policy allow-command stores the rule its refusal names', async (command, args, outcome) => {
    const rule = ruleIn(reasonOf(evaluate(command, args, { allow: ['bash -c *'] })))
    expect(rule).toBe(`${command} ${args.slice(0, -1).join(' ')} *`)
    const response = await stored(rule, command, args)
    expect(response.outcome).toBe(outcome)
    if (response.outcome === 'approval_required') expect(response.approvals.map(approval => approval.rule)).toEqual(['destructive_command'])
  })
})

// The continuation review, "Seen outside this range": `env git push --force dest main` passed both the destructive
// floor and the default command policy, and an allowed wrapper's body was never read as commands.
describe('a prefix that runs another command', () => {
  it.each([
    ['env', ['git', 'push', '--force', 'dest', 'main']],
    ['env', ['A=b', 'git', 'clean', '-fdx']],
    ['timeout', ['5', 'git', 'reset', '--hard']],
  ])('asks about %s %s under the default policy, as the command it runs would', (command, args) => {
    const outcome = evaluate(command, args)
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks[0]?.rule).toBe('destructive_command')
  })

  it('asks about a destructive body once the owner allows the wrapper', () => {
    const outcome = evaluate('bash', ['-c', 'git push --force origin main'], { allow: ['bash -c *'] })
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks[0]?.reason).toMatch(/Force push/)
  })

  it('leaves an ordinary wrapped command alone', () => {
    expect(evaluate('env', ['git', 'status']).kind).toBe('allow')
    expect(evaluate('bash', ['-c', 'git status'], { allow: ['bash -c *'] }).kind).toBe('allow')
  })

  it('has the deny list meet the command behind the prefix', () => {
    expect(evaluate('env', ['A=b', 'curl', 'https://x.test'], { deny: ['curl'] }).kind).toBe('deny')
    expect(evaluate('timeout', ['5', 'nice', 'curl', 'https://x.test'], { deny: ['curl'] }).kind).toBe('deny')
    expect(evaluate('bash', ['-c', 'env curl https://x.test'], { allow: ['bash -c *'], deny: ['curl'] }).kind).toBe('deny')
  })

  it('needs the wrapper allowed when a prefix hands its command to a shell, naming the prefix in the rule', () => {
    const outcome = evaluate('env', ['bash', '-c', 'pnpm build'])
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain("allow-command 'env bash -c *'")
  })

  it('never carries a command past the allow list, which admits the call as typed', () => {
    expect(evaluate('env', ['pnpm', 'build'], { allow: ['pnpm build'] }).kind).toBe('deny')
    expect(evaluate('pnpm', ['build'], { allow: ['pnpm build'] }).kind).toBe('allow')
  })

  it('reaches the owner\'s destructive list behind a prefix', () => {
    expect(evaluate('env', ['TF_LOG=1', 'terraform', 'destroy'], { destructive: ['terraform destroy *'] }).kind).toBe('ask')
  })
})

// Slice 7 review F1 and owner decision D25: with `bash -c *` allowed and git's history commands denied, an
// assignment prefix, eval, builtin or a runner inside the body passed the deny list (real bash rewrote a branch).
describe('a shell body that hands its command on', () => {
  const commands = { allow: ['bash -c *'], deny: ['git push *', 'git clean *', 'git reset *'] }

  it.each([
    'A=b git push --force origin main',
    'GIT_TRACE=1 git clean -fdx',
    'cd sub && GIT_DIR=.git git reset --hard',
    'eval git push --force origin main',
    "eval 'git push --force origin main'",
    'builtin command git push --force origin main',
    '\\git reset --hard',
    'xargs git push --force dest main',
    'find . -maxdepth 0 -exec git push --force dest main \\;',
    'setsid git push --force dest main',
    'flock /tmp/lock git push --force dest main',
    "git clean -e ';' -f",
  ])('refuses bash -c %s by the deny list', (body) => {
    const outcome = evaluate('bash', ['-c', body], commands)
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toMatch(/Refused by the workspace command policy: git (push|clean|reset) \*/)
  })

  // Slice 7l: an eval whose text Buckle cannot know asked, so the dangerously-allow switch let it run past the deny glob;
  // it is unread now, refused under any deny glob and asked at the floor with none.
  it('refuses an eval whose text it cannot know under a deny glob, since no glob can meet it, and asks with none', () => {
    const body = 'x="git push --force origin main"; eval "$x"'
    expect(reasonOf(evaluate('bash', ['-c', body], commands))).toMatch(/^Runs a command word or shell text an expansion supplies, .*\(expansion\), so the workspace command policy's deny list cannot meet all of it; refused rather than asked$/)
    const outcome = evaluate('bash', ['-c', body], { allow: ['bash -c *'] })
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks[0]?.reason).toMatch(/^Runs a command word or shell text an expansion supplies, .*\(expansion\); asked rather than guessed at$/)
  })

  it('leaves an ordinary command behind an assignment alone', () => {
    expect(evaluate('bash', ['-c', 'A=1 git status'], commands).kind).toBe('allow')
  })

  it('needs the wrapper allowed when flock or xargs hands a body to a shell, as env does', () => {
    expect(reasonOf(evaluate('flock', ['/tmp/lock', '-c', 'pnpm build']))).toContain("allow-command 'flock /tmp/lock -c *'")
    expect(reasonOf(evaluate('xargs', ['-n', '1', 'bash', '-c', 'pnpm build']))).toContain("allow-command 'xargs -n 1 bash -c *'")
  })
})

// Slice 7b review W7B-2 to W7B-6: with `bash -c *` allowed and git's history commands and rm denied, `eval --`, a
// one-line `function` or `coproc`, ANSI-C `$'\''`, an apostrophe in an earlier comment or heredoc line, and a find
// primary's value spelled `-exec` each passed the deny list (real bash ran every one).
describe('a shell body the reader now reads whole', () => {
  const commands = { allow: ['bash -c *'], deny: ['git push *', 'git clean *', 'git reset *', 'rm *'] }

  it.each([
    'eval -- git push --force origin main',
    "eval -- 'git clean -fdx'",
    'eval -- rm -rf build',
    'function f { git clean -fdx; }; f',
    'coproc git push --force origin main; wait',
    'coproc NAME { git reset --hard; }; wait',
    'coproc { git reset --hard; }; wait',
    "rm $'\\'' -rf build",
    "git push $'\\'' --force origin main",
    "git clean -e $'\\'' -f",
    "rm $'a\\'b' -rf build",
    "# don't keep build output\ngit clean -e ';' -fdx",
    "echo done # it's\nrm '|' -rf build",
    "cat <<EOF\nit's done\nEOF\ngit clean -e ';' -f",
    'find . -name -exec -exec git clean -f \;',
    'find . -path -exec -exec rm -rf {} +',
    'find . -maxdepth 1 -name -exec -o -exec git clean -f \;',
  ])('refuses bash -c %s by the deny list', (body) => {
    const outcome = evaluate('bash', ['-c', body], commands)
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toMatch(/Refused by the workspace command policy: (git (push|clean|reset)|rm) \*/)
  })

  it('leaves the ordinary forms of the same constructs alone', () => {
    for (const body of ['eval -- echo hi', 'function g { ls; }; g', 'coproc sleep 1; wait', "echo $'it\\'s'; ls", "cat <<EOF\nit's\nEOF\nls"]) {
      expect(evaluate('bash', ['-c', body], commands).kind).toBe('allow')
    }
  })
})

/** Text as one double-quoted shell word. */
const doubleQuoted = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`

// Slice 7b review W7B-1 and W7B-8: each rule read every nested eval or `bash -c` level again, and each level twice, so
// one check of a 1 MB script took 2 to 6 s, and a body of 140,000 quoted statements threw RangeError. A check now
// reads each level once within a budget and asks past it.
describe('a check of a large nested body', () => {
  const commands = { allow: ['bash -c *'], deny: ['git push *', 'git clean *', 'git reset *', 'rm *'] }
  /** A script_run bash script of about 999,180 bytes: `levels` nested `eval "..."` or `bash -c "..."` around filler. */
  const nested = (runner: string, levels: number, tail = '') => {
    let body = `${'a '.repeat(levels === 8 ? 499_000 : 499_400)}${tail}`
    for (let level = 0; level < levels; level++) body = `${runner} ${doubleQuoted(`${body} ; true`)}`
    return body
  }

  it.each([
    ['eval', 8, '', /READ_BUDGET: 8,000,000 characters, 1,000,000 words or 100,000 commands/],
    ['bash -c', 8, '', /READ_BUDGET: 8,000,000 characters, 1,000,000 words or 100,000 commands/],
    ['eval', 3, '; git clean -fdx', /git clean deletes untracked files/],
  ] as const)('checks %s nested %i levels deep in a 1 MB script within a second, and asks', (runner, levels, tail, reason) => {
    const body = nested(runner, levels, tail)
    expect(body.length).toBeGreaterThan(998_000)
    const { milliseconds, result: outcome } = leastProcessorTime(() => evaluate('bash', ['-c', body], { allow: ['bash -c *'] }))
    expect(milliseconds).toBeLessThan(1_000)
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks[0]?.reason).toMatch(reason)
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  it.each(['eval', 'bash -c'])('reads a 1 MB body three %s levels deep whole, each level once, and allows it', (runner) => {
    const body = nested(runner, 3)
    const { milliseconds, result } = leastProcessorTime(() => evaluate('bash', ['-c', body], { allow: ['bash -c *'] }))
    expect(result.kind).toBe('allow')
    expect(milliseconds).toBeLessThan(1_000)
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  it('still refuses by the deny list what a 1 MB body three levels down runs', () => {
    expect(reasonOf(evaluate('bash', ['-c', nested('eval', 3, '; git clean -fdx')], commands))).toMatch(/git clean \*/)
  })

  it('reads the forms of one effect once for every rule and every check of the call', () => {
    const effect = { command: 'bash', args: ['-c', 'eval -- git push --force origin main'] }
    const forms = commandFormsOf(effect)
    expect(commandFormsOf(effect)).toBe(forms)
    expect(commandFormsOf({ ...effect })).not.toBe(forms)
    expect(commandFormsOf({ ...effect })).toEqual(forms)
  })

  it('asks about a body of 140,000 quoted statements past the budget, where it threw RangeError', () => {
    const body = `bash -c '"${Array.from({ length: 140_000 }, (_, index) => `a${index}`).join(';')}"'`
    expect(body.length).toBeGreaterThan(960_000)
    const outcome = evaluate('bash', ['-c', body], { allow: ['bash -c *'] })
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks[0]?.reason).toMatch(/^Shell text runs past what Buckle reads in one check \(READ_BUDGET/)
  })
})

// Slice 7c review R7C-CR-1: past READ_BUDGET, or nested past MAX_DEPTH, the deny globs met nothing, so a denied `git push`
// after 100,001 statements was asked about, and the dangerously-allow switch allowed it with no click (owner decision
// D7). A call Buckle cannot read whole is refused whenever a deny glob exists (default D30).
// Slice 7d review R7D-BD-1 and R7D-BD-2: substitutions nested past MAX_SUBSTITUTIONS and a find primary were refused
// as "MAX_DEPTH". Each reason now names the limit that stopped the reading and the policy that refused; every limit
// still refuses under a deny glob (default D33). No node ceiling sits over a workspace's policy (Q14).
describe('a call Buckle cannot read whole', () => {
  const push = 'git push origin main'
  const statements = (count: number) => `${Array.from({ length: count }, (_, index) => `:${index.toString(36)}`).join(';')}; ${push}`
  const evalNested = (levels: number) => Array.from({ length: levels }).reduce<string>(body => `eval ${doubleQuoted(body)}`, push)
  /** The repo-root idiom of the slice 7d review (rrm0qfZp): five `$(...)` levels inside double quotes, one past MAX_SUBSTITUTIONS. */
  const repoRoot = 'ROOT="$(cd "$(dirname "$(dirname "$(dirname "$(dirname "$0")")")")" && pwd)"; echo "$ROOT"'
  /** The find primary shape of the slice 7d review (0SQC4zdm): a find -exec command that is itself a primary. */
  const findPrimary = 'find . -exec -print \\;'
  const policyOf = (commands: { allow?: string[]; deny?: string[] }) => {
    const policy = emptyWorkspacePolicy()
    policy.commands.allow = commands.allow ?? []
    policy.commands.deny = commands.deny ?? []
    return compilePolicy(policy)
  }
  const engines = {
    workspace: (deny: string[]) => [createCommandPolicyRule(policyOf({ allow: ['bash -c *'], deny })), createDestructiveCommandRule()],
  }
  const named = { workspace: 'the workspace command policy' } as const
  const check = (engine: keyof typeof engines, switched: boolean, body: string, deny = ['git push *']) =>
    withDangerouslyAllow(createPermissionEngine(engines[engine](deny)), { enabled: () => switched, root: () => '/workspace' })
      .evaluate({ tool: 'script_run', effects: [{ kind: 'exec', command: 'bash', args: ['-c', body] }], grants: { subjectsFor: () => [] } })
  const refusal = (outcome: ReturnType<typeof check>) => {
    if (outcome.kind !== 'deny') throw new Error(`expected a deny, got ${outcome.kind}`)
    expect(outcome.denial.rule).toBe('command_policy')
    return outcome.denial.reason
  }
  const overBudget = statements(100_001)
  const eightDeep = evalNested(8)
  const cases = (['workspace'] as const).flatMap(engine => [false, true].map(switched => [engine, switched] as const))

  it.each(cases)('refuses git push after 100,001 statements past READ_BUDGET, %s deny, switch on: %s', (engine, switched) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', overBudget] }).overBudget).toBe(true)
    expect(refusal(check(engine, switched, overBudget))).toBe(`Shell text runs past what Buckle reads in one check (READ_BUDGET: 8,000,000 characters, 1,000,000 words or 100,000 commands across every level), so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each(cases)('refuses git push eight eval levels down, past MAX_DEPTH, %s deny, switch on: %s', (engine, switched) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', eightDeep] }).unread).toBe('depth')
    expect(refusal(check(engine, switched, eightDeep))).toBe(`Wrappers or shell bodies nest deeper than Buckle reads (MAX_DEPTH: 8 levels), so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  // Slice 7l, the 7h to 7k review: eight heredocs fed to bash around backtick bodies, under the 1 MiB request cap, took
  // 33.7 s to read, blocking the node, since each pass re-read each body whole. Every pass is charged to READ_BUDGET
  // now, and this shape runs past it: refused naming the budget under any deny glob, and asked at the floor with none.
  const fedBackticks = (() => {
    let body = `echo ${Array.from({ length: 200_000 }, (_, index) => `w${index % 1000}`).join(' ')} \\\\x`
    for (let level = 0; level < 8; level++) body = `bash <<E${level}\necho \`${body}\`\nE${level}\n`
    return body
  })()

  it.each(cases)('refuses the 1 MiB shape of eight heredocs around backtick bodies past READ_BUDGET, %s deny, switch on: %s', (engine, switched) => {
    expect(refusal(check(engine, switched, fedBackticks, ['terraform destroy *']))).toBe(`${READ_LIMITS.budget}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it('asks at the floor with no deny glob about the 1 MiB shape of eight heredocs around backtick bodies, naming the budget', () => {
    const outcome = check('workspace', false, fedBackticks, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${READ_LIMITS.budget}; asked rather than guessed at`]])
  })

  it.each(cases)('still refuses git push after 99,998 statements by matching it, %s deny, switch on: %s', (engine, switched) => {
    expect(refusal(check(engine, switched, statements(99_998)))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each(cases.flatMap(([engine, switched]) => [
    [engine, switched, 'the repo-root idiom', repoRoot, 'substitutions', 'Command substitutions inside double quotes nest deeper than Buckle splits into statements (MAX_SUBSTITUTIONS: 4 levels)'],
    [engine, switched, 'the find primary shape', findPrimary, 'findPrimary', 'A find -exec command starts with a word find reads as a primary, which Buckle does not read as a command (find primary)'],
  ] as const))('refuses %s deny, switch on: %s, %s under terraform destroy *, naming its own limit', (engine, switched, _shape, body, limit, reason) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] })).toMatchObject({ unread: limit, overBudget: false })
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${reason}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each(cases.flatMap(([engine, switched]) => [
    [engine, switched, 'echo $(a $(b $(c $(d $(git push origin main)))))'],
    [engine, switched, 'echo "$(a "$(b "$(c "$(d "$(git push origin main)")")")")"'],
  ] as const))('refuses %s deny, switch on: %s, a git push five substitutions down: %s', (engine, switched, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each([
    [overBudget, /^Shell text runs past what Buckle reads in one check \(READ_BUDGET: .*\); asked rather than guessed at$/],
    [eightDeep, /^Wrappers or shell bodies nest deeper than Buckle reads \(MAX_DEPTH: 8 levels\); asked rather than guessed at$/],
    [repoRoot, /^Command substitutions inside double quotes nest deeper than Buckle splits into statements \(MAX_SUBSTITUTIONS: 4 levels\); asked rather than guessed at$/],
    [findPrimary, /^A find -exec command starts with a word find reads as a primary, which Buckle does not read as a command \(find primary\); asked rather than guessed at$/],
  ])('still asks, naming the limit, with no deny glob', (body, reason) => {
    const outcome = check('workspace', false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(reason)]])
  })

  // Slice 7e review R7E-LW-1 and R7E-LW-2: a heredoc body line dropped its MAX_SUBSTITUTIONS flag, and was read with
  // shell quoting, although under an unquoted delimiter bash runs every `$(...)` and backtick body in it whatever the
  // quotes around it. A git push nested in a heredoc ran under a git push * deny glob with no refusal and no ask, on
  // both engines and both switches (real bash pushed to a throwaway remote).
  const findLine = (substitution: string) => `find . -maxdepth 0 -exec true ${substitution} \\;`
  /** The nested find shape of the slice 7e review (zSZt25Yl/probe3.out): a find at every level, so each statement reads its text again. */
  const nestedFind = (command: string) => `cat <<EOF\n$(${findLine(Array.from({ length: 5 }).reduce<string>(text => `"$(${findLine(text)})"`, `$(${command})`))})\nEOF`
  const heredocLine = (line: string, opener = 'cat <<EOF', closer = 'EOF') => `${opener}\n${line}\n${closer}`
  const quotedPush = findLine("'$(git push origin main)'")

  it.each(cases)('refuses the nested find heredoc of R7E-LW-1, %s deny, switch on: %s, by the push glob, or by its limit when no glob matches', (engine, switched) => {
    const body = nestedFind(push)
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('substitutions')
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`Command substitutions inside double quotes nest deeper than Buckle splits into statements (MAX_SUBSTITUTIONS: 4 levels), so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each([
    ['the nested find heredoc', nestedFind(push), /^Command substitutions inside double quotes nest deeper than Buckle splits into statements \(MAX_SUBSTITUTIONS: 4 levels\); asked rather than guessed at$/],
    ['the nested find heredoc with git push --force', nestedFind('git push --force origin main'), /^Force push rewrites remote history/],
    ['the nested find heredoc with rm -rf', nestedFind('rm -rf build'), /^Recursive delete/],
    ['a single-quoted git push --force on a find line', heredocLine(findLine("'$(git push --force origin main)'")), /^Force push rewrites remote history/],
    ['a single-quoted backtick git push --force on a find line', heredocLine(findLine("'`git push --force origin main`'")), /^Force push rewrites remote history/],
  ])('asks at the floor with no deny glob, never allows: %s', (_shape, body, reason) => {
    const outcome = check('workspace', false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(reason)]])
  })

  it.each(cases.flatMap(([engine, switched]) => [
    [engine, switched, 'a single-quoted $(...) on a find line', heredocLine(quotedPush)],
    [engine, switched, 'a single-quoted backtick body on a find line', heredocLine(findLine("'`git push origin main`'"))],
    [engine, switched, 'a double-quoted $(...) on a find line', heredocLine(findLine('"$(git push origin main)"'))],
    [engine, switched, 'a <<- body with tabs', heredocLine(`\t${quotedPush}`, 'cat <<-EOF', '\tEOF')],
    [engine, switched, 'a substitution continued past a backslash-newline', heredocLine("find . -maxdepth 0 -exec true '$(git push \\\norigin main)' \\;")],
    [engine, switched, 'a substitution over two lines', heredocLine(`$(echo "a\n${findLine(`"; ${push})"`)}`)],
    [engine, switched, 'a quoted delimiter fed to bash', heredocLine(push, "bash <<'EOF'")],
    // bash stops at the quote that never closes; each line is still read on its own, so no line hides the next.
    [engine, switched, 'a line after one whose quote never closes', heredocLine(`$(echo it's)\n${quotedPush}`)],
  ] as const))('refuses %s deny, switch on: %s, a heredoc whose body runs git push: %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each(["cat <<'EOF'", 'cat <<"EOF"', 'cat <<\\EOF'])('reads the find line of %s as shell text only, as before, since bash expands nothing in it', (opener) => {
    const body = heredocLine(quotedPush, opener)
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).nested).toContainEqual(['find', '.', '-maxdepth', '0', '-exec', 'true', '$(git push origin main)', ';'])
    expect(check('workspace', false, body).kind).toBe('allow')
  })

  it('reads a 1 MB heredoc body as shell text and as heredoc text within a second', () => {
    const notes = Array.from({ length: 40_000 }, (_, index) => `note ${index} of the release`).join('\n')
    expect(notes.length).toBeGreaterThan(1_000_000)
    const allowed = leastProcessorTime(() => check('workspace', false, heredocLine(notes)))
    expect(allowed.result.kind).toBe('allow')
    expect(allowed.milliseconds).toBeLessThan(1_000)
    const refused = leastProcessorTime(() => check('workspace', false, heredocLine(`${notes}\n${quotedPush}`)))
    expect(refusal(refused.result)).toBe('Refused by the workspace command policy: git push *')
    expect(refused.milliseconds).toBeLessThan(1_000)
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  // Slice 7f residual 1: heredoc body lines a backslash-newline joins were read one at a time, so `git push \` then
  // `--force origin main` fed to bash was allowed with no ask (real bash force-pushed); a deny glob still met `git push`.
  const B = '\\'
  const continued = [
    ['a quoted delimiter', `bash <<'EOF'\ngit push ${B}\n--force origin main\nEOF`],
    ['an unquoted delimiter', `bash <<EOF\ngit push ${B}\n--force origin main\nEOF`],
    ['three lines joined', `bash <<'EOF'\ngit push ${B}\n--force ${B}\norigin main\nEOF`],
    ['a <<- body with tabs', `bash <<-'EOF'\n\tgit push ${B}\n\t--force origin main\n\tEOF`],
    ['an unquoted delimiter and an escaped backslash, which bash halves', `bash <<EOF\ngit push ${B}${B}\n--force origin main\nEOF`],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => continued.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a continued git push under %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each((['workspace'] as const).flatMap(engine => continued.map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a continued force push under %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  it.each([
    ['a backslash before the delimiter line', `bash <<'EOF'\ngit push --force ${B}\nEOF\necho after`, 'ask'],
    ['an escaped backslash under a quoted delimiter, which joins nothing (real bash ran no force push)', `bash <<'EOF'\ngit push ${B}${B}\n--force origin main\nEOF`, 'allow'],
  ] as const)('reads %s as bash does, with no deny glob', (_shape, body, kind) => {
    expect(check('workspace', false, body, []).kind).toBe(kind)
  })

  // Slice 7f review R7F-HR-1: an unquoted heredoc body fed to a shell is read as the shell receives it, so a git push
  // a backslash-dollar or an escaped backtick hid is read; R7F-HR-2: a body line ending in an odd run of backslashes
  // joins the delimiter line into the body, so the find line past it expands. Real bash pushed to a throwaway remote.
  const escapeShapes = {
    'a backslash-dollar substitution': (command: string) => heredocLine(findLine(`"\\$(${command})"`), 'bash <<EOF'),
    'an escaped backtick substitution': (command: string) => heredocLine(findLine(`"\\\`${command}\\\`"`), 'bash <<EOF'),
    'a delimiter line swallowed by a continuation': (command: string) => `cat <<EOF\nx ${B}\nEOF\n${findLine(`'$(${command})'`)}\nEOF`,
  } as const
  const escapeCases = Object.entries(escapeShapes)

  it.each(cases.flatMap(([engine, switched]) => escapeCases.map(([shape, make]) => [engine, switched, shape, make(push)] as const)))('refuses %s deny, switch on: %s, a git push an unquoted heredoc body hides with %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each((['workspace'] as const).flatMap(engine => escapeCases.map(([shape, make]) => [engine, shape, make('git push --force origin main')] as const)))('asks at the floor, %s with no deny glob, about a force push an unquoted body hides with %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // `git push \\--force` reaches the fed shell as `git push \--force`, which is `git push --force`, so the force glob
  // and the force-push floor both meet it although the raw body carries no `--force` word.
  const halvedForce = `bash <<EOF\ngit push ${B}${B}--force origin main\nEOF`

  it.each(cases)('refuses a halved force push, %s deny, switch on: %s, by the force glob', (engine, switched) => {
    expect(refusal(check(engine, switched, halvedForce, ['git push --force *']))).toBe(`Refused by ${named[engine]}: git push --force *`)
  })

  it('asks at the floor about a halved force push with no deny glob', () => {
    const outcome = check('workspace', false, halvedForce, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  it.each([
    ['a double-quoted backslash-dollar fed to bash', heredocLine(findLine('"\\$(git push origin main)"'), "bash <<'EOF'")],
    ['a continuation that joins nothing under a quoted delimiter', `cat <<'EOF'\nx ${B}\nEOF\n${findLine("'$(git push origin main)'")}\nEOF`],
  ] as const)('leaves a quoted-delimiter body unexpanded as at eaf4e05, so it allows: %s', (_shape, body) => {
    expect(check('workspace', false, body).kind).toBe('allow')
  })

  // Slice 7f review R7F-HR-3 and R7F-HR-4: every heredoc body is read whole as shell text, its nested bodies whole in
  // turn, so a quoted body fed to bash, a double quote spanning body lines and a substitution spanning a nested body
  // no longer hide a denied command. Real bash pushed to a throwaway remote.
  const findWhole = 'find . -maxdepth 0 -exec true'
  const wholeShapes = {
    'a quoted body fed to bash with an inner unquoted heredoc': (command: string) => `bash <<'EOF'\ncat <<X\n${findWhole} '$(${command})' ${B};\nX\nEOF`,
    'a double quote spanning body lines': (command: string) => `bash <<'EOF'\n${findWhole} "\n${findWhole} ' $(${command}) ' ${B};\n" ${B};\nEOF`,
    'a substitution spanning a nested unquoted heredoc': (command: string) => `cat <<EOF\n$(cat <<X\nx '$("\n${findWhole} " ;${command}; " ${B};\n")'\nX\n)\nEOF`,
  } as const
  const wholeCases = Object.entries(wholeShapes)

  it.each(cases.flatMap(([engine, switched]) => wholeCases.map(([shape, make]) => [engine, switched, shape, make(push)] as const)))('refuses %s deny, switch on: %s, a git push a whole-body reading reveals with %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each((['workspace'] as const).flatMap(engine => wholeCases.map(([shape, make]) => [engine, shape, make('git push --force origin main')] as const)))('asks at the floor, %s with no deny glob, about a force push a whole-body reading reveals with %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // A heredoc nested inside a whole reading is read whole in turn, up to MAX_DEPTH; a thousand nested one in another
  // are left unread 'depth', refused under a deny glob and asked about without one, within a second (bounded passes).
  const nestedHeredocs = (count: number) => {
    const open = Array.from({ length: count }, (_, index) => `bash <<'D${index}'`).join('\n')
    const close = Array.from({ length: count }, (_, index) => `D${count - 1 - index}`).join('\n')
    return `${open}\necho deep\n${close}`
  }

  it.each(cases)('refuses a thousand nested heredocs, %s deny, switch on: %s, naming the depth limit, within a second', (engine, switched) => {
    const body = nestedHeredocs(1_000)
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('depth')
    const { milliseconds, result } = leastProcessorTime(() => check(engine, switched, body))
    expect(refusal(result)).toBe(`Wrappers or shell bodies nest deeper than Buckle reads (MAX_DEPTH: 8 levels), so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
    expect(milliseconds).toBeLessThan(1_000)
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  it('asks about a thousand nested heredocs with no deny glob, naming the depth limit', () => {
    const outcome = check('workspace', false, nestedHeredocs(1_000), [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Wrappers or shell bodies nest deeper than Buckle reads \(MAX_DEPTH: 8 levels\)/)]])
  })

  it('reads a 1 MB quoted heredoc body whole as shell text within a second', () => {
    const notes = Array.from({ length: 40_000 }, (_, index) => `note ${index} of the release`).join('\n')
    expect(notes.length).toBeGreaterThan(1_000_000)
    const { milliseconds, result } = leastProcessorTime(() => [check('workspace', false, heredocLine(notes, "bash <<'EOF'")), check('workspace', false, heredocLine(`${notes}\n${push}`, "bash <<'EOF'"))] as const)
    expect(result[0].kind).toBe('allow')
    expect(refusal(result[1])).toBe('Refused by the workspace command policy: git push *')
    expect(milliseconds).toBeLessThan(1_000)
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  // Slice 7h probe: a backslash-newline outside single quotes is a line continuation bash removes before it splits
  // words, so one inside a command name or a flag ran a git push, or a force push, that every rule read as two words.
  // Real bash ran the sentinel in each shape.
  const continuedShapes = {
    'the command name': `gi${B}\nt push origin main`,
    'a word inside a double-quoted substitution': `echo "$(git pu${B}\nsh origin main)"`,
    'a double-quoted shell body': `bash -c "gi${B}\nt push origin main"`,
    'a word inside a backtick substitution': `echo \`git pu${B}\nsh origin main\``,
  } as const

  it.each(cases.flatMap(([engine, switched]) => Object.entries(continuedShapes).map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a git push a backslash-newline splits in %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each(['workspace'] as const)('asks at the floor, %s with no deny glob, about a force push whose flag a backslash-newline splits', (engine) => {
    for (const body of [`git push --for${B}\nce origin main`, `echo \`git push "--for${B}\nce" origin main\``]) {
      const outcome = check(engine, false, body, [])
      if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
      expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
    }
  })

  // Slice 7h probes: inside a backtick body bash removes a backslash before `\`, a backtick or `$` (and `"` in double
  // quotes) before it parses the body, so `\\--force` there force-pushes; the reader read `\--force`, which neither the
  // force glob nor the force-push floor met, at top level, in double quotes, under bash -c and in every heredoc body.
  // Real bash ran the sentinel in each shape.
  const backtickForce = {
    'top level': `echo \`git push ${B}${B}--force origin main\``,
    'double quotes': `echo "\`git push ${B}${B}--force origin main\`"`,
    'bash -c': `bash -c 'echo \`git push ${B}${B}--force origin main\`'`,
    'a quoted heredoc fed to bash': heredocLine(`echo \`git push ${B}${B}--force origin main\``, "bash <<'EOF'"),
    'a nested backtick': `echo \`echo ${B}\`git push ${B}${B}${B}${B}--force origin main${B}\`\``,
    'escaped double quotes in double quotes': `echo "\`git push ${B}"--force${B}" origin main\`"`,
  } as const

  it.each(cases.flatMap(([engine, switched]) => Object.entries(backtickForce).map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a force push a backtick body escapes in %s, by the force glob', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body, ['git push --force *']))).toBe(`Refused by ${named[engine]}: git push --force *`)
  })

  it.each((['workspace'] as const).flatMap(engine => Object.entries(backtickForce).map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a force push a backtick body escapes in %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // Slice 7l: bash removes a backslash-newline that ends an odd run of backslashes while it reads a backtick body, so
  // three backslashes and a newline inside `gi` and `t` run git; the reader kept the continuation, read `gi\` and `t`,
  // and the git push ran past the deny glob and the floor. Real bash ran the sentinel in each shape.
  const continuedBacktick = (command: string) => ({
    'top level': `echo \`gi${B.repeat(3)}\nt ${command}\``,
    'double quotes': `echo "\`gi${B.repeat(3)}\nt ${command}\`"`,
    '$()': `echo $(echo \`gi${B.repeat(3)}\nt ${command}\`)`,
    'bash -c': `bash -c 'echo \`gi${B.repeat(3)}\nt ${command}\`'`,
    'a nested body, five backslashes': `echo \`echo ${B}\`gi${B.repeat(5)}\nt ${command}${B}\`\``,
  })

  it.each(cases.flatMap(([engine, switched]) => Object.entries(continuedBacktick('push origin main')).map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a git push a backtick continuation joins in %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each((['workspace'] as const).flatMap(engine => Object.entries(continuedBacktick('push --force origin main')).map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a force push a backtick continuation joins in %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // Slice 7i probes: a comment inside a backtick body ran to the end of the line, so the git push after the
  // substitution ran with no rule reading it; bash ends the comment at the closing backtick. Real bash ran the sentinel.
  const commentedBacktick = {
    'top level': `echo \`id # c\`; ${push}`,
    'bash -c': `bash -c 'echo \`id # c\`; ${push}'`,
    'a quoted heredoc fed to bash': heredocLine(`echo \`id # c\`; ${push}`, "bash <<'EOF'"),
    'heredoc text': heredocLine(`\`id # c\` \`${push}\``),
  } as const

  it.each(cases.flatMap(([engine, switched]) => Object.entries(commentedBacktick).map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a git push after a commented backtick body in %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each(['workspace'] as const)('asks at the floor, %s with no deny glob, about a force push after a commented backtick body', (engine) => {
    const outcome = check(engine, false, `echo \`id # c\`; git push --force origin main`, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // Slice 7l: a `#` inside a word was read as a comment, and a carriage return, form feed, or no-break space split a
  // word bash keeps whole, so the git push after it ran past a git push * deny glob with no refusal and no ask, on both
  // engines and both switches. Real bash ran the sentinel in each shape.
  const hiddenByLexer = (command: string) => ({
    'a # after $()': `echo $(true)#; ${command}`,
    'a # after a backtick body': `echo \`true\`#; ${command}`,
    'a # after an escaped space': `echo x${B} #; ${command}`,
    'a # after a carriage return': `echo x\r#; ${command}`,
    'a # after a continuation inside a word': `echo x${B}\n#; ${command}`,
    'a # after <()': `cat <(true)#; ${command}`,
    'a # after an array assignment': `a=(1)#; ${command}`,
    'a carriage return in env -u': `env -u A\rB ${command}`,
    'a form feed in env -u': `env -u A\fB ${command}`,
    'a no-break space in exec -a': `exec -a a\xa0b ${command}`,
  })

  it.each(cases.flatMap(([engine, switched]) => Object.entries(hiddenByLexer(push)).map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a git push behind %s', (engine, switched, _shape, body) => {
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each((['workspace'] as const).flatMap(engine => Object.entries(hiddenByLexer('git push --force origin main')).map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a force push behind %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // A `)` that a case pattern or `!(` may close leaves Buckle unable to place the `#` after it: the call is unread.
  const unsureComment = "A # follows a ) that a case pattern or an extended glob may have closed, so Buckle cannot tell whether the rest of the line is a comment (comment)"
  const unsureShapes = [`echo $(case x in x) :;; esac)#; ${push}`, `!(true)#; ${push}`]

  it.each(cases.flatMap(([engine, switched]) => unsureShapes.map(body => [engine, switched, body] as const)))('refuses %s deny, switch on: %s, %j as unread, naming the comment limit', (engine, switched, body) => {
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${unsureComment}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each(unsureShapes)('asks at the floor with no deny glob about %j, naming the comment limit', (body) => {
    const outcome = check('workspace', false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${unsureComment}; asked rather than guessed at`]])
  })

  // Slice 7h probes: a shell whose script arrives as data, piped in, redirected, or handed over by xargs, ran the
  // payload with nothing read; the floor asked only about `| bash`, so under the dangerously-allow switch a deny glob
  // was bypassed (owner decision D7). Such a call is now unread: refused naming the limit under any deny glob, on both
  // engines and both switches, and asked at the floor with none (default D33 (b)). Real bash ran the sentinel in each.
  const scriptData = 'A shell takes its script, or a startup file it runs first, from a pipe, a redirection, a descriptor, an expansion, xargs, or find, so the script arrives as data, which Buckle cannot read (script as data)'
  const piped = /^Pipes a downloaded payload into a shell/
  const device = /^Targets a device node/
  const asData = new RegExp(`^${scriptData.replace(/[()]/g, '\\$&')}; asked rather than guessed at$`)
  const dataShapes = [
    ['echo piped into bash', `echo '${push}' | bash`, piped],
    ['printf piped into xargs -d newline bash -c', `printf '%s\\n' '${push}' | xargs -d '\\n' bash -c`, asData],
    ['xargs -0 bash -c', `printf '%s\\0' '${push}' | xargs -0 bash -c`, asData],
    ['xargs bash -c with a double-quoted item', heredocLine(`"${push}"`, "xargs bash -c <<'EOF'"), asData],
    ['xargs bash -c with a single-quoted item', heredocLine(`'${push}'`, "xargs bash -c <<'EOF'"), asData],
    ['xargs sh -c with escaped spaces', heredocLine(`git${B} push${B} origin${B} main`, "xargs sh -c <<'EOF'"), asData],
    ['xargs -I bash -c', heredocLine(push, "xargs -I{} bash -c {} <<'EOF'"), asData],
    ['xargs env bash -c', `printf '%s\\n' '${push}' | xargs -d '\\n' env bash -c`, asData],
    ['echo piped into sh -s', `echo '${push}' | sh -s`, piped],
    ['echo piped into bash /dev/stdin', `echo '${push}' | bash /dev/stdin`, piped],
    ['echo piped into a group running bash', `echo '${push}' | { bash; }`, asData],
    ['echo piped into bash -c bash', `echo '${push}' | bash -c bash`, piped],
    ['a pipe into bash with a heredoc on descriptor 3', heredocLine('x', `echo '${push}' | bash 3<<'EOF'`), piped],
    ['bash from a redirected file', 'bash < deploy.sh', asData],
    ['bash from a here-string', `bash <<< '${push}'`, asData],
    ['bash from a process substitution', `bash <(echo '${push}')`, asData],
    ['source from a process substitution', `source <(echo '${push}')`, asData],
    ['echo piped into source /dev/stdin', `echo '${push}' | source /dev/stdin`, device],
    ['bash -c with no command string', 'bash -c', asData],
    // Slice 7l: its own input or another descriptor named by another path, and a file name find hands a shell as its
    // script. Real bash ran the sentinel in each shape.
    ['echo piped into bash /dev//stdin', `echo '${push}' | bash /dev//stdin`, piped],
    ['bash //dev/stdin from a redirected file', 'bash //dev/stdin < deploy.sh', asData],
    ['bash /proc/thread-self/fd/0 from a redirected file', 'bash /proc/thread-self/fd/0 < deploy.sh', asData],
    ['bash climbing to /dev/stdin from a redirected file', 'bash ../../../../../../dev/stdin < deploy.sh', asData],
    ['bash /dev/./stdin from a process substitution', `bash /dev/./stdin < <(echo '${push}')`, device],
    ['bash /dev/fd/3 from a here-string', `bash /dev/fd/3 3<<<'${push}'`, device],
    ['bash /proc/self/fd/3 from a process substitution', `bash /proc/self/fd/3 3< <(echo '${push}')`, asData],
    ['source /dev/fd/3 from a here-string', `source /dev/fd/3 3<<<'${push}'`, device],
    ['find -exec bash -c {}', `find . -name '*.sh' -exec bash -c {} \\;`, asData],
    ['find -exec sh -c with {} inside its string', `find . -name x -exec sh -c 'cd /; {}' \\;`, asData],
    ['find -execdir bash {}', `find . -name '*.sh' -execdir bash {} \\;`, asData],
    ['find -exec env bash -c {} +', `find . -name x -exec env bash -c {} +`, asData],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => dataShapes.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a script that arrives as data: %s, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).scriptData).toBe(true)
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${scriptData}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace'] as const).flatMap(engine => dataShapes.map(([shape, body, reason]) => [engine, shape, body, reason] as const)))('asks at the floor, %s with no deny glob, about a script that arrives as data: %s', (engine, _shape, body, reason) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(reason)]])
  })

  it.each(cases)('refuses xargs handing items to bash -c as the call itself, %s deny, switch on: %s, naming the limit', (engine, switched) => {
    const outcome = withDangerouslyAllow(createPermissionEngine(engines[engine](['terraform destroy *'])), { enabled: () => switched, root: () => '/workspace' })
      .evaluate({ tool: 'shell_exec', effects: [{ kind: 'exec', command: 'xargs', args: ['-0', 'bash', '-c'] }], grants: { subjectsFor: () => [] } })
    expect(refusal(outcome)).toBe(`${scriptData}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  // A heredoc on the shell's own statement feeds its input, and Buckle reads that body; a -c string is read too; and a
  // shell with no operand as the call itself reads the input Buckle's exec leaves empty. These stay read as before.
  it.each(cases.flatMap(([engine, switched]) => [
    [engine, switched, 'a heredoc feeding bash after a pipe', heredocLine(push, "echo x | bash <<'EOF'")],
    [engine, switched, 'bash -s fed by its heredoc', heredocLine(push, "bash -s <<'EOF'")],
    [engine, switched, 'bash -c with a string after a pipe', `echo x | bash -c '${push}'`],
  ] as const))('refuses %s deny, switch on: %s, by the push glob, a git push read through %s', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).scriptData).toBe(false)
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  // Slice 7l: a shell's -c string that an expansion supplies runs text Buckle never sees, as eval of the same text does;
  // the call is unread: refused naming the limit under any deny glob, and asked at the floor with none. A -c string
  // whose `$` sits in single quotes is text the inner shell reads, and stays read. Real bash ran the sentinel in each.
  const expansion = 'Runs a command word or shell text an expansion supplies, or a command an expansion among a wrapper\'s own words may move, which exists only once the shell has run ($cmd args, eval "$x", bash -c "$(...)", timeout $t cmd), so Buckle cannot read it (expansion)'
  const expandedShapes = [
    ['bash -c of a substitution', `bash -c "$(echo '${push}')"`],
    ['sh -c of a variable', `x='${push}'; sh -c "$x"`],
    ['bash -c of printf', `bash -c "$(printf '%s %s' git push)"`],
    ['bash -c of a variable inside its string', `x=main; bash -c "git push origin $x"`],
    ['bash -c of a glob', 'bash -c *.sh'],
    ['bash -c of a brace expansion', `bash -c {'${push}',x}`],
    ['env bash -c of a variable', 'env bash -c "$x"'],
    ['su -c of a variable', 'su -c "$x" root'],
    ['ssh with a remote command of a variable', 'ssh host "$x"'],
    ['eval of a variable', 'eval "$x"'],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => expandedShapes.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, shell text an expansion supplies: %s, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('expansion')
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${expansion}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace'] as const).flatMap(engine => expandedShapes.filter(([shape]) => !shape.startsWith('su')).map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about shell text an expansion supplies: %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${expansion}; asked rather than guessed at`]])
  })

  it.each(cases.flatMap(([engine, switched]) => [
    [engine, switched, 'a single-quoted -c string holding a variable', `x=main; bash -c 'git push origin $x'`],
    [engine, switched, 'find handing {} to bash -c as $0', `find . -maxdepth 0 -exec bash -c '${push}' {} \\;`],
    // A host whose typed text before the variable is no option; a bare `"$host"` may be one (an expansion among ssh's words).
    [engine, switched, 'an ssh host from a variable after a typed user', `ssh deploy@"$host" '${push}'`],
  ] as const))('refuses %s deny, switch on: %s, by the push glob, a git push still read through %s', (engine, switched, _shape, body) => {
    const forms = commandFormsOf({ command: 'bash', args: ['-c', body] })
    expect([forms.unread, forms.scriptData]).toEqual([null, false])
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  // A command word the shell supplies, from a variable, a substitution, a pattern, or a brace expansion, from find's `{}`,
  // or from what xargs hands on, names a command Buckle cannot know until the shell has run, behind each wrapper and in
  // each text Buckle reads as shell. The call is unread: refused naming the limit under any deny glob, and asked at the
  // floor with none. Real bash ran the sentinel in each shape (heredoc-oracle.test.ts).
  const commandWords = [
    ['a variable', 'x=git; $x push origin main'],
    ['a double-quoted variable', 'x=git; "$x" push origin main'],
    ['a braced variable', 'x=git; ${x} push origin main'],
    ['a substitution', '$(echo git) push origin main'],
    ['a backtick substitution', '`echo git` push origin main'],
    ['an array', 'cmd=(git push origin main); "${cmd[@]}"'],
    ['a brace expansion', '{git,push} origin main'],
    ['a bracket pattern', 'g[i]t push origin main'],
    ['a ? pattern', 'gi? push origin main'],
    ['a path pattern', '/usr/bin/gi? push origin main'],
    ['an extended glob', 'shopt -s extglob\n@(git) push origin main'],
    ['a substitution inside the word', 'g$(echo it) push origin main'],
    ['a substitution after an assignment holding blanks', 'x=$(echo a b) $(echo git) push origin main'],
    ['a substitution after a double-quoted assignment holding quotes', 'x="$(echo "a b")" $(echo git) push origin main'],
    ['a variable behind sudo', 'sudo $x push origin main'],
    ['a variable behind env', 'env $x push origin main'],
    ['a variable behind timeout', 'timeout 5 $x push origin main'],
    ['a variable behind xargs', 'echo main | xargs $x push origin'],
    ['the xargs replace string behind env', 'echo git | xargs -I X env X push origin main'],
    ['xargs items handed to env', 'echo git push origin main | xargs env'],
    ['find {} as the command word', 'find /usr/bin -name git -exec {} push origin main \;'],
    ['find {} behind env', 'find /usr/bin -name git -exec env {} push origin main \;'],
    ['a variable in a quoted body fed to bash', "bash <<'EOF'\nx=git; $x push origin main\nEOF"],
    ['a variable in a substitution in heredoc text', 'cat <<EOF\n$($x push origin main)\nEOF'],
    ['a variable in a -c string', "bash -c '$x push origin main'"],
    ['a variable in a (( bash reads as a subshell', '(($x push origin main); true)'],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => commandWords.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a command word an expansion supplies: %s, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('expansion')
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${expansion}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace'] as const).flatMap(engine => commandWords.filter(([, body]) => !body.includes('sudo')).map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a command word an expansion supplies: %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${expansion}; asked rather than guessed at`]])
  })

  // A lone tilde as the command word is the whole name: HOME, OLDPWD, PWD, the directory stack, or a user's home holds
  // it, and the call may set the first three, so bash runs `HOME=/usr/bin/git; ~ push` as a git push. The call is
  // unread: refused naming the limit under git push*, and asked at the floor with no deny glob. Real bash ran the
  // sentinel in each shape but `~user`, whose home is a directory (heredoc-oracle.test.ts).
  const loneTildes = [
    ['~ that HOME names', 'HOME=/usr/bin/git; ~ push origin main'],
    ['~- that OLDPWD names', 'OLDPWD=/usr/bin/git; ~- push origin main'],
    ['~+ that PWD names', 'PWD=/usr/bin/git; ~+ push origin main'],
    ['~0 that PWD names', 'PWD=/usr/bin/git; ~0 push origin main'],
    ['~user', '~git push origin main'],
    ['~ behind command', 'HOME=/usr/bin/git; command ~ push origin main'],
    ['~- behind command', 'OLDPWD=/usr/bin/git; command ~- push origin main'],
    ['~+ behind command', 'PWD=/usr/bin/git; command ~+ push origin main'],
    ['~ behind env', 'HOME=/usr/bin/git; env ~ push origin main'],
    ['~- behind env', 'OLDPWD=/usr/bin/git; env ~- push origin main'],
    ['~+ behind env', 'PWD=/usr/bin/git; env ~+ push origin main'],
    ['~- naming rm', 'OLDPWD=/bin/rm; ~- -rf build'],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => loneTildes.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, under git push*, a lone tilde command word: %s, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('expansion')
    expect(refusal(check(engine, switched, body, ['git push*']))).toBe(`${expansion}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace'] as const).flatMap(engine => loneTildes.map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a lone tilde command word: %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${expansion}; asked rather than guessed at`]])
  })

  // A command word the text spells stays read as written: quoted, escaped, behind a tilde path with a typed basename or
  // a literal path, or after assignments that expand. The push glob refuses each by name.
  it.each(cases.flatMap(([engine, switched]) => [
    ['a quoted letter', 'g"i"t push origin main'],
    ['an escaped first letter', '\\git push origin main'],
    ['single quotes', "'git' push origin main"],
    ['ANSI-C quotes', "$'git' push origin main"],
    ['a tilde path', '~/bin/git push origin main'],
    ['a tilde path under a user', '~user/bin/git push origin main'],
    ['a literal path', '/usr/bin/git push origin main'],
    ['an assignment holding a variable', 'GIT_DIR=$HOME/.git git push origin main'],
    ['an assignment holding a substitution with blanks', 'x=$(echo a b) git push origin main'],
    ['an assignment holding a double-quoted substitution', 'x="$(git rev-parse HEAD)" git push origin main'],
  ].map(([shape, body]) => [engine, switched, shape!, body!] as const)))('refuses %s deny, switch on: %s, by the push glob, a git push whose command word is written: %s', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBeNull()
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  // Quotes nest as bash nests them: a `$(...)`, a `${...}`, and a backtick body each start a fresh quoting context, in
  // double quotes and out, so a word holding one ends where bash ends it and the git push after it is the command. The
  // forms read `x="$(echo "a b")" git push` as the command `b)`, so no glob and no floor met the push bash ran. Real
  // bash ran the sentinel in each shape (heredoc-oracle.test.ts).
  const nestedWords = [
    ['a substitution holding a double-quoted string', '"$(echo "a b")"'],
    ['a default value holding a double-quoted string', '"${q:-"a b"}"'],
    ['a default value holding a quoted separator', '"${q:-"a;b"}"'],
    ['an unquoted default value holding a blank', '${q:-a b}'],
    ['an unquoted default value holding a separator', '${q:-a;b}'],
    ['a default value holding a single-quoted brace', `"\${q:-'}'}"`],
    ['an unquoted default value holding a single-quoted brace and a separator', `\${q:-'}; a'}`],
    ['an unquoted default value holding a single-quoted brace and a double quote', `\${q:-'}"'}`],
    ['a default value holding a substitution with blanks', '${q:-$(echo a b)}'],
    ['a substitution two deep, each double-quoted', '"$(echo "$(echo "c d")")"'],
    ['a substitution holding a double-quoted parenthesis', '"$(echo ")")"'],
    ['a substitution holding a single-quoted parenthesis', `"$(echo ')')"`],
    ['a substitution holding a case pattern', '"$(case a in a) echo "q; r";; esac)"'],
    ['a substitution holding a separator after a parenthesized case pattern and an alternative', '"$(case a in (a) :;; b|c) echo "q; r";; esac)"'],
    ['a substitution holding a separator after a second case pattern', '"$(case a in a) :;; b) echo "q; r";; esac)"'],
    ['a substitution holding a case whose in is on the next line', '"$(case a\nin a) echo "q; r";; esac)"'],
    ['a substitution holding a command after a case', '"$(case a in a) :;; esac; echo "q; r")"'],
    ['a backtick body holding escaped double quotes', '"`echo \\"a b\\"`"'],
    ['arithmetic holding double quotes', '"$(( "1" + (2) ))"'],
    ['a substitution holding a heredoc body with a parenthesis', '"$(cat <<EOF\n) "\nEOF\n)"'],
    ['a substitution holding a comment with a parenthesis', '"$(echo a # ) "\n)"'],
  ] as const
  const nestedPlaces = (word: string, command: string) => [
    ['an assignment before the command', `x=${word} ${command}`],
    ['an argument before a later statement', `echo ${word}; ${command}`],
    ['behind env', `env X=${word} ${command}`],
  ] as const
  const nested = (command: string) => nestedWords.flatMap(([shape, word]) => nestedPlaces(word, command).map(([place, body]) => [`${shape}, ${place}`, body] as const))

  // env is handed an unquoted word split on its blanks, so the word after a blank is env's command: unread (expansion),
  // still refused by the push glob, which meets the git push as written.
  it.each(cases.flatMap(([engine, switched]) => nested(push).map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, by the push glob, a git push after %s', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe(body.startsWith('env X=') && !body.startsWith('env X="') ? 'expansion' : null)
    expect(refusal(check(engine, switched, body, ['git push*']))).toBe(`Refused by ${named[engine]}: git push*`)
  })

  it.each((['workspace'] as const).flatMap(engine => nested('git push --force origin main').map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a force push after %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // The same words spelled to name git are a command word an expansion supplies: unread, refused naming the limit.
  const nestedCommandWords = [
    ['a substitution holding a double-quoted string', '"$(echo "git")" push origin main'],
    ['a default value holding a double-quoted string', '"${q:-"git"}" push origin main'],
    ['an unquoted default value', '${q:-git} push origin main'],
    ['a substitution two deep, each double-quoted', '"$(echo "$(echo "git")")" push origin main'],
    ['a substitution holding a double-quoted parenthesis', '"$(echo ")" >/dev/null; echo git)" push origin main'],
    ['a substitution holding a case pattern', '"$(case a in a) echo "git";; esac)" push origin main'],
    ['a backtick body holding escaped double quotes', '"`echo \\"git\\"`" push origin main'],
    ['a substitution holding a heredoc body', '"$(cat <<EOF\ngit\nEOF\n)" push origin main'],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => nestedCommandWords.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a command word %s supplies, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('expansion')
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${expansion}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace'] as const).flatMap(engine => nestedCommandWords.map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a command word %s supplies', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${expansion}; asked rather than guessed at`]])
  })

  // A heredoc body fed to a program that runs no shell is data, read as shell text only as a safety net: a Makefile or a
  // script written through cat or tee whose lines start with an expansion stays read, and a deny glob that names none
  // of its commands lets it run. Fed to bash, the same body runs, and its command word is judged.
  const makefile = "cat > Makefile <<'EOF'\nall:\n\t$(CC) -o app main.c\n\t\"$PYTHON\" -m pip install -r requirements.txt\nEOF"
  const script = "cat > run.sh <<'EOF'\n#!/bin/sh\n\"$PYTHON\" -m pytest\n$(dirname \"$0\")/build.sh\n${RUNNER:-sh} deploy.sh\nEOF"
  it.each(cases.flatMap(([engine, switched]) => [
    ['a Makefile written through cat', makefile],
    ['a Makefile written through cat, unquoted', 'cat > Makefile <<EOF\nall:\n\t\\$(CC) -o app main.c\nEOF'],
    ['a script written through cat', script],
    ['a script written through tee', script.replace('cat > run.sh', 'tee run.sh >/dev/null')],
    ['a script written through cat beside a body fed to bash', `${script}\nbash <<'EOF'\nmake\nEOF`],
  ].map(([shape, body]) => [engine, switched, shape!, body!] as const)))('admits %s deny, switch on: %s, %s, whose lines start with an expansion', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBeNull()
    expect(check(engine, switched, body, ['terraform destroy *']).kind).toBe('allow')
  })

  it('judges the same lines fed to bash, whose command word an expansion supplies', () => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', makefile.replace('cat > Makefile', 'bash')] }).unread).toBe('expansion')
    expect(commandFormsOf({ command: 'bash', args: ['-c', script.replace('cat > run.sh', 'sudo -u ci bash')] }).unread).toBe('expansion')
  })

  // An argument an expansion supplies is read as written, so a deny glob meets the words as typed: `git push*` does not
  // meet `git $x origin main` even where $x is push, and nothing marks the call unread. A later argument is no matter:
  // the glob meets `git push $x`.
  it.each(cases)('reads an argument an expansion supplies as written, %s deny, switch on: %s, so git push* meets git push $x but not git $x origin', (engine, switched) => {
    const forms = commandFormsOf({ command: 'bash', args: ['-c', 'x=push; git $x origin main'] })
    expect([forms.unread, forms.nested]).toEqual([null, [['x=push'], ['git', '$x', 'origin', 'main']]])
    expect(check(engine, switched, 'x=push; git $x origin main', ['git push*']).kind).toBe('allow')
    expect(refusal(check(engine, switched, 'x=main; git push origin $x', ['git push*']))).toBe(`Refused by ${named[engine]}: git push*`)
  })

  // An expansion among the words a wrapper, xargs, find, ssh, su, or a shell reads before the command it runs may be an
  // option, a value naming what runs, or several words, and so supply or move that command: the words as read name no
  // git push while bash runs one. The call is unread: refused naming the limit under git push*, and asked at the floor
  // with no deny glob. Real bash ran the sentinel in each shape (heredoc-oracle.test.ts, wrapper words).
  const movedCommands = [
    ['timeout, an unquoted duration', 'v="1 git"; timeout $v push origin main'],
    ['timeout, a quoted duration that is -s', 'v=-s; timeout "$v" KILL 5 git push origin main'],
    ['timeout, a brace expansion', 'timeout {1,git} push origin main'],
    ['timeout, "$@"', 'set -- 5 git; timeout "$@" push origin main'],
    ['nice -n, an unquoted value', 'v="5 git"; nice -n $v push origin main'],
    ['nice -n, "${a[@]}"', 'a=(5 git); nice -n "${a[@]}" push origin main'],
    ['nice, a quoted option letter', 'v=n; nice -"$v" 5 git push origin main'],
    ['env, an unquoted assignment value', 'v="1 git"; env X=$v push origin main'],
    ['env, a quoted word that is -u', 'v=-u; env "$v" x git push origin main'],
    ['env -S, a quoted attached value', 'v="git push"; env -S"$v" origin main'],
    ['env, an option letter before a typed one', `v='S git push #'; env -"$v"uX origin main`],
    ['flock, a quoted file that is -x', 'v=-x; flock "$v" lk git push origin main'],
    ['xargs -I, a quoted replace string', 'r=X; echo git | xargs -I "$r" env X push origin main'],
    ['xargs items handed to find', "echo '-exec git push origin main ;' | xargs find ."],
    ['find, a quoted path that is -exec', 'v=-exec; find "$v" git push origin main \\;'],
    ['find, a quoted -exec closed by a quoted ;', 'a=-exec; b=";"; find "$a" git push origin main "$b"'],
    ['find, an unquoted path', 'd=". -exec git push origin main ;"; find $d -name x'],
    ['ssh, an unquoted host', 'h="host git"; ssh $h push origin main'],
    ['ssh, a quoted host that is -p', 'v=-p; ssh "$v" 22 host git push origin main'],
    ['ssh, a quoted host that is an -o ProxyCommand', 'v="-oProxyCommand=git push origin main"; ssh "$v" host true'],
    ['ssh -o, a quoted attached ProxyCommand', 'v="ProxyCommand=git push origin main"; ssh -o"$v" host true'],
    ['bash, a quoted script operand that is -c before a variable', 'x="git push origin main"; v=-c; bash "$v" "$x"'],
    ['bash, an unquoted script operand', 'v="-c git"; bash $v'],
    ['su, a quoted user that is -c', 'v=-c; x="git push origin main"; su "$v" "$x" root'],
    ['timeout -s, an empty quoted attached value', 'v=; timeout -s"$v" KILL 5 git push origin main'],
    ['nice -n, an empty quoted attached value', 'v=; nice -n"$v" 5 git push origin main'],
    ['env -u, an empty quoted attached value', 'v=; env -u"$v" X git push origin main'],
    ['xargs -n, an empty quoted attached value', 'v=; echo main | xargs -n"$v" 1 git push origin'],
    ['ssh -p, an empty quoted attached value', 'v=; ssh -p"$v" 22 host git push origin main'],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => movedCommands.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, under git push*, a command an expansion among the wrapper words may move: %s, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('expansion')
    expect(refusal(check(engine, switched, body, ['git push*']))).toBe(`${expansion}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace'] as const).flatMap(engine => movedCommands.filter(([shape]) => !shape.startsWith('su')).map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a command an expansion among the wrapper words may move: %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${expansion}; asked rather than guessed at`]])
  })

  // Where the expanded word cannot change the parse, the call stays read whole: a quoted value after an option that always
  // takes one, or attached after a long option's `=` or after typed value text, an assignment with a typed name and a
  // quoted value, `NAME=$v` before a command, a quoted find path with no exec after it or a quoted find primary value, an
  // operand with typed text before the expansion that is no option, and a shell's quoted script operand with no word
  // after it. The push glob refuses each by name, and the floor asks about each force push as one.
  const keptRead = (command: string) => [
    ['nice -n, a quoted value', `v=5; nice -n "$v" ${command}`],
    ['nice -n, an empty quoted value attached after typed digits', `v=; nice -n1"$v" ${command}`],
    ['sudo -u, a quoted user', `sudo -u "$USER" ${command}`],
    ['timeout --signal=, a quoted value', `s=TERM; timeout --signal="$s" 5 ${command}`],
    ['timeout --signal=, an empty quoted value', `s=; timeout --signal="$s" 5 ${command}`],
    ['timeout -s, an empty quoted value attached after a typed signal', `s=; timeout -sTERM"$s" 5 ${command}`],
    ['timeout -k, a quoted substitution', `timeout -k "$(echo 5)" 10 ${command}`],
    ['env, a quoted assignment value', `env FOO="$BAR" ${command}`],
    ['an unquoted assignment before a command', `FOO=$BAR ${command}`],
    ['env -C, a quoted value', `env -C "$dir" ${command}`],
    ['flock, a file with typed text first', `flock ./"$lock" ${command}`],
    ['xargs -P, a quoted substitution', `xargs -P "$(nproc)" ${command} < /dev/null`],
    ['find, a quoted -name value before -exec', `find . -name "$n" -exec ${command} \\;`],
    ['find, a quoted path with no exec after it', `find "$dir" -name x -print; ${command}`],
    ['ssh, a host with a typed user first', `ssh deploy@"$host" ${command}`],
    ['ssh -p, a quoted value', `ssh -p "$port" host ${command}`],
    ['bash -o, a quoted value', `bash -o "$opt" -c '${command}'`],
    ['bash, a quoted script operand with no word after it', `bash "$script"; ${command}`],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => keptRead(push).map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, by the push glob, a git push read whole behind %s', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBeNull()
    expect(refusal(check(engine, switched, body, ['git push*']))).toBe(`Refused by ${named[engine]}: git push*`)
  })

  it.each((['workspace'] as const).flatMap(engine => keptRead('git push --force origin main').map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a force push read whole behind %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(body.startsWith('sudo') ? /^sudo escalates privileges$/ : /^Force push rewrites remote history/)]])
  })

  // The cost of the rule: these ordinary shapes are now unread, refused under any deny glob and asked at the floor, since
  // a quoted value there may be an option, an unquoted one several words, and an empty one attached to a short option's
  // letter no value at all.
  it.each([
    'timeout $T make test', 'timeout "$T" make test', 'env FOO=$BAR make test', 'ssh "$HOST" uptime', 'ssh "$USER@$HOST" uptime',
    'find $DIR -name x', 'find . -name *.log', 'find "$dir" -name x -exec rm {} \\;', 'find . -exec grep -l "$pattern" {} +', 'xargs -P $(nproc) make',
    'flock "$LOCK" make', 'bash "$script" "$@"', 'su "$user" -c make', 'nice -n $N make', 'sudo -u $USER make',
    'nice -n"$N" make', 'timeout -s"$SIG" 5 make', 'sudo -u"$USER" make', 'ssh -p"$PORT" host uptime', 'xargs -n"$N" make',
  ])('reads %j as unread (expansion), the cost of the rule', (body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('expansion')
  })

  // A startup file reaches bash through a program Buckle does not read as a shell, a bash script run by its shebang or
  // make with SHELL=/bin/bash, and bash runs it (probes under bash 5.2 and GNU make 4.3 ran the sentinel). Buckle reads
  // neither as a shell, so the git push in the file is read by no rule and the call is not marked unread: these rows pin
  // that limit.
  it.each([
    'BASH_ENV=<(echo git push origin main) ./deploy.sh',
    'BASH_ENV=<(echo git push origin main) make SHELL=/bin/bash',
  ])('reads no startup file %j hands bash through a program it does not read as a shell, and marks the call read (a limit)', (body) => {
    const forms = commandFormsOf({ command: 'bash', args: ['-c', body] })
    expect([forms.unread, forms.scriptData, allForms(forms).some(([command, subcommand]) => command === 'git' && subcommand === 'push')]).toEqual([null, false, false])
  })

  // A shell or source given a script operand, while the call's own text feeds its input on any descriptor, may read its
  // script from that input through a link or a device path: the call is unread (script as data), refused naming the
  // limit under any deny glob. Real bash ran the sentinel in each shape (heredoc-oracle.test.ts).
  const fedOperands = [
    ['a pipe into bash "$x"', `x=/dev/stdin; echo '${push}' | bash "$x"`],
    ['a pipe into source "$x"', `x=/dev/stdin; echo '${push}' | source "$x"`],
    ['a heredoc into source "$x"', heredocLine(push, `x=/dev/stdin; source "$x" <<'EOF'`)],
    ['a here-string into bash "$x"', `x=/dev/stdin; bash "$x" <<< '${push}'`],
    ['a pipe into bash stdin from /dev', `cd /dev; echo '${push}' | bash stdin`],
    ['a pipe into bash through a link', `ln -s /dev/stdin l; echo '${push}' | bash l`],
    ['a process substitution into bash through a link', `bash l < <(echo '${push}')`],
    ['a here-string on descriptor 3', `bash l3 3<<< '${push}'`],
    ['a pipe into a group', `echo '${push}' | { true; bash l; }`],
    ['a pipe into a while loop', `echo '${push}' | while true; do bash l; break; done`],
    ['a heredoc on a group', heredocLine(push, "{ bash l; } <<'EOF'")],
    ['a here-string on a subshell', `(bash l) <<< '${push}'`],
    ['exec redirecting the input', heredocLine(push, "exec <<'EOF'").concat('\nbash l')],
    ['a function called in a pipeline', `f() { bash l; }; echo '${push}' | f`],
    ['a pipe into sudo bash', `echo '${push}' | sudo bash l`],
    ['a pipe into bash -c', `echo '${push}' | bash -c 'bash l'`],
    ['a |& pipe', `echo '${push}' |& bash l`],
    ['a pipe into bash cut by a substitution', `echo '${push}' | bash l "$(true)"`],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => fedOperands.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a script operand the call\'s text feeds: %s, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).scriptData).toBe(true)
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${scriptData}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace'] as const).flatMap(engine => fedOperands.filter(([, body]) => !body.includes('sudo')).map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a script operand the call\'s text feeds: %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => ask.rule)).toEqual(['destructive_command'])
  })

  // With no feed from the call's own text, a script operand stays a script file, and a deny glob that names none of the
  // call's commands lets it run: after a pipeline that ended, after `&&`, before a pipe, from a file, inside a body fed
  // to a shell (whose input is that body, which Buckle reads), and a substitution in a command a here-string feeds.
  it.each(cases.flatMap(([engine, switched]) => [
    ['source "$NVM_DIR/nvm.sh"', 'source "$NVM_DIR/nvm.sh"'],
    ['. "$HOME/.cargo/env"', '. "$HOME/.cargo/env"'],
    ['bash "$script"', 'bash "$script"'],
    ['bash script.sh < file', 'bash script.sh < input.txt'],
    ['source before a pipeline', 'source .venv/bin/activate && pytest -x 2>&1 | tail -20'],
    ['bash after a pipeline ended', 'git status | head -5; bash build.sh'],
    ['bash after &&', 'make && bash deploy.sh'],
    ['bash after a piped loop closed', 'ls | while read -r f; do echo "$f"; done; bash build.sh'],
    ['source in a body fed to bash', "bash <<'EOF'\nsource ./env.sh\nmake\nEOF"],
    ['a substitution in a command a here-string feeds', 'cat $(bash list.sh) <<< x'],
    ['a heredoc whose <<- is apart from its delimiter', 'bash <<- EOF\n\tbash build.sh\n\tEOF'],
    ['sh -c with its arguments', 'sh -c \'echo "$1"\' _ "$@"'],
  ].map(([shape, body]) => [engine, switched, shape!, body!] as const)))('admits %s deny, switch on: %s, a script operand with no feed from the call\'s text: %s', (engine, switched, _shape, body) => {
    const forms = commandFormsOf({ command: 'bash', args: ['-c', body] })
    expect([forms.unread, forms.scriptData]).toEqual([null, false])
    expect(check(engine, switched, body, ['terraform destroy *']).kind).toBe('allow')
  })

  // A shell runs a startup file before its script (BASH_ENV, ENV, --rcfile, --init-file). One whose text the call
  // supplies, set before the shell, through env, or exported earlier, is read by no reading: refused naming the limit
  // under any deny glob and asked at the floor. A file on disk, /dev/null, or none stays read. Real bash ran the sentinel
  // in each unread shape (heredoc-oracle.test.ts).
  const startupShapes = [
    ['BASH_ENV of a process substitution', `BASH_ENV=<(echo '${push}') bash -c true`],
    ['BASH_ENV of a process substitution through env', `env BASH_ENV=<(echo '${push}') bash -c true`],
    ['BASH_ENV of /dev/stdin from a here-string', `BASH_ENV=/dev/stdin bash -c true <<< '${push}'`],
    ['BASH_ENV of a descriptor', `BASH_ENV=/dev/fd/3 bash -c true 3<<< '${push}'`],
    ['BASH_ENV of a variable while a pipe feeds bash', `echo '${push}' | BASH_ENV="$x" bash -c true`],
    ['BASH_ENV holding a command substitution', `BASH_ENV='$(${push})' bash -c true`],
    ['BASH_ENV of /dev/stdin exported, then a here-string into bash', `export BASH_ENV=/dev/stdin; bash -c true <<< '${push}'`],
    ['a BASH_ENV prefix on a function that starts a shell', `f() { bash -c true; }; BASH_ENV=<(echo '${push}') f`],
    ['--rcfile of a process substitution', `bash --rcfile <(echo '${push}') -i -c true`],
    ['--rcfile of a descriptor', `bash --rcfile /dev/fd/3 -i -c true 3<<< '${push}'`],
    ['ENV of a process substitution', `ENV=<(echo '${push}') sh -i -c true`],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => startupShapes.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, a startup file the call supplies: %s, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).scriptData).toBe(true)
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${scriptData}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  // A device operand (`--rcfile /dev/fd/3`) is asked about first as one, so those rows check the refusal alone.
  it.each((['workspace'] as const).flatMap(engine => startupShapes.filter(([, body]) => !/ \/dev\//.test(body)).map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a startup file the call supplies: %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${scriptData}; asked rather than guessed at`]])
  })

  it('reads the call itself handing bash a startup file whose name it expands into a substitution', () => {
    expect(commandFormsOf({ command: 'env', args: ['BASH_ENV=$(git push origin main)', 'bash', '-c', 'true'] }).scriptData).toBe(true)
    expect(commandFormsOf({ command: 'env', args: ['BASH_ENV=/dev/stdin', 'bash', '-c', 'true'] }).scriptData).toBe(false)
  })

  it.each(cases.flatMap(([engine, switched]) => [
    ['a file on disk', 'BASH_ENV=/etc/profile bash -c true'],
    ['/dev/null', 'BASH_ENV=/dev/null bash -c true'],
    ['--rcfile of a file on disk', 'bash --rcfile ./rc -i -c true'],
    ['a file a variable names, with no feed', 'BASH_ENV="$HOME/.bashenv" bash -c true'],
    ['a startup file set for no shell', 'BASH_ENV=/dev/stdin make <<< x'],
    ['none', 'bash -c true'],
  ].map(([shape, body]) => [engine, switched, shape!, body!] as const)))('admits %s deny, switch on: %s, a shell whose startup file is %s', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).scriptData).toBe(false)
    expect(check(engine, switched, body, ['terraform destroy *']).kind).toBe('allow')
  })

  // Shell text a builtin keeps for the shell to run later is read as shell text: a trap's action, an alias's value, and
  // a mapfile or readarray callback. The push glob refuses each by name; one an expansion supplies is unread, refused
  // naming the limit. Real bash ran the sentinel in each shape (heredoc-oracle.test.ts).
  it.each(cases.flatMap(([engine, switched]) => [
    ['a trap on exit', `trap '${push}' EXIT`],
    ['a trap after --', `trap -- '${push}' EXIT INT`],
    ['an alias', `shopt -s expand_aliases\nalias p='${push}'\np`],
    ['a mapfile callback', `mapfile -C '${push} #' -c 1 <<< a`],
    ['an attached readarray callback', `readarray -t -C'${push} #' -c1 lines <<< a`],
  ].map(([shape, body]) => [engine, switched, shape!, body!] as const)))('refuses %s deny, switch on: %s, by the push glob, a git push %s keeps', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBeNull()
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each(cases.flatMap(([engine, switched]) => [
    ['a trap of a variable', `x='${push}'; trap "$x" EXIT`],
    ['an alias of a variable', `x='${push}'; alias p="$x"`],
    ['a mapfile callback of a variable', `x='${push} #'; mapfile -C "$x" -c 1 <<< a`],
  ].map(([shape, body]) => [engine, switched, shape!, body!] as const)))('refuses %s deny, switch on: %s, held shell text an expansion supplies: %s, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('expansion')
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${expansion}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  // An alias is expanded where its name is a command's word: past the reserved words before a command, in a function's
  // body, and after an alias ending in a blank. The force push only the substitution spells is refused by the force
  // glob and asked about at the floor. Real bash ran the sentinel in each shape (heredoc-oracle.test.ts).
  const aliasedUse = (use: string) => `shopt -s expand_aliases\nalias g='git push'\n${use}`
  const forcedUses = [
    ['after if', aliasedUse('if g --force origin main; then :; fi')],
    ['in a group', aliasedUse('{ g --force origin main; }')],
    ['after !', aliasedUse('! g --force origin main')],
    ['after time -p', aliasedUse('time -p g --force origin main')],
    ['after do', aliasedUse('for i in 1; do g --force origin main; done')],
    ['in a function body', aliasedUse('f() { g --force origin main; }\nf')],
    ['in a function keyword body', aliasedUse('function h { g --force origin main; }; h')],
    ['after coproc', aliasedUse('coproc g --force origin main; wait')],
    ['after an alias ending in a blank', "shopt -s expand_aliases\nalias e='env ' g='git push'\ne g --force origin main"],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => forcedUses.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, by the force glob, a force push an alias spells %s', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBeNull()
    expect(refusal(check(engine, switched, body, ['git push --force *']))).toBe(`Refused by ${named[engine]}: git push --force *`)
  })

  it.each((['workspace'] as const).flatMap(engine => forcedUses.map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about a force push an alias spells %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // An alias defined anywhere in the call reaches text the same shell parses later (eval, a trap's action, a mapfile
  // callback, source of its input), which no reading follows it into: such a call is unread, refused naming the limit
  // under any deny glob and asked at the floor. A call that defines no alias reads that text as before.
  const aliasedLater = [
    ['eval', `shopt -s expand_aliases\nalias p='${push}'\neval p`],
    ['a trap action', `shopt -s expand_aliases\nalias p='${push}'\ntrap p EXIT`],
    ['a mapfile callback', `shopt -s expand_aliases\nalias p='${push}'\nmapfile -C 'p #' -c 1 <<< a`],
    ['source of its input', `shopt -s expand_aliases\nalias p='${push}'\nsource /dev/stdin <<'EOF'\np\nEOF`],
    ['an alias eval defines, used after it', `shopt -s expand_aliases\neval "alias p='${push}'"\np`],
  ] as const

  it.each(cases.flatMap(([engine, switched]) => aliasedLater.map(([shape, body]) => [engine, switched, shape, body] as const)))('refuses %s deny, switch on: %s, an alias reaching %s, naming the limit', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBe('expansion')
    expect(refusal(check(engine, switched, body, ['terraform destroy *']))).toBe(`${expansion}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  // A device operand (`source /dev/stdin`) is asked about first as one, so that row checks the refusal alone.
  it.each((['workspace'] as const).flatMap(engine => aliasedLater.filter(([, body]) => !/ \/dev\//.test(body)).map(([shape, body]) => [engine, shape, body] as const)))('asks at the floor, %s with no deny glob, about an alias reaching %s', (engine, _shape, body) => {
    const outcome = check(engine, false, body, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${expansion}; asked rather than guessed at`]])
  })

  it.each(cases.flatMap(([engine, switched]) => [
    ['eval', `eval '${push}'`],
    ['a trap action', `trap '${push}' EXIT`],
    ['source of its input', `source /dev/stdin <<'EOF'\n${push}\nEOF`],
    ['a -c string beside an alias, run in a child shell', `shopt -s expand_aliases\nalias p=ls\nbash -c '${push}'`],
  ].map(([shape, body]) => [engine, switched, shape!, body!] as const)))('refuses %s deny, switch on: %s, by the push glob, a git push in %s, with no alias reaching it', (engine, switched, _shape, body) => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBeNull()
    expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  // Arithmetic and PS4 under set -x run text a variable holds: Buckle reads it only where the call spells it out, so a
  // git push built at run time is read by no rule and the call is not marked unread. These rows pin that limit.
  const pushes = (body: string) => allForms(commandFormsOf({ command: 'bash', args: ['-c', body] })).some(([command, subcommand]) => command === 'git' && subcommand === 'push')

  it('reads arithmetic and PS4 text the call spells out, so the push glob meets it', () => {
    expect(pushes(`x='a[$(${push})]'; (( x ))`)).toBe(true)
    expect(pushes(`PS4='$(${push})'; set -x; true`)).toBe(true)
  })

  it('reads no arithmetic or PS4 text the call builds at run time, and marks no such call unread (a limit)', () => {
    for (const body of [`p='$(git'; x="a[$p push origin main)]"; (( x ))`, `p='$(git'; PS4="$p push origin main)"; set -x; true`]) {
      expect(pushes(body)).toBe(false)
      expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).unread).toBeNull()
    }
  })

  // An alias stands for its value where its name begins a command, the words after the name joined on, so a glob and the
  // floor meet `git push --force` that neither the alias nor its use spells alone.
  const aliasedForce = "shopt -s expand_aliases\nalias g='git push' f='g --force'\nf origin main"
  it.each(cases)('refuses %s deny, switch on: %s, a force push an alias of an alias spells, by the force glob', (engine, switched) => {
    expect(refusal(check(engine, switched, aliasedForce, ['git push --force *']))).toBe(`Refused by ${named[engine]}: git push --force *`)
  })

  it.each(['workspace'] as const)('asks at the floor, %s with no deny glob, about a force push an alias spells', (engine) => {
    const outcome = check(engine, false, aliasedForce, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
  })

  // Slice 7l: rbash, ash, mksh, yash, and posh are POSIX shells: a -c string is read, and a script piped in is data.
  // Real rbash ran the sentinel both ways; the others are not installed here.
  it.each(cases.flatMap(([engine, switched]) => ['rbash', 'ash', 'mksh', 'yash', 'posh'].map(shell => [engine, switched, shell] as const)))('refuses %s deny, switch on: %s, a git push %s -c runs by the push glob, and a script piped into it as data', (engine, switched, shell) => {
    expect(refusal(check(engine, switched, `${shell} -c '${push}'`))).toBe(`Refused by ${named[engine]}: git push *`)
    expect(refusal(check(engine, switched, `echo '${push}' | ${shell}`, ['terraform destroy *']))).toBe(`${scriptData}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it('reads no script as data in bash with no operand as the call itself, or in bash --version after a pipe', () => {
    expect(commandFormsOf({ command: 'bash', args: [] }).scriptData).toBe(false)
    expect(commandFormsOf({ command: 'env', args: ['bash'] }).scriptData).toBe(false)
    expect(commandFormsOf({ command: 'bash', args: ['-c', `echo '${push}' | bash --version`] }).scriptData).toBe(false)
  })

  // A statement's pieces are a split no shell makes, read only so a glob meets a command quoted for another program,
  // so a shell named inside a quoted message marks no script as data.
  it('reads no script as data in a shell named inside a quoted argument', () => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', 'git commit -m "fix the build; bash; source"'] }).scriptData).toBe(false)
    expect(check('workspace', false, 'git commit -m "fix the build; bash; source"', ['terraform destroy *']).kind).toBe('allow')
  })

  // Slice 7h probes: under `<<-EOF` a line an odd run of backslashes joins on keeps its tabs, so five backslashes
  // before the newline leave a `\` word and a tab before `--force`: real bash passed `\`, `--force`, `origin` and
  // `main` as four words (seven leave one word, `\` and a tab and `--force`, so no flag). The reader stripped every
  // line and read `\--force`, so the floor let the force push run.
  const tabbedRuns = [[5, `bash <<-EOF\n\tgit push ${B.repeat(5)}\n\t--force origin main\n\tEOF`]] as const

  it.each(['workspace'] as const)('asks at the floor, %s with no deny glob, about a force push a <<- continuation joins on with its tab', (engine) => {
    for (const [, body] of tabbedRuns) {
      const outcome = check(engine, false, body, [])
      if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
      expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(/^Force push rewrites remote history/)]])
    }
  })

  it.each(cases)('refuses %s deny, switch on: %s, a git push a <<- continuation joins on with its tab', (engine, switched) => {
    for (const [, body] of tabbedRuns) expect(refusal(check(engine, switched, body))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  // A continuation between words joins no word and leaves none, so `git push \<newline> --force` reads as `git push
  // --force` and a word glob on it still matches; an empty word between push and the flag would misalign it.
  it.each(cases)('refuses a force push with a space-surrounded continuation, %s deny, switch on: %s, by the force glob', (engine, switched) => {
    expect(refusal(check(engine, switched, `git push ${B}\n --force origin main`, ['git push --force *']))).toBe(`Refused by ${named[engine]}: git push --force *`)
  })

  it('reads a heredoc body of 40,000 lines, every one continued, within a second, joining them in one pass', () => {
    const notes = Array.from({ length: 40_000 }, (_, index) => `note ${index} of the release ${B}`).join('\n')
    expect(notes.length).toBeGreaterThan(1_000_000)
    for (const opener of ["bash <<'EOF'", 'bash <<EOF']) {
      const { milliseconds, result } = leastProcessorTime(() => check('workspace', false, heredocLine(notes, opener)))
      expect(result.kind).toBe('allow')
      expect(milliseconds).toBeLessThan(1_000)
    }
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  it('reads a thousand heredocs nested in substitutions within a second, each body whole once', () => {
    const opened = Array.from({ length: 1_000 }, (_, index) => `$(cat <<D${index}`).join('\n')
    const closed = Array.from({ length: 1_000 }, (_, index) => `D${999 - index}\n)`).join('\n')
    const { milliseconds, result } = leastProcessorTime(() => check('workspace', false, heredocLine(`${opened}\n${quotedPush}\n${closed}`)))
    expect(result).toMatchObject({ kind: 'deny' })
    expect(milliseconds).toBeLessThan(1_000)
  }, PROCESSOR_TIME_ROW_TIMEOUT)
})

// The interpreter decision (docs/dev/architecture.md, Interpreters): a body run by python, node, deno, bun, perl, ruby,
// php, awk (gawk, mawk, nawk), lua, luajit, pwsh, powershell, tsx or ts-node is code Buckle cannot read as shell, so
// such a call is unknown: refused naming the limit under any deny glob, with the dangerously-allow switch on or off,
// and asked at the floor otherwise, as an unread call is, until the workspace's policy allows that interpreter, which
// then reads as an ordinary command under its own globs (owner decision D7).
describe('a call that runs code with an interpreter', () => {
  const policyOf = (input: { deny?: string[]; interpreters?: string[] }) => {
    const policy = emptyWorkspacePolicy()
    policy.commands.deny = input.deny ?? []
    if (input.interpreters) policy.commands.allowedInterpreters = input.interpreters
    return compilePolicy(policy)
  }
  interface Setting { deny: string[]; workspaceAllows?: string[] }
  const engines = {
    workspace: (setting: Setting) => {
      const workspace = policyOf({ deny: setting.deny, interpreters: setting.workspaceAllows })
      return [createCommandPolicyRule(workspace, { enforceWrapperAllow: false }), createDestructiveCommandRule({ allowedInterpreters: workspace.commands.allowedInterpreters })]
    },
  }
  const named = { workspace: 'the workspace command policy' } as const
  const check = (engine: keyof typeof engines, switched: boolean, call: readonly [string, readonly string[]], setting: Setting) =>
    withDangerouslyAllow(createPermissionEngine(engines[engine](setting)), { enabled: () => switched, root: () => '/workspace' })
      .evaluate({ tool: 'shell_exec', effects: [{ kind: 'exec', command: call[0], args: [...call[1]] }], grants: { subjectsFor: () => [] } })
  const unknown = (name: string) => `Runs code Buckle cannot read as shell, with an interpreter the policy does not allow (unknown interpreter): ${name} (allow it with buckle policy allow-interpreter ${name})`
  const engineCases = (['workspace'] as const).flatMap(engine => [false, true].map(switched => [engine, switched] as const))
  /** Each form runs code: inline code, a script, a module, code on its input, a versioned name, and the same behind a wrapper, a shell body, or xargs. */
  const forms = [
    ['python3', ['-c', 'print(1)'], 'python3'],
    ['python3', ['script.py'], 'python3'],
    ['python3', ['-m', 'venv', '.venv'], 'python3'],
    ['python3.12', ['-c', 'print(1)'], 'python3.12'],
    ['node', ['-e', 'console.log(1)'], 'node'],
    ['node', ['--eval', 'console.log(1)'], 'node'],
    ['node', ['-p', '1'], 'node'],
    ['node', ['script.js'], 'node'],
    ['deno', ['run', 'main.ts'], 'deno'],
    ['bun', ['run', 'index.ts'], 'bun'],
    ['perl', ['-e', 'print 1'], 'perl'],
    ['ruby', ['-e', 'puts 1'], 'ruby'],
    ['ruby', ['-v', 'script.rb'], 'ruby'],
    ['php', ['-r', 'echo 1;'], 'php'],
    ['env', ['python3', '-c', 'print(1)'], 'python3'],
    ['xargs', ['python3', '-c'], 'python3'],
    ['xargs', ['python3'], 'python3'],
    ['bash', ['-c', 'python3 -c "print(1)"'], 'python3'],
    ['bash', ['-c', 'echo "print(1)" | python3'], 'python3'],
    ['bash', ['-c', 'python3 < job.py'], 'python3'],
    ['bash', ['-c', "python3 <<'EOF'\nprint(1)\nEOF"], 'python3'],
    ['awk', ['BEGIN{system("id")}'], 'awk'],
    ['awk', ['-f', 'report.awk', 'data.txt'], 'awk'],
    ['gawk', ['-e', 'BEGIN{}'], 'gawk'],
    ['mawk', ['{print $1}', 'data.txt'], 'mawk'],
    ['nawk', ['BEGIN{}'], 'nawk'],
    ['bash', ['-c', "ps aux | awk '{print $2}'"], 'awk'],
    ['lua', ['-e', 'os.execute("id")'], 'lua'],
    ['lua5.4', ['script.lua'], 'lua5.4'],
    ['luajit', ['script.lua'], 'luajit'],
    ['pwsh', ['-c', 'Get-Date'], 'pwsh'],
    ['pwsh', ['-Command', 'Get-Date'], 'pwsh'],
    ['pwsh', ['-File', 'script.ps1'], 'pwsh'],
    ['powershell', ['-Command', 'Get-Date'], 'powershell'],
    ['tsx', ['script.ts'], 'tsx'],
    ['tsx', ['-e', 'console.log(1)'], 'tsx'],
    ['ts-node', ['script.ts'], 'ts-node'],
    ['ts-node', ['-e', 'console.log(1)'], 'ts-node'],
    // Slice 7l: CPython build suffixes, PyPy, the C shells, and busybox's shell applet.
    ['python3.13t', ['-c', 'print(1)'], 'python3.13t'],
    ['python3.13d', ['script.py'], 'python3.13d'],
    ['python3.12-dbg', ['-m', 'venv', '.venv'], 'python3.12-dbg'],
    ['pypy3', ['-c', 'print(1)'], 'pypy3'],
    ['pypy', ['script.py'], 'pypy'],
    ['tcsh', ['-c', 'echo 1'], 'tcsh'],
    ['csh', ['script.csh'], 'csh'],
    ['busybox', ['sh', '-c', 'echo 1'], 'busybox'],
    ['bash', ['-c', 'echo id | busybox ash'], 'busybox'],
    // A shell applet behind a wrapper, and toybox's own shell, are interpreters too.
    ['env', ['busybox', 'hush', '-c', 'echo 1'], 'busybox'],
    ['toybox', ['sh', '-c', 'echo 1'], 'toybox'],
    ['toybox', ['toysh', 'script.sh'], 'toybox'],
    // D86 (4): the package runners fetch and run a package's code Buckle never reads.
    ['npx', ['tsx', 'script.ts'], 'npx'],
    ['pnpx', ['ts-node', 'script.ts'], 'pnpx'],
    ['bunx', ['cowsay', 'hi'], 'bunx'],
    ['bash', ['-c', 'npx prettier --check .'], 'npx'],
  ] as const
  const refusal = (outcome: ReturnType<typeof check>) => {
    if (outcome.kind !== 'deny') throw new Error(`expected a deny, got ${outcome.kind}`)
    expect(outcome.denial.rule).toBe('command_policy')
    return outcome.denial.reason
  }

  it.each(engineCases.flatMap(([engine, switched]) => forms.map(([command, args, name]) => [engine, switched, command, args, name] as const)))('refuses %s deny, switch on: %s, %s %j as an unknown interpreter, naming it', (engine, switched, command, args, name) => {
    expect(refusal(check(engine, switched, [command, args], { deny: ['terraform destroy *'] }))).toBe(`${unknown(name)}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace'] as const).flatMap(engine => forms.map(([command, args, name]) => [engine, command, args, name] as const)))('asks at the floor, %s with no deny glob, about %s %j, naming the interpreter', (engine, command, args, name) => {
    const outcome = check(engine, false, [command, args], { deny: [] })
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${unknown(name)}; asked rather than guessed at`]])
  })

  it.each(forms.map(([command, args]) => [command, args] as const))('lets the dangerously-allow switch answer the floor\'s ask about %s %j when no deny glob exists, as it answers every ask', (command, args) => {
    const outcome = check('workspace', true, [command, args], { deny: [] })
    if (outcome.kind !== 'allow') throw new Error(`expected an allow, got ${outcome.kind}`)
    expect(outcome.allowedBy).toEqual([expect.stringMatching(/^dangerously_allow:destructive_command:/)])
  })

  it.each(engineCases.flatMap(([engine, switched]) => forms.map(([command, args, name]) => [engine, switched, command, args, name] as const)))('reads %s, switch on: %s, %s %j as an ordinary command once the policy allows %s', (engine, switched, command, args, name) => {
    const setting = { deny: ['terraform destroy *'], workspaceAllows: [name] }
    expect(check(engine, switched, [command, args], setting)).toMatchObject({ kind: 'allow' })
    expect(check(engine, switched, [command, args], { deny: [], workspaceAllows: [name] })).toMatchObject({ kind: 'allow' })
  })

  it.each(engineCases)('still refuses an allowed interpreter its own deny glob names, %s deny, switch on: %s', (engine, switched) => {
    expect(refusal(check(engine, switched, ['python3', ['-m', 'venv', '.venv']], { deny: ['python3 -m *'], workspaceAllows: ['python3'] }))).toBe(`Refused by ${named[engine]}: python3 -m *`)
  })



  it('names each interpreter a call runs and how to allow one, by name for one and as <name> for several', () => {
    expect(refusal(check('workspace', false, ['bash', ['-c', 'python3 -c 1; node -e 1']], { deny: ['terraform destroy *'] }))).toBe(
      "Runs code Buckle cannot read as shell, with an interpreter the policy does not allow (unknown interpreter): python3, node (allow each with buckle policy allow-interpreter <name>), so the workspace command policy's deny list cannot meet all of it; refused rather than asked",
    )
    expect(refusal(check('workspace', false, ['bash', ['-c', 'python3 -c 1; node -e 1']], { deny: ['terraform destroy *'], workspaceAllows: ['node'] }))).toBe(`${unknown('python3')}, so the workspace command policy's deny list cannot meet all of it; refused rather than asked`)
  })

  it('judges an allowance by the exact program name, so python3 allows neither python nor python3.12', () => {
    for (const command of ['python', 'python3.12']) {
      expect(refusal(check('workspace', false, [command, ['-c', 'print(1)']], { deny: ['terraform destroy *'], workspaceAllows: ['python3'] }))).toBe(`${unknown(command)}, so the workspace command policy's deny list cannot meet all of it; refused rather than asked`)
    }
  })

  it.each(engineCases.flatMap(([engine, switched]) => [
    [engine, switched, 'node', ['--version']],
    [engine, switched, 'node', ['-v']],
    [engine, switched, 'python3', ['--version']],
    [engine, switched, 'python3', ['-V']],
    [engine, switched, 'python3', ['-VV']],
    [engine, switched, 'perl', ['-V']],
    [engine, switched, 'ruby', ['-v']],
    [engine, switched, 'deno', ['-v']],
    [engine, switched, 'python3', []],
    [engine, switched, 'php', ['--help']],
    [engine, switched, 'awk', ['--version']],
    [engine, switched, 'gawk', ['-V']],
    [engine, switched, 'mawk', ['-W', 'version']],
    [engine, switched, 'nawk', ['-version']],
    [engine, switched, 'awk', []],
    [engine, switched, 'lua', ['-v']],
    [engine, switched, 'luajit', ['-v']],
    [engine, switched, 'pwsh', ['-Version']],
    [engine, switched, 'pwsh', ['-v']],
    [engine, switched, 'powershell', ['-Help']],
    [engine, switched, 'tsx', ['--version']],
    [engine, switched, 'ts-node', ['-h']],
    [engine, switched, 'python3.13t', ['--version']],
    [engine, switched, 'pypy3', ['-V']],
    [engine, switched, 'tcsh', ['--version']],
    [engine, switched, 'busybox', ['--list']],
    [engine, switched, 'busybox', ['ls', '-la']],
    [engine, switched, 'toybox', ['--version']],
    [engine, switched, 'toybox', ['ls', '-la']],
    [engine, switched, 'bash', ['-c', 'busybox']],
    [engine, switched, 'bash', ['-c', 'toybox']],
    // The package runners print their version or help and run nothing, as the other interpreters do (D86 (4)).
    [engine, switched, 'npx', ['--version']],
    [engine, switched, 'pnpx', ['-v']],
    [engine, switched, 'bunx', ['--help']],
  ] as const))('leaves %s, switch on: %s, %s %j an ordinary command: it prints, or reads the input Buckle leaves empty', (engine, switched, command, args) => {
    expect(check(engine, switched, [command, args], { deny: ['terraform destroy *'] })).toMatchObject({ kind: 'allow' })
    expect(check(engine, switched, [command, args], { deny: [] })).toMatchObject({ kind: 'allow' })
  })

  it('reads a bare interpreter inside shell text as running code from its input, a pipe, a redirection, or a heredoc', () => {
    for (const body of ['python3', 'cat job.py | python3', "python3 <<'EOF'\nprint(1)\nEOF"]) {
      expect(commandFormsOf({ command: 'bash', args: ['-c', body] }).interpreters).toEqual(['python3'])
    }
    expect(commandFormsOf({ command: 'bash', args: ['-c', 'python3 --version && node -v'] }).interpreters).toEqual([])
    expect(commandFormsOf({ command: 'bash', args: ['-c', 'git commit -m "fix; python3 -c x"'] }).interpreters).toEqual([])
  })
})

// Slice 7i residual and owner decision D7: `sudo git push` was read as `sudo` alone, so the floor asked about sudo and
// the dangerously-allow switch turned that ask into an allow past a deny glob on `git push *`; `su -c` and `ssh` were
// judged by their own words only. The command a wrapper runs is now read as a command of its own, beside the wrapper:
// a deny glob on it refuses with the switch on or off, and the floor asks about a
// destructive one. An interactive session (ssh or su with no command, a sudo or doas shell) is unread: refused naming
// the limit under any deny glob, and asked at the floor with none (default D33 (b)).
describe('a command behind a wrapper', () => {
  const policyOf = (deny: string[]) => {
    const policy = emptyWorkspacePolicy()
    policy.commands.deny = deny
    return compilePolicy(policy)
  }
  const engines = {
    workspace: (deny: string[]) => [createCommandPolicyRule(policyOf(deny), { enforceWrapperAllow: false }), createDestructiveCommandRule()],
  }
  const named = { workspace: 'the workspace command policy' } as const
  const check = (engine: keyof typeof engines, switched: boolean, call: readonly string[], deny: string[]) =>
    withDangerouslyAllow(createPermissionEngine(engines[engine](deny)), { enabled: () => switched, root: () => '/workspace' })
      .evaluate({ tool: 'shell_exec', effects: [{ kind: 'exec', command: call[0]!, args: call.slice(1) }], grants: { subjectsFor: () => [] } })
  const refusal = (outcome: ReturnType<typeof check>) => {
    if (outcome.kind !== 'deny') throw new Error(`expected a deny, got ${outcome.kind}`)
    expect(outcome.denial.rule).toBe('command_policy')
    return outcome.denial.reason
  }
  const cases = (['workspace'] as const).flatMap(engine => [false, true].map(switched => [engine, switched] as const))
  /** Each wrapper and option shape around a command: argv wrappers before it, su -c and ssh with it as shell text. */
  const wrappers: Array<[string, (command: string[]) => string[]]> = [
    ...[
      ['sudo'], ['sudo', '-u', 'root'], ['sudo', '-iu', 'root'], ['sudo', '--login'], ['sudo', '-E', 'X=1'], ['/usr/bin/sudo', '--'], ['doas'], ['doas', '-nu', 'root'],
      ['ssh', 'host'], ['ssh', '-p', '22', 'host'], ['ssh', 'host', '-l', 'me'], ['ssh', '-P', 'tag', 'host'], ['env', '-i', '-u', 'HOME', 'X=1'], ['nice', '-n', '5'],
      ['nohup'], ['timeout', '-s', 'KILL', '-k', '1', '--foreground', '5'], ['time', '-p'], ['stdbuf', '-oL'], ['ionice', '-c', '3'], ['chrt', '-o', '0'],
      ['command', '-p'], ['builtin'], ['exec'], ['sudo', 'env', 'X=1', 'nice'], ['ssh', 'host', 'sudo'], ['doas', 'timeout', '5', 'ssh', 'host'],
      // busybox and toybox run the applet they are given; chrt from util-linux 2.41 may omit the priority.
      ['busybox', 'env'], ['busybox', 'env', '-i'], ['busybox', 'nice'], ['busybox', 'timeout', '5'], ['busybox', 'xargs'], ['/bin/busybox', 'chrt', '-o', '0'],
      ['toybox', 'env'], ['toybox', 'nice', '-n', '5'], ['toybox', 'timeout', '5'], ['toybox', 'xargs'], ['chrt', '-o'], ['chrt', '--other'], ['chrt', '-f', '5'],
    ].map(prefix => [prefix.join(' '), (command: string[]) => [...prefix, ...command]] as [string, (command: string[]) => string[]]),
    ['su -c', command => ['su', '-c', command.join(' '), 'root']],
    ['su root -c', command => ['su', 'root', '-c', command.join(' ')]],
    ['su -s /bin/bash -lc', command => ['su', '-s', '/bin/bash', '-lc', command.join(' '), 'root']],
    ['sudo su -c', command => ['sudo', 'su', '-c', command.join(' '), 'root']],
    ['ssh with one quoted word', command => ['ssh', 'host', `echo ok; ${command.join(' ')}`]],
    ['ssh -o ProxyCommand', command => ['ssh', '-o', `ProxyCommand=${command.join(' ')}`, 'host', 'true']],
    ['ssh -o RemoteCommand', command => ['ssh', '-o', `RemoteCommand=${command.join(' ')}`, 'host']],
    ['bash -c with sudo', command => ['bash', '-c', `sudo ${command.join(' ')}`]],
    ['bash -c with ssh', command => ['bash', '-c', `ssh host '${command.join(' ')}'`]],
  ]
  const push = ['git', 'push', 'origin', 'main']
  const forcePush = ['git', 'push', '--force', 'origin', 'main']
  /** Whether the call runs sudo, doas, or su anywhere, whose own ask (privilege) the floor names first. */
  const privileged = (call: readonly string[]) => call.some(word => /(^|[\s/])(sudo|doas|su)(\s|$)/.test(word))

  it.each(cases.flatMap(([engine, switched]) => wrappers.map(([shape, wrap]) => [engine, switched, shape, wrap] as const)))('refuses %s deny, switch on: %s, git push behind %s by the push glob', (engine, switched, _shape, wrap) => {
    expect(refusal(check(engine, switched, wrap(push), ['git push *']))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  it.each((['workspace'] as const).flatMap(engine => wrappers.map(([shape, wrap]) => [engine, shape, wrap] as const)))('asks at the floor, %s with no deny glob, about a force push behind %s', (engine, _shape, wrap) => {
    const call = wrap(forcePush)
    const outcome = check(engine, false, call, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => ask.rule)).toEqual(['destructive_command'])
    expect(outcome.asks[0]!.reason).toMatch(privileged(call) ? /^(sudo|doas|su) escalates privileges$/ : /^Force push rewrites remote history/)
  })

  const session = READ_LIMITS.session
  const sessions = [
    ['ssh', 'host'], ['ssh', '-p', '22', 'host'], ['ssh', 'host', ''], ['ssh', '-o', 'ProxyCommand=nc %h %p', 'host'], ['su'], ['su', '-'], ['su', '-', 'root'],
    ['su', '-l', 'root'], ['sudo', '-i'], ['sudo', '-s'], ['sudo', '-iu', 'root'], ['sudo', '--login'], ['sudo', '--shell'], ['doas', '-s'], ['sudo', 'su'],
    ['env', 'ssh', 'host'], ['bash', '-c', 'echo id | ssh host'],
  ]

  it.each(cases.flatMap(([engine, switched]) => sessions.map(call => [engine, switched, call] as const)))('refuses %s deny, switch on: %s, the interactive session %j, naming the limit', (engine, switched, call) => {
    expect(refusal(check(engine, switched, call, ['terraform destroy *']))).toBe(`${session}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace'] as const).flatMap(engine => sessions.map(call => [engine, call] as const)))('asks at the floor, %s with no deny glob, about the interactive session %j', (engine, call) => {
    const outcome = check(engine, false, call, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', privileged(call) ? expect.stringMatching(/^(sudo|doas|su) escalates privileges$/) : `${session}; asked rather than guessed at`]])
  })

  it.each(cases.flatMap(([engine, switched]) => [
    ['ssh', 'host', 'git', 'status'], ['ssh', '-N', '-L', '8080:localhost:80', 'host'], ['ssh', '-G', 'host'], ['ssh', '-V'], ['env', 'git', 'status'],
  ].map(call => [engine, switched, call] as const)))('allows %s deny, switch on: %s, %j, which opens no session and runs nothing denied', (engine, switched, call) => {
    expect(check(engine, switched, call, ['git push *', 'terraform destroy *'])).toMatchObject({ kind: 'allow' })
  })

  it('needs the wrapper allowed when sudo hands its command to a shell, as env does', () => {
    expect(reasonOf(evaluate('sudo', ['bash', '-c', 'pnpm build']))).toContain("allow-command 'sudo bash -c *'")
  })

  // Slice 7l: env -S, an ssh -o command setting, and sudo -s or -i each parse their argument by rules of their own.
  // Where those rules are small and certain they are read exactly: env -S splits a value with no backslash and no `${`
  // on six blanks with quotes and a `#` comment, ssh reads its keyword as readconf does (a quoted keyword, `=` or
  // blanks) and a `%%` as a `%`, and sudo hands a shell words that read as themselves unchanged. Anything else is
  // unread (own parsing): refused under any deny glob and asked at the floor with none. GNU env 9.4 and OpenSSH 9.6p1
  // ran each env and ssh shape with a sentinel; sudo's escaping is the one its manual gives, and bash ran the escaped
  // text it yields.
  const ownParsing = READ_LIMITS.ownParsing
  const modelled: Array<[string, string[]]> = [
    ['env -S with a vertical tab', ['env', '-S', 'git\vpush origin main']],
    ['env -S with a form feed', ['env', '-S', 'git push\forigin main']],
    ['env -S with a comment', ['env', '-S', 'git push origin main #x']],
    ['env -S with quotes', ['env', '-S', "git 'push' \"origin\" main"]],
    ['ssh -o with a quoted keyword', ['ssh', '-o', '"ProxyCommand" git push origin main', 'host', 'true']],
    ['ssh -o with a quoted keyword and =', ['ssh', '-o', '"ProxyCommand"=git push origin main', 'host', 'true']],
    ['ssh -o with a quote inside the keyword', ['ssh', '-o', 'Proxy"Command" git push origin main', 'host', 'true']],
    ['ssh -o with an empty quoted word first', ['ssh', '-o', '"" ProxyCommand git push origin main', 'host', 'true']],
    ['ssh -o with two = signs', ['ssh', '-o', 'ProxyCommand==git push origin main', 'host', 'true']],
    ['ssh -o attached with a quoted keyword', ['ssh', '-o"ProxyCommand" git push origin main', 'host', 'true']],
    ['ssh -o with a %%', ['ssh', '-o', 'ProxyCommand=git push origin %%main', 'host', 'true']],
    ['sudo -s with plain words', ['sudo', '-s', 'git', 'push', 'origin', 'main']],
    ['sudo -i with an empty word', ['sudo', '-i', '', 'git', 'push', 'origin', 'main']],
  ]

  it.each(cases.flatMap(([engine, switched]) => modelled.map(([shape, call]) => [engine, switched, shape, call] as const)))('refuses %s deny, switch on: %s, by the push glob, a git push read exactly through %s', (engine, switched, _shape, call) => {
    expect(commandFormsOf({ command: call[0]!, args: call.slice(1) }).unread).toBe(null)
    expect(refusal(check(engine, switched, call, ['git push *']))).toBe(`Refused by ${named[engine]}: git push *`)
  })

  const unreadOwn: Array<[string, (command: string) => string[]]> = [
    ['env -S with \\_ separators', command => ['env', '-S', command.replaceAll(' ', '\\_')]],
    ['env -S with \\c', command => ['env', '-S', `${command}\\c x`]],
    ['env --split-string with \\_', command => ['env', `--split-string=${command.replaceAll(' ', '\\_')}`]],
    ['env -S with ${}', command => ['env', '-S', `\${GIT} ${command.split(' ').slice(1).join(' ')}`]],
    ['nice env -S with \\_', command => ['nice', 'env', '-S', command.replaceAll(' ', '\\_')]],
    ['ssh -o ProxyCommand with %r', command => ['ssh', '-l', 'git', '-o', `ProxyCommand=%r ${command.split(' ').slice(1).join(' ')}`, 'host', 'true']],
    ['ssh -o ProxyCommand with %h', command => ['ssh', '-o', `ProxyCommand=%h ${command.split(' ').slice(1).join(' ')}`, 'git', 'true']],
    ['ssh -o quoted RemoteCommand with %n', command => ['ssh', '-o', `"RemoteCommand" %n ${command.split(' ').slice(1).join(' ')}`, 'git']],
    ['sudo -s with a newline in a word', command => ['sudo', '-s', `gi\nt`, ...command.split(' ').slice(1)]],
    ['sudo -i with a $', command => ['sudo', '-i', '$GIT', ...command.split(' ').slice(1)]],
  ]

  it.each(cases.flatMap(([engine, switched]) => unreadOwn.map(([shape, wrap]) => [engine, switched, shape, wrap] as const)))('refuses %s deny, switch on: %s, a git push behind %s as unread, naming the limit', (engine, switched, _shape, wrap) => {
    const call = wrap('git push --force origin main')
    expect(commandFormsOf({ command: call[0]!, args: call.slice(1) }).unread).toBe('ownParsing')
    expect(refusal(check(engine, switched, call, ['git push *']))).toMatch(/^(Refused by .*: git push \*|A program reads an argument by rules of its own .*)$/)
    expect(refusal(check(engine, switched, call, ['terraform destroy *']))).toBe(`${ownParsing}, so ${named[engine]}'s deny list cannot meet all of it; refused rather than asked`)
  })

  it.each((['workspace'] as const).flatMap(engine => unreadOwn.map(([shape, wrap]) => [engine, shape, wrap] as const)))('asks at the floor, %s with no deny glob, about a force push behind %s', (engine, _shape, wrap) => {
    const call = wrap('git push --force origin main')
    const outcome = check(engine, false, call, [])
    if (outcome.kind !== 'ask') throw new Error(`expected an ask, got ${outcome.kind}`)
    // Where the words read still name the force push (env -S with \c), the floor names that first; it asks either way.
    const reason = privileged(call) ? /^sudo escalates privileges$/ : /^(Force push rewrites remote history|A program reads an argument by rules of its own .*\(own parsing\); asked rather than guessed at$)/
    expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', expect.stringMatching(reason)]])
  })
})

describe('the destructive floor the owner raised', () => {
  const destructive = ['terraform destroy *']

  it('asks before running what the owner added, naming the glob', () => {
    const outcome = evaluate('terraform', ['destroy', '-auto-approve'], { destructive })
    expect(outcome.kind).toBe('ask')
    if (outcome.kind !== 'ask') return
    expect(outcome.asks[0]?.rule).toBe('destructive_command')
    expect(outcome.asks[0]?.reason).toContain('terraform destroy *')
  })

  it('never offers a standing grant for one', () => {
    const outcome = evaluate('terraform', ['destroy'], { destructive })
    if (outcome.kind !== 'ask') throw new Error('expected ask')
    expect(outcome.asks[0]?.offeredScopes).toEqual(['once', 'session'])
  })

  it('leaves the rest of that binary alone', () => {
    expect(evaluate('terraform', ['plan'], { destructive }).kind).toBe('allow')
  })

  it('reaches what an allowed wrapper runs', () => {
    expect(evaluate('bash', ['-c', 'cd infra && terraform destroy'], { allow: ['bash -c *'], destructive }).kind).toBe('ask')
  })

  it('cannot lower the built-in floor, whatever the owner lists', () => {
    expect(evaluate('sudo', ['ls'], { destructive, allow: ['sudo *'] }).kind).toBe('ask')
    expect(evaluate('rm', ['-rf', 'build'], { destructive }).kind).toBe('ask')
  })
})

describe('a statement a redirection opens (fix brief 5, N2)', () => {
  it('keeps the interpreter after >&, 2>&1, and >| in the statement, so the deny list and the floor meet it', () => {
    for (const text of ['>&2 python3 x.py', '2>&1 python3 x.py', '>| out python3 x.py']) {
      expect(evaluate('bash', ['-c', text], { allow: ['bash -c *'], deny: ['python3 *'] }).kind, text).toBe('deny')
      const ask = evaluate('bash', ['-c', text], { allow: ['bash -c *'] })
      expect(ask.kind, text).toBe('ask')
      if (ask.kind === 'ask') expect(ask.asks[0]?.rule, text).toBe('destructive_command')
    }
  })

  it('does not let a leading redirection lift a deny glob or the built-in floor', () => {
    expect(evaluate('bash', ['-c', '>&2 git push --force origin main'], { allow: ['bash -c *'], deny: ['git push *'] }).kind).toBe('deny')
    expect(evaluate('bash', ['-c', '>&2 sudo ls'], { allow: ['bash -c *'] }).kind).toBe('ask')
  })
})

describe('a leading &> or &>> redirection (fix brief 6, A1)', () => {
  // bash reads `&>f` as one redirection and runs the command after it; dash and POSIX sh read `a &>f b` as the
  // background job `a &` and then `>f b`. Cutting the statement at that `&` reads python3 as the command either way.
  const texts: Array<[string, string]> = [
    ['bash', '&>/dev/null python3 x.py'],
    ['bash', '&>>log python3 x.py'],
    ['bash', 'true &&>/dev/null python3 x.py'],
    ['sh', 'true &>/dev/null python3 x.py'],
  ]

  it.each(texts)('%s -c %j asks at the interpreter floor and meets a python3 deny', (shell, text) => {
    const allow = [`${shell} -c *`]
    const ask = evaluate(shell, ['-c', text], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate(shell, ['-c', text], { allow, deny: ['python3 *'] }).kind).toBe('deny')
  })
})

describe('a list operator right after a heredoc word (fix brief 6, A2)', () => {
  // bash and dash read `<<EOF` as the operator and its word, so the `&` after the word puts `cat <<EOF` in the
  // background and runs the next statement; `let x=1<<2&...` holds the same heredoc for bash.
  it.each(['cat <<EOF&python3 x.py', 'cat <<EOF&python3 x.py\nbody\nEOF', "cat <<'EOF'&python3 x.py", 'let x=1<<2&python3 x.py'])('bash -c %j asks at the interpreter floor and meets a python3 deny', (text) => {
    const ask = evaluate('bash', ['-c', text], { allow: ['bash -c *'] })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate('bash', ['-c', text], { allow: ['bash -c *'], deny: ['python3 *'] }).kind).toBe('deny')
  })
})

describe('a redirection attached to the word before it (fix brief 6, A3)', () => {
  // bash ends a word at an unquoted `<` or `>`, so `rm>/dev/null -rf x` runs rm with the arguments -rf x.
  it('meets rm, sudo, and git behind an attached redirection at the floor and in the deny list', () => {
    const recursive = evaluate('bash', ['-c', 'rm>/dev/null -rf x'], { allow: ['bash -c *'] })
    expect(recursive.kind).toBe('ask')
    if (recursive.kind === 'ask') expect(recursive.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'floor' })
    expect(evaluate('bash', ['-c', 'rm>/dev/null -rf x'], { allow: ['bash -c *'], deny: ['rm *'] }).kind).toBe('deny')
    expect(evaluate('bash', ['-c', 'sudo>/dev/null ls'], { allow: ['bash -c *'] }).kind).toBe('ask')
    expect(evaluate('bash', ['-c', 'git>out push --force origin main'], { allow: ['bash -c *'], deny: ['git push *'] }).kind).toBe('deny')
  })

  it.each(['python3>log x.py', 'python3<x.py', 'python3 x.py>log'])('bash -c %j asks at the interpreter floor and meets a python3 deny', (text) => {
    const ask = evaluate('bash', ['-c', text], { allow: ['bash -c *'] })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate('bash', ['-c', text], { allow: ['bash -c *'], deny: ['python3 *'] }).kind).toBe('deny')
  })
})

describe('a bare redirection operator, a named descriptor, or a zsh clobber operator (fix brief 6, A4)', () => {
  // Each operator takes the next word as its target, so the command is the word after that (bash 5.2 ran the command
  // after `>& out`, `2>& 1`, `<& 0`, and `{fd}>out`; zsh's operators are from the zshmisc manual, REDIRECTION).
  const texts: Array<[string, string]> = [
    ['bash', '>& out python3 x.py'],
    ['bash', '2>& err python3 x.py'],
    ['bash', '<& 0 python3 x.py'],
    ['bash', '{fd}>out python3 x.py'],
    ['bash', '{fd}> out python3 x.py'],
    ['zsh', '>! out python3 x.py'],
    ['zsh', '>>| out python3 x.py'],
    ['zsh', '>&| out python3 x.py'],
  ]

  it.each(texts)('%s -c %j asks at the interpreter floor and meets a python3 deny', (shell, text) => {
    const allow = [`${shell} -c *`]
    const ask = evaluate(shell, ['-c', text], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate(shell, ['-c', text], { allow, deny: ['python3 *'] }).kind).toBe('deny')
  })

  it("reads a bare >! both as zsh's clobber operator and as bash's > onto a file named !, so either command meets the rules", () => {
    // bash 5.2 ran `>! echo x`, writing a file named `!`; zsh takes the next word as the target.
    expect(evaluate('bash', ['-c', '>! rm -rf x'], { allow: ['bash -c *'] }).kind).toBe('ask')
    expect(evaluate('bash', ['-c', '>! rm -rf x'], { allow: ['bash -c *'], deny: ['rm *'] }).kind).toBe('deny')
    expect(evaluate('zsh', ['-c', '>! out rm -rf x'], { allow: ['zsh -c *'], deny: ['rm *'] }).kind).toBe('deny')
    expect(evaluate('bash', ['-c', '>>! git push --force origin main'], { allow: ['bash -c *'], deny: ['git push *'] }).kind).toBe('deny')
  })
})

describe("ksh93's >;word and <>;word redirections (fix brief 6, A5)", () => {
  // The ksh93 manual (sh.1, Input/Output): `>;word` writes a temporary file renamed to word when the command succeeds,
  // and `<>;word` is `<>` truncated the same way; both run the command. bash and dash reject `>;` as a syntax error.
  it.each(['>;out python3 x.py', '<>;out python3 x.py', '>; out python3 x.py'])('ksh -c %j asks at the interpreter floor and meets a python3 deny', (text) => {
    const ask = evaluate('ksh', ['-c', text], { allow: ['ksh -c *'] })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate('ksh', ['-c', text], { allow: ['ksh -c *'], deny: ['python3 *'] }).kind).toBe('deny')
  })
})

describe("the clauses of the splitter's redirection branch, under an unrelated deny glob (fix brief 6, A6)", () => {
  // A call that runs an interpreter is refused under any deny glob (slice 7c review R7C-CR-1), so a statement the splitter
  // cuts wrong, which hides python3, is allowed under `git push *`; each row pins one clause or cut of the branch.
  const rows: Array<[string, string]> = [
    ['bash', '<&0 python3 x.py'],
    ['bash', '&>/dev/null python3 x.py'],
    ['bash', 'true &&>/dev/null python3 x.py'],
    ['bash', 'cat <<EOF&python3 x.py'],
    ['sh', 'echo A &>/dev/null python3 x.py'],
    ['dash', 'echo A &>/dev/null python3 x.py'],
  ]

  it.each(rows)('%s -c %j asks at the interpreter floor and is denied under git push *', (shell, text) => {
    const allow = [`${shell} -c *`]
    const ask = evaluate(shell, ['-c', text], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate(shell, ['-c', text], { allow, deny: ['git push *'] }).kind).toBe('deny')
  })
})

describe('an assignment-shaped word a wrapper runs as a program (fix brief 6, A7)', () => {
  // nice, timeout, nohup, xargs, exec, and command exec the word after their own as a path (coreutils 9.4: nice
  // PYTHONSTARTUP=x ... exits 127, no such file), so `nice FOO=/bin/rm x` runs a file in a folder named FOO=.
  it('meets the deny list and the destructive list by its basename, as it did before D1', () => {
    const commands = { allow: ['*'], deny: ['curl *', 'rm *'], destructive: ['tar *'] }
    expect(evaluate('nice', ['FOO=/bin/rm', 'x'], commands).kind).toBe('deny')
    expect(evaluate('timeout', ['5', 'FOO=/usr/bin/curl', 'http://x'], commands).kind).toBe('deny')
    const listed = evaluate('nice', ['FOO=/bin/tar', 'x'], commands)
    expect(listed.kind).toBe('ask')
    if (listed.kind === 'ask') expect(listed.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'destructive-list' })
    expect(evaluate('bash', ['-c', 'exec FOO=/bin/rm x'], { allow: ['bash -c *'], deny: ['rm *'] }).kind).toBe('deny')
  })
})

describe('a &> or &>> redirection between a command and its arguments (fix brief 7, A1b)', () => {
  // bash keeps the words after `&>word` as the first command's arguments (bash 5.2.21 ran `rm &>/dev/null -rf x` as rm
  // -rf x), while dash reads the `&` as a background job; the statement is read cut at the `&` and whole as well.
  // `rm -rf *` covers the line in order, so `rm x -rf y` meets `rm *` alone, as the direct call does.
  it.each([['rm &>/dev/null -rf x', 'rm -rf *'], ['rm x &>/dev/null -rf y', 'rm *'], ['rm &> /dev/null -rf x', 'rm -rf *']])('bash -c %j asks at the floor and meets the deny %j', (text, deny) => {
    const ask = evaluate('bash', ['-c', text], { allow: ['bash -c *'] })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'floor' })
    expect(evaluate('bash', ['-c', text], { allow: ['bash -c *'], deny: [deny] }).kind).toBe('deny')
  })

  it.each(['git push &>/dev/null --force origin main', 'git &>/dev/null push --force origin main'])('bash -c %j meets a git push deny', (text) => {
    expect(evaluate('bash', ['-c', text], { allow: ['bash -c *'], deny: ['git push *'] }).kind).toBe('deny')
  })

  it('still reads the interpreter after env &>/dev/null, and the dash reading of a later command', () => {
    for (const [shell, text] of [['bash', 'env &>/dev/null python3 x.py'], ['sh', 'true &>/dev/null python3 x.py'], ['dash', 'echo A &>/dev/null python3 x.py']] as const) {
      const ask = evaluate(shell, ['-c', text], { allow: [`${shell} -c *`] })
      expect(ask.kind, text).toBe('ask')
      if (ask.kind === 'ask') expect(ask.asks[0], text).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    }
  })
})

describe('a chain of &> redirections, read whole once where it ends (fix brief 8, A1c)', () => {
  // A1b read the command before every `&>` of a chain whole, so n links pushed n statements of up to n links each, none
  // charged to the read budget: a 320 KB body ran the node out of memory. bash runs only the whole command, and dash
  // the pieces the `&` cuts; the commands before a chain's last `&>` are ones no shell runs.
  it('keeps the joined whole of each A1b row and drops the middle prefixes', () => {
    expect(shellStatementList('rm &>/dev/null -rf x').statements).toContain('rm  >/dev/null -rf x')
    expect(shellStatementList('rm x &>/dev/null -rf y').statements).toContain('rm x  >/dev/null -rf y')
    expect(shellStatementList('git &>/dev/null push --force origin main').statements).toContain('git  >/dev/null push --force origin main')
    expect(shellStatementList('a &>b c &>d e').statements).toEqual(['a', '>b c', '>d e', 'a  >b c  >d e'])
  })

  it('meets a deny through the whole of a chain, and reads the head of a join a substitution cut', () => {
    expect(evaluate('bash', ['-c', 'rm &>a -r &>b -f x'], { allow: ['bash -c *'], deny: ['rm -r -f *'] }).kind).toBe('deny')
    for (const text of ['rm &>/dev/null -rf $(echo x)', 'rm &>$(echo f) -rf x', 'rm &>`echo f` -rf x', 'rm $(echo) &>/dev/null -rf x']) {
      const ask = evaluate('bash', ['-c', text], { allow: ['bash -c *'] })
      expect(ask.kind, text).toBe('ask')
      if (ask.kind === 'ask') expect(ask.asks[0], text).toMatchObject({ rule: 'destructive_command', cause: 'floor' })
      expect(evaluate('bash', ['-c', text], { allow: ['bash -c *'], deny: ['rm -rf *'] }).kind, text).toBe('deny')
    }
  })

  it('charges the joined whole to the read budget, so a text past it is over budget', () => {
    const text = `a${' &>b'.repeat(1_000)}`
    expect(shellStatementList(text, { characters: text.length + 100 }).overBudget).toBe(true)
    expect(shellStatementList(text.replaceAll('&>', ';>'), { characters: text.length + 100 }).overBudget).toBe(false)
  })

  it('reads a bash -c body of 24,999 &> links in well under a second', () => {
    const { milliseconds, result } = leastProcessorTime(() => evaluate('bash', ['-c', `a${' &>b'.repeat(24_999)}`], { allow: ['bash -c *'] }))
    expect(milliseconds).toBeLessThan(250)
    expect(result.kind).toBe('allow')
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  it('reads a 1 MiB chained body within the budget, holding three statements and charging about twice its length', () => {
    const text = `a${' &>b'.repeat(262_143)}`
    const meter = { characters: READ_BUDGET.characters }
    const list = shellStatementList(text, meter)
    expect(list.overBudget).toBe(false)
    expect(list.statements).toHaveLength(3)
    expect(list.statements.reduce((sum, statement) => sum + statement.length, 0)).toBeLessThan(2 * text.length)
    expect(READ_BUDGET.characters - meter.characters).toBeLessThan(3 * text.length)
    expect(evaluate('bash', ['-c', text], { allow: ['bash -c *'] }).kind).toBe('allow')
  }, PROCESSOR_TIME_ROW_TIMEOUT)
})

describe('a heredoc word ending in an escaped operator character (fix brief 7, A2b)', () => {
  // A backslash makes the delimiter's last character part of the word, never an operator, so the `&`, `|`, or `;` after
  // it is a list operator (bash 5.2.21 and dash ran the second command of each).
  const texts = ['cat <<E\\<&python3 x.py\nE<', 'cat <<E\\>&python3 x.py', 'cat <<E\\>|python3 x.py', 'cat <<E\\>;python3 x.py', 'cat <<a\\>;python3 x.py', 'cat <<\\>;python3 x.py', 'cat <<-a\\>;python3 x.py', 'cat <<"a"\\>;python3 x.py']
  const rows = texts.flatMap(text => [['bash', text], ['sh', text]] as Array<[string, string]>)

  it.each(rows)('%s -c %j asks at the interpreter floor and meets a python3 deny and an unrelated git push deny', (shell, text) => {
    const allow = [`${shell} -c *`]
    const ask = evaluate(shell, ['-c', text], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate(shell, ['-c', text], { allow, deny: ['python3 *'] }).kind).toBe('deny')
    expect(evaluate(shell, ['-c', text], { allow, deny: ['git push *'] }).kind).toBe('deny')
  })

  it('keeps the pipe after a delimiter ending in an escaped |, so the shell it feeds reads its script as data', () => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', 'cat <<E\\||bash l'] }).scriptData).toBe(true)
    expect(evaluate('bash', ['-c', 'cat <<E\\||bash l'], { allow: ['bash -c *'], deny: ['node *'] }).kind).toBe('deny')
  })

  it('still splits after an unescaped delimiter and keeps a redirection after a heredoc in its statement', () => {
    for (const text of ['cat <<EOF&python3 x.py', 'let x=1<<2&python3 x.py']) expect(allForms(commandFormsOf({ command: 'bash', args: ['-c', text] })), text).toContainEqual(['python3', 'x.py'])
    const kept = allForms(commandFormsOf({ command: 'bash', args: ['-c', 'cat <<EOF >&2 python3 x.py'] }))
    expect(kept).toContainEqual(['cat', 'python3', 'x.py'])
    expect(kept).not.toContainEqual(['python3', 'x.py'])
  })

  it('asks through the runtime for a find -exec sh text under an empty policy', async () => {
    const config = configFromEnvironment({
      BUCKLE_WORKSPACE_ROOT: mkdtempSync(join(tmpdir(), 'buckle-heredoc-word-')), BUCKLE_STATE_DIR: mkdtempSync(join(tmpdir(), 'buckle-heredoc-word-state-')),
      BUCKLE_SANDBOX: 'none', BUCKLE_ALLOW_SHELL: 'true', BUCKLE_SHELL_ISOLATION: 'false', BUCKLE_PACKS: 'fs,shell', BUCKLE_APPROVAL_TIMEOUT_MS: '1',
    })
    const runtime = await createRuntime({ config })
    const execute = vi.fn(async () => 'executed')
    const prepare = vi.spyOn(runtime.registry().get('shell_exec'), 'prepare').mockReturnValue({ effects: [{ kind: 'exec', command: 'find', args: ['.', '-maxdepth', '0', '-exec', 'sh', '-c', 'cat <<a\\>;python3 build.js', ';'] }], execute })
    try {
      const response = await runtime.invoke({ request: { requestId: 'heredoc-word', approvalTokens: [], tool: 'shell_exec', args: {} }, sessionId: 'heredoc-word', approvalWait: { mode: 'none' } })
      expect(response.outcome).toBe('approval_required')
      expect(execute).not.toHaveBeenCalled()
    } finally {
      prepare.mockRestore()
      await runtime.approvalService.close()
      await runtime.history.close()
    }
  })
})

describe('a command a substitution cuts, read whole by the floor and the deny list (fix brief 7, A3b)', () => {
  // A head is the command a substitution cut, read whole with each body as `$()`; the pieces alone show `rm` apart from
  // `-rf x`. The floor and the deny list read every head that surely runs; the allow list never reads one.
  const allow = ['bash -c *']

  it.each(['rm>$(true) -rf x', 'rm >$(true) -rf x', 'rm >`true` -rf x', 'rm $(true) -rf x', 'rm<$(echo)x -rf x', 'rm>>$(echo)x -rf x', 'chmod>$(echo)x 777 x'])('bash -c %j asks at the floor', (text) => {
    const ask = evaluate('bash', ['-c', text], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'floor' })
  })

  it('meets an rm -rf deny through the head of rm>$(true) -rf x', () => {
    expect(evaluate('bash', ['-c', 'rm>$(true) -rf x'], { allow, deny: ['rm -rf *'] }).kind).toBe('deny')
  })

  it.each(['git>$(true) push --force origin main', 'git >`true` push --force origin main', 'git>$((1))x push --force origin main', 'git $(echo) push --force origin main'])('bash -c %j meets a git push deny', (text) => {
    expect(evaluate('bash', ['-c', text], { allow, deny: ['git push *'] }).kind).toBe('deny')
  })

  it('writes a backtick body after > as a command substitution, never as the process substitution a >( cut leaves', () => {
    const [head] = [...shellStatementList('rm>`true` -rf x').heads.keys()]
    expect(shellTokens(head!).map(token => token.raw)).toEqual(['rm', '>$$()', '-rf', 'x'])
    expect(commandFormsOf({ command: 'bash', args: ['-c', 'BASH_ENV=<(echo x) bash'] }).scriptData).toBe(true)
    const ask = evaluate('bash', ['-c', 'python3>`echo log` x.py'], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate('bash', ['-c', 'python3>`echo log` x.py'], { allow, deny: ['python3 *'] }).kind).toBe('deny')
  })

  it('reads a substitution between ordinary words as before, and never admits a call through a head', () => {
    expect(evaluate('bash', ['-c', 'echo $(date) done'], { allow, deny: ['git push *'] }).kind).toBe('allow')
    expect(evaluate('git', ['commit', '-m', '"$(cat msg)"', '--signoff'], { allow: ['git commit *'] }).kind).toBe('allow')
    expect(evaluate('bash', ['-c', '$(x) rm -rf y'], { allow: ['rm *'] }).kind).toBe('deny')
    const asked = evaluate('bash', ['-c', '$(x) rm -rf y'], { allow: ['rm *', 'bash -c *'] })
    expect(asked.kind).toBe('ask')
  })
})

describe('a head holding many bare substitutions (fix brief 8, A3c)', () => {
  // The reading of a head without its bare substitution words looked each word up in the list of them, so a body of echo
  // and 330,000 empty backtick pairs (990 KB, under the request cap) held the node for about a minute.
  it('reads echo and 330,000 empty backtick pairs through the rules in under a second', () => {
    const text = `echo${' ``'.repeat(330_000)}`
    const { milliseconds, result } = leastProcessorTime(() => evaluate('bash', ['-c', text], { allow: ['bash -c *'] }), 2)
    expect(milliseconds).toBeLessThan(1_000)
    expect(result.kind).toBe('allow')
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  it('charges that reading to the read budget before it is built', () => {
    // 400,001 words in the statement, 400,002 in its head, and 400,001 in the head read without its bare word: past the
    // budget's 1,000,000 words only with the last counted.
    const forms = commandFormsOf({ command: 'bash', args: ['-c', `echo${' w'.repeat(400_000)} \`\``] })
    expect(forms.overBudget).toBe(true)
    expect(commandFormsOf({ command: 'bash', args: ['-c', `echo${' w'.repeat(400_000)} x`] }).overBudget).toBe(false)
  }, PROCESSOR_TIME_ROW_TIMEOUT)
})

describe('a line continuation inside a redirection operator (fix brief 7, A4b)', () => {
  // bash and dash remove a backslash-newline before they read words, so `>\<newline> out` is `> out`, `2\<newline>>` is
  // `2>`, and `{f\<newline>d}>` is `{fd}>` (bash 5.2.21 ran the command after each, and printed fd=10 for the named one).
  const shells = ['bash', 'sh']

  it.each(shells.flatMap(shell => ['>\\\n out rm -rf x', '{f\\\nd}>out rm -rf x'].map(text => [shell, text])))('%s -c %j asks at the floor and meets an rm deny', (shell, text) => {
    const allow = [`${shell} -c *`]
    const ask = evaluate(shell, ['-c', text], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'floor' })
    expect(evaluate(shell, ['-c', text], { allow, deny: ['rm *'] }).kind).toBe('deny')
  })

  const interpreted = ['>\\\n| out python3 x.py', '<\\\n& 0 python3 x.py', '2\\\n> err python3 x.py', '{fd}\\\n>out python3 x.py', '2>\\\n& 1 python3 x.py']
  it.each(shells.flatMap(shell => interpreted.map(text => [shell, text])))('%s -c %j asks at the interpreter floor and meets a python3 deny and an unrelated git push deny', (shell, text) => {
    const allow = [`${shell} -c *`]
    const ask = evaluate(shell, ['-c', text], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate(shell, ['-c', text], { allow, deny: ['python3 *'] }).kind).toBe('deny')
    expect(evaluate(shell, ['-c', text], { allow, deny: ['git push *'] }).kind).toBe('deny')
  })

  it('leaves a quoted operator a word, and an escaped backslash before a newline a word that ends its statement', () => {
    expect(allForms(commandFormsOf({ command: 'bash', args: ['-c', "echo '>\\\n' out"] }))).toContainEqual(['echo', '>\\\n', 'out'])
    // `2`, an escaped backslash, then a newline: the newline ends a statement whose word is `2\`, and no continuation joins it.
    expect(shellStatementList('2\\\\\n> out python3 x.py').statements).toEqual(['2\\\\', '> out python3 x.py'])
    expect(shellTokens('2\\\\').map(token => token.word)).toEqual(['2\\'])
    expect(joinedOperator('2\\\\\n>')).toBe('2\\\\\n>')
    expect(joinedOperator('2\\\n>')).toBe('2>')
  })

  it("pins ksh93's bare <>; operator, whose target is the next word", () => {
    expect(evaluate('ksh', ['-c', '<>; out python3 x.py'], { allow: ['ksh -c *'] }).kind).toBe('ask')
    expect(evaluate('ksh', ['-c', '<>; out python3 x.py'], { allow: ['ksh -c *'], deny: ['python3 *'] }).kind).toBe('deny')
  })

  it('reads a continuation between the characters of an operator the statement keeps (recheck 7, A4b residue)', () => {
    expect(evaluate('bash', ['-c', '>\\\n> out python3 x.py'], { allow: ['bash -c *'], deny: ['python3 *'] }).kind).toBe('deny')
    expect(evaluate('bash', ['-c', '>\\\n> out python3 x.py'], { allow: ['bash -c *'], deny: ['git push *'] }).kind).toBe('deny')
    expect(evaluate('bash', ['-c', 'git >\\\n> out push --force origin main'], { allow: ['bash -c *'], deny: ['git push *'] }).kind).toBe('deny')
  })
})

describe('a line continuation inside the &> or << the splitter reads (fix brief 8, A4c)', () => {
  // bash and dash remove a backslash-newline before they read an operator: bash 5.2.21 wrote `one two` to the file for
  // `printf "%s\n" one &\<newline>>outA two`, where dash ran `two` as a command, and both read `<\<newline><'EOF'` as a
  // heredoc and ran the command after its delimiter line, as they did for `<< \<newline> 'EOF'` and for `<<E\<newline>OF`,
  // whose delimiter is EOF, unquoted (the body's substitution ran).
  const shells = ['bash', 'sh']

  it.each(shells.flatMap(shell => ['rm &\\\n>/dev/null -rf x', 'rm &\\\n> /dev/null -rf x', 'rm &\\\n>>/dev/null -rf x', 'rm &\\\n\\\n>/dev/null -rf x'].map(text => [shell, text])))('%s -c %j asks at the floor and meets an rm -rf deny', (shell, text) => {
    const allow = [`${shell} -c *`]
    const ask = evaluate(shell, ['-c', text], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'floor' })
    expect(evaluate(shell, ['-c', text], { allow, deny: ['rm -rf *'] }).kind).toBe('deny')
  })

  it('reads chmod and git push after a continued &>', () => {
    const ask = evaluate('bash', ['-c', 'chmod &\\\n>/dev/null -R 777 x'], { allow: ['bash -c *'] })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'floor' })
    expect(evaluate('bash', ['-c', 'git &\\\n>/dev/null push origin main'], { allow: ['bash -c *'], deny: ['git push *'] }).kind).toBe('deny')
  })

  it('keeps the dash reading, a cut at the &', () => {
    expect(shellStatementList('rm &\\\n>/dev/null -rf x').statements).toEqual(['rm', '\\\n>/dev/null -rf x', 'rm  \\\n>/dev/null -rf x'])
  })

  const heredocs = ["cat <\\\n<'EOF'\n'\nEOF\npython3 x.py\n'", "cat << \\\n 'EOF'\n'\nEOF\npython3 x.py\n'", "cat <<\\\n-EOF\n'\n\tEOF\npython3 x.py\n'", 'cat <<E\\\nOF\n$(python3 x.py)\nEOF']
  it.each(shells.flatMap(shell => heredocs.map(text => [shell, text])))('%s -c %j asks at the interpreter floor and meets a python3 deny', (shell, text) => {
    const allow = [`${shell} -c *`]
    const ask = evaluate(shell, ['-c', text], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate(shell, ['-c', text], { allow, deny: ['python3 *'] }).kind).toBe('deny')
  })

  // A continuation in the delimiter word quotes nothing (fix brief 9, A7), so under `<<E\<newline>OF` a body line ending in
  // a backslash-newline joins the next line, the `EOF` line is swallowed, and the find line stays heredoc text, whose
  // single-quoted substitution runs (bash 5.2.21 and dash printed `x EOF`, then the find line with the substitution run).
  it.each(shells)('%s -c reads a body line continued over the EOF line under a continued delimiter as unquoted heredoc text', (shell) => {
    const text = "cat <<E\\\nOF\nx \\\nEOF\nfind . -maxdepth 0 -exec true '$(python3 x.py)' \\;\nEOF"
    const allow = [`${shell} -c *`]
    const ask = evaluate(shell, ['-c', text], { allow })
    expect(ask.kind).toBe('ask')
    if (ask.kind === 'ask') expect(ask.asks[0]).toMatchObject({ rule: 'destructive_command', cause: 'interpreter' })
    expect(evaluate(shell, ['-c', text], { allow, deny: ['python3 *'] }).kind).toBe('deny')
  })

  it('reads the heredoc whole: its delimiter line ends the body, and the command after it is a statement', () => {
    expect(shellStatementList("cat <\\\n<'EOF'\n'\nEOF\npython3 x.py").statements).toContain('python3 x.py')
    expect(shellStatementList('cat <<E\\\nOF\nbody\nEOF\npython3 x.py').statements).not.toContain('EOF')
  })

  it('reads a continued here-string as one, so a shell it feeds reads its script as data', () => {
    expect(commandFormsOf({ command: 'bash', args: ['-c', "bash <<<'echo hi'"] }).scriptData).toBe(true)
    expect(commandFormsOf({ command: 'bash', args: ['-c', "bash <\\\n<\\\n<'echo hi'"] }).scriptData).toBe(true)
  })
})

describe("zsh's =name expansion of a command word (fix brief 9, A5)", () => {
  // zsh's EQUALS option, on by default, expands a word that starts with an unquoted `=` to the full path of the named
  // command (zshexpn, Filename Expansion; zsh 5.9 ran `=git push --force origin main` as git), so the word is a command
  // word an expansion supplies: unread, refused under a deny list and asked at the floor with none.
  const expansion = READ_LIMITS.expansion
  const texts: Array<[string, string, string]> = [
    ['zsh', '=rm -rf x', 'rm -rf *'],
    ['zsh', 'nice =rm -rf x', 'rm -rf *'],
    ['zsh', 'timeout 5 =rm -rf x', 'rm -rf *'],
    ['zsh', 'env =rm -rf x', 'rm -rf *'],
    ['zsh', 'sudo =rm -rf x', 'rm -rf *'],
    ['zsh', 'xargs =rm -rf x', 'rm -rf *'],
    ['zsh', 'FOO=1 =rm -rf x', 'rm -rf *'],
    ['zsh', '=git push --force origin main', 'git push *'],
    ['bash', "zsh -c '=git push --force origin main'", 'git push *'],
    ['bash', "zsh -c '=rm -rf x'", 'rm -rf *'],
    ['bash', "zsh <<'EOF'\n=git push --force origin main\nEOF", 'git push *'],
  ]

  it.each(texts)('%s -c %j is refused under a deny list naming the limit', (shell, text, deny) => {
    expect(commandFormsOf({ command: shell, args: ['-c', text] }).unread).toBe('expansion')
    const outcome = evaluate(shell, ['-c', text], { allow: [`${shell} -c *`], deny: [deny] })
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain(expansion)
  })

  it.each(texts.filter(([, text]) => !text.includes('sudo')))('%s -c %j asks at the floor with no deny list', (shell, text) => {
    const outcome = evaluate(shell, ['-c', text], { allow: [`${shell} -c *`] })
    expect(outcome.kind).toBe('ask')
    if (outcome.kind === 'ask') expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${expansion}; asked rather than guessed at`]])
  })

  it('leaves assignments, an option value, a quoted or escaped =, and a lone = as written', () => {
    const allow = { allow: ['zsh -c *'], deny: ['rm -rf *'] }
    for (const text of ['FOO=1 echo x', 'echo --opt=value', 'git commit -m=x', "'=rm' -rf x", '"=rm" -rf x', '\\=rm -rf x', 'echo = x', 'echo a=b']) {
      expect(commandFormsOf({ command: 'zsh', args: ['-c', text] }).unread).toBeNull()
      expect(evaluate('zsh', ['-c', text], allow).kind).toBe('allow')
    }
  })
})

describe('a zsh glob qualifier that may run shell code (fix brief 9, A6)', () => {
  // zsh reads a word's trailing parenthesised list as glob qualifiers (BARE_GLOB_QUAL, on by default), and its e
  // qualifier and +name run shell code once for each file the pattern matches (zshexpn, Glob Qualifiers). The splitter
  // does not know which shell reads the text, so a ( glued to the word before it whose body holds an e or a + leaves
  // the call unread: refused under a deny list and asked at the floor with none.
  const qualifier = READ_LIMITS.qualifier
  const marker = "'git push --force origin main'"
  const texts: Array<[string, string]> = [
    ['zsh', `echo *(e:${marker}:)`],
    ['zsh', `echo ?(e:${marker}:)`],
    ['zsh', `echo @(e:${marker}:)`],
    ['zsh', `echo +(e:${marker}:)`],
    ['zsh', `echo *.txt(e:${marker}:)`],
    ['zsh', `echo a(e:${marker}:)`],
    ['zsh', `echo *(.e:${marker}:)`],
    ['zsh', `echo **/*(e:${marker}:)`],
    ['zsh', `echo *(e[${marker}])`],
    ['zsh', `echo *(e{${marker}})`],
    ['zsh', 'echo *(e:git\\ push\\ --force\\ origin\\ main:)'],
    ['zsh', 'echo *(+marker)'],
    ['bash', `zsh -c "echo *(e:${marker}:)"`],
  ]

  it.each(texts)('%s -c %j is refused under a deny list naming the limit', (shell, text) => {
    expect(commandFormsOf({ command: shell, args: ['-c', text] }).unread).toBe('qualifier')
    const outcome = evaluate(shell, ['-c', text], { allow: [`${shell} -c *`], deny: ['git push *'] })
    expect(outcome.kind).toBe('deny')
    expect(reasonOf(outcome)).toContain(qualifier)
  })

  it.each(texts)('%s -c %j asks at the floor with no deny list', (shell, text) => {
    const outcome = evaluate(shell, ['-c', text], { allow: [`${shell} -c *`] })
    expect(outcome.kind).toBe('ask')
    if (outcome.kind === 'ask') expect(outcome.asks.map(ask => [ask.rule, ask.reason])).toEqual([['destructive_command', `${qualifier}; asked rather than guessed at`]])
  })

  it('asks about a floor command inside a qualifier, directly and nested', () => {
    for (const [shell, text] of [['zsh', "echo *(e:'sudo ls':)"], ['bash', `zsh -c "echo *(e:'sudo ls':)"`]] as const) {
      expect(evaluate(shell, ['-c', text], { allow: [`${shell} -c *`] }).kind).toBe('ask')
    }
  })

  it('reads a glob with no code qualifier, an extended glob, a subshell after a blank, a substitution, and arithmetic as before', () => {
    const rows: Array<[string, string]> = [
      ['zsh', 'echo *.log'],
      ['zsh', 'echo *(N)'],
      ['zsh', 'echo *(om[1])'],
      ['bash', 'echo @(a|b)'],
      ['bash', 'echo x; (cd sub && make)'],
      ['bash', 'echo $(ls)'],
      ['bash', '(( x = 1 + 2 ))'],
      ['bash', 'echo $(( 1 + 2 ))'],
      ['bash', "cat > x.js <<'EOF'\nfunction handle(e) { return e + 1 }\nEOF"],
    ]
    for (const [shell, text] of rows) {
      expect(commandFormsOf({ command: shell, args: ['-c', text] }).unread, text).toBeNull()
      const outcome = evaluate(shell, ['-c', text], { allow: [`${shell} -c *`], deny: ['git push *'] })
      expect(outcome.kind, `${text}: ${reasonOf(outcome)}`).toBe('allow')
    }
  })
})

describe('what no pattern can change', () => {
  it('never lets a tool administer the node that runs it', () => {
    expect(reasonOf(evaluate('buckle', ['approve', 'abc'], { allow: ['*'] }))).toContain('cannot administer')
    expect(evaluate('bash', ['-c', 'cd /x && buckle grants revoke 1']).kind).toBe('deny')
  })

  it('refuses the pending queue too, which is where a tool would read the token to approve itself', () => {
    expect(reasonOf(evaluate('buckle', ['approvals'], { allow: ['*'] }))).toContain('cannot administer')
    expect(evaluate('bash', ['-c', 'buckle approvals --json'], { allow: ['bash -c *'] }).kind).toBe('deny')
  })

  it('refuses check-url, which would hand a tool a probe of the network policy', () => {
    expect(reasonOf(evaluate('buckle', ['check-url', 'example.com'], { allow: ['*'] }))).toContain('cannot administer')
    expect(evaluate('bash', ['-c', 'buckle check-url 10.0.0.1'], { allow: ['bash -c *'] }).kind).toBe('deny')
  })

  // The workspace-model brief, item 5: keys enrolls who signs, client holds a person's key, service starts the node.
  it.each(['workspaces', 'workspace', 'history', 'settings', 'init', 'keys', 'client', 'service'])('rejects %s administration directly and through a wrapper', command => {
    expect(evaluate('buckle', [command, 'list'], { allow: ['*'] }).kind).toBe('deny')
    expect(evaluate('bash', ['-c', `buckle ${command} list`], { allow: ['bash -c *'] }).kind).toBe('deny')
  })

  it('refuses a settings write, which would turn a pack or the shell on for the next start', () => {
    expect(reasonOf(evaluate('buckle', ['settings', 'set', 'host-git', 'on'], { allow: ['*'] }))).toContain('cannot administer')
    expect(evaluate('bash', ['-c', 'buckle settings set shell on'], { allow: ['bash -c *'] }).kind).toBe('deny')
    expect(evaluate('node', ['./node_modules/.bin/buckle', 'settings', 'show'], { allow: ['*'] }).kind).toBe('deny')
  })

  it.each([
    ['buckle', ['approve', 'abc']],
    ['/usr/local/bin/buckle', ['approve', 'abc']],
    ['./node_modules/.bin/buckle', ['approve', 'abc']],
    ['node', ['./node_modules/.bin/buckle', 'approve', 'abc']],
    ['bash', ['-c', '/usr/local/bin/buckle approve abc']],
    ['bash', ['-c', '"./node_modules/.bin/buckle" approve abc']],
    // Finding 35 of the workspace-model Phase 1 review: an option word before the subcommand, and the installed entry point.
    ['buckle', ['--skip-owner-only-check', 'keys', 'enroll', 'ed25519:AAAA', '--purpose', 'approval', '--workspace', 'node']],
    ['buckle', ['--skip-owner-only-check', 'policy', 'dangerously-allow', 'on']],
    ['bash', ['-c', 'buckle --skip-owner-only-check keys enroll ed25519:AAAA --purpose approval --workspace node']],
    ['node', ['/usr/lib/node_modules/@5straps/buckle/dist/main.js', 'keys', 'enroll', 'ed25519:AAAA']],
    ['node', ['./node_modules/@5straps/buckle/dist/main.js', '--skip-owner-only-check', 'policy', 'dangerously-allow', 'on']],
    // Recheck of the workspace-model fix round 1 (finding 35 left): bash strips the quotes round an option word, so the quoted spelling runs the same command.
    ['bash', ['-c', 'buckle "--skip-owner-only-check" keys enroll ed25519:AAAA --purpose approval --workspace node']],
    ['bash', ['-c', `buckle '--skip-owner-only-check' keys enroll ed25519:AAAA --purpose approval --workspace node`]],
    ['bash', ['-c', `buckle "--skip-owner-only-check" '--other' "--more" policy dangerously-allow on`]],
  ] as Array<[string, string[]]>)('refuses %s %j, whatever path names the binary', (command, args) => {
    expect(reasonOf(evaluate(command, args, { allow: ['*', 'bash -c *'] }))).toContain('cannot administer')
  })

  // Fix brief 4, finding 11: an option word may hold a `/`, so each `-x/buckle` word starts the name again, and the
  // pattern that tried each start over the rest of the line took seconds on 100 KB, holding the node's one thread.
  // About 100 KB, the most one shell_exec argument holds.
  const optionRun = `buckle${' -x/buckle'.repeat(9_999)}`
  it.each([
    ['a shell_exec argument', () => evaluate('echo', [optionRun], { allow: ['*'] }), 'allow'],
    ['a script_run body', () => evaluate('bash', ['-c', optionRun], { allow: ['bash -c *'] }), 'allow'],
    ['a script_run body ending in a subcommand', () => evaluate('bash', ['-c', `${optionRun} policy`], { allow: ['bash -c *'] }), 'deny'],
  ] as const)('reads %s of 9,999 option words naming the binary in well under a second', (_form, run, kind) => {
    const { milliseconds, result } = leastProcessorTime(run)
    expect(milliseconds).toBeLessThan(250)
    expect(result.kind).toBe(kind)
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  // Fix brief 6, item 8: the service manager reaches the unit or task that runs Buckle at login, past its approvals.
  it.each([
    ['systemctl', ['--user', 'stop', 'buckle.service']],
    ['systemctl', ['--user', 'restart', 'buckle']],
    ['/usr/bin/systemctl', ['--user', 'edit', 'buckle.service']],
    ['systemctl', ['--user', 'disable', '--now', "'buckle.service'"]],
    ['systemctl', ['--user', 'daemon-reload']],
    ['bash', ['-c', 'cd /tmp && systemctl --user kill buckle.service']],
    ['bash', ['-c', 'echo done\nsystemctl --user daemon-reload']],
    ['loginctl', ['--user', 'buckle.service']],
    ['schtasks.exe', ['/End', '/TN', '\\5straps\\Buckle']],
    ['C:\\Windows\\System32\\SCHTASKS.EXE', ['/Change', '/TN', '\\5straps\\Buckle', '/DISABLE']],
    ['schtasks', ['/Delete', '/TN', '5straps/Buckle', '/F']],
  ] as Array<[string, string[]]>)('refuses %s %j, which reaches Buckle\'s own unit or task', (command, args) => {
    expect(reasonOf(evaluate(command, args, { allow: ['*', 'bash -c *'] }))).toBe('A tool cannot administer the Buckle that runs it')
  })

  it.each([
    ['systemctl', ['--user', 'status', 'nginx.service']],
    ['systemctl', ['daemon-reload']],
    ['systemctl', ['--user', 'restart', 'buckle-docs.service']],
    ['bash', ['-c', 'systemctl --user list-units | grep buckle']],
    ['schtasks.exe', ['/Query', '/TN', '\\5straps\\Buckle-docs']],
    ['echo', ['buckle.service']],
    ['loginctl', ['show-user', 'owner']],
  ] as Array<[string, string[]]>)('leaves %s %j alone, which names no unit or task of Buckle\'s', (command, args) => {
    expect(evaluate(command, args, { allow: ['*', 'bash -c *'] }).kind).not.toBe('deny')
  })

  it('reads a long service manager line in well under a second', () => {
    const { milliseconds, result } = leastProcessorTime(() => evaluate('bash', ['-c', `systemctl${' --user'.repeat(15_000)} buckle`], { allow: ['bash -c *'] }))
    expect(milliseconds).toBeLessThan(250)
    expect(result.kind).toBe('deny')
  }, PROCESSOR_TIME_ROW_TIMEOUT)

  it('still lets a tool drive the node the ordinary way', () => {
    expect(evaluate('buckle', ['fs', 'read', 'a.ts']).kind).toBe('allow')
    expect(evaluate('/usr/local/bin/buckle', ['fs', 'read', 'a.ts']).kind).toBe('allow')
    expect(evaluate('/opt/notbuckle', ['approve', 'abc']).kind).toBe('allow')
    expect(evaluate('pnpm', ['--filter', '@5straps/buckle', 'mcp-probe']).kind).toBe('allow')
    expect(evaluate('cat', ['/srv/buckle', 'policy.json']).kind).toBe('allow')
    expect(evaluate('buckle', ['--version']).kind).toBe('allow')
    // The interpreter rule asks about any `node <file>` under an empty policy; the point is that the entry point is not refused as administration.
    expect(evaluate('node', ['./node_modules/@5straps/buckle/dist/main.js', 'fs', 'read', 'a.ts']).kind).not.toBe('deny')
  })

  it('keeps the destructive gate under an allow pattern, so rm -rf still asks', () => {
    const outcome = evaluate('rm', ['-rf', 'build'], { allow: ['rm -rf build'] })
    expect(outcome.kind).toBe('ask')
    if (outcome.kind !== 'ask') return
    expect(outcome.asks[0]?.rule).toBe('destructive_command')
  })
})

// D74 (owner, 2026-10-11, "Bare words only"): command rules compared the basename, so `./git status` and
// `/usr/bin/git status` were admitted by an allow rule for `git status`, running whatever program sat at that path
// under the owner's rule for git. An allow glob now meets a command word written as a path only where it spells a path.
describe('a command word written as a path (D74, bare words only)', () => {
  const PATH_CAUSE = /a command written as a path/i
  const askOf = (outcome: ReturnType<typeof evaluate>) => (outcome.kind === 'ask' ? outcome.asks : [])

  it.each<[string, string[]]>([['./git', ['status']], ['/usr/bin/git', ['status']], ['bin/git', ['status']]])('asks for %s %j under allow git status, at the floor, the whole call shown', (command, args) => {
    const outcome = evaluate(command, args, { allow: ['git status'] })
    expect(outcome.kind).toBe('ask')
    expect(askOf(outcome)).toEqual([expect.objectContaining({ rule: 'destructive_command', cause: 'floor', subject: expect.stringContaining(command), reason: expect.stringMatching(PATH_CAUSE) })])
  })

  it('runs git status, the bare word the rule names', () => {
    expect(evaluate('git', ['status'], { allow: ['git status'] }).kind).toBe('allow')
  })

  it('runs the spelling an allow rule spells, and only that one', () => {
    expect(evaluate('/usr/bin/git', ['status'], { allow: ['/usr/bin/git status'] }).kind).toBe('allow')
    expect(evaluate('./git', ['status'], { allow: ['/usr/bin/git status'] }).kind).toBe('deny')
    expect(evaluate('./git', ['status'], { allow: ['*/git status'] }).kind).toBe('allow')
  })

  it('refuses a path spelling a deny glob meets by its basename or as written', () => {
    expect(evaluate('/usr/bin/git', ['push', '--force'], { deny: ['git push *'] }).kind).toBe('deny')
    expect(evaluate('/usr/bin/git', ['push', '--force'], { allow: ['git *'], deny: ['git push *'] }).kind).toBe('deny')
    expect(evaluate('/usr/bin/curl', ['https://x.test'], { deny: ['/usr/bin/curl *'] }).kind).toBe('deny')
    expect(evaluate('bash', ['-c', '/usr/bin/curl https://x.test'], { allow: ['bash -c *'], deny: ['/usr/bin/curl *'] }).kind).toBe('deny')
  })

  it('asks for a path spelling the workspace\'s destructive list spells', () => {
    expect(evaluate('/opt/tf/terraform', ['destroy'], { destructive: ['/opt/tf/terraform destroy *'] }).kind).toBe('ask')
  })

  it('reads bash -c \'./git status\' as the direct call: it asks with the same cause, and bash -c \'git status\' runs', () => {
    const allow = ['git status', 'bash -c *']
    const direct = askOf(evaluate('./git', ['status'], { allow }))
    const wrapped = askOf(evaluate('bash', ['-c', './git status'], { allow }))
    expect(wrapped.map(ask => ask.reason)).toEqual(direct.map(ask => ask.reason))
    expect(wrapped).toEqual([expect.objectContaining({ cause: 'floor', reason: expect.stringMatching(PATH_CAUSE) })])
    expect(evaluate('bash', ['-c', 'git status'], { allow }).kind).toBe('allow')
  })

  // A command a substitution cuts is read whole as its head shows it (fix brief 7, A3b), so the path ask reads it too.
  it.each<[string]>([['./git>$(echo)x status'], ['./git >`true` status'], ['./git $(echo) status']])('reads bash -c %j, a command a substitution cuts, as the direct call: it asks with the path reason', body => {
    const allow = ['git status', 'bash -c *']
    expect(askOf(evaluate('bash', ['-c', body], { allow }))).toEqual([expect.objectContaining({ cause: 'floor', reason: expect.stringMatching(PATH_CAUSE) })])
    expect(evaluate('bash', ['-c', body.replace('./git', 'git')], { allow }).kind).toBe('allow')
  })

  it('leaves a path spelling alone where no allow rule names the command, and a host path Buckle supplies itself', () => {
    expect(evaluate('./gradlew', ['build']).kind).toBe('allow')
    expect(evaluate('/opt/tools/agent-browser', ['open', 'https://x.test'], { allow: ['agent-browser *'] }, 'agent-browser').kind).toBe('allow')
  })

  it('admits every path spelling under */* *, as docs/policy-02.md says, and still asks at the floor where the call asks', () => {
    for (const command of ['./gradlew', '/usr/bin/git', 'node_modules/.bin/vitest']) expect(evaluate(command, ['run'], { allow: ['*/* *'] }).kind, command).toBe('allow')
    expect(evaluate('/bin/rm', ['-rf', 'build'], { allow: ['*/* *'] }).kind).toBe('ask')
  })

  it('names, for a shell wrapper written as a path, the allow rule that spells it', () => {
    expect(reasonOf(evaluate('/bin/sh', ['-c', 'pnpm build']))).toContain("allow-command '/bin/sh -c *'")
    expect(evaluate('/bin/sh', ['-c', 'pnpm build'], { allow: ['/bin/sh -c *'] }).kind).toBe('allow')
  })

  // A brace in the command word made the whole glob a path glob, so its bare alternative admitted every path spelling
  // of the command with no ask (review 1 of the git pack, held[3]). Each alternative now counts on its own.
  it.each([['{git,/usr/bin/git} status'], ['{/usr/bin/git,git} status'], ['{*git,/usr/bin/git} status']])('reads each alternative of the command word on its own under %s: the bare word and the spelled path run, any other spelling asks', glob => {
    for (const allow of [[glob], ['ls', glob]]) {
      expect(evaluate('git', ['status'], { allow }).kind).toBe('allow')
      expect(evaluate('/usr/bin/git', ['status'], { allow }).kind).toBe('allow')
      for (const command of ['./x/git', '/tmp/evil/git']) {
        expect(askOf(evaluate(command, ['status'], { allow })), `${command} under ${allow.join(', ')}`).toEqual([expect.objectContaining({ rule: 'destructive_command', cause: 'floor', reason: expect.stringMatching(PATH_CAUSE) })])
      }
    }
  })

  it('reads the alternatives of the command word the same way in a shell body', () => {
    const allow = ['bash -c *', '{git,/usr/bin/git} status']
    expect(evaluate('bash', ['-c', 'git status'], { allow }).kind).toBe('allow')
    expect(evaluate('bash', ['-c', '/usr/bin/git status'], { allow }).kind).toBe('allow')
    for (const body of ['./x/git status', '/tmp/evil/git status']) {
      expect(askOf(evaluate('bash', ['-c', body], { allow })), body).toEqual([expect.objectContaining({ rule: 'destructive_command', cause: 'floor', reason: expect.stringMatching(PATH_CAUSE) })])
    }
  })

  // `*` crosses `/`, so a path glob with a wildcard met a `..` spelling that climbs out of the folder it names, and ran
  // the agent's program there with no ask (review 1 of the git pack, held[4]). It now meets only a plain spelling.
  it.each<[string, string[], string[]]>([
    ['/usr/bin/../../w/bin/git', ['status'], ['/usr/bin/* *']],
    ['/opt/tools/../../w/bin/x', [], ['/opt/tools/* *']],
  ])('refuses %s %j under allow %j, a path glob meeting only a command word written plainly', (command, args, allow) => {
    expect(evaluate(command, args, { allow }).kind).toBe('deny')
  })

  it.each<[string, string[], string[]]>([
    ['/usr/bin/../../w/bin/git', ['status'], ['git *', '/usr/bin/* *']],
    ['/usr//bin/git', ['status'], ['git status', '/usr/* *']],
    ['./../w/git', ['status'], ['git status', './* *']],
    ['bash', ['-c', '/usr/bin/../../w/bin/git status'], ['bash -c *', 'git *', '/usr/bin/* *']],
  ])('asks for %s %j under allow %j at the floor, a .. or a doubled slash meeting no path glob', (command, args, allow) => {
    expect(askOf(evaluate(command, args, { allow }))).toEqual([expect.objectContaining({ rule: 'destructive_command', cause: 'floor', reason: expect.stringMatching(PATH_CAUSE) })])
  })

  it('still runs a plain spelling a path glob with a wildcard covers', () => {
    expect(evaluate('/usr/bin/git', ['status'], { allow: ['/usr/bin/* *'] }).kind).toBe('allow')
    expect(evaluate('/usr/bin/git', ['status'], { allow: ['git *', '/usr/bin/* *'] }).kind).toBe('allow')
    expect(evaluate('./git', ['status'], { allow: ['./* *'] }).kind).toBe('allow')
    expect(evaluate('/opt/tools/lint', ['a'], { allow: ['/opt/tools/* *'] }).kind).toBe('allow')
    expect(evaluate('node_modules/.bin/vitest', ['run'], { allow: ['*/* *'] }).kind).toBe('allow')
  })

  // A pattern cannot hold `\`, so on Windows a command written with backslashes could never be admitted, and a shell
  // wrapper's refusal suggested `C:*Git*bin*bash -c *`, a rule that admits nothing (review 1 of the git pack, held[5]
  // and held[12]). On Windows only, a path glob now reads the command word's `\` as `/`.
  describe('on Windows, where a backslash is a separator', () => {
    const onWindows = (command: string, args: string[], commands: { allow?: string[] }) => evaluate(command, args, commands, undefined, 'win32')

    it.each<[string, string[], string]>([
      ['C:\\Tools\\git', ['status'], 'C:/Tools/git status'],
      ['C:\\Tools\\git', ['status'], '*/* *'],
      ['.\\gradlew', ['run'], '*/* *'],
    ])('admits %s %j by allow %s, which spells it with /', (command, args, glob) => {
      expect(onWindows(command, args, { allow: [glob] }).kind).toBe('allow')
    })

    it('asks for C:\\Tools\\git status under the bare word, and for a .. spelling of it beside a path glob', () => {
      const pathAsk = [expect.objectContaining({ rule: 'destructive_command', cause: 'floor', reason: expect.stringMatching(PATH_CAUSE) })]
      expect(askOf(onWindows('C:\\Tools\\git', ['status'], { allow: ['git status'] }))).toEqual(pathAsk)
      expect(askOf(onWindows('C:\\Tools\\..\\w\\git', ['status'], { allow: ['git status', 'C:/Tools/* *'] }))).toEqual(pathAsk)
    })

    it('names, for a shell wrapper written with backslashes, the rule with / that admits it', () => {
      expect(reasonOf(onWindows('C:\\Git\\bin\\bash', ['-c', 'ls'], { allow: ['git status'] }))).toContain("allow-command 'C:/Git/bin/bash -c *'")
      expect(onWindows('C:\\Git\\bin\\bash', ['-c', 'ls'], { allow: ['git status', 'C:/Git/bin/bash -c *'] }).kind).toBe('allow')
    })
  })

  it('reads a backslash as part of a name on Linux: a glob spelling / admits no command written with \\', () => {
    for (const [command, glob] of [['C:\\Tools\\git', 'C:/Tools/git status'], ['\\x\\git', '/x/git status'], ['.\\gradlew', '*/* *']] as const) {
      expect(evaluate(command, ['status'], { allow: [glob] }, undefined, 'linux').kind, command).toBe('deny')
    }
  })

  // Pins the review's mutations showed missing (review 1 of the git pack, held[6], held[7], and held[8]).
  describe('pins', () => {
    const pathAsk = [expect.objectContaining({ rule: 'destructive_command', cause: 'floor', reason: expect.stringMatching(PATH_CAUSE) })]

    // `\` counts as a separator on every platform, so a command written with one is a path spelling everywhere.
    it.each<[string, string[]]>([['.\\git', ['status']], ['C:\\Tools\\git', ['status']], ['tools\\git', ['status']]])('asks for %s %j under allow git status, a backslash counting as a separator on every platform', (command, args) => {
      expect(askOf(evaluate(command, args, { allow: ['git status'] }))).toEqual(pathAsk)
    })

    it('asks for a backslash spelling in a shell body too, and refuses one a deny glob meets by its basename', () => {
      expect(askOf(evaluate('bash', ['-c', "'.\\git' status"], { allow: ['git status', 'bash -c *'] }))).toEqual(pathAsk)
      for (const command of ['.\\git', 'C:\\Tools\\git']) expect(evaluate(command, ['push', '--force'], { allow: ['git *'], deny: ['git push *'] }).kind, command).toBe('deny')
    })

    it('runs the spelling an allow glob spells beside a bare glob for the same command, and asks for one only the bare glob admits', () => {
      const allow = ['git *', '/usr/bin/git status']
      expect(evaluate('/usr/bin/git', ['status'], { allow }).kind).toBe('allow')
      expect(askOf(evaluate('/usr/bin/git', ['push'], { allow }))).toEqual(pathAsk)
      expect(evaluate('git', ['status'], { allow }).kind).toBe('allow')
      expect(evaluate('bash', ['-c', '/usr/bin/git status'], { allow: [...allow, 'bash -c *'] }).kind).toBe('allow')
    })

    // A wrapper's NAME=value operand is a program path (`nice FOO=./git status` runs a file in a folder named FOO=.).
    it.each<[string, string[], string[]]>([
      ['nice', ['FOO=./git', 'status'], ['nice *', 'git status']],
      ['bash', ['-c', 'exec FOO=./git status'], ['bash -c *', 'git status']],
      ['timeout', ['5', 'FOO=/usr/bin/git', 'status'], ['timeout *', 'git status']],
    ])('asks for %s %j under allow %j, a wrapper running a NAME=value word written as a path', (command, args, allow) => {
      expect(askOf(evaluate(command, args, { allow }))).toEqual(pathAsk)
    })

    it('admits a wrapper\'s NAME=value operand an allow glob spells', () => {
      expect(evaluate('nice', ['FOO=./git', 'status'], { allow: ['nice *', 'FOO=./git status'] }).kind).toBe('allow')
    })
  })

  it('admits each path a brace in the command word spells, and no other spelling', () => {
    const allow = ['/usr/{bin,local/bin}/git status']
    expect(evaluate('/usr/local/bin/git', ['status'], { allow }).kind).toBe('allow')
    expect(evaluate('/usr/bin/git', ['status'], { allow }).kind).toBe('allow')
    expect(evaluate('./x/git', ['status'], { allow }).kind).toBe('deny')
  })
})
