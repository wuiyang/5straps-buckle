# Moving a node from 0.1

Buckle, the approval and sandbox runtime on this machine, served one folder in 0.1. This release
serves [workspaces](workspaces.md), and the first command of it on a state directory 0.1 used moves
the node onto them, once, under the registry's lock. This page says what moves, what the move keeps
for going back, and how to go back. [Workspace settings](workspaces-02.md) covers what each
workspace then holds.

## What the move does

- The folder the node served, `BUCKLE_WORKSPACE_ROOT` or the directory the command runs in,
  becomes a workspace named after its folder, with a UUID id and its records under
  `workspaces/<id>/`. A name another workspace holds, or `node`, is asked about at a terminal,
  `buckle serve` included, else it takes the start of the id. `BUCKLE_AUTH_TOKEN` becomes its token `node`, so agents configured with it
  keep working; `buckle workspace token create --workspace <that name>`, then `token revoke
  node`, rotates it.
- Each workspace registered with `buckle workspace add` keeps its 0.1 id as its name, gets a UUID
  id, and keeps its folder, tokens, and `/workspace` mount. A disabled or retired one stays
  offline. Each workspace's own admin credential goes: the node's is the one.
- The registry keeps each token's SHA-256 digest alone.
- Each `workspace.json` holds what was the workspace's own: the lists `buckle policy` stored, and
  for the node's folder a mount it stored. The settings `buckle.env` held stay there as every
  workspace's defaults. A workspace with an allow list of its own now uses it alone, where the
  node's list was a ceiling over it, and the move says so.
- Grants, remembered denials, and the dangerously-allow switch move from the folder they were
  kept under to the workspace's id; device keys enrolled for it, from its 0.1 id.
- The audit log 0.1 kept holds the node folder's calls, so it becomes that workspace's log, which
  `buckle log --workspace <name>` reads. The node's own log starts fresh. A workspace that has a
  log already keeps it, and the old one stays where it is.
- The folder's other records, its plugins, history, pending approvals, and staged shell copies
  among them, move into `workspaces/<id>/` too, as does each registered workspace's
  `workspaces/<0.1 id>/` folder's.

A state directory that served nothing gets no workspace until `buckle init` makes one.

## Going back

The move keeps owner-only copies of what it changes: `workspaces.v1.json` and
`policy.v1.json` in the state directory (empty where the node had no registry or policy),
`client-keys.v1.json` there where a device key moved, and
`grants.v1.json` and `dangerously-allow.v1.json` beside each grants and switch file it moved: in
the state directory for the node's folder, and in `workspaces/<0.1 id>/` for each workspace
registered under 0.1 ([the files](install-02.md)). It makes `policy.json`
a version 2 stub and takes `BUCKLE_AUTH_TOKEN` out of `buckle.env`, so an older Buckle refuses to
start.

To go back to 0.1, first run `buckle service uninstall` where a service is installed: 0.1 has no
such command, and its `serve` ignores the flags the definition passes. Then stop Buckle and its MCP
clients. Copy each `*.v1.json` file over its original,
and move the other records back where 0.1 kept them: out of `workspaces/<id>/` into the state
directory for the node's folder, and into `workspaces/<0.1 id>/` for a registered workspace,
leaving `workspace.json`, `actions.jsonl`, and the lock files. Set `BUCKLE_AUTH_TOKEN` in `buckle.env` to the token
your agents use (Buckle kept only its digest), set `BUCKLE_WORKSPACE_ROOT` there to the node's
folder (see `buckle workspace list`) if `buckle settings unset root` removed it, and install the
older release. Going back loses every workspace registered, token created, key enrolled, grant,
denial, and `workspace.json` written after the move. Records left in `workspaces/<id>/` are lost
to 0.1, which would start with no plugins, no history to undo from, and no pending approvals or
shell copies awaiting review; the calls from before the move stay in `actions.jsonl` there, which
0.1 does not read.

Moving again later starts from what 0.1 holds then. The copies are made again from those files,
the move says so, and records the first move left in `workspaces/<id>/` are kept beside the new
ones with `.earlier-move` ending their names, never read. Grants and the switch from after the
first move do not come back: moved back by hand, an entry under the workspace's id is kept under
`<id>.earlier-move`, and a move again that stops partway is finished as one.

`workspaces.v1.json` holds the registered workspaces' agent tokens and admin credentials in clear
text. Once the node works, delete every `*.v1.json` file in the state directory and in each
`workspaces/<0.1 id>/` folder; the way back goes with them.
