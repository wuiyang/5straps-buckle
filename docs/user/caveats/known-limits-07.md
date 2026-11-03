# Known limits, part seven

Continues [part six](known-limits-06.md) on the [decision AI](../how-to/judge.md). The
[first part](known-limits.md) lists the other limits.

## Programs the agent may have placed

- A program a call runs is the file its typed word names, so none the agent could have placed is
  rated: an interpreter, a wrapper such as `env`, `nice`, or `timeout`, a shell, or a runner such
  as `npx`, named by a path inside the workspace or a mount (`./fv/bin/env python3 job.py`,
  `./fv/bash -c 'python3 job.py'`), typed directly, behind another wrapper, or in shell text. Such a
  runner is never a standard script (`./bin/npx vitest run`). An absolute path outside the
  workspace and every mount is still rated (`/usr/bin/env python3 job.py`, `/bin/bash -c`), but
  one that names no file is not.
- An absolute program path holding a backslash is not rated on Linux and macOS, where the backslash
  is part of the file's name (`/workspace/fv\python3`), so the file is one the agent could have
  placed.
- An absolute program path holding a `.` or `..` segment, or lying under `/proc` or `/dev/fd`, is
  not rated: the kernel follows a link before the `..` after it, so
  `/workspace/l/../../usr/bin/python3` may run a file the agent placed, and `/proc/self/cwd` is the
  caller's own folder.
- Any relative program path holding a separator is not rated, even one that seems to leave the
  workspace: the sandbox runs the call at `/workspace` under a root holding each mount at its
  target, so `../data/fv/bin/python3` reaches the mount at `/data`, and `../workspace/x` the
  workspace itself.
- A command word that reads as an assignment is not rated: a direct call of `FOO=1 python3 job.py`
  runs a program named `FOO=1`, and a wrapper that runs its command (`nice FOO=1 ...`) does the
  same. In shell text, `"FOO"=x`, `F\OO=x`, `'FOO=x'`, and `FOO+=x` are the program a shell runs,
  so they ask a person under every shell, though bash and zsh apply `FOO+=x` as an assignment.
- A runner package named by anything but a registry name, with an optional version or range, is
  not rated: a path (`./tool`, `/abs`, `~/tool`), `file:`, `link:`, a git or other scheme, GitHub
  shorthand (`user/repo`), or a tarball, alone or after the name's `@` (`npx tsx@file:./tool`), and
  a version part that starts with a dot, which names a folder (`npx eslint@.`, `npx tsx@. job.ts`),
  and a scope or name that is not URL-safe, which npm reads as a folder (`npx @scope/x#y`).

## Another package's script

- A standard form selecting another package's script is not rated: npm's and npx's `-w`,
  `--workspace`, `--workspaces`, `-ws`, `--ws`, and `--include-workspace-root`, bun's `--filter` and
  `-F`, pnpm's `--filter`, `-F`, `--filter-prod`, `-r`, `--recursive`, `--parallel`, `-w`,
  `--workspace-root`, `--config.` keys, and the `recursive`, `multi`, and `m` commands, and ruby's
  `-x` (`ruby3.2` too). Options are read as npm reads them: under any dashes, a long one by a
  prefix of three letters or more, in a cluster (`-qw a`), after `no-`, or as `--C sub`. Words after
  a `--`, npx's command, or pnpm's script name are the script's own (`npx tsc -w`), so those are
  rated; after an option without `=value` that name is unknown: every word counts
  (`npx -y tsc -w`).
- npm, pnpm, and yarn classic also run `pre<name>` and `post<name>` beside the named script unless
  configured off, and the stages see only the named script's text; bun is unconfirmed.
- `npm`, `pnpm`, and `yarn` never ask on their own, so their standard scripts reach a stage only
  under `approval.quickJudge all` in automated mode, or, under `asks` or `all`, when the destructive
  list names them; a person still decides.

## Over-refusals kept

- A `-m` anywhere after a Python script is read as a module, so `python3 job.py -m pdb` asks a
  person, though Python hands those words to the script.
- A heredoc fed to an interpreter other than a shell, holding a line that starts with an
  interpreter's name (`python3 - <<'EOF'` with a line `node build.js`), asks a person: the rules
  read that line as a command.
- A standard script inside shell text that is not one simple command (`bash -c 'echo hi; npx vitest
  run'`) asks a person, as a bun one already did.
- A standard script naming a `package.json` script asks a person where the working directory's
  `package.json` is missing, cannot be read or parsed, or holds no such script, even where the tool
  would still run something: `npm start` falls back to `node server.js`, and npm runs a parent
  folder's script where the working directory has no `package.json`. An allowed command screened
  under `approval.quickJudge all` is rated on its command line instead, with no script text.

## Not yet read

- `node .` at the root of the workspace or a mount asks: node tries the file beside that folder
  first, which lies beyond what the reader sees.
- A project `.npmrc` holding `node-options` preloads code under `npx` with no variable set, and one
  holding `workspace=` or `workspaces=` runs another package's script under `npm run` with no option
  typed; the reader does not read `.npmrc`. Writing one asks, as a sensitive file does.
- `pnpm_config_*` is not a code-loading name: pnpm 10.33.2 ignored `pnpm_config_node_options`,
  while `npm_config_node_options` reached its scripts and is refused.

## Elsewhere

- Socket is advisory and looks at 50 packages a rating; with no key, a timeout, or an error, the
  rating runs without it, and a verdict reached while its lookup failed is not kept.
- A pass binds to the code it rated, read again under the write lock just before the program
  starts; a write the lock does not hold back (a process still running from an earlier call, or
  another workspace writing through a shared mount) can land after that check.
- No local model ships with Buckle: point `BUCKLE_JUDGE_BASE_URL` at one that speaks OpenAI's API.
- `buckle client approve`, the enrolled-device route, shows the level alone in the ask's reason:
  a signed challenge carries no verdict yet.
- No live call has been made yet to a real AI gateway, TypeSafe, or Socket: the built-in model name
  `gpt-6-luna` (a gateway may name it differently), Jev's answers, and Socket's organization route
  follow the published documentation and the tests' imitations. A failure of any of them is no
  verdict, so a call asks as before.
