# Workspaces

Buckle, the approval and sandbox runtime that runs an AI agent's tool calls, runs as one node per
machine. The node serves workspaces: each one is a folder an agent works in, with its own agent
tokens, policy, settings, grants, approvals, and history. The node's admin credential, host,
port, and other node settings are its alone; its other settings in `buckle.env` are each
workspace's defaults. This page covers making and changing workspaces; [the next
one](workspaces-02.md) covers their settings, [Node defaults](workspaces-03.md) how the node's
settings apply to each, and [Moving a node from 0.1](workspaces-04.md) a node set up before them.

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
admin credential, and keeps every workspace and the node's workspace defaults. In a folder a workspace already serves, it adds
nothing and says how to mint a token there.

In a terminal it asks where the agent sees the folder (`/workspace`), which packs to offer,
whether shell tools and host Git are on, and the approved hosts and URLs. Each answer goes to the
new workspace's settings; Enter leaves the setting to the node's default. [First run](first-run.md) walks through it.

## buckle workspace

`buckle workspace` changes the node's workspaces. Every verb needs the node's admin credential,
`BUCKLE_ADMIN_TOKEN` in `buckle.env`.

```bash
buckle workspace init [--dir <path>] [--name <name>] [--yes]
buckle workspace add <dir> [--name <name>] [--yes] [--fresh]
buckle workspace list [--json]
buckle workspace show [--json]
buckle workspace enable <name>
buckle workspace disable <name>
buckle workspace rename <name> <new-name>
buckle workspace remove <name> [--purge]
buckle workspace prune [--yes]
buckle workspace set <key> <value>
buckle workspace unset <key>
buckle workspace token create [--label <text>]
buckle workspace token list
buckle workspace token revoke <token-id>
```

- `init` serves a folder as a new workspace and prints its agent token once; `add <dir>` is the
  same, with the folder named first. The id is a UUID Buckle derives from the folder. The name is
  the folder's basename unless `--name` gives one: 1 to 64 characters, unique on the node
  (case insensitively), with no `/`, `\`, or `%`, no leading `-`, and never `node`, `.`, `..`, or
  UUID-shaped text. A taken or refused name is asked about at a terminal, and refused with `--yes` or without
  one; `buckle workspace init --name <name>` gives another. A folder inside a workspace, or
  holding one or the state directory, is refused.
- `list` shows every workspace, online or not. `show`, the default verb, prints one workspace's
  settings in force, each with where it comes from; no token is ever shown again.
- `disable` stops serving a workspace, as an MCP server is switched off: calls to it are refused,
  and its files, records, and tokens stay. `enable` serves it again. `rename` gives it another
  name; its id never changes.
- `remove` forgets a workspace and never touches its folder. Its records stay in the state
  directory under `workspaces/<id>/`, and adding the folder again takes up those of its most
  recently removed workspace; `--purge` deletes them. `add <dir> --fresh` starts a new id and
  leaves the older records for `buckle workspace prune`, which lists the removed workspaces whose
  records are kept and, with `--yes`, deletes them.
- `set` and `unset` change one setting; [the next page](workspaces-02.md#settings) lists them.
- `token create` mints another agent token for the workspace, shown once. `token list` shows
  each token's id, label, and date, never the token. `token revoke` refuses one from the next call
  on; the last token of a workspace cannot be revoked.

The 0.1 `buckle workspace add <id> --root <dir>` is gone: `add` names the folder first.
`buckle workspace token add <id>` still works for one release.

## Which workspace a command means

A command that acts on one workspace, such as `buckle policy`, `buckle grants`, `buckle tools`,
or a tool call, takes the workspace from:

1. `--workspace <name>`, a workspace's name (its id is accepted too);
2. else `--dir <path>`, the workspace whose folder holds that path;
3. else the workspace whose folder holds the current directory.

Where none does, the command is refused and lists the names. `buckle approvals`, its `--watch`,
`buckle approve`, and `buckle check-url` default the same way to the workspace holding the
current directory; `--all` widens the first three to every online workspace, each ask prefixed
with its workspace name, as [Approvals](approvals.md#where-to-answer) describes.

## Agents and tokens

An agent token belongs to one workspace. Buckle keeps only its SHA-256 digest, so the token is
shown once, when it is minted. Over HTTP, `/mcp` and `/v1/*` serve the workspace the presented
token belongs to, so an agent's configuration needs only the host, the port, and its token.
`/workspaces/<id>/mcp` and `/workspaces/<id>/v1/*` also work, for a token of `<id>` alone. A
token of no workspace and a token of another workspace get the same refusal, revealing nothing
about which workspaces exist. A disabled workspace answers 409.

`buckle mcp` serves one workspace over stdio: the one `--workspace <name>` names, else the one
holding `--dir <path>`, else the one holding `BUCKLE_WORKSPACE_ROOT` (for older configurations),
else the one holding the client's working directory:

```json
{
  "mcpServers": {
    "buckle": { "command": "buckle", "args": ["mcp", "--workspace", "my-project"] }
  }
}
```

It checks the registry at every call: a workspace taken offline or removed answers each call with
a refusal naming it, and one removed and added again needs the client to restart `buckle mcp`.

Neither a workspace's settings nor the defaults it takes from the node come from an MCP client's
`env`: the node reads them from `workspace.json` and `buckle.env` alone, and says so in its log
where that `env` sets one otherwise.

## buckle serve

`buckle serve` serves every online workspace, and opens each at start, so a broken one is named
then rather than at its first call; the rest are served. On its terminal it lists them, each with
its id and name, where the agent sees its folder and from where, its URL mode, and the packs it
offers, and lists them again after each change. Every question it asks is marked with the
workspace it waits in.
