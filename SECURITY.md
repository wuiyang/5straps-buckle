# Security policy

## Supported versions

Buckle is pre-release. Only the latest commit on the main branch receives security fixes.
There are no maintained release lines yet.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it through GitHub private vulnerability reporting on this repository: open the
Security tab and use the "Report a vulnerability" advisory form
(<https://github.com/wuiyang/buckle/security/advisories/new>). That form is the only
reporting channel; there is no security email address.

Include the package, the version or commit, steps to reproduce, and the impact you expect.

## Disclosure window

- Acknowledgement within: 3 business days of the report.
- Fix or coordinated publication within: 90 days of acknowledgement.

The maintainers may ask for more time when a fix needs a data or schema migration.

## Scope

In scope, as built in this repository:

- Buckle, the approval and sandbox runtime for AI agents (`buckle/`, published as
  `@5straps/buckle`)
- The protocol package (`packages/protocol/`, published as `@5straps/protocol`)
- The runtime package (`packages/runtime/`, published as `@5straps/runtime`)

Out of scope:

- Third-party model providers and gateways, and their handling of data sent to them
- Services Buckle can report to, such as a Rings control plane, which are not built here
- The owner's own configuration: environment files, tokens, policy rules, host setup,
  and any permission the owner chose to grant

## Permission model

Buckle runs what its policy allows, asks a person before anything else runs, shows that
person the full action with only credentials redacted, and refuses what the policy denies.
A report that shows Buckle running a call it should have asked about or refused, or showing
an approver less than the full action, is in scope.

## Audits and certification

No external security audit, penetration test, or certification exists for Buckle.
The checks in this repository are the maintainer's own.
