# Policy

The policy is the owner's standing answer about what an agent may run and reach through Buckle,
the approval and sandbox runtime on this machine. What it refuses is refused without a question,
and no tool can read or change it.

## Where it comes from

Two sources, unioned: every allow and deny from either, and the last mount named. Deny wins.

- The environment: `BUCKLE_COMMAND_ALLOW`, `BUCKLE_COMMAND_DENY`, and
  `BUCKLE_COMMAND_DESTRUCTIVE`, with patterns one per line or separated by `;;`; the approved list
  `BUCKLE_NETWORK_ALLOW`, comma separated; and `BUCKLE_WORKSPACE_MOUNT`.
- The stored policy: `policy.json` in the state directory, keyed by workspace root, which
  `buckle policy` writes.

## Commands

```bash
buckle policy allow-command 'pnpm {build,test} *'
buckle policy deny-command '{curl,wget}'
buckle policy destructive-command 'terraform destroy *'
```

A pattern is a glob read one shell word at a time, never a regular expression. `*` inside a word
matches any characters, and a `*` word matches one word, or the rest of the line when it comes
last. `**` matches any run of words, and `{a,b}` one alternative. Buckle refuses the characters
`^ $ ( ) | \ + ? [ ]` in a pattern.

- An allow list, once it has an entry, admits only command lines a glob covers whole. It judges
  the call as typed, so a prefix such as `env` never carries another command past it.
- A deny glob refuses every command line that starts with it, wherever Buckle finds that line.
- A destructive glob adds to the [destructive floor](approvals.md#the-destructive-floor), which
  asks, once or for the session.

A shell wrapper, `bash -c` or the same with `sh`, `zsh`, `dash`, `ksh`, or `fish`, hides its
command from word globs, so it needs an allow rule of its own, such as
`buckle policy allow-command 'bash -c *'`, even with no allow list. `script_run` with the `bash`
runtime is one ([Troubleshooting](troubleshooting.md#a-bash-script-is-refused)).

Whatever the patterns say, a tool cannot run Buckle's admin commands, such as `buckle approve`,
`buckle policy`, or `buckle settings`.

### What Buckle reads

The deny list and the destructive floor judge every command a call runs: the call as typed; the
command behind a prefix such as `env`, `nice`, `timeout`, `flock`, or `xargs`, or behind leading
`NAME=value` assignments; each statement of a shell body; `eval` text; each `find -exec`,
`-execdir`, `-ok`, and `-okdir` command; and heredoc bodies. Another program that runs a
command, such as `watch`, `ssh`, or `su -c`, is judged by its own words only.

### Reading limits

One reading of a call stops at the first of these:

- `READ_BUDGET`: 8,000,000 characters, 1,000,000 words, or 100,000 commands across every level.
- `MAX_DEPTH`: wrappers or shell bodies nested 8 levels deep.
- `MAX_SUBSTITUTIONS`: `$(...)` substitutions nested 4 deep in double quotes or heredoc text.
- A `find -exec` command that starts with a dash word, which `find` reads as its own option.

Past a limit, the destructive floor asks, naming the limit. When the policy has a deny list, the
call is refused instead, because the unread part might hold a denied command.

## Network

```bash
buckle policy allow-url localhost:3000
buckle policy allow-url https://app.example.com/admin
```

An entry is a host (`example.com`), a host and port (`example.com:8443`), a pattern
(`*.example.com` covers the apex and every subdomain), or an http or https URL prefix. A
wildcard anywhere but the whole leftmost label is refused.

With a list, `web_fetch`, browser navigation, and forge pushes reach only what it names; a listed
private address needs no approval, and everything else is refused. Without a list, public hosts
are reachable, and loopback, private, and other reserved addresses ask, per host and port.
`web_fetch` checks every resolved address and every redirect hop, up to five.

`BUCKLE_ALLOWED_HOSTS` lists hosts `web_fetch` may reach even when they resolve to a private
address. There is no public-suffix list, so `*.com` would cover every `.com` name. An empty
approved list is no list: `buckle policy remove` warns when it takes out the last entry.

`buckle check-url <url|host>` shows what an address would meet, without a running node. It exits
0 approved, 1 denied, 3 asks, 4 not listed, and 2 on bad input.

## Tools and files

- `buckle policy deny-tool fs_write` refuses a tool outright; `allow-tool` lifts that. A tool
  in a withheld pack stays withheld.
- `buckle policy mount /workspace` shows the workspace to the agent at that path, and then every
  path outside the workspace and `BUCKLE_SCRATCH_ROOTS` is refused, not asked. A mount under
  `/bin`, `/etc`, `/home`, `/tmp`, `/usr`, or the other system directories is refused.
- Sensitive files ask every time, matched on the exact path, so a granted directory never unlocks
  one: anything under `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.config/gcloud`,
  `.password-store`, browser and mail profiles, or `keychains`; `.env` files except
  `.env.schema`; and names such as `.netrc`, `.npmrc`, `.git-credentials`, `id_rsa`, `*.pem`,
  `*.key`, and `secrets.yaml`.
- Filesystem rules exist only in a policy file loaded with `buckle policy import`:
  `{"version":1,"filesystem":{"rules":[{"path":"secrets","read":"deny","write":"deny"}]}}`. Each
  rule names a workspace-relative path and `allow`, `ask`, or `deny` for `read` and `write`; any
  deny wins, otherwise the longest path decides. Any rule stops plugins loading, and a deny or
  ask rule withholds the `git`, `forge`, and `dev` packs.

## Workspace and node ceiling

`buckle workspace add <id> --root <dir>` registers another workspace, served under
`/workspaces/<id>/v1` and `/workspaces/<id>/mcp` with its own tokens and state, always mounted
at `/workspace`, its writes offering only `once`. The node's environment policy, the
`BUCKLE_COMMAND_*` and `BUCKLE_NETWORK_ALLOW` settings, is a ceiling over it: both command
policies apply, a URL must pass both approved lists, a tool must pass both tool lists, and a
filesystem deny in either wins. What `buckle policy` stores governs the node's own workspace.

## Inspecting and changing it

```bash
buckle policy show          # each entry and its source: env, stored, or env+stored
buckle policy export > policy.json
buckle policy import policy.json
buckle policy remove 'pnpm {build,test} *'
buckle policy clear         # drops the stored part, keeps the environment's
```

`buckle policy` exits 0 when done, 1 on a refused change, and 2 on a conflict: work in progress,
such as a shell copy waiting for review, or an imported file naming the dangerously-allow switch.

Every CLI command reads the policy fresh. `buckle serve` and `buckle mcp` read it when they start,
so restart them after a `buckle policy` or `buckle settings` change. The dangerously-allow switch
is the exception: a running node reads it on every call. If the stored policy stops loading, the
node refuses to start and names the file; `buckle policy show`, `export`, `remove`, and `clear`
still run, to repair it.
