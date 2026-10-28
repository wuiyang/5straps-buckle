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
macOS it creates the directory with mode 700 and the file with 600. It never writes into
the project. `--out <file>`, or `BUCKLE_ENV_FILE`, puts the file elsewhere; every start then
names it with `BUCKLE_ENV_FILE`, and `buckle mcp` needs it in the state directory. A node set up
already keeps its file unless you pass `--force`, and `buckle init` in another project adds it
as another workspace.

In a terminal it asks each question with a default. Enter keeps it, leaving a workspace
setting to the node's default, else the one shown:

| Question | Default | Kept as |
|---|---|---|
| Folder to serve | the current directory | the workspace's folder |
| Where the agent sees it | `/workspace` | the workspace's mount |
| Mount another folder? (until blank) | none | a mount, as `--volume` adds one |
| Name for this node, first run or `--force` | the folder's path with each `/` replaced by `-` | `BUCKLE_SERVER_NAME` |
| Packs to offer | every built-in pack, and plugins | `packs.enabled` |
| Shell tools on? | on | `packs.shell` |
| Host Git and forge tools on? | off | `packs.hostGit` |
| Approved hosts and URLs | none | the workspace's approved list |
| Approved hosts for workspaces without a list, first run or `--force` | none, or the file's list under `--force` | `BUCKLE_ALLOWED_HOSTS` |

`--yes`, or no terminal, takes every default, adding only `--volume` mounts, and says so. Its
summary checks `bwrap` on Linux, `rg`, `git`, and `agent-browser`: where each was found, or why
not and what it unlocks. The node's file also sets `BUCKLE_HOST=127.0.0.1`, `BUCKLE_PORT=4320`,
and `BUCKLE_SANDBOX=auto`. Change the workspace's answers later with `buckle workspace set` and
`buckle policy`, and the node's with `buckle settings set`.

The two credentials, the agent token and the admin token, are in [part two](first-run-02.md#the-two-credentials).

## Choosing the folder

The folder decides what an agent reaches without asking:

- Reads inside the folder run. With the default `/workspace` mount, a read outside it is
  refused; without a mount, it asks.
- The first write to each directory asks, inside the folder too.

Choose the project directory, not your home directory. Buckle refuses a folder that contains the
state directory or the settings file, or one inside or around another workspace.

A command run in a workspace's folder, or below it, acts on that workspace; elsewhere, name one
with `--workspace <name>` ([Workspaces](workspaces.md#which-workspace-a-command-means)).

## Three ways to run

The same tools, policy, and approvals sit behind all three.

### The CLI

```bash
buckle fs read README.md
buckle call fs_read --json '{"path":"README.md"}'
buckle shell exec -- pnpm test
```

A tool named `group_verb` runs as `buckle group verb`: `fs_read_batch` is `buckle fs read-batch`.
It prints the result as JSON and exits 0, 3 when the call needs approval, or 1 on an error.

### MCP over stdio

For Claude Code:

```bash
claude mcp add buckle -- buckle mcp
```

For a client configured in JSON:

```json
{
  "mcpServers": {
    "buckle": { "command": "buckle", "args": ["mcp", "--workspace", "my-project"] }
  }
}
```

`--workspace` pins the workspace; without it, `buckle mcp` serves the one holding the client's
working directory. Each available tool registers with its schema; each skill is a resource at
`buckle://skills/<id>`. Logs go to stderr, because stdout carries the protocol.

### HTTP

```bash
buckle serve
```

It listens on `127.0.0.1:4320`, or `BUCKLE_HOST` and `BUCKLE_PORT`. There is no TLS; put a
proxy in front before exposing it. `buckle service install --now` keeps it running at every login
([Running Buckle as a service](service.md)). Every route but `/health` and
`/health/ready` wants an agent token, and serves that token's workspace:

| Route | What it does |
|---|---|
| `GET /health` | liveness |
| `GET /health/ready` | 503 while starting, or while the audit log refuses writes |
| `GET /v1/manifest` | the workspace, its packs and tools, and its limits |
| `GET /v1/skills` | the skills, with their text |
| `POST /v1/invoke` | runs one tool call |
| `PUT /v1/files` | receives one file for [`buckle cp`](copy.md) |
| `GET /v1/files` | sends one file back for `buckle cp` |
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
`BUCKLE_MAX_REQUEST_BYTES`, 1 MiB by default, gets a 413. `/mcp` holds a call that needs a
person 30 seconds at most, then answers with the ask, as no error; the agent sends the same call
again once it is decided ([approvals over MCP](approvals-03.md)).

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
  waiting on workspace my-project
  see the whole action with: buckle approvals --workspace my-project
  then approve with: buckle approve 3f6c...-... --scope session --workspace my-project (it shows the action again and asks to confirm)
```

At a terminal, the same command shows the whole action and asks in place:

```
[my-project] (1) approve once  (2) approve this session  (3) always approve  (n) deny
[my-project] Your choice:
```

Enter, or anything not on offer, denies. Choose `2` and the write, and later writes in that
directory or below, go ahead this session. Every CLI call shares one
session, so for the CLI that lasts until `buckle grants revoke <id>`. [Approvals](approvals.md)
covers every question Buckle asks and every way to answer one.
