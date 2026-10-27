# The audit log

Buckle, the approval and sandbox runtime on your machine, records what it was asked to do. Every
[workspace](workspaces.md) keeps its calls in `workspaces/<id>/actions.jsonl` in the state
directory, `~/.5straps/buckle` by default, and the node keeps its own commands and refusals in
`actions.jsonl` beside it. The workspace made of a 0.1 node's folder starts with the calls 0.1
recorded, which the move brings along. The log shows what an agent tried as well as what ran: a refusal
is recorded as fully as a success.

## Reading it

`buckle log` reads the log of the workspace a command means
([Workspaces](workspaces.md#which-workspace-a-command-means)), `--workspace <name>` naming another.

```bash
buckle log                 # the last 50 entries
buckle log --limit 200     # up to 200, the most one read returns
buckle log --json          # the same entries as JSON
```

```
2026-10-02T11:00:43.447Z  started           fs_write           0ms
2026-10-02T11:00:43.482Z  approval_required fs_write           35ms
    write_path
    asked: write_scope
```

Every tool call writes two lines. The first, with outcome `started`, is written before the call is
judged; if Buckle cannot write it, the call does not run. The second carries the result: `ok`,
`error`, `denied`, or `approval_required`. A call whose process stopped before its result was
written is marked `interrupted` the next time a Buckle process opens the log. A call refused
before it reaches its tool, because the workspace is offline or a settings change waits for active
work, writes the same two lines, the second `error` with the detail `WORKSPACE_REFUSED`.

Owner commands are logged too, under names such as `cli_policy`, `cli_approve`,
`cli_approvals`, `cli_settings`, and `cli_init`. So are refused HTTP requests, each use of the
dangerously-allow switch (`policy_dangerously_allowed`, whose `args.level` names `command` or `all`), and each change of it
(`policy_dangerously_allow_changed`).

## What an entry holds

| Field | Holds |
|---|---|
| `at`, `durationMs` | when, and how long |
| `requestId`, `sessionId`, `workspaceId`, `workspaceName` | which call, session, and workspace, the workspace by its id and by the name it had when the entry was written |
| `tool`, `outcome`, `event` | the tool, the outcome, and `attempt` or `result` |
| `effects` | the kinds of effect the call declared: `read_path`, `write_path`, `exec`, `network`, `process_probe` |
| `asked`, `approvedBy` | the rules that stopped the call, and the rules whose grants let it through, or `judge` where the decision AI passed an ask |
| `judge` | where the [decision AI](judge.md) rated the call: each stage's level, confidence, and model, the thorough model's reasoning in its own words, clipped at 2,000 characters with credentials hidden, `passed`, `passedBy: 'thorough'` where the thorough model's safe verdict ran or approved the call (Jev's verdict never does), `socket: 'unavailable'` where the Socket lookup failed, `changed: true` where the code a pass rated changed before the program started, so the call did not run, and `codeUnread` where Jev rated an allowed command on its command line because its code could not be read ([what it keeps](judge-03.md#the-audit-entry)) |
| `detail` | an error code, or what an owner command changed; a workspace variable's value and the value of `browser.cdp`, `browser.profile`, or `browser.args` (a DevTools URL, a profile folder, Chromium arguments) are never in it, only the key; `browser.headed`'s value is |
| `args` | the arguments' shape, trimmed as below |
| `actorId` | who the transport authenticated, such as `local-owner` for the CLI or `agent:<token id>` over HTTP |
| `parentRequestId` | on a call a [code mode](code-mode.md) script made, the `requestId` of the `code_run` call that sent the script; `buckle log` prints it as `parent request` |

## What is trimmed

The log keeps the shape of a call, not its content:

- every string argument becomes its length, such as `"content": "[5 characters]"`, paths
  included;
- any value under a key named like a credential becomes `[redacted]`;
- objects keep at most 40 keys, with names cut to 100 characters, arrays at most 20 items, and
  anything nested deeper than 6 levels becomes `[nested]`;
- effects keep their kind, and `asked` and `approvedBy` keep the rule name, without the path,
  host, or command;
- identifiers are cut to 200 characters.

Three exceptions keep text as it is. In `judge`, the thorough model's reasoning about the command
and its code is kept as it wrote it, clipped at 2,000 characters, with credentials hidden.

A file copy is the other. Its entry (`fs_receive` for a copy in, `fs_send` for a copy out, from
[`buckle cp`](copy.md)) keeps the path as written, with credentials hidden and at most 1,024
characters, the byte count, and the file's sha256, so the log says which file moved. It never keeps
the content. A digest can be guessed for a short or predictable file, and Rings reports carry the
entry as the log keeps it.

The file tools that remove or reshape files are the third. `fs_delete` keeps every path it was
asked to remove, `fs_move` both of its paths, and `fs_apply_patch` every file the diff names, each
as written, with credentials hidden and at most 1,024 characters. They never keep content or the
diff, and Rings reports carry them too.

Apart from those, the log says that `fs_write` wrote something and which gate asked, not what it wrote or
where. Approvers see the whole call when they decide; the log does not keep it.

## Limits

- Each entry is one JSON line of at most 64 KiB.
- On Linux and macOS the file is created owner-only (mode 600). It is synced to disk on every write.
- Buckle never rotates or truncates it.
- When the log will not take a write, Buckle refuses the calls it would have to record:
  `AUDIT_UNAVAILABLE`, HTTP 503 over HTTP. `GET /health/ready` answers 503 until a write works
  again.

## Not tamper-proof

The log is a plain append-only file protected by file permissions alone. Anyone who can write to
the state directory can edit or delete it. It is a record for the owner to read, not evidence
that stands up to someone with access to the machine.

## Sending it elsewhere

With `BUCKLE_REPORT_URL` and `BUCKLE_REPORT_TOKEN` set, Buckle also posts each tool call's
result entry to that URL in batches, as [Rings](rings.md) describes. The local file is written either way.
