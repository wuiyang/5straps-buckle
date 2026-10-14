# Code mode

Buckle, the approval and sandbox runtime on your machine, can run a short JavaScript program an
agent writes, called a script, that calls Buckle's other tools. The agent sends one `code_run`
call instead of many, and only what the script prints and returns goes back to the model. A
script that reads fifty files and keeps three lines costs the agent three lines, not fifty files.

Every call a script makes is judged, approved, and audited exactly as the same call made
directly.

## The two tools

| Tool | What it does |
|---|---|
| `code_run` | runs `{ script, timeoutMs? }` and returns what it printed, what it returned, and the calls it made |
| `code_api` | returns the TypeScript declarations of the tools a script can call, or of the ones named in `{ tools }` |

The `code_run` description declares the tools a script can call, as far as fits in about 4000
tokens, and names the rest; `code_api` serves agents whose host cannot read MCP resources.
`buckle skills buckle-code` prints the guide the agent reads.

```bash
buckle code run --script 'const r = await tools.fs_list({ path: "." }); return r.entries.length'
```

## The script's environment

A script is the body of an async function, so `await` and `return` work at its top level. It
runs in QuickJS, a small JavaScript engine compiled to WebAssembly, inside a worker thread of the
Buckle process. The engine has no files, network, processes, timers, or modules: a script reaches
the machine only through `tools`. That is why code mode needs no operating-system sandbox and runs
wherever Buckle does.

A script can use:

- `tools.<name>(args)`, which resolves to the JSON a direct call returns, or rejects with an
  `Error` whose message is `<code>: <message>` and which carries `code` and `retryable`;
- `ALL_TOOLS`, the callable tools as `{ name, description }`, and `describeTool(name)`, one tool's
  declaration;
- `text(value)` and `console.log(...)`, one output line each, `return`, and `exit()`.

The tools a script can call are the workspace's tools as `buckle manifest` lists them at that
moment, after the node's and the workspace's tool policy, without `code_run` and `code_api`:
scripts cannot start scripts. A script runs in the workspace whose token its call presented, and its
calls reach only that workspace's tools, sessions, approvals, replay records, and audit log.

## Approvals inside a script

A script's call meets the same rules as a direct call: a read inside the workspace runs, the
first write into a directory asks, and a refusal is a refusal. A refused call rejects inside the
script, where the script may catch it; the refusal is in the audit log either way.

When a call needs a person, the script stops there. Buckle lets the calls already running finish,
stops the script, and answers `code_run` with `approval_required`, carrying the asks of every call
that asked. Each ask is that call's own: the approver sees the call whole, in the terminal, in
`buckle approvals`, in `--watch`, or in an MCP host's form, and its summary line says a `code_run`
script made it, naming the stage it is filed under. The script's text is not repeated there.

Where the caller waits for answers, as the CLI does, a call that asks waits inside the script,
and the script goes on once the person answers.

## Replay after an approval

Once the person answers, the agent sends the same script again. Buckle recognises it by the
session, the caller, and the script with its arguments, and replays it: each call the first run
made gets the result it got then, read from a record Buckle kept, without running again. The
script then reaches the call that asked, which now runs with the person's answer, and carries on.
A script is deterministic for this: its clock and random numbers repeat its first run's.

Limits of the replay:

- The record is kept for ten minutes after the ask. Sent later, the script runs from its start, and
  the calls before the ask run again.
- A script whose results pass 32 MiB cannot be resumed: `code_run` answers
  `CODE_REPLAY_TOO_LARGE`. A workspace keeps 128 MiB of records, dropping the oldest first.
- A script that, replayed, makes other calls than its first run did is refused with
  `CODE_REPLAY_DIVERGED`. Change the script to run it from its start.
- A changed script is a new script: nothing is replayed for it.

Records live in `code-journal/` in the workspace's state directory, owner-only, which every
sandbox hides. A script that ends without an ask leaves none. Once a script ends by itself,
sending it again runs every call again; one stopped by its deadline, a cancel, or a shutdown leaves
its finished calls answered for ten minutes, so none of them runs twice.

## Limits

| Limit | Value |
|---|---|
| script size | 262144 characters |
| calls per script | 256, then each call fails with `CODE_CALL_LIMIT` |
| calls running at once | 8, and a call past them waits for a free slot |
| memory | 256 MiB per script |
| time | the call's timeout, or `timeoutMs`, up to `BUCKLE_MAX_TIMEOUT_MS`; a wait for a person counts |
| output, and the returned value | 1 MiB each, keeping the start and the end |
| scripts at once | 4 per Buckle process, then `CODE_VM_BUSY` |

A script that waits on something no call can settle fails at once, since there are no timers.

## The setting

`BUCKLE_ALLOW_CODE=true` is the default. `false` withholds the code pack, and `buckle manifest`
gives the reason; `buckle settings set code off` writes it. Restart every Buckle process after a
change. The setting covers the node; to turn code mode off for one workspace alone, deny `code_run`
in that workspace's tool policy, with `buckle policy deny-tool code_run` on the node's own
workspace.

## Reading a script in the audit log

The `code_run` call is one entry, with the script's size among its arguments, since the log keeps
the shape of arguments, not their text ([The audit log](audit-log.md)). Each call the script made
is an entry of its own, with a `requestId` of `code:<key>:<number>` and a `stageId` that names
the script: the stage the caller gave the `code_run` call, or else its run, or else its own
`requestId`. So `buckle log --json` lists a script's calls together under that stage, and the
change history groups their writes the same way. A replayed call adds no entry: it did not run
again.
