# The decision AI

The decision AI is an optional check that rates a command before a person has to. Buckle, the
approval and sandbox runtime on this machine, asks one or two models with the node's own keys:

- **Jev**, TypeSafe AI's quick stage: a decision model that answers typed questions with a choice
  and a confidence, in well under a second, with no written reasoning.
- **The thorough model**: a general model reached through an OpenAI-compatible endpoint, such as an
  AI gateway (one address that forwards to many model providers).

Both answer `safe`, `warning`, or `danger` with a confidence from 0 to 1. Everything is off until
the owner turns it on. [What it reads and sends](judge-02.md), [what it keeps and
shows](judge-03.md), [its instructions, settings, cache, and cost](judge-04.md), and [why it rates
nothing](judge-05.md) continue on the next pages.

## Modes

`approval.judge` governs the whole decision AI:

| Value | What happens |
|---|---|
| `off` | The default. Nothing is rated, and asks go out as they always have. |
| `on-request` | Asks go out as before, with one line saying the decision AI is available ([on request](judge-03.md#on-request)). |
| `automated` | Each call in scope is rated as it arrives, and the routing below decides. |

## What each stage rates

The thorough model rates an ask about running code with an interpreter the policy does not allow,
such as `python3 job.py` ([interpreters](policy-02.md#interpreters)), and on request any ask Jev's
scope covers. `approval.quickJudge` sets what Jev rates:

| Value | Jev rates |
|---|---|
| `off` | Nothing: the default. |
| `interpreters` | The interpreter asks the thorough model rates. |
| `asks` | Every command ask a person would see at the [destructive floor](approvals.md#the-destructive-floor): an interpreter, the built-in floor (`sudo`, `rm -rf`), a command written as a path, and the workspace's destructive list. |
| `all` | Every command, allowed ones too, in automated mode only: an allowed command runs unless Jev rates it `danger` at 0.8 or above, which turns it into an ask; one whose code the reader cannot read whole is rated on its command line. |

Jev's verdict is a rating alone and never runs a call. An ask at the destructive floor, from the
built-in floor or the destructive list, always goes to a person whatever either model says, its
line led by "a command at the destructive floor always needs a person". A deny is never rated and
never lifted, nothing either model says refuses a call, and a call the dangerously-allow switch lets
through is not rated.

## Routing in automated mode

| Jev's answer | What happens |
|---|---|
| `danger` at 0.8 or above | A person decides, the verdict beside the whole action; the thorough model is not asked. |
| `safe`, `warning`, a lower confidence, no verdict, a call over Jev's budget, or Jev off | An interpreter ask goes to the thorough model; any other goes to a person, Jev's verdict beside the action. |

The thorough model's `safe` at 0.8 or above lifts an interpreter ask, and the call runs once no
other ask remains, named in the audit entry and at the serve terminal; any other answer asks, with
both verdicts beside the action. A pass binds to the code it rated: Buckle reads that code again
under the write lock just before the program starts, and where it changed the call does not run,
the ask going to a person with "the code changed after the decision AI rated it". A `warning`
never runs a call. The agent reads the level alone in the ask's reason ("the decision AI rated it
danger"), never the reasoning, which would show it how to steer the next rating.

## Standard development scripts

These run the project's own tooling, so a stage rates them on the command line alone, shown no file
but what bun preloads first: by default `npm run *`, `npm test`, `npm start`, `pnpm run *`, `pnpm
dev`, `pnpm build`, `pnpm test`, `yarn run *`, `yarn dev`, `yarn build`, `yarn test`, `bun run *`,
`npx tsc *`, `npx vitest *`, `npx eslint *`, `npx prettier *`, `pnpx tsc *`, `pnpx vitest *`, `bunx
tsc *`, and `bunx vitest *`, in the allow list's glob syntax. `bun run` naming a file (`bun run
./deploy.ts`) is read like `bun <file>`, and no call with `sudo` or another privilege wrapper, nor
a runner named by a path inside the workspace or a mount (`./bin/npx`), is a standard script.
Where the form names a `package.json` script (`npm run build`, `npm test`, `npm start`, `pnpm dev`,
`yarn build`, `bun run dev`), both stages are shown that script's text from the working directory's
`package.json` as context, clipped at 2,000 characters; a missing `package.json` or script asks a
person, and an allowed command screened under `all` is rated on its command line instead. `bun run`,
`npx`, `pnpx`, and `bunx` are interpreter invocations, so they ask on their own; `npm`, `pnpm`, and
`yarn` never ask on their own, so they reach a stage under `approval.quickJudge all` in automated
mode, or, under `asks` or `all`, when the destructive list names them, and a person still decides.
`npm run dev` runs whatever `package.json` names, so the list is the owner's call: set your own,
separated by `;;`, or empty it with `buckle workspace set approval.judgeStandardScripts ''`, or the
node's with `buckle settings set approval-judge-standard-scripts ''`; unset restores the default.
