# Copying files

`buckle cp` copies one file between this machine and a workspace on a node. Buckle is the program that
gives an agent a folder to work in and asks a person before anything risky. A
[workspace](workspaces.md) is that folder, and a node is the running `buckle serve` that serves it.
The file goes straight over HTTP. It never passes through the agent's context, so a large file costs
no tokens.

Each copy is judged the way a write or a read is judged. A write into a workspace is judged as
`fs_receive`, and a read out of one as `fs_send`. The same [policy](policy.md) and
[approvals](approvals.md) apply, and the copy lands in the [audit log](audit-log.md).

```bash
buckle cp ./release.tgz my-project:/workspace
buckle cp my-project:/workspace/report.txt ./report.txt
```

## The two spellings

Each end of a copy is one of two spellings:

- A bare path, or `local:<path>`, is a file on the machine that runs `buckle cp`. A path with a
  slash before its first colon, such as `./notes:2026.txt`, is also a file here.
- `<workspace>:<path>` is a file in that workspace on the node. The workspace is named by its name
  or its id. The path takes any form `fs_write` takes there: relative to the workspace's folder, or
  under its mount, such as `/workspace/out.log`. `<workspace>:` alone means the workspace's folder.

Two rules keep the spelling unambiguous:

- A workspace whose name holds a colon must be written by its id, because the first colon ends the
  name.
- On Windows, a single letter followed by `\` or `/` is a drive: `C:\release.tgz` is a file here.
  A workspace named with one letter must be written by its id.

A `<to>` that is an existing folder takes the source's file name, as `cp` does. A `<to>` whose folder
does not exist is refused, and the refusal names that folder. So is a `<to>` that ends in a slash
without being a folder. Buckle makes no folder for a copy.

`buckle cp` refuses two ends on this machine, and says to use `cp`. It refuses two workspaces too,
before it asks the node anything: a token opens one workspace, so copy the file out to this machine,
then into the other. A copy names one node, so a copy between two nodes is not possible yet.

## The node and the token

`buckle cp` finds the node in this order:

1. `--node <url>`, such as `http://127.0.0.1:4320`.
2. The `BUCKLE_NODE_URL` variable.
3. The node that `buckle serve` runs on this machine.

The URL must be `http` or `https`, with the origin only. A URL with a user name or password is
refused. If no node answers, the refusal says to pass `--node`.

The credential is the workspace's agent token, the same one an HTTP client presents to
`/v1/invoke`. `buckle cp` reads it from one of two places:

- `--token-file <file>`, a file the owner alone can read, with one line: `BUCKLE_AUTH_TOKEN=<token>`.
  It has the same shape as `buckle.env`.
- The `BUCKLE_AUTH_TOKEN` variable. It is used only when no `--token-file` is given.

The token never goes on the command line. `buckle cp` refuses `--token`, `--auth-token`, and
`--bearer` before it reads anything else, and it does not echo the value it was given. The token is
never printed, logged, or written to an error. A refusal can name the token file's path, but never
its contents.

A node that answers 404 or 405 on the files route is too old. Buckle says so and names 0.1.8 as the
first version with file copies.

## Approvals

A copy that needs a person waits for one. The node holds the copy for the workspace's wait first, 15
seconds by default and 120 at most, then answers that a person must approve it. The CLI prints what
the node asks and the command that approves it there, and one line naming the ask, never its token:

```
This copy needs a person to approve it at the node, with these commands there:
- Writing to /srv/my-project is not yet approved
  subject: /srv/my-project
  expires in 10m 15s (2026-10-27T11:16:29.838Z)
  waiting on node http://127.0.0.1:4320, workspace my-project
  see the whole action with: buckle approvals --workspace my-project
  then approve with: buckle approve <token> --scope once --workspace my-project (it shows the action again and asks to confirm)
Waiting for approval of write_scope /srv/my-project; sending the copy again under the same request until it is decided (Ctrl-C stops)
```

The whole action is shown at the node, by `buckle approvals` and again by `buckle approve`, as every
approval shows it. For a write, that is the path, the byte count, and the full sha256 digest. For a
read, it is the path and its size. The bytes are not part of the action. They stand behind their
count and digest, and the node refuses a body whose digest does not match.

While the copy waits, the CLI sends the same request again 2 seconds after each answer, and the node
holds each send for its own wait first. Each send joins the same pending ask, so the copy does not
start over. Once the ask is answered, the copy runs. When the ask is denied, the copy stops and exits
1. An ask that expires before anyone answers is asked again by the next send, which shows the fresh
ask. A node that holds a copy past node:http's 300 seconds answers HTTP 408; the CLI says so on one
line and sends the same request again too. Ctrl-C stops the wait, exit 130, and nothing is copied
([approvals over MCP, and copies](approvals-03.md#copies)).

Each copy asks in a session of its own, `buckle-cp-` and a random id. Callers name their own sessions,
so a fixed name would let an approval at session scope cover anyone who used it, an agent's own writes
included. The printed command is the one-time approval for that reason. A person who wants later
copies to go ahead can approve with `--scope always`, which covers every caller of the workspace.

[Part two](copy-02.md) covers the limit, the checks on each copy, what lands on this machine, Windows,
and what is not included.
