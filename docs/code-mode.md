# Code mode

Buckle, the approval and sandbox runtime on your machine, can run a short JavaScript program an
agent writes, called a script, that calls Buckle's other tools. The agent sends one `code_run`
call instead of many, and only what the script prints and returns goes back to the model. A
script that reads fifty files and keeps three lines costs the agent three lines, not fifty files.

Every call a script makes is judged, approved, and audited exactly as the same call made
directly. [Code mode, part two](code-mode-02.md) covers replay, and
[part three](code-mode-03.md) limits, the setting, and the audit log.

## The two tools

| Tool | What it does |
|---|---|
| `code_run` | runs `{ script, timeoutMs? }` and returns what it printed, what it returned, and the calls it made |
| `code_api` | returns the TypeScript declarations of the tools a script can call, or of the ones named in `{ tools }` |

The `code_run` description declares the tools a script can call, as far as fits in about 4000
tokens, and names the rest. `code_api` returns the declaration of any of them, including those
the description only names.
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
- `ALL_TOOLS`, the callable tools as `{ name, description }`;
- `searchTools(query, { limit })`, the tools whose name or description holds every word of the
  query, ignoring case, 8 unless `limit` asks for up to 100;
- `describeTool(name)`, one tool's declaration;
- `text(value)` and `console.log(...)`, one output line each, `return`, and `exit()`.

Naming a tool that is not in `ALL_TOOLS` throws a `TypeError` at once, and nothing is audited.

The tools a script can call are the workspace's tools as `buckle manifest` lists them at that
moment, after the node's and the workspace's tool policy, without `code_run` and `code_api`:
scripts cannot start scripts. A script runs in the workspace whose token its call presented, and its
calls reach only that workspace's tools, sessions, approvals, replay records, and audit log. They
carry the caller's own session and stage, so a script's `browser_command` drives the browser the
agent's direct calls opened, on the same page.

## Approvals inside a script

A script's call meets the same rules as a direct call: a read inside the workspace runs, the
first write into a directory asks, and a refusal is a refusal. A refused call rejects inside the
script, where the script may catch it; the refusal is in the audit log either way.

When a call needs a person, the script stops there. The script gets no further results, but every
call it made in the same turn still runs, or asks, and every call already running finishes. Then
Buckle stops the script and answers `code_run` with `approval_required`, carrying the asks of every
call that asked.

Each ask is that call's own. The approver sees the call whole, in the terminal, in
`buckle approvals`, in `--watch`, or in an MCP host's form, and that call is what they approve.
Its summary line says a `code_run` script made it, names the `requestId` of the `code_run` call that
sent the script, and says that `buckle approvals show <token>` prints the script. That command prints the
ask whole, decides nothing, and adds the script's text, which Buckle keeps with the script's
replay record, owner-only, for ten minutes after the ask.

Where the caller waits for answers, as the CLI does, a call that asks waits inside the script,
and the script goes on once the person answers. The wait ends a second before the script's
deadline, however slow the approval webhook is, so an ask nobody answered in time comes back as
`approval_required`, never as a timeout. While the call still waits inside the script, the
script's text is not kept yet.

The script's deadline, its end, and a shutdown leave its asks pending, and the same script sent
again joins them. Buckle withdraws them when the caller itself cancels, and when the script cannot
be resumed, with `CODE_REPLAY_TOO_LARGE` or `CODE_REPLAY_DIVERGED`, since no call would spend them.
A withdrawal that fails, such as one behind a busy approvals file, is logged, the answer keeps its
code, and the asks expire on their own.

Once the person answers, the agent sends the same script again, and Buckle replays what already
ran: [Code mode, part two](code-mode-02.md) has how.
