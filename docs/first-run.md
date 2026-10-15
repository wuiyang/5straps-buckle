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

The first run sets this machine's node up, then serves the current directory as a
[workspace](workspaces.md). It writes the node's settings to one file, `buckle.env`, in the
state directory: `~/.5straps/buckle`, or the absolute path in `BUCKLE_STATE_DIR`. On Linux and
macOS it creates that directory with mode 700 and the file with mode 600, readable by you alone.
It never writes into the project. `--out <file>`, or `BUCKLE_ENV_FILE`, puts the file elsewhere;
then name that file with `BUCKLE_ENV_FILE` whenever you start Buckle. A node set up already keeps
its file unless you pass `--force`, and `buckle init` in another project adds it as another
workspace.

In a terminal it asks, each question with a default that Enter keeps:

| Question | Default | Kept as |
|---|---|---|
| Folder to serve | the current directory | the workspace's folder |
| Where the agent sees it | `/workspace` | the workspace's mount |
| Name for this node, first run only | the folder's path with each `/` replaced by `-` | `BUCKLE_SERVER_NAME` |
| Packs to offer | every built-in pack, and plugins | `packs.enabled` |
| Shell tools on? | on | `packs.shell` |
| Host Git and forge tools on? | off | `packs.hostGit` |
| Approved hosts and URLs | none | the workspace's approved list |
| Private-address hosts `web_fetch` may reach, first run only | none | `BUCKLE_ALLOWED_HOSTS` |

`--yes`, or running without a terminal, takes every default and says so. Its summary checks
`bwrap` on Linux, `rg`, `git`, and `agent-browser`: where each was found, or why not and what it
unlocks. The node's file also sets `BUCKLE_HOST=127.0.0.1`, `BUCKLE_PORT=4320`, and
`BUCKLE_SANDBOX=auto`. Change the workspace's answers later with `buckle workspace set` and
`buckle policy`, and the node's with `buckle settings set`.

### The two credentials

- The agent token belongs to the workspace. An HTTP client presents it as a bearer token to call
  tools through `buckle serve`, which serves that workspace for it. Buckle keeps only its digest,
  so `buckle init` prints it once; `buckle workspace token create` mints another.
- `BUCKLE_ADMIN_TOKEN`, the admin credential, is the node's, in `buckle.env`. It opens the
  experimental `/setup` face, which is off until `BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true`, and
  `buckle workspace` needs it before it changes workspaces or mints tokens.

Running tools and answering approvals from the local CLI needs neither. `buckle init` prints both
once in its summary, so treat that terminal output like the file.

## Choosing the folder

The folder decides what an agent reaches without asking:

- Reads inside the folder run. With the default `/workspace` mount, a read outside it is
  refused; without a mount, it asks.
- The first write to each directory asks, inside the folder too.
- Tools show the folder to the agent as `/workspace`.

Choose the project directory, not your home directory. Buckle refuses a folder that contains the
state directory or the settings file, or one inside or around another workspace.

A command run in a workspace's folder, or below it, acts on that workspace; elsewhere, name one
with `--workspace <id>` ([Workspaces](workspaces.md#which-workspace-a-command-means)).

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
    "buckle": { "command": "buckle", "args": ["mcp", "--workspace", "my-project"] }
  }
}
```

`--workspace` pins the workspace, so the client's working directory does not matter; without
it, `buckle mcp` serves the workspace holding that directory. Each available tool registers with its schema, and each skill is a resource at
`buckle://skills/<id>`. Logs go to stderr, because stdout carries the protocol.

### HTTP

```bash
buckle serve
```

It listens on `127.0.0.1:4320`, or `BUCKLE_HOST` and `BUCKLE_PORT`. There is no TLS; put a
proxy in front before exposing it beyond the machine. Every route but `/health` and
`/health/ready` wants an agent token, and serves that token's workspace:

| Route | What it does |
|---|---|
| `GET /health` | liveness |
| `GET /health/ready` | 503 while starting, or while the audit log refuses writes |
| `GET /v1/manifest` | the workspace, its packs and tools, and its limits |
| `GET /v1/skills` | the skills, with their text |
| `POST /v1/invoke` | runs one tool call |
| `POST /mcp` | MCP over HTTP |

```bash
TOKEN=<the agent token buckle init printed>
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
  waiting on workspace my-project (my-project)
  see the whole action with: buckle approvals --workspace my-project
  then approve with: buckle approve 3f6c...-... --scope session --workspace my-project (it shows the action again and asks to confirm)
```

At a terminal, the same command shows the whole action and asks in place:

```
  1) allow once  2) allow this session  3) always allow  n) deny >
```

Enter, or anything not on offer, denies. Choose `2` and the write goes ahead, and later writes
in that directory or below it run without asking in the same session. Every CLI call shares one
session, so for the CLI that lasts until `buckle grants revoke <id>`. [Approvals](approvals.md)
covers every question Buckle asks and every way to answer one.
