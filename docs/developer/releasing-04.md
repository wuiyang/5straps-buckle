# Releasing: one-time setup

## Overview

- [npm trusted publishing](#npm-trusted-publishing): a stage-only trusted publisher on each package, and no npm token.
- [GitHub rules](#github-rules): the `npm` environment, and the branch and tag rules the release push meets.

## npm trusted publishing

[Releasing](releasing.md) covers the two release workflows, and
[Releasing: repeats and approval](releasing-02.md) covers finishing a release.

On npmjs.com, open each of the three packages, then Settings, then Trusted publishing, and add a
trusted publisher for GitHub Actions:

| Field | Value |
|---|---|
| Organization or user | `wuiyang` |
| Repository | `5straps-buckle` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed actions | `npm stage publish` only, which trusted publishing always allows |

Do not allow `npm publish`. With it allowed, any `release.yml` run could publish without human
approval, a copy on another branch included. A connection cannot be edited, so delete any
connection that allows `npm publish` and create a stage-only one in its place, on every package.
New connections created after 3 September 2026 allow staged publishing by default. Check the
active connection's identity fields on every package.
See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) and
[staged publishing](https://docs.npmjs.com/staged-publishing/).

Never re-run a `release.yml` run from before staging: a re-run keeps its original workflow, which
still runs `npm publish`.

No npm token is stored. npm trades the staging job's GitHub identity for a short-lived one.
Approving stages requires a human npm account with package publishing permission and 2FA;
OIDC cannot approve, reject, list, or inspect stages.

## GitHub rules

- The staging job runs in an environment named `npm`. Before the first real publish, make the
  repository public, then create this environment in Settings, Environments, and allow deployments
  from `main` only; a required reviewer is optional. A `dry_run` skips the staging job and does
  not create the environment. Until the deployment rule is set, only a test inside `release.yml`
  holds staging to `main`, and a run on another branch uses that branch's copy. On GitHub Free,
  environments are configurable only for public repositories
  ([Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
- A branch rule or ruleset on `main` that requires pull requests, status checks, or signed commits
  (the release commit is unsigned), or that restricts who may update `main`, refuses the push
  Prepare release makes, and the release stops there. The push is a fast-forward, leased on the
  source commit, so a rule that only blocks force pushes accepts it.
- A tag rule that stops the workflow token from creating `v*` tags refuses the atomic push
  Prepare release makes. Neither the branch nor the tag changes.
