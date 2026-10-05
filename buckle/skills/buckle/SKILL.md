---
name: buckle
description: Run filesystem, shell, git, web, browser, and language-server operations on a remote or local machine through a 5straps Buckle node. Use when work must happen on a specific machine such as a dev box, a laptop, or a build server, rather than wherever you are running.
---

# Buckle

A Buckle node exposes one machine's capabilities. Every call runs there, with that machine's
files, network, and processes.

Discover what a node offers before assuming:

```
buckle tools            # available tools, with risk level
buckle manifest         # platform, sandbox mode, workspace roots, packs
buckle skills           # per-pack guides
buckle skills buckle-fs # print one
```

`buckle manifest` carries a `usage` string describing what the node is for. Read it when
choosing between nodes.

## Approvals, and why you cannot route around them

Buckle decides what needs a human's permission. Not you, and not the harness you are running
in. A gated call returns `approval_required` and exits with code 3:

```
Approval required: Writing to /workspace is not yet approved
  subject: /home/you/code/my-project
  expires in 9m 59s (...)
  waiting on workspace default
  see the whole action with: buckle approvals
  then approve with: buckle approve 21bff0bf-... --scope session (it shows the action again and asks to confirm)
```

When you see this, relay it to the person you are working with. Tell them what you were trying
to do and why, then ask them to read the whole action in `buckle approvals` (or answer it in
`buckle approvals --watch`) on the Buckle machine. `buckle approve` shows the action again and
approves only once they confirm it at a terminal. Reaching for a different tool, a shell one-liner, or
a rephrased path hits the same gate, because the gate is on the effect rather than the wording.

Scopes are `once`, `session`, and `always`. Some gates deliberately do not offer `always`.

Four things are gated:

1. **Reading outside the workspace**, on a node with no mount. Approval adds that directory to
   the sandbox. Under a mount, such as the `/workspace` mount `buckle init` writes, such a read
   is refused instead.
2. **Writing.** The first write to any directory asks. Remembered afterwards.
3. **Credential files.** `.env`, `.ssh/`, `*.pem`, `.aws/credentials` and similar. Asked every
   time until granted for that exact file. A granted directory never unlocks these.
4. **Destructive commands.** Recursive `rm`, `dd of=`, `mkfs`, `sudo`, `git push --force`,
   `git reset --hard`, and similar, plus whatever the owner added to that list. Gated whether
   or not they are inside the sandbox, and never grantable beyond the session.

Private-network and loopback URLs are also refused until approved, per host and port.

Some things are refused outright, with the reason, and no approval is offered: a command the
owner's policy denies or leaves off its allow list, a URL off the owner's approved list, any
non-HTTP scheme, and Buckle's own state directory through the file tools. Only a process
sandbox hides that directory from shell commands; with `BUCKLE_SANDBOX=none`, a shell command
can reach it. The refusal names what is allowed instead where that helps. Do not try to route
around it; the owner already answered.

The owner's command rules are shell-word globs read a word at a time, so `pnpm {build,test} *`
allows `pnpm build` with any arguments and refuses `pnpm install`. Wrapping a command in a
shell does not get past them: `bash -c ...` at the start of a call or behind a prefix such as
`sudo` or `env`, and `script_run` with the `bash` runtime, are refused unless the owner allowed
the wrapper itself. Run the program directly with
`shell_exec` instead, one command per call.

Code an interpreter runs (`python3 -c`, `node script.js`, `perl -e`, and the like) is code Buckle
cannot read: it asks, or is refused when the owner has deny rules, until the owner runs
`buckle policy allow-interpreter <name>`. Relay the refusal; do not rephrase the call.

A workspace may be mounted: then `buckle manifest` names `/workspace` (or similar) as the root,
and that is the path to use. Relative paths work the same either way.

## Packs

| Group | What it does | Skill |
|---|---|---|
| `fs` | read, write, patch, list, find, search | `buckle-fs` |
| `shell` | run programs and scripts, sandboxed | `buckle-shell` |
| `git` | status, diff, log, blame, branches as structured data | `buckle-git` |
| `forge` | commit, push, and open or read pull requests under the owner's credential | `buckle-forge` |
| `web` | fetch and search, with SSRF filtering | `buckle-web` |
| `lsp` | definitions, references, hover, diagnostics, rename | `buckle-dev` |
| `browser` | drive a real browser via agent-browser | `buckle-browser` |

A pack that cannot run here is withheld rather than failing at call time, so `buckle tools` is
always an honest list. `buckle manifest` names each absent pack and the reason. Shell tools are
the common absence: they stay hidden until the machine has a working sandbox.

## Passing arguments

Positionals fill a tool's required fields in order, and a trailing list absorbs the rest:

```
buckle fs read src/app.ts --limit 40
buckle shell exec -- pnpm build --filter web
```

When the shape is awkward, pass it exactly:

```
buckle call shell_exec --json '{"command":"pnpm","args":["build"]}'
```

## Two ways in

As a CLI, through this skill, which works in any harness with a shell.

As an MCP server, where tools appear natively:

```
claude mcp add buckle -- buckle mcp
```

Both drive the same registry and the same permission engine. Over stdio (`buckle mcp`), in
hosts that support elicitation, approvals appear as an inline prompt. Elsewhere, HTTP `/mcp`
included, they come back as the same relay text.

## Running a node

```
buckle serve    # HTTP: native RPC on /v1, MCP on /mcp
buckle mcp      # MCP over stdio
```

`serve` requires `BUCKLE_AUTH_TOKEN`. Bind to localhost unless the network is trusted.
