# Approvals

Buckle, the local permission node that runs an AI agent's tool calls, judges each call by its
effects: paths read and written, commands run, and URLs reached, never the tool's name. A deny
on any effect refuses the call, an ask waits for a person, and otherwise it runs.

## What runs, asks, or is refused

Runs: reads inside the workspace, writes inside `BUCKLE_SCRATCH_ROOTS`, http(s) to
public addresses when no approved list is set, and anything a standing grant covers.

Asks:

| Rule | Asks about | Scopes offered |
|---|---|---|
| `read_scope` | a read outside the workspace, when no mount is set | once, session, always |
| `write_scope` | the first write to a directory | once, session, always; once alone with `BUCKLE_STRICT_WRITES=true` |
| `sensitive_path` | a credential file such as `.env`, `.ssh/`, `*.pem` | once (a [secret reference](secrets.md)'s file: once, session, always) |
| `destructive_command` | a destructive command | once, session |
| `network_egress` | loopback, private, and other reserved addresses, when no approved list is set | once, session, always |
| `process_probe` | listing running processes (`lsp_discover`) | once, session |
| `filesystem_policy` | a path a policy rule marks `ask` | once |

Refused, with the reason: Buckle's own state through the file tools, a sensitive file you denied
for the session or always, a tool running a Buckle admin command such as `buckle approve`, and
whatever the [policy](policy.md) denies.

## Scopes

- `once` covers this call alone: the same caller, session, tool, and arguments. Retrying that
  call spends it; unspent, it lapses ten minutes after the decision.
- `session` lasts for the caller's session, until revoked or [the session
  ends](approvals-07.md): at 15 minutes with no activity, or as its MCP server closes. Every CLI
  call shares `cli`; each `buckle mcp` process has its own; HTTP MCP shares `mcp`; the HTTP API
  uses `context.sessionId`, or `rpc`.
- `always` lasts until revoked, for every caller in the workspace.

Only the owner's authority records a `session` or `always` grant: every local route below,
`buckle mcp` elicitation included, and over HTTP only the admin face.

A path grant covers its directory and all below it. A network grant covers one host and
port; `buckle approve <token> --scope session --host '*.localhost:3000'` widens one to a pattern
covering the asking host, `--below` [a delete](policy-05.md) outside the workspace to its folder
and subfolders. `buckle grants list` shows grants and remembered denials;
`buckle grants revoke <id>` removes one. A grant that cannot be saved still lets the call that
asked run once, and the route warns and offers a retry or a skip
([when a grant cannot be saved](approvals-05.md)).

## The destructive floor

Built in, it asks before `sudo`, `su`, `doas`, `pkexec`, `mkfs`, `fdisk`, `parted`, `wipefs`,
`blkdiscard`, `shred`, and `sgdisk`; `rm -r` or `-f`; `dd of=`; `truncate`; `chmod -R` and
`chown -R`; `find -delete`; `kill`, `pkill`, or `killall` with `-9`; an argument under `/dev/`;
`git push` with force, `--delete`, `--mirror`, or `--prune`; `git reset --hard`; `git clean -f`;
and `git checkout --force`. In a shell body it catches a pipe into a shell, a fork bomb,
`rm -rf /`, and `chmod 777`. It judges [every command a call runs](policy-02.md#what-buckle-reads),
and asks about an `eval` of text that only exists at run time and a call past the
[reading limits](policy-02.md#reading-limits).

`buckle policy destructive-command '<glob>'` adds to the floor, and nothing removes a built-in.
The command floor never offers `always`, and its subject is the exact command with its
arguments' digest. The [file floor](policy-04.md) offers `always`, a
[history restore](change-history.md) `once` alone.

## What the approver sees

Every deciding route shows the ask, then the whole action:
node, workspace, a summary, rule, subject, reason, working directory, every effect, and every
argument as JSON, uncut. Scripts and free text show as written; a plain value under a key naming password,
secret, or token, and a URL's password and credential query values, read `[redacted]`, with
[known limits](../caveats/known-limits.md#credential-hiding). Control and invisible characters show as escapes. Hiding is display only; the decision binds the exact arguments. An
ask whose whole call was not recorded can be denied, never approved.

## Where to answer

| Channel | How |
|---|---|
| The terminal running [`buckle serve`](approvals-02.md) | asks in place when stdin and stderr are terminals: `1`, `2`, `3` pick an offered scope, `n` or Enter denies |
| A CLI tool command at a terminal | the same question, before it returns |
| `buckle approvals --watch` | a second terminal: `o` once, `s` session, the word `always`, `d` deny, `n` skip; `ds` or `da` deny a sensitive file for the session or always |
| `buckle approvals`, then `buckle approve <token>` | shows the whole action and approves only after you type `yes` at a terminal; `--deny` works anywhere |
| MCP elicitation | with [forms](approvals-06.md) on, `buckle mcp` and `/mcp` send a form per ask when the client declares form elicitation, over HTTP for a non-floor `once` alone; otherwise the agent is pointed to `buckle approvals` |

A question ignores keys until the keyboard rests half a second. `buckle approvals`, `--watch`,
and `buckle approve` take the [workspace](workspaces.md) holding the current directory,
`--workspace <name>`, or every online one with `--all`.

Nothing the agent token reaches can decide, save an MCP form while you have [forms](approvals-06.md)
on: the agent's own app draws and answers it. With the experimental
`BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true`, `POST /workspaces/<name>/setup/approvals` takes a denial
under the admin credential, and an approval only when a device key enrolled with `buckle keys
enroll` signed it, as `buckle client approve <node-url> <token> --workspace <name>` does.

`BUCKLE_APPROVAL_WEBHOOK` names a URL each new ask is posted to, carrying the node (`serverId`), the
workspace, and per ask the token, tool, rule, subject, reason, expiry, scopes, and the answering
commands. Later posts say how each ask ended. A post times out after 5 seconds; a failure is
logged, never failing the call. It never decides.

## Timeouts

`buckle serve` and `buckle mcp` hold a gated call for the workspace's `approvalWaitMs`, 15000
by default, `0` until answered; `/mcp` over HTTP holds 30 seconds at most. Unanswered, it
returns `approval_required`, and the agent sends the same call again once decided
([over MCP](approvals-03.md)). A hold, `0` included, also ends with [its
session](approvals-07.md): the call then answers `APPROVAL_UNANSWERED`. An HTTP caller's
`context.approvalWait` overrides it:
`{"mode":"none"}` returns at once, `{"mode":"finite","ms":60000}` holds a minute.
`buckle workspace set approvalWaitMs 60000` changes it from the next call.

## Dangerously allow

[The dangerously-allow switch](approvals-04.md) removes the person for the asks its mode covers, `on`
or `safe`, in one workspace. It is off by default.
