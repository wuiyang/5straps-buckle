# The audit log, part three

[Part one](audit-log.md) covers the log's file and its entries, and [part two](audit-log-02.md)
how it is written and what is queued.

## Decision records

Every answer that reaches the approval service writes two `approval_decision` entries in its
workspace's log, whichever route it came by: the serve terminal, `buckle approve`,
`buckle approvals --watch`, `--approve-if-safe`, an MCP form over stdio or HTTP, or the setup and device routes.
The attempt is written as Buckle receives the answer, and the result once it applied (`ok`) or was
refused (`error`, its detail the refusal's code, such as `scope_not_offered`). An answer that
stopped on an error ends with an `error` result and no code. A device's or an envelope's answer
refused while Buckle reads it (its proof, its envelope, or a body that does not parse) writes
none: the setup POST's `setup_post_approvals` entries record it, beside
`setup_approval_proof_refused` or `setup_approval_envelope_refused` for a refused proof or envelope.

Their `args` hold the `token`, the `outcome` (`approve` or `deny`), the `scope`, the `source` (its
`id` and `kind`), and the `proof` (`none`, `device`, or `envelope`), with `decidedBy` where an
enrolled key or the decision AI decided. A result adds the `assurance`, `repeated`, and, for a
`session` or `always` approval, `save`: where its grant stands (`owed`, `saved`, `skipping`,
`skipped`, or `dropped`), or the refusal's `code`. A refusal's reason is not kept, since it can name a path.

- **`widening`:** its `kind`, `none`, `below` (a delete's folder and its subfolders, as every
  route's folder and below choice grants), or `host` (a host pattern, as `buckle approve --host`
  grants, its `subject` the pattern). A result that applied a widening names the `subject` the
  grant took in place of the ask's own.
- **`call`:** on a result, the call the answer met: the `requestId` and `auditId` of that call's
  attempt entry, which find it in this log, and the ask's `rule` and `subject`. A subject is kept
  as written, a command line as its program and its length, a credential in a path hidden. An
  answer refused before Buckle read its ask, or for a token it does not hold, names none.

Each names who answered as its `actorId`: the key or judge that decided, else `local-owner` for the
terminal and the CLI, the route's name (`forms`, `sealed`), the agent token that sent an HTTP form
(`agent:<id>`), or `backend:<id>`. An HTTP form answer to an ask its token did not raise, or to no
waiting ask, is not read, and writes none.

Skipping the save of an approval whose grant could not be written
([when a grant cannot be saved](approvals-05.md)) writes two `approval_decision` entries too. Their
`args` hold the `token`, the `outcome` `skip_save`, and the `source`; a result adds `repeated`
(the save was skipped already) and `removed` (its grant had saved and is gone), or the refusal's
`code`, such as `approver_not_allowed` for a route that did not record the decision. A skip whose
grant is not confirmed removed ends `ok` with `removed: false` and `unfinished: true`. A retry of the save is
the same decision sent again, recorded as any decision is, with `repeated`.

Each session that [ends](approvals-07.md) writes one `approval_session_ended` result entry under
that session's id. Its `args` hold the `actor` that asked in it, where one did, the `cause`
(`idle`; `stdio_closed` as a `buckle mcp` process exits; `serve_stopped`, or `serve_started` as
serve first opens the workspace after it starts), and how many
asks it `withdrawn`, unspent `onces` it dropped, `owed` grants it kept from being written, and
session `grants` and `denials` it removed. A session with none of these writes none.

Each ask nobody answered before it ran out ([when nobody answers](approvals-09.md)) writes one
`approval_skipped` result entry, `ok`, with the `detail` `no_response`. It names no actor, as nobody
answered. Its `args` hold the `token`, the `reason` `no_response`, and the `call`, as a decision's
result names it. The process whose update dropped the ask writes it.

No tool takes a name Buckle writes its own records under: `approval_decision`, `log_dropped`,
`approval_session_ended`, `approval_skipped`, and those starting `cli_`, `setup_`, `workspace_`, or
`policy_`. An agent's call naming one is refused as an unknown tool, and leaves no entry.

`buckle approve` also keeps its `cli_approve` entries, whose result reads `ok` for a decision that
applied though its grant did not save, and `buckle approvals --watch` its
`cli_approvals` entries for the whole watch; each answer the watch takes is in the decision records
alone.
