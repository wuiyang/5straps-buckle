---
name: buckle-code
description: Run a JavaScript script on a 5straps Buckle node that calls the node's other tools, so many calls cost one round trip and large results are filtered before you read them. Use when a task needs several tool calls, a loop over files, or only part of a large result.
---

# Buckle code mode

`code_run` runs a script you write in a small JavaScript sandbox on the node. The script can do one
thing: call the node's other tools. Only what it prints and returns comes back to you, so a script
that reads fifty files and keeps three lines costs you three lines.

```
buckle code run --script 'const r = await tools.fs_list({ path: "src" }); return r.entries.length'
```

Over MCP, call `code_run` with `{ "script": "..." }`, and `timeoutMs` when it needs longer than a call's
own timeout.

## Writing a script

The script is the body of an async function: top-level `await` and `return` work. It has no
files, network, processes, timers, `require`, or modules of its own. Everything it reaches goes
through `tools`.

```js
const listed = await tools.fs_list({ path: 'docs' })
const pages = listed.entries.filter(entry => entry.type === 'file' && entry.name.endsWith('.md'))
const read = await Promise.all(pages.slice(0, 8).map(page => tools.fs_read({ path: `docs/${page.path}` })))
for (const file of read) text(`${file.path}: ${file.content.split('\n')[0]}`)
return read.length
```

The globals:

- `tools.<name>(args)`: calls a tool with one object of arguments and resolves to the JSON a direct
  call returns. The `code_run` description declares each tool and what it resolves to.
- `ALL_TOOLS`: every tool you can call, as `{ name, description }`.
- `await searchTools(query, { limit })`: the tools whose name or description holds every word of
  `query`, ignoring case, as `{ name, description }`; 8 unless `limit` asks for up to 100.
- `await describeTool(name)`: one tool's TypeScript declaration. `code_api` returns them all, or the
  ones you name.
- `text(value)` and `console.log(...)`: one line of output each.
- `return value`: the script's result, as JSON. `exit()` ends the script at once.

`store()`, `load()`, and `image()` are not supported: nothing carries over to the next script,
and an image is dropped. Scripts cannot start scripts: a script has no `code_run` or `code_api`.
Naming either, or any tool not in `ALL_TOOLS`, throws a `TypeError` at once, with no `code`, and
nothing is audited. Look the name up with `ALL_TOOLS` or `searchTools`.

## Errors

A call that fails or is refused rejects with an `Error` whose message is `<code>: <message>`; it
carries `code` and `retryable` as properties. Catch it to go on:

```js
try { await tools.fs_read({ path: 'notes/missing.md' }) } catch (error) { text(`skipped: ${error.code}`) }
```

A refusal (`PERMISSION_DENIED`) is in the audit log whether or not you catch it. When the script
throws, `code_run` still returns what it printed before, with `ok: false` and an `error` naming its
kind: `script`, `timeout`, `aborted`, or `sandbox`. Its name, message, and stack are each cut to
16384 characters. A `sandbox` error is one fixed sentence: retry, or tell the owner. Calls made
before a failure are not undone.

## When a call needs approval

Every call a script makes is judged as a direct call, with the same rules and approvals. A call
that needs a person stops the script there: `code_run` answers `approval_required`, with the asks
of every call that asked. Relay them as you would any ask. The person sees that one call whole,
with a note that a `code_run` script made it.

Once they answer, send the same script again, its text unchanged; `timeoutMs` may differ. Buckle
replays the calls that already ran from its record of the first run, without running them again,
and then runs the call that asked. A call refused or failed with a retryable error after the
script stopped is made again, and past 50 pending asks in one session, the rest ask on the next
send. On a node that waits for answers (the CLI, or a caller that
sends a wait), the call simply waits inside the script, as a direct call would, until a second
before the script's deadline.

Do not change the script to get around an ask. A changed script is a new script: Buckle replays
nothing for it, its calls run again, and the same call asks again. Changing the script is right
only when Buckle tells you to, with `CODE_REPLAY_DIVERGED`.

`CODE_REPLAY_TOO_LARGE` means the script's results were too large to keep for a replay: make the
call that asked on its own, or send a script that keeps less. A replay is kept for ten minutes.

## After a timeout or a cancel

A script stopped by its deadline, a cancel, or a shutdown keeps the same record. The same script
sent again within ten minutes goes on where it stopped: the calls that finished are replayed, not
run again. To run it from its start, change one character of it, even in a comment. A call that
answers `REQUEST_ALREADY_EXECUTED` ran before, perhaps cut short, and Buckle did not run it again:
check what it did, then change the script to run it again.

## Limits

- A script is at most 262144 characters.
- At most 256 calls per script, refused ones and those before an ask counted; past it, the call
  fails inside the script with `CODE_CALL_LIMIT`, and a script that keeps calling is ended. Eight
  run at once, and the rest wait their turn, so `Promise.all` over many files works; a batch tool
  such as `fs_read_batch` makes fewer calls.
- One call's arguments, as JSON, are held to the node's request size, 1 MiB by default; past it the
  call fails with `REQUEST_TOO_LARGE`.
- The sandbox has 256 MiB of memory. Running out throws inside the script.
- The whole script, calls included, runs for the call's timeout unless `timeoutMs` asks for more,
  up to the node's maximum. A wait for an approval counts toward it.
- Output and the return value are each cut to 1048576 characters, keeping the start and the end.
  Past 100000 lines of output, or 16777216 characters, the script fails with a `RangeError`: print
  a summary instead.
- A Buckle process runs four scripts at once, two per workspace; another gets `CODE_VM_BUSY` and
  can retry.
- A script waiting on something no call will settle fails at once: there are no timers.
