# First run

This page takes a fresh install of Buckle, the approval and sandbox runtime that runs an AI
agent's tool calls on your machine, to its first approval. It assumes `buckle --version`
works; see [Installing Buckle](install.md) if it does not.

## buckle init

Run it in the project the agent should work on:

```bash
cd ~/code/my-project
buckle init
```

`buckle init` writes one file, `buckle.env`, in the state directory: `~/.5straps/buckle`, or
the absolute path in `BUCKLE_STATE_DIR`. On Linux and macOS it creates that directory with mode
700 and the file with mode 600, readable by you alone. It never writes into the project. `--out <file>`, or
`BUCKLE_ENV_FILE`, puts the file elsewhere; then name that file with `BUCKLE_ENV_FILE` whenever
you start Buckle. An existing file is kept unless you pass `--force`.

In a terminal it asks, each question with a default that Enter keeps:

| Question | Default | Written as |
|---|---|---|
| Workspace root | the current directory | `BUCKLE_WORKSPACE_ROOT` |
| Virtual workspace path | `/workspace` | `BUCKLE_WORKSPACE_MOUNT` |
| Name for this node | the root path with each `/` replaced by `-` | `BUCKLE_SERVER_NAME` |
| Packs to enable | every built-in pack, and plugins | `BUCKLE_PACKS` |
| Shell tools on? | on | `BUCKLE_ALLOW_SHELL` |
| Host Git and forge tools on? | off | `BUCKLE_ALLOW_HOST_GIT` |
| Approved hosts and URLs | none | `BUCKLE_NETWORK_ALLOW` |
| Private-address hosts `web_fetch` may reach | none | `BUCKLE_ALLOWED_HOSTS` |

`--yes`, or running without a terminal, takes every default and says so. Its summary checks
`bwrap` on Linux, `rg`, `git`, and `agent-browser`: where each was found, or why not and what it
unlocks. The file also sets
`BUCKLE_HOST=127.0.0.1`, `BUCKLE_PORT=4320`, and `BUCKLE_SANDBOX=auto`, and lists the other
settings as comments. Change any of the questions' answers later with
`buckle settings set <key> <value>`, and see them with `buckle settings show`.

### The two credentials

`buckle init` generates two random credentials and writes them into the file:

- `BUCKLE_AUTH_TOKEN`, the agent token. An HTTP client presents it as a bearer token to call
  tools through `buckle serve`. `buckle serve` refuses to start without it.
- `BUCKLE_ADMIN_TOKEN`, the admin credential. It opens the experimental `/setup` face, which is
  off until `BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true`, and `buckle workspace` needs it before it
  mints credentials for a registered workspace.

Buckle refuses to start when the two are the same value. Running tools and answering
approvals from the local CLI needs neither. `buckle init` prints both once in its summary, so
treat that terminal output like the file.

## Choosing the workspace root

The root decides what an agent reaches without asking:

- Reads inside the root run. With the default `/workspace` mount, a read outside it is refused;
  without a mount, it asks.
- The first write to each directory asks, inside the root too.
- Tools show the root to the agent as `/workspace`.

Choose the project directory, not your home directory. Buckle refuses a root that contains the
state directory or the settings file.

One settings file serves one root. `buckle mcp`, or a command that runs a tool, started in a
directory outside that root still serves the root, and warns on stderr:

```
Warning: Buckle serves /home/you/code/my-project, the workspace root /home/you/.5straps/buckle/buckle.env sets, but started in /home/you/other, outside it: this project gets that root's files, grants and history. ...
```

To give another project its own node, set `BUCKLE_ENV_FILE` to a settings file of its own, or
set `BUCKLE_WORKSPACE_ROOT` and `BUCKLE_STATE_DIR`, in the shell or in the MCP client's `env`.

## Three ways to run

The same tools, policy, and approvals sit behind all three.

### The CLI

```bash
buckle fs read README.md
buckle call fs_read --json '{"path":"README.md"}'
buckle shell exec -- pnpm test
```

A tool named `group_verb` runs as `buckle group verb`: `fs_read_batch` is `buckle fs read-batch`
and `script_run` is `buckle script run`. The command prints the result as JSON and exits 0, exits
3 when the call needs approval, and exits 1 on an error.

### MCP over stdio

For Claude Code:

```bash
claude mcp add buckle -- buckle mcp
```

For a client configured in JSON, the usual entry is:

```json
{
  "mcpServers": {
    "buckle": {
      "command": "buckle",
      "args": ["mcp"],
      "env": { "BUCKLE_ENV_FILE": "/home/you/.5straps/buckle/buckle.env" }
    }
  }
}
```

The `env` entry is optional; it pins the node, so the client's working directory does not
matter. Each available tool registers with its schema, and each skill is a resource at
`buckle://skills/<id>`. Logs go to stderr, because stdout carries the protocol.

### HTTP

```bash
buckle serve
```

It listens on `127.0.0.1:4320`, or `BUCKLE_HOST` and `BUCKLE_PORT`. There is no TLS; put a
proxy in front before exposing it beyond the machine. Every route but `/health` and
`/health/ready` wants the agent token:

| Route | What it does |
|---|---|
| `GET /health` | liveness |
| `GET /health/ready` | 503 while starting, or while the audit log refuses writes |
| `GET /v1/manifest` | the node, its packs and tools, and its limits |
| `GET /v1/skills` | the skills, with their text |
| `POST /v1/invoke` | runs one tool call |
| `POST /mcp` | MCP over HTTP |

```bash
TOKEN=$(sed -n 's/^BUCKLE_AUTH_TOKEN=//p' ~/.5straps/buckle/buckle.env)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4320/v1/manifest
curl -s -X POST http://127.0.0.1:4320/v1/invoke \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"requestId":"r1","tool":"fs_read","args":{"path":"README.md"},"context":{"sessionId":"s1"}}'
```

The answer's `outcome` is `ok`, `error`, or `approval_required`. `context.sessionId` names the
session a session grant belongs to; calls without one share the session `rpc`. A body over
`BUCKLE_MAX_REQUEST_BYTES`, 1 MiB by default, gets a 413.

## The first approval

Reads inside the workspace just run. The first write asks:

```bash
buckle fs write notes.txt hello
```

Without a terminal, the call stops and exits 3:

```
Approval required: Writing to /workspace is not yet approved
  subject: /home/you/code/my-project
  expires in 10m 15s (2026-10-02T11:16:29.838Z)
  waiting on workspace default
  see the whole action with: buckle approvals
  then approve with: buckle approve 3f6c...-... --scope session (it shows the action again and asks to confirm)
```

At a terminal, the same command shows the whole action and asks in place:

```
  1) allow once  2) allow this session  3) always allow  n) deny >
```

Enter, or anything not on offer, denies. Choose `2` and the write goes ahead, and later writes
in that directory or below it run without asking in the same session. Every CLI call shares one
session, so for the CLI that lasts until `buckle grants revoke <id>`. [Approvals](approvals.md)
covers every question Buckle asks and every way to answer one.
