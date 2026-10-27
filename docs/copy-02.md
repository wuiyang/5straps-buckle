# Copying files, part two

The limit, the checks on each copy, what lands on this machine, the Windows rule, and what `buckle cp` does not do. [Part one](copy.md) covers the spellings, the node and token, and approvals.

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
  hash and the stream, the node cuts the response short. The reason reaches only its audit log, so the CLI
  says the node cut the file short, perhaps because the file changed, and to run the copy again. The call
  also ends with its own timeout, whether or not the CLI is still reading.
- Protected folders, such as the state directory, and paths outside the workspace's mounts are
  refused, as `fs_write` and `fs_read` refuse them. A path is followed to where it lands, and the copy
  is judged there. A link that appears after that check is refused.
- A `<to>` that is a folder outside the workspace's own folder is known to be one only after the
  write is judged, so such a copy asks twice, once for the folder and once for the file in it.
- `fs_receive` and `fs_send` are tools of their own. A [policy](policy.md) that denies `fs_write` also
  denies `fs_receive`, and one that denies `fs_read` also denies `fs_send`. Where `fs_receive` is
  denied, the manifest reports no limit.

## On this machine

A download is checked before the node is asked, so a refusal costs no approval. A folder that does not
exist, a trailing slash on a file, a folder where the file would go, and a link to nothing are refused.
A `<to>` that is a link to a file is written through, as `cp` does.

The new file takes the mode of the file it replaces, exactly, so a private file never becomes one
that others read. Where nothing is replaced, the new file gets the mode any new file gets in that
folder, as a shell redirect or `touch` would make it: `0666` narrowed by the umask, so `644` under
the usual `022`.

A rename onto a file that Windows holds open is tried again a few times. A file still held is
named in the refusal. Ctrl-C and `SIGTERM` remove the new file of a download under way and end the
copy, so no unverified bytes stay beside the target. A closed terminal (`SIGHUP`) is left alone, so
`nohup buckle cp` survives it. Without `nohup` it ends the copy, and the owner-only partial file
`.buckle-cp-<id>.part` may stay beside the target.

The CLI connects with a 30-second connection timeout. It sets no other timeout. The output on success
is one line:

```
Copied 3145728 bytes to my-project:/workspace/random.bin (sha256 65315623a565af1419797a1eb24bc36a473397a3be1d78af1e14d14d53fcb388)
```

## Windows

On Windows, `buckle cp` treats a drive letter as a drive, so `C:\release.tgz` and `C:/release.tgz`
are files on this machine. The rule applies only to a single letter. A workspace named `d` is
written as its id, a full UUID such as `0b7e4f3a-5c1d-4e2b-9a86-3f1c7d2e8b40:/workspace`. The usage
text says so.

Drive-letter parsing is covered by unit tests only. A copy from a real Windows machine is not yet tested.

## Not included

- Copies between two different nodes. Each copy names one node. Rings, the separate 5straps control
  plane, brokers copies across nodes later.
- Copies between two workspaces. A token opens one workspace. Copy out to this machine, then in.
- An MCP tool for copies. A copy through an agent would pass every byte through the model, which
  defeats the point. Agents use `fs_read` and `fs_write` for small text.
- Progress bars. Files are small today, and each copy prints one line when it ends.
