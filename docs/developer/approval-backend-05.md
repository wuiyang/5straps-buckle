# Approval backend: MCP forms over HTTP

How `/mcp` draws forms, what each one offers, and who may open them. [MCP
forms](approval-backend-04.md) covers the setting and the caller check, and [MCP
forms](../user/how-to/approvals-06.md) the setting as an owner sets it. Paths are in `buckle/`.

## The wiring

`mcp/http.ts` keeps one stateless SDK handler per workspace runtime, and opens that runtime's HTTP
forms with it: `openForms(runtime, { face: 'http' })` in `mcp/open-forms.ts`. Each per-request
server the handler builds gets the same forms backend, so a form drawn in one request is answered
in the next. The backend closes with the runtime's approvals, as every forms backend the service
opened does.

`mcp/server.ts` is the same for both faces. At each call it reads the forms setting; on, it hands
the call's `inputResponses` to the forms with the transport's caller, and, for a client that
declares form elicitation, answers an ask with `input_required` and one form per ask at once,
instead of holding the call. The client sends the call again with its answers, which joins the
first call's ask by the resend join, so the call runs once. Where an answer's grant did not save,
the face returns a save form first and invokes nothing ([grant save
routes](approval-backend-03.md#each-route)), over HTTP as over stdio.

- **A 2026-07-28 client:** declares its capabilities in every request's `_meta` envelope, which the
  first capability reader takes. Claude Code's HTTP client is one ([the
  probe](approval-backend-04.md#claude-code-over-http)).
- **A 2025-era client:** declares them once, in `initialize`. The stateless handler builds a new
  server for each request, so the one that answers its `tools/call` never saw that handshake,
  `getClientCapabilities()` is empty, and the call gets the relay text. The SDK's legacy shim
  could not elicit on that connection either.

## What a form offers

A form offers what its ask offers, whichever face draws it: the owner ruled (APPROVAL-17, and
APPROVAL-33 of 2026-11-09) that where an ask is answered changes nothing it offers. The
`http-forms` row in `common/domain/approval/assurance.ts`
is the `forms` row with `sameCaller`, so an HTTP form approves `once`, `session`, or `always` as
the ask offers them, floor asks included, and the guard still checks each answer: a destructive
command never takes `always`, and a host pattern is `buckle approve`'s alone. A credential
file's form offers its lasting denials; an ask kept without its whole call gets the denial form.
Each form is one `action` field whose enum lists the terminal's choices for its ask,
`allow_<scope>` per offered scope, then `allow_<scope>_below` per lasting one where the ask has a
[wider subject](approval-backend-11.md), then `deny`, and for a credential file `deny_session` and
`always_deny`, so no answer it admits is one the guard refuses (`approvalForm` in
`mcp/forms-backend.ts`). An answer in the earlier `approve` and `scope` shape still reads; its
denial denies once, as the terminal's does.

- **`host.reach`:** `{ sameCaller }`, which core sets on each host it opens with
  `reachOf(rightsOf(source.kind))`, so the forms and the guard read one row: where it holds, the
  forms read answers only to the asks their own caller raised.

## The answers read

`answer` reads at most `MOST_FORM_ANSWERS` keys a round, one call's forms, since a session keeps
at most 50 asks waiting, and reads the waiting asks once with `host.pending()`. An approval answer
goes to `host.decide` only for one of them, and where `reach.sameCaller` holds, only for one its
sender raised; any other key costs no record and no lock. A `save:` key settles the question the
backend drew for its sender ([grant save routes](approval-backend-03.md#each-route)). A form that
comes back declined or cancelled decides nothing, and the call sent again draws the forms again
at once.

## The caller

`transportSender()` in `mcp/server.ts` reads the actor of the request's operation scope, which the
agent guard set to `agent:<tokenId>`, and the forms pass it with each answer. The guard holds an
`http-forms` answer to the asks that actor raised, and the decision record names it
(`common/adapters/approval/logged-decision-audit.ts`), so the workspace's log shows which token
answered. Every client under one token is one caller.

## Who opens forms

The forms opener is no member of the runtime every face holds. `createRuntime` binds each runtime's
opener in `common/services/workspaces/forms-opener.ts`, which only `mcp/open-forms.ts` imports, and
only the stdio and HTTP faces import that. `test/approval-boundary.test.ts` holds it by type, the
runtime type has no opener, and by import: each module's static, re-exported, side-effect, and
dynamic imports resolved, in either quote, and each module's file name looked for in every source.
A specifier assembled at run time from pieces is beyond that scan.

## Tests

- `test/mcp-http-forms.test.ts`, on the face's own handler with a real runtime: a `tools/call`
  built from Claude Code's recorded `_meta` envelope draws one form per ask, and the call sent
  again with a `once` answer runs, recorded under its caller; `@modelcontextprotocol/client` 2.0.0
  plays the round itself; every offered scope, a `session` answer saving its own caller's grant, a
  floor ask approved, another token's answer and 300 unknown keys left unread with no record and
  the approvals file untouched, a dismissed form drawn again at once, the forms closed with the
  runtime's approvals, a 2025-era client's relay text, and the setting off.
- `test/http/mcp-http.test.ts`: the same round on the real `/mcp` route, under the agent token.
- `test/approval-choice-parity.test.ts`: a plain write, a floor command, a file floor delete in
  and outside the workspace, a secret reference file, and a script file run, each made by its
  rule and kept in a real ledger. Each route is driven for all it can send: every key the serve
  terminal and `--watch` take, every answer a stdio and an HTTP form's schema admits, and every
  `--scope`, `--deny`, and `--below` from `buckle approve` and a device, which the guard holds to
  the same set. The guard takes each form choice from its own caller.
- `test/forms-backend.test.ts`: the same forms for either face, the answers read and the cap, the
  reach core hands, and the save form's answers, a skip without its question included.
- `test/mcp-save-form.test.ts` and `test/mcp-http-save-form.test.ts`: the save form over stdio,
  and over HTTP. Each also lets the SDK's own client play
  all three rounds, a 2025-era one through the server's legacy shim and a 2026-07-28 one over
  HTTP; a call of two asks sent again with the save answer alone still runs once on both. Over
  stdio, a skip after a restart removes the grant the reopening wrote; over HTTP, core refuses
  another token's skip.
