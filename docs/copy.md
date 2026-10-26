# Copying files

`buckle cp` copies one file between this machine and a workspace on a Buckle node. A
[workspace](workspaces.md) is the folder an agent works in, and a node is the running `buckle serve`
that serves it. The file goes straight over HTTP. It never passes through the agent's context, so a
large file costs no tokens.

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
does not exist is refused, and the refusal names that folder. Buckle makes no folder for a copy.

`buckle cp` refuses two ends on this machine, as `cp` already does. A copy names one node, so a copy
between workspaces on two different nodes is not possible yet. A copy between two workspaces on one
node runs through this machine. Buckle downloads the file into a private temporary folder, then uploads it, and removes
the temporary folder when the copy ends.

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
first version with file copies. The owner's Windows node runs 0.1.7 today, so copies to it fail
until it is upgraded.

## Approvals

A copy that needs a person waits for one. The node holds the copy for a short time first, 15 seconds
by default, then answers that a person must approve it. The CLI prints the action and the command
that approves it at the node:

```
This copy needs a person to approve it at the node, with these commands there:
- Receive 3145728 bytes (sha256 65315623a565af1419797a1eb24bc36a473397a3be1d78af1e14d14d53fcb388) into "random.bin" in "/workspace"
  then approve with: buckle approve <token> --scope once --workspace my-project (it shows the action again and asks to confirm)
Waiting for the approval...
```

The action is shown whole, as every approval shows it. For a write, that is the path, the byte count,
and the full sha256 digest. For a read, it is the path and its size. The bytes are not part of the
action. They stand behind their count and digest, and the node refuses a body whose digest does not
match.

While the copy waits, the CLI sends the same request again every 2 seconds. Each send joins the same
pending ask, so the copy does not start over. Once the ask is answered, the copy runs. When the ask
is denied, the copy stops and exits 1. When the ask expires before anyone answers, the copy also stops
and exits 1, and nothing is copied.

Copies run in the session `buckle-cp`. A session grant made for a copy covers later copies, and it
does not cover an agent's own calls, which run in the session `rpc`. The session is kept apart from
agent calls.

[Part two](copy-02.md) covers the limit, the checks on each copy, Windows, and what is not included.
