# Policy: deletes in and outside the workspace

Buckle, the approval and sandbox runtime that runs an AI agent's tool calls, judges a delete by
where it lands. Inside the workspace's own folder a delete is part of a coding task, such as
removing old code in a refactor, so by default it runs where the folder's writes are granted.
Outside that folder every delete asks a person, who approves the target alone or its folder with
its subfolders. [The file floor](policy-04.md) covers the rest of what the file tools ask, and
[known limits, part nine](known-limits-09.md#deletes) what this policy leaves out.

## Inside the workspace's folder

`files.deleteInWorkspace` decides, per workspace:

- `allow`, the default: a delete is judged as a write to its folder. That covers `fs_delete`,
  what `fs_move` takes away with `replace` or when it moves a folder, and a file `fs_apply_patch`
  deletes. The folder's write grant covers it, the first write into a folder asks as it always
  did, and the file floor asks nothing.
- `ask`: every delete asks at the file floor, as before this policy.

```bash
buckle workspace set files.deleteInWorkspace ask
buckle settings set delete-in-workspace ask    # every workspace's default, BUCKLE_DELETE_IN_WORKSPACE
```

Inside means the workspace's own folder and none of its mounts: a writable mount, a scratch root,
and a path a read or write approval reached are outside, wherever they sit. Refusals stay under
both: Buckle's state, a filesystem `deny` rule, a `deny` on `fs_write`, the workspace's folder
itself, and a mount's source.

## The mass-delete guard

Under `allow`, one call still asks at the floor when it would remove:

- a folder with more than `files.massDeleteLimit` entries in all (100 by default, the folder
  itself counted), under `delete-tree:<folder>`;
- a folder at the top of the workspace's folder that holds anything, under `delete-tree:<folder>`;
- more than the limit across the call, files and folders, each folder counted whole, under
  `delete-batch:<workspace folder>`, asked once.

The reason says which: "removes more than 100 entries at once", "at the top of the workspace", or
"This call deletes 140 entries in the workspace at once". A folder moved whole removes nothing,
since all of it lands elsewhere, so it is not counted. A grant of `delete-tree:<folder>` or
`delete-batch:<workspace folder>`, for the session or always, lets that removal through again.
`buckle workspace set files.massDeleteLimit 0` turns the guard off, and `250` raises it, up to
10000; the node's default is `BUCKLE_MASS_DELETE_LIMIT` (`mass-delete-limit`).

## Outside the workspace's folder

A delete outside the folder asks at the floor, whatever the folder's write grant says, under
`delete:<folder>` for an entry or `delete-tree:<path>` for a folder removed whole, as before. The
ask also offers `delete-below:<folder>`: the folder that holds the target, with its subfolders. A
grant of it covers every later delete anywhere inside that folder, matched as a write grant
matches, except inside the workspace's own folder, which its setting decides.

| Choice | What it grants |
|---|---|
| once | this one call |
| this session, or always | the target: `delete:<folder>` covers the entries directly in that folder, `delete-tree:<path>` that folder removed whole |
| this session, or always, folder and below | `delete-below:<folder>` |

The wider subject is never offered for `once`, and strict mode (`BUCKLE_STRICT_WRITES=true`)
offers `once` alone, with no wider subject.

## Approving

- The serve terminal shows the wider subject under the ask's subject, as
  `or: delete-below:<folder>`, and numbers two more choices after the scopes:
  `(4) approve this session, folder and below` and `(5) always approve, folder and below`.
- `buckle approve <token> --scope session --below` grants it once you confirm. `--below` refuses
  `--scope once`, `--deny`, `--host`, and an ask that offers no wider subject.
- `buckle approvals --watch` takes `sb` for the session, and the word `always-below`.
- An ask in JSON carries `widerSubject`, and a decision may name the subject it grants as
  `subject`. Both are optional, so Rings, the 5straps agent control plane, at protocol 0.1.7 shows
  and approves the first subject unchanged. A device key's signed decision grants the subject of
  the challenge it signed, and names no other.

`buckle grants list` shows a `delete-below:` grant, and `buckle grants revoke <id>` removes it.

## Code mode and the shell

A script's `fs_delete` and `fs_move` meet the same policy as direct calls
([code mode](code-mode.md)). The shell is not part of it: `rm -r`, `rm -f`, a plain `rm` with a
glob or several targets, and `find -delete` still ask at the
[command floor](approvals.md#the-destructive-floor), inside the workspace's folder too.
