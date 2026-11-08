# Approval backend: grant save routes

What each route does with a decision whose grant did not save. [Grant saves](approval-backend-02.md)
covers the ledger, and the [approval backend](approval-backend.md) page the port. Paths are in
`buckle/`.

## The question

`common/adapters/approval/grant-save-question.ts` holds what every route does next, beside the
terminal backend and the CLI that share it. The ledger keeps no route's wording: it answers with
save states and reasons.

- **What did not save:** `unsavedOf` reads a receipt: an approval with `save: 'owed'`, one
  `skipping`, whose removal is not confirmed, or a `grant_unsaved` refusal. The warning is worded
  from the decision's scope and the receipt's `saveError`.
- **The loop:** `settleUnsaved` asks through the route's `ask`, then sends the same decision again,
  skips the save, or denies the call once, until it saves, is skipped, or is left; a retry that
  fails asks again, with no cap. An `unfinished` skip asks once more, offering only a retry of the
  removal.
- **Endings:** a retry ends `saved` only where its receipt says `saved`, and `dropped` where a
  revoke, a session end, or a denial in its place removed the grant. Its words, keys, and endings
  are one table there.

## Each route

- **The terminal backend:** a `grant_save` question through the requester, by key, closed after
  `SAVE_QUESTION_WAIT_MS` (`terminal-question.ts`). An approval's waits on the backend's close
  alone, since the submit's signal aborts once the call clears; a denial's ends with its ask. A
  lasting denial left unsaved is asked again. The ending goes to `host.log`.
- **`buckle approve` and `--watch`:** the same loop over the core approval API, as `cli`. Without a
  terminal, `buckle approve` prints the warning and the commands and exits 5 (`cli/exit-codes.ts`);
  its `cli_approve` result still reads `ok` where the decision applied. `--watch` shows a lasting
  denial left unsaved again at its next poll.
- **The setup POST:** an owed approval answers `grantOwed` and `saveError`; a decision refusal
  answers 409 with its `code`, and `saveError` for `grant_unsaved`, which `server/error.ts` writes
  beside `error`. `buckle client approve` words the warning from them and exits 5.

## Backends

A backend never sends a decision again, nor skips a save, on its own: after a receipt with `save:
'owed'` or a `grant_unsaved` refusal, though the refusal is retryable, its person retries, skips, or
leaves it. The contract kit in `test/support/approval-backend-kit.ts` holds these duties, and that
a retry sends the same decision once more and a skip calls `skipSave`, or denies a lasting denial
once. Its fake host records each skip. The contract stays version 1 with these fields.
