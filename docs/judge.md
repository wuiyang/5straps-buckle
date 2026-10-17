# The decision AI

The decision AI is a model call that Buckle, the approval and sandbox runtime on this machine,
makes with the node's own key to a provider's API: Anthropic's, or any that speaks OpenAI's,
such as a gateway or a model running on this machine. It rates one kind of call: one that runs
code with an interpreter the workspace's policy does not allow, such as `python3 job.py`
([interpreters](policy-02.md#interpreters)). It is off until the owner turns it on and names a
provider, a model, and a key. [What it reads and keeps](judge-02.md) continues on the next page.

## What it rates, and what it never rates

Buckle reads shell and nothing else. A call that runs code with an interpreter no `buckle policy
allow-interpreter` names asks at the [destructive floor](approvals.md#the-destructive-floor),
since no glob can meet what that code does. That ask, and only that ask, is the judge's. It
never rates:

- a call a deny rule refuses: with any command deny glob, such a call is refused before any ask;
- a call the built-in floor asks about for its own reason, such as `sudo`, `rm -rf`, or a body
  nested too deep to read;
- a call the workspace's destructive list names;
- a call the dangerously-allow switch already lets through.

## Modes

`approval.judge` takes three values:

| Value | What happens |
|---|---|
| `off` | The default. Asks go out as they always have. |
| `on-request` | Asks go out as before, with one added line telling the approver the judge is available. |
| `automated` | The judge rates each such call as it arrives. A `safe` verdict at a confidence of 0.8 or above runs the call without a person; any other answer asks, with the verdict beside the whole action. |

A `warning` never runs a call. In automated mode the agent reads the level alone in the ask's
reason ("the decision AI rated it danger"), never the reasoning, which would show it how to steer
the next rating. Every approver reads the whole line beside the action:

```text
  judge:    danger (0.92, claude-opus-5-5): It deletes the build folder and pushes to a remote.
```

The approval webhook carries the same as a `judge` object beside each ask, and `buckle approvals
--json` inside the ask's `call`.

## On request

```bash
buckle approvals judge <token>                    # the verdict beside the whole action
buckle approvals judge <token> --approve-if-safe  # and approve it once where it is safe
```

The command prepares the call again from the arguments its ask kept, reads its code afresh, and
prints the whole action as `buckle approvals show` does, with the verdict, the confidence, the
model, and the reasoning. With `--approve-if-safe`, a safe verdict at 0.8 or above approves the
ask once, recorded as decided by the judge; any other verdict approves nothing and exits 0, and
no verdict exits 1. Each run is audited with what the judge said. It takes `--workspace <name>`,
and works in automated mode too, for an ask left waiting.

## Settings

Each is a workspace setting, set with `buckle workspace set <key> <value>`, else the node's
default in `buckle.env` (`buckle settings set <alias> <value>`), else Buckle's own:

| Workspace key | Node default | Buckle's own |
|---|---|---|
| `approval.judge` | `BUCKLE_APPROVAL_JUDGE` | `off` |
| `approval.judgeProvider` | `BUCKLE_APPROVAL_JUDGE_PROVIDER` | none: `anthropic` or `openai` |
| `approval.judgeModel` | `BUCKLE_APPROVAL_JUDGE_MODEL` | none: a model name, such as `claude-opus-5-5` or `GPT-6-luna` |
| `approval.judgeStandardScripts` | `BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS` | the list below |

The node alone holds `BUCKLE_JUDGE_API_KEY`, the provider's key, and `BUCKLE_JUDGE_BASE_URL`,
the address of an OpenAI-compatible endpoint (unset: OpenAI's own). Both go in `buckle.env` by
hand: `buckle settings show` names them and never prints them, no workspace sets them, and no
command Buckle runs receives them. The Anthropic provider always asks `https://api.anthropic.com`.
Where the judge is on but its provider, its model, or the key is missing, it stays off in that
workspace, and `buckle serve` says once at start which setting or key is missing, by name.

```bash
buckle workspace set approval.judgeProvider anthropic
buckle workspace set approval.judgeModel claude-opus-5-5
buckle workspace set approval.judge on-request
```

## Standard development scripts

Some commands run the project's own tooling, so the judge rates them on their command line
alone and is shown no file: by default `npm run *`, `npm test`, `npm start`, `pnpm run *`,
`pnpm dev`, `pnpm build`, `pnpm test`, `yarn run *`, `yarn dev`, `yarn build`, `yarn test`,
`bun run *`, `npx tsc *`, `npx vitest *`, `npx eslint *`, `npx prettier *`, `pnpx tsc *`,
`pnpx vitest *`, `bunx tsc *`, and `bunx vitest *`, in the allow list's glob syntax. `npm run dev`
runs whatever `package.json` names, so the list is the owner's call: set your own, separated by
`;;`, or empty it with `buckle workspace set approval.judgeStandardScripts ''`. Only an interpreter
call reaches the judge, so of these the `npx`, `pnpx`, and `bunx` entries are the ones that
apply today: `npm`, `pnpm`, `yarn`, and `bun run` are ordinary commands.
