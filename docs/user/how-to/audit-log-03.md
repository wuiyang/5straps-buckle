# The audit log, part three

[Part one](audit-log.md) covers the log's file and its entries, and [part two](audit-log-02.md)
how it is written and what is queued.

## Decision records

Every answer that reaches the approval service writes two `approval_decision` entries in its
workspace's log, whichever route it came by: the serve terminal, `buckle approve`,
`buckle approvals --watch`, `--approve-if-safe`, a stdio MCP form, or the setup and device routes.
The attempt is written as Buckle receives the answer, and the result once it applied (`ok`) or was
refused (`error`, its detail the refusal's code, such as `scope_not_offered`). An answer that
stopped on an error ends with an `error` result and no code. A device's or an envelope's answer
refused while Buckle reads it (its proof, its envelope, a device naming a subject, or a body that
does not parse) writes none: the setup POST's `setup_post_approvals` entries record it, beside
`setup_approval_proof_refused` or `setup_approval_envelope_refused` for a refused proof or envelope.

Their `args` hold the `token`, the `outcome` (`approve` or `deny`), the `scope`, the `source` (its
`id` and `kind`), and the `proof` (`none`, `device`, or `envelope`), with `decidedBy` where an
enrolled key or the decision AI decided. A result adds the `assurance`, `repeated`, and
`grantOwed`, or the refusal's `code`. A refusal's reason is not kept, since it can name a path.
Each names who answered as its `actorId`: the key or judge that decided, else `local-owner` for the
terminal and the CLI, the route's name (`forms`, `sealed`), or `backend:<id>`.

No tool takes a name Buckle writes its own records under: `approval_decision`, `log_dropped`, and
those starting `cli_`, `setup_`, `workspace_`, or `policy_`. An agent's call naming one is refused
as an unknown tool, and leaves no entry.

`buckle approve` also keeps its `cli_approve` entries, and `buckle approvals --watch` its
`cli_approvals` entries for the whole watch; each answer the watch takes is in the decision records
alone.
