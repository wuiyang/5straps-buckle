# Workspaces

Buckle, the approval and sandbox runtime that runs an AI agent's tool calls, runs as one node per
machine. The node serves workspaces: each one is a folder an agent works in, with its own agent
tokens, policy, settings, grants, approvals, and history. The node shares only its admin
credential, its host, and its port. This page covers making and changing workspaces;
[the next one](workspaces-02.md) covers their settings and moving a node set up before them.

## buckle init

```bash
cd ~/code/my-project
buckle init
```

The first `buckle init` on a machine sets the node up: it writes `buckle.env`, the node's
settings, in the state directory (`~/.5straps/buckle`, or the absolute path in
`BUCKLE_STATE_DIR`), with the node's name, host, port, and admin credential. Then it serves the
current directory, or the folder `--dir` names, as a workspace, and prints that workspace's agent
token once. Each later `buckle init`, in another project, keeps the node's file and adds that
folder as a workspace with a token of its own. `--force` writes the node's file again, with a new
admin credential, and keeps every workspace. In a folder a workspace already serves, it adds
nothing and says how to mint a token there.

In a terminal it asks where the agent sees the folder (`/workspace`), which packs to offer,
whether shell tools and host Git are on, and the approved hosts and URLs. Each answer goes to the
new workspace's settings; Enter keeps the default. [First run](first-run.md) walks through it.

## buckle workspace

`buckle workspace` changes the node's workspaces. Every verb needs the node's admin credential,
`BUCKLE_ADMIN_TOKEN` in `buckle.env`, which `buckle init` writes.

```bash
buckle workspace init [--dir <path>] [--name <name>] [--id <id>]
buckle workspace list [--json]
buckle workspace show [--json]
buckle workspace enable <id>
buckle workspace disable <id>
buckle workspace remove <id> [--purge]
buckle workspace set <key> <value>
buckle workspace unset <key>
buckle workspace token create [--label <text>]
buckle workspace token list
buckle workspace token revoke <token-id>
```

- `init` serves a folder as a new workspace and prints its agent token once. Its id comes from
  the folder's name unless `--id` gives one. A folder inside a workspace, or holding one or the
  state directory, is refused.
- `list` shows every workspace, online or not. `show`, the default verb, prints one workspace's
  settings as JSON; no token is ever shown again.
- `disable` stops serving a workspace, as an MCP server is switched off: calls to it are refused,
  and its files, records, and tokens stay. `enable` serves it again.
- `remove` forgets a workspace and never touches its folder. Its records stay in the state
  directory, and `buckle workspace init --dir <folder> --id <id>` takes them up again;
  `--purge` deletes them.
- `set` and `unset` change one setting; [the next page](workspaces-02.md#settings) lists them.
- `token create` mints another agent token for the workspace, shown once. `token list` shows
  each token's id, label, and date, never the token. `token revoke` refuses one from the next call
  on; the last token of a workspace cannot be revoked.

The 0.1 spellings, `buckle workspace add <id> --root <dir>` and `buckle workspace token add
<id>`, still work for one release.

## Which workspace a command means

A command that acts on one workspace, such as `buckle policy`, `buckle grants`, `buckle tools`,
or a tool call, takes the workspace from:

1. `--workspace <id>`;
2. else `--dir <path>`, the workspace whose folder holds that path;
3. else the workspace whose folder holds the current directory.

Where none does, the command is refused and lists the ids. `buckle approvals`, its `--watch`,
and `buckle approve` are the exception: with neither flag they cover every online workspace, as
[Approvals](approvals.md#where-to-answer) describes.

## Agents and tokens

An agent token belongs to one workspace. Buckle keeps only its SHA-256 digest, so the token is
shown once, when it is minted. Over HTTP, `/mcp` and `/v1/*` serve the workspace the presented
token belongs to, so an agent's configuration needs only the host, the port, and its token.
`/workspaces/<id>/mcp` and `/workspaces/<id>/v1/*` also work, for a token of `<id>` alone. A
token of no workspace and a token of another workspace get the same refusal, so a caller learns
nothing about which workspaces exist. A disabled workspace answers 409.

`buckle mcp` serves one workspace over stdio: the one `--workspace <id>` names, else the one
holding `--dir <path>`, else the one holding `BUCKLE_WORKSPACE_ROOT` (for configurations written
before workspaces), else the one holding the client's working directory:

```json
{
  "mcpServers": {
    "buckle": { "command": "buckle", "args": ["mcp", "--workspace", "my-project"] }
  }
}
```

A workspace's settings never come from an MCP client's `env`: a node set up with workspaces
ignores the old settings variables there, and says so in its log.

## buckle serve

`buckle serve` serves every online workspace, and opens each at start, so a broken one is named
then rather than at its first call; the rest are served. On its terminal it lists them, each with
its id and name, where the agent sees its folder and from where, its URL mode, and the packs it
offers, and lists them again after each change. Every question it asks is marked with the
workspace it waits in.
