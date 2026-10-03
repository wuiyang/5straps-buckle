# Approvals

Buckle, the approval and sandbox runtime that runs an AI agent's tool calls, judges each call
by its effects: the paths it reads and writes, the commands it runs, and the URLs it reaches,
never the tool's name. A deny on any effect refuses the call, an ask waits for a person, and
otherwise it runs.

## What runs, asks, or is refused

Runs: reads inside the workspace root, writes inside `BUCKLE_SCRATCH_ROOTS`, http and https to
public addresses when no approved list is set, and anything a standing grant covers.

Asks:

| Rule | Asks about | Scopes offered |
|---|---|---|
| `read_scope` | a read outside the workspace, when no mount is set | once, session, always |
| `write_scope` | the first write to a directory | once, session, always; once alone with `BUCKLE_STRICT_WRITES=true` |
| `sensitive_path` | a credential file such as `.env`, `.ssh/`, `*.pem` | once |
| `destructive_command` | a destructive command | once, session |
| `network_egress` | loopback, private, and other reserved addresses, when no approved list is set | once, session, always |
| `process_probe` | listing running processes (`lsp_discover`) | once, session |
| `filesystem_policy` | a path a policy rule marks `ask` | once |

Refused, with the reason: Buckle's own state, a sensitive file you denied for the session or
always, a tool running a Buckle admin command such as `buckle approve`, and whatever the
[policy](policy.md) denies.

## Scopes

- `once` covers this call alone: the same session, tool, and arguments. Retrying the identical
  call spends it; unspent, it lapses ten minutes after the decision.
- `session` lasts until revoked, for the call's session. Every CLI call shares the session
  `cli`; MCP uses the client's session id, or `mcp`; HTTP uses `context.sessionId`, or `rpc`.
- `always` lasts until revoked, for every session in the workspace.

A path grant covers its directory and everything below it. A network grant covers one host and
port; `buckle approve <token> --scope session --host '*.localhost:3000'` widens one to a pattern
that covers the asking host. `buckle grants list` shows grants and remembered denials, and
`buckle grants revoke <id>` removes one.

## The destructive floor

Built in, it asks before `sudo`, `su`, `doas`, `pkexec`, `mkfs`, `fdisk`, `parted`, `wipefs`,
`blkdiscard`, `shred`, and `sgdisk`; `rm -r` or `-f`; `dd of=`; `truncate`; `chmod -R` and
`chown -R`; `find -delete`; `kill`, `pkill`, or `killall` with `-9`; an argument under `/dev/`;
`git push` with force, `--delete`, `--mirror`, or `--prune`; `git reset --hard`; `git clean -f`;
and `git checkout --force`. In a shell body it also catches a pipe into a shell, a fork bomb,
`rm -rf /`, and `chmod 777`. It judges [every command a call runs](policy-02.md#what-buckle-reads),
and asks about an `eval` of text that only exists at run time and a call past the
[reading limits](policy-02.md#reading-limits).

`buckle policy destructive-command '<glob>'` adds to the floor, and nothing removes a built-in.
The floor never offers `always`, and its subject is the exact command with a digest of its
arguments, so approving `rm -rf build` does not approve `rm -rf /`.

## What the approver sees

Every route that decides shows the ask, then the whole action: node, workspace, a summary,
rule, subject, reason, working directory, every effect, and every argument as JSON. Nothing is
cut or paged. Scripts and free text show as written; only credential-named values, and a URL
value's password and token-like query values, read `[redacted]`. Control and invisible
characters show as escapes. Hiding is display only; the decision binds the exact arguments. An
ask whose whole call was not recorded can be denied, never approved.

## Where to answer

| Channel | How |
|---|---|
| The terminal running `buckle serve` | asks in place when stdin and stderr are terminals: `1`, `2`, `3` pick an offered scope, `n` or Enter denies |
| A CLI tool command at a terminal | the same question, before the command returns |
| `buckle approvals --watch` | a second terminal: `o` once, `s` session, the word `always`, `d` deny, `n` skip; `ds` or `da` deny a sensitive file for the session or always |
| `buckle approvals`, then `buckle approve <token>` | shows the whole action and approves only after you type `yes` at a terminal; `--deny` works anywhere |
| MCP elicitation | `buckle mcp` sends a form per ask when the client declares form elicitation; other clients, and `/mcp` over HTTP, get text pointing to `buckle approvals` |

A question ignores keys until the keyboard has been still for half a second. Add
`--workspace <id>` for a [registered workspace](policy.md#workspace-and-node-ceiling).

Nothing the agent token reaches can decide. With the experimental
`BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true`, `POST /setup/approvals` takes a denial under the admin
credential, and an approval only when a device key enrolled with `buckle keys enroll` signed it,
as `buckle client approve <node-url> <token>` does.

`BUCKLE_APPROVAL_WEBHOOK` names a URL that Buckle posts each new ask to. It announces and never
decides; [Rings](rings.md#approval-webhook) describes what it sends.

## Timeouts

`buckle serve` and `buckle mcp` hold a gated call for `BUCKLE_APPROVAL_TIMEOUT_MS`, 15000 by
default, and an answer inside that window lets it run. `0` holds until someone answers. When a
hold ends unanswered, the call returns `approval_required`, its asks stay answerable ten more
minutes, and the agent retries the same call once answered. An HTTP caller's `context.approvalWait` overrides the node:
`{"mode":"none"}` returns at once, `{"mode":"finite","ms":60000}` holds a minute. A one-shot CLI
command waits only while its own terminal question is open. Change the node's wait with
`buckle settings set approval-wait 60000`, then restart.

## Persisted grants and the admin credential

Only the owner's authority records a `session` or `always` grant. Every local route above carries
it, `buckle mcp` elicitation included; over HTTP only the admin face does.

## Dangerously allow

```bash
buckle policy dangerously-allow on [--workspace <id>]
buckle policy dangerously-allow off
```

Warning: this removes the person. While it is on, every ask about a path inside the workspace
root, and every command, host, and process ask, is allowed without anyone being asked, sensitive
files, writes, and destructive commands included. Paths outside the root keep their normal
outcome, and deny rules, the node's policy over a registered workspace, the mount, and the state
directory still refuse.

Only the local CLI sets it; `buckle policy import` refuses a file that names it. A running node
reads it on every call, so `off` applies at once. Each use is logged as
`policy_dangerously_allowed`. `buckle policy clear` leaves it on, and a registered workspace's
switch works only while the node's is on too. `buckle --help` and `buckle policy --help` both
list it.
