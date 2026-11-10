# Approval backend: grant saves

What the ledger does when a lasting decision's grant cannot be written to `grants.json`, and how a
person gives that grant up. The [approval backend](approval-backend.md) page covers the port and a
decision's order, and [grant save routes](approval-backend-03.md) what each route does next. Paths
are in `buckle/`.

## The ledger

`common/services/approvals/approval-registry.ts` keeps each resolved `session` or `always`
approval's grant on its entry in `approvals.json`: the id the grant is written under, its holder,
rule, subject, and scope, the source that recorded the decision, and `save`:

| `save` | Where the grant stands |
|---|---|
| `owed` | not written yet |
| `saved` | in the grant store |
| `skipping` | given up; a grant that may have saved is not yet confirmed removed |
| `skipped` | given up, and none stands |
| `dropped` | a revoke, its session's end, or a lasting denial in its place removed it or kept it from being written |

- **The settling pass:** `settleGrants` runs under the approvals lock (approvals, then grants). It
  writes each owed grant and commits it `saved`, then removes each `skipping` entry's grant by its
  id and commits it `skipped`. It runs at each decision while an entry is owed or skipping, on the
  same decision sent again, and as the workspace opens (`recover`). A failure is logged, stops that
  half of the pass, and leaves the rest for the next.
- **Kept:** an entry that is `owed` or `skipping` is never pruned; the others go ten minutes after
  their decision, as other decisions do.
- **Dropped:** a revoke or a session end marks the owed and saved grants it undoes `dropped`, under
  the same lock, so the pass never writes them and a retry says so.
- **One id:** the grant is written under the id its entry keeps, also when a pass writes it again
  after a lost commit, so a revoke by that id reaches the grant. `LedgerGrants.owed()` lists those
  not written yet (`buckle grants`), and a revoke by its id drops one.
- **Recorded:** the store's update says when its last write is on disk (`persisted`), and the
  ledger marks a decision recorded then, so a lock that then fails to release changes no answer.

## An approval left owed

The decision commits with its grant owed and, under the same lock, a `once` for the call that
asked, bound to its session, actor, tool, and fingerprint. Then the pass runs.

- **The call that asked:** runs on that `once`, waiting or sent again, until it is spent; the `once`
  goes again if the pass saved the grant. Every other call the grant would cover asks until it
  saves.
- **The receipt:** `applied`, or `repeated` on a retry, with `save` and, while it is `owed` or
  `skipping`, `saveError`. The reason comes from `common/services/approvals/grant-save.ts`, a table
  keyed by the error's code; a node error's message names the file, so it is never used.
- **A retry:** the same decision sent again, while the grant is owed only from the source that
  recorded it (`repeatOf` in `common/domain/approval/decision-guard.ts`); another source is refused
  `approver_not_allowed`. Once saved, a repeat from any source answers `repeated`.
- **A one-shot prompt:** a call under the `prompt` hold, a CLI tool command asking at its own
  terminal, waits for the terminal's questions to end once a decision this process recorded left
  its grant owed (`approval-service.ts`), so the command is still there to take a retry or a skip.

## A skip

`skipSave(token)` on the host, and `skipSave({ source: 'cli', token })` on the core approval API,
give up the grant of a `session` or `always` approval. The skip and the settling pass each run under
the approvals lock, so one goes first:

- **Skip first:** the entry turns `skipping` and commits before anything else, so no settling pass,
  retry, or opening writes the grant, then `skipped` once no grant stands. A retry then answers
  `repeated` with `save: 'skipped'`.
- **Settling pass first:** the grant is in the store, and the skip removes it by the id its entry
  kept; the receipt says `removed`. A grant a stopped process wrote while its entry still read
  `owed` is removed the same way.
- **Read before removing:** the skip lists the grant store and removes only a grant it finds, so a
  store that cannot be written never stops a skip of a grant it never held.
- **Not confirmed:** where the grants cannot be read, or the grant found cannot be removed, the
  entry stays `skipping` and the skip answers `unfinished`, with `stands` (it had saved and could
  not be removed) and `saveError`. The next settling pass, the opening, or the skip sent again
  removes it.
- **The call that asked:** its `once` stays, so it still runs; every other call asks.
- **Who:** only the source that recorded the decision, by id and kind (`guardSkip`). A `once`
  approval or a denial is refused `conflicting_decision`, a token with no decision `unknown_ask`,
  and another source `approver_not_allowed`. A grant already `skipped` or `dropped` has nothing left
  to skip, and answers `repeated`.
- **Audit:** each skip writes `approval_decision` entries through the log service, the attempt with
  `outcome: skip_save`, the result with `repeated`, `removed`, and `unfinished` where it is, or the
  refusal's `code`.

## A lasting denial

Written before its decision commits, so a denial is never recorded without being in force:

- **Superseded approvals:** the owed approvals it takes the place of are dropped and committed
  first, since one written after it would replace it in the grant store; the saved ones it replaces
  turn `dropped` with its decision.
- **A write that fails:** the decision is refused `grant_unsaved`, `retryable: true`, with
  `saveError`; each route words the warning from the decision's scope and that reason. Nothing is
  recorded, and the ask waits. A step after the update that fails still answers that refusal.
- **No skip:** nothing was recorded, so refusing just the call is a `once` denial.
- **A commit that fails:** the denial is taken back. A step that fails once the decision is
  recorded, such as waking the webhook sender or reporting an ask skipped with no response,
  leaves the decision applied and its denial in force.
