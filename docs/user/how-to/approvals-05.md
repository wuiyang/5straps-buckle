# Approvals: when a grant cannot be saved

Buckle, the local permission node that runs an AI agent's tool calls, keeps `session` and
`always` grants, and remembered denials, in `grants.json` in its state directory. This page covers
what happens when that file cannot be written. [Approvals](approvals.md) covers the scopes.

## An approval

A `session` or `always` approval is recorded first and its grant written after. When the write
fails:

- **The decision stands:** the call that asked still runs, once, as if you had approved it
  `once`. It gets less than you granted, never more.
- **Other calls ask:** until the grant is saved, any other call it would cover asks again, the same
  call sent anew included.
- **The answer says why:** the reason names no path, such as `permission denied`.
- **Saving again:** send the same decision again to try the write again, as often as you like. The
  next decision in the workspace, and the workspace opening again, also write it.

The decision keeps the id its grant is written under, so `buckle grants revoke <id>` finds the
grant once it is saved.

## A lasting denial

A denial for the session or always is written before it is recorded, so a denial is never recorded
without being in force. When the write fails:

- **Nothing is recorded:** the call keeps waiting, and the answer is refused with the code
  `grant_unsaved`: `Not denied for the session: saving failed: <reason>; the call still waits`.
- **Saving again:** send the same denial again.
- **Refusing just this call:** deny it once, which writes nothing to the file:
  `buckle approve <token> --deny` with no `--scope`, `d` in `buckle approvals --watch`, or `n` at
  the serve terminal.

## The reasons

| Reason | What to check |
|---|---|
| `permission denied`, `operation not permitted` | the state directory's owner and modes ([troubleshooting](../caveats/troubleshooting.md#the-state-directory-has-the-wrong-modes)) |
| `the file system is read-only` | the volume holding the state directory |
| `no space is left on the disk`, `the disk quota is used up` | free space on that volume |
| `a disk I/O error` | the disk |
| `another Buckle process holds the file` | another `buckle` command still running; send the decision again shortly |
| `a state file is unreadable or invalid` | `grants.json` or `approvals.json`, which Buckle names in its log |
| `system error <code>` or `an unexpected error` | Buckle's log, which names the error |

Each answer is also recorded in the workspace's audit log
([decision records](audit-log-03.md#decision-records)): an approval left unsaved with `grantOwed`,
and a refused denial with its `code`.
