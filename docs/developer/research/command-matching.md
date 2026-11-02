# OpenCode command matching research

> Research record from 2026-09-27, lightly edited for this repository: links to design notes outside it are removed. It describes another project's matcher and the options it raised, not how Buckle matches commands today; for that, see [Policy](../../user/how-to/policy.md#commands).

## Overview

- [Source behavior](#source-behavior): wildcard matching and ordered evaluation.
- [Examples](#examples): spaces and command composition matter.
- [Buckle implications](#buckle-implications): structured matching plus isolation.

## Source behavior

Research date: 2026-09-27. Inspected OpenCode revision `a42f393c850bec0c0f395fb91bf19b1ee8b31666`; this describes the linked source, not every released OpenCode version.

The permission evaluator flattens rules, chooses the last matching permission/action pattern, and defaults to ask when no rule matches. Its imported core wildcard matcher:

- Matches the entire input string.
- Treats `*` as any character sequence, including spaces/newlines, and `?` as one character.
- Escapes other regular-expression syntax rather than accepting arbitrary regex.
- Normalizes backslashes to forward slashes.
- Matches case-insensitively on Windows.
- Makes the final space-plus-wildcard optional, allowing a bare command to match a pattern ending in ` *`.

Sources: [permission evaluator](https://github.com/anomalyco/opencode/blob/a42f393c850bec0c0f395fb91bf19b1ee8b31666/packages/opencode/src/permission/index.ts), [imported wildcard matcher](https://github.com/anomalyco/opencode/blob/a42f393c850bec0c0f395fb91bf19b1ee8b31666/packages/core/src/util/wildcard.ts). Public docs also describe wildcard rules and last-match precedence: [OpenCode permissions](https://opencode.ai/docs/permissions/).

## Examples

These describe the wildcard function alone, not a guarantee that the whole application authorizes the shell invocation:

| Pattern | Input | Matcher result |
|---|---|---|
| `git status *` | `git status` | Match |
| `git status *` | `git status --short` | Match |
| `git *` | `git status; curl example.com` | Match |
| `echo ?` | `echo ab` | No match |

Matching raw text cannot establish what a shell will execute. Parsing, working directory, executable resolution, wrappers, and policy evaluation are separate concerns. Avoid treating one matcher function as an execution sandbox.

## Buckle implications

Keep the proposed command contract from the design notes: executable identity plus exact/regex/token-glob argument rules, explicit shell handling, and a rule-preview UI. Do not quietly adopt OpenCode's last-match behavior while documenting first-match firewall rules.

Define fixtures before implementation: quoted spaces, pipelines, substitutions, redirects, newlines, Windows paths, interpreters, executable replacement, and unmatched commands. Scope an approval to the normalized action and parameters actually executed. Broad interpreter or package-script permission can authorize arbitrary code; filesystem and network containment remain necessary.
