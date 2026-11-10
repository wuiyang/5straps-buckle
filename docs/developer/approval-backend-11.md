# Approval backend: the wider subject on every route

For a delete outside the workspace, an ask's wider subject, `delete-below:<folder>`, grants that
folder and its subfolders for the session or always. Every route a person answers on offers it,
and grants it alike (APPROVAL-37, owner 2026-11-10, under APPROVAL-33: every route offers the
same options for the same ask). The older rule that only the terminal, the CLI, and config widen
(APPROVAL-09) no longer holds for it. [Deletes](../user/how-to/policy-05.md) covers the choices.
Paths are in `buckle/`.

## The guard

`widerGrant` in `common/domain/approval/decision-guard.ts` takes the wider subject from any source
whose rights say `person`: the terminal, `cli`, both forms, and devices. The decision AI is no
person, and is refused "Only a person grants a folder and its subfolders". `SourceRights.widens` is
gone, as it now equals `person`. A host pattern stays `cli`'s alone (`checkWidening`).

## The forms

`approvalForm` in `mcp/forms-backend.ts` lists `allow_session_below` and `allow_always_below`, for
each lasting scope the ask offers, after its own subject's choices and before the denials, as the
terminal numbers them. `ACTION_DECISIONS` maps each to `{ scope, widen: 'below' }`, the decision
the terminal's `session_below` and `always_below` send, so the ledger's `widened` turns it into the
same grant and the audit names the same `below` widening.

## The device route

- **The challenge:** `ApprovalChallengeSchema` in `packages/protocol/src/signed-request.ts` gains
  an optional `widerSubject`, inside the signed bytes. The node signs it in only for a listing
  asked with `widerSubject` among `?fields=`, as with `workspaceName`, since an older device parses
  strictly (`challengeListing` and `challengeOf` in `common/domain/approval/challenges.ts`).
- **The decision:** `buckle client approve --below` (`cli/client.ts`) names the challenge's wider
  subject as the signed decision's `subject`, after `--deny`, `--scope once`, and a challenge
  without one are refused. `readSigned` in `core-approval-api.ts` reads a named subject as
  `widen: 'below'`, and the ledger keeps the subject as named, so the guard holds it to the ask's.
- **What it was shown:** `shownDigests` counts, for a decision that grants the wider subject, only
  the digests of challenges that carried it; one on another challenge is `action_mismatch`.

## Tests

- `test/approval-choice-parity.test.ts`: every route sends the same set for each ask, the serve
  terminal, `--watch`, a stdio and an HTTP form, `buckle approve`, and a device, with no exception.
- `test/approval-decision-audit.test.ts`: the same `below` widening from each route.
- `test/forms-backend.test.ts`: the form's choices, and a form's grant record equal to the CLI's.
- `test/delete-below.test.ts` and `test/core-approval-api.test.ts`: the challenge field, and the
  device's decision on a challenge that showed it, or not.
- `test/http/approval-proofs.test.ts`: `buckle client approve --below` end to end.
