# First run, part two

The two credentials: what each one opens, and where it lives. [Part one](first-run.md) covers the first run and the three ways to run Buckle.

## The two credentials

- The agent token belongs to the workspace. An HTTP client presents it as a bearer token to call
  tools through `buckle serve`, which serves that workspace for it. Buckle keeps only its digest,
  so `buckle init` prints it once; `buckle workspace token create` mints another.
- `BUCKLE_ADMIN_TOKEN`, the admin credential, is the node's, in `buckle.env`. It opens the
  experimental `/setup` face, which is off until `BUCKLE_EXPERIMENTAL_ADMIN_HTTP=true`, and
  `buckle workspace` needs it before it changes workspaces or mints tokens.

Running tools and answering approvals from the local CLI needs neither. Treat what `buckle init`
prints, both credentials, like the file.
