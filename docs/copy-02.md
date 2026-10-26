# Copying files, part two

The limit and the checks on each copy, the Windows rule, and what `buckle cp` does not do. [Part one](copy.md) covers the spellings, the node and token, and approvals.

## Limits and checks

The largest file one copy moves is 100 MiB by default. The node reads its limit from
`BUCKLE_MAX_TRANSFER_BYTES`, set in `buckle.env` or in the environment that runs `buckle serve`. A
larger file is refused before any byte is kept. For a workspace that offers
copies, the node reports the limit in `GET /v1/manifest`, under `limits.maxTransferBytes`.

Each copy is checked before it lands:

- An upload is written to a new file beside its target. It is renamed onto the target only when every
  byte has arrived and the digest matches. A short body, a long body, or a cancelled upload leaves
  nothing behind.
- A download is hashed first, then streamed from the same file. The CLI writes it to a new file beside
  its target and renames it there once every byte has arrived and matches. If the file changes between the
  hash and the stream, the response is cut short, and `buckle cp` reports the change.
- Protected folders, such as the state directory, and paths outside the workspace's mounts are
  refused, as `fs_write` and `fs_read` refuse them. Links are not followed.

The CLI connects with a 30-second connection timeout. It sets no other timeout. The output on success
is one line:

```
Copied 3145728 bytes to my-project:/workspace/random.bin (sha256 65315623a565af1419797a1eb24bc36a473397a3be1d78af1e14d14d53fcb388)
```

## Windows

On Windows, `buckle cp` treats a drive letter as a drive, so `C:\release.tgz` and `C:/release.tgz`
are files on this machine. The rule applies only to a single letter. A workspace named `d` is
written as its id, such as `a9f9e5a2:/workspace`. The usage text says so.

Drive-letter parsing is covered by unit tests only. A copy from a real Windows machine is not yet tested.

## Not included

- Copies between two different nodes. Each copy names one node. Rings, the separate 5straps control
  plane, brokers copies across nodes later.
- An MCP tool for copies. A copy through an agent would pass every byte through the model, which
  defeats the point. Agents use `fs_read` and `fs_write` for small text.
- Progress bars. Files are small today, and each copy prints one line when it ends.
