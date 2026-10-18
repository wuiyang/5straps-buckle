# The decision AI

The decision AI is an optional check that rates a command before a person has to. Buckle, the
approval and sandbox runtime on this machine, asks one or two models with the node's own keys:

- **Jev**, TypeSafe AI's quick stage: a decision model that answers typed questions with a choice
  and a confidence, in well under a second, with no written reasoning.
- **The thorough model**: a general model reached through an OpenAI-compatible endpoint, such as an
  AI gateway (one address that forwards to many model providers).

Both answer `safe`, `warning`, or `danger` with a confidence from 0 to 1. Everything is off until
the owner turns it on. [What it reads and sends](judge-02.md) and [what it keeps and
shows](judge-03.md) continue on the next pages.

## Modes

`approval.judge` governs the whole decision AI:

| Value | What happens |
|---|---|
| `off` | The default. Nothing is rated, and asks go out as they always have. |
| `on-request` | Asks go out as before, with one line telling the approver the decision AI is available. |
| `automated` | Each call in scope is rated as it arrives, and the routing below decides. |

## What each stage rates

The thorough model rates an ask about running code with an interpreter the policy does not allow,
such as `python3 job.py` ([interpreters](policy-02.md#interpreters)), and any ask Jev rated without
settling. `approval.quickJudge` sets what Jev rates:

| Value | Jev rates |
|---|---|
| `off` | Nothing: the default. |
| `interpreters` | The interpreter asks the thorough model rates. |
| `asks` | Every command ask a person would see at the [destructive floor](approvals.md#the-destructive-floor): an interpreter, the built-in floor (`sudo`, `rm -rf`), and the workspace's destructive list. |
| `all` | Every command, allowed ones too, in automated mode only. An allowed command runs unless Jev rates it `danger` at 0.8 or above, which turns it into an ask. |

Under `asks` and `all`, a Jev `safe` at 0.8 or above can run a call the built-in floor or the
destructive list asks about, such as `sudo apt update`: choose it knowing that. A deny is never
rated and never lifted, nothing either model says refuses a call, and a call the dangerously-allow
switch lets through is not rated.

## Routing in automated mode

| Jev's answer | What happens |
|---|---|
| `safe` at 0.8 or above | Its ask is lifted, and the call runs once no other ask remains; the audit entry and an info line at the serve terminal name Jev. |
| `danger` at 0.8 or above | A person decides, the verdict beside the whole action; the thorough model is not asked. |
| `warning`, a lower confidence, no verdict, a call over Jev's budget, or Jev off | An interpreter ask, or one Jev rated, goes to the thorough model; any other ask goes to a person. |

The thorough model runs the call on `safe` at 0.8 or above; any other answer asks, with both
verdicts beside the action. A `warning` never runs a call. The agent reads the level alone in the
ask's reason ("the decision AI rated it danger"), never the reasoning, which would show it how to
steer the next rating.

## On request

```bash
buckle approvals judge <token>                    # both verdicts beside the whole action
buckle approvals judge <token> --approve-if-safe  # and approve it once where one is safe
```

The command prepares the call again from the arguments its ask kept, reads its code afresh, has
every stage that applies rate it, and prints the whole action as `buckle approvals show` does,
with each verdict, confidence, and model, and the thorough reasoning. With `--approve-if-safe`,
either stage's `safe` at 0.8 or above approves the ask once, recorded as decided by that stage and
its model; anything else approves nothing and exits 0, and no verdict at all exits 1. Each run is
audited with what was said. It takes `--workspace <name>`, and works in automated mode too.

## Settings

Each is a workspace setting (`buckle workspace set <key> <value>`), else the node's default in
`buckle.env` (`buckle settings set <alias> <value>`), else Buckle's own:

| Workspace key | Node default | Buckle's own |
|---|---|---|
| `approval.judge` | `BUCKLE_APPROVAL_JUDGE` | `off` |
| `approval.judgeProvider` | `BUCKLE_APPROVAL_JUDGE_PROVIDER` | `openai-compatible` |
| `approval.judgeModel` | `BUCKLE_APPROVAL_JUDGE_MODEL` | `gpt-6-luna` |
| `approval.judgeStandardScripts` | `BUCKLE_APPROVAL_JUDGE_STANDARD_SCRIPTS` | the list below |
| `approval.quickJudge` | `BUCKLE_APPROVAL_QUICK_JUDGE` | `off` |
| `approval.quickJudgeProvider` | none | `typesafe` |
| `approval.quickJudgeModel` | `BUCKLE_APPROVAL_QUICK_JUDGE_MODEL` | `jev-latest` |

Set the model your gateway serves: it may name `gpt-6-luna` differently. The node alone holds, by
hand in `buckle.env` and read from that file alone, never from a shell's or an MCP config's env,
`BUCKLE_JUDGE_API_KEY` and `BUCKLE_JUDGE_BASE_URL` (unset: `https://api.openai.com/v1`),
`BUCKLE_QUICK_JUDGE_API_KEY` and `BUCKLE_QUICK_JUDGE_BASE_URL` (unset: `https://api.typesafe.ai`),
and `BUCKLE_SOCKET_API_KEY` and `BUCKLE_SOCKET_BASE_URL` (unset: `https://api.socket.dev`) for
[Socket](judge-02.md#packages-and-socket), a supply-chain security service. `buckle settings show`
names them and never prints them, no workspace sets them, and no command Buckle runs receives them.
A stage whose key is missing stays off, and `buckle serve` says once at start which key, by name.

## Standard development scripts

These run the project's own tooling, so a stage rates them on the command line alone, shown no
file: by default `npm run *`, `npm test`, `npm start`, `pnpm run *`, `pnpm dev`, `pnpm build`,
`pnpm test`, `yarn run *`, `yarn dev`, `yarn build`, `yarn test`, `bun run *`, `npx tsc *`,
`npx vitest *`, `npx eslint *`, `npx prettier *`, `pnpx tsc *`, `pnpx vitest *`, `bunx tsc *`, and
`bunx vitest *`, in the allow list's glob syntax. `bun run` naming a file (`bun run ./deploy.ts`)
is read like `bun <file>`, and no call with `sudo` or another privilege wrapper in it is a standard
script. `bun run`, `npx`, `pnpx`, and `bunx` are interpreter invocations, so they ask on their own;
`npm`, `pnpm`, and `yarn` never ask on their own, so they reach a stage under
`approval.quickJudge all` in automated mode, or when the destructive list names them. `npm run dev`
runs whatever `package.json` names, so the list is the owner's call: set your own, separated by
`;;`, or empty it with `buckle workspace set approval.judgeStandardScripts ''`, or the node's with
`buckle settings set approval-judge-standard-scripts ''` (unset brings back the built-in list).
