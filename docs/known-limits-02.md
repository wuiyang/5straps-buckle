# Known limits, part two

More of what Buckle, the approval and sandbox runtime on this machine, does not yet handle: the
programs it starts itself, such as `rg`, `git`, and `agent-browser`, a browser for agents, and the
files a browser command writes. [Known limits](known-limits.md) covers reading commands, credential
hiding, and paths, and [part three](known-limits-03.md) code mode and the command line.

## Where programs come from

- Buckle runs each program it needs, such as `rg`, `git`, the sandbox program `bwrap`, or the
  environment validator, from where `PATH`, or a place it looks after `PATH`, really leads, and
  refuses one an agent could have written: one found in, or through a link in, any workspace or
  scratch root this node knows, whichever workspace runs it. `BUCKLE_MOUNTS` shares folders
  read-only, so a program there runs. `npx` and `pnpm exec` put a workspace's `node_modules/.bin`
  first on `PATH`, so an `rg` there leaves content search out of every workspace, and a `bwrap`
  there leaves no sandbox: the shell tools are withheld rather than run without one. A node
  started while its workspace registry cannot be read runs no program: repair the registry, then
  restart the node.
- Each program Buckle runs gets a `PATH` with those places taken out, so a script it runs that
  starts `#!/usr/bin/env node` never finds a `node` an agent planted. The shell keeps the agent's
  `PATH`.
- After `PATH`, Buckle looks beside its own `buckle` command, as npm lays out a global install,
  beside the Node.js it runs on, and on Windows in `%APPDATA%\npm`. A program another installer
  put elsewhere is found only on `PATH`.
- A running workspace keeps the programs it found: a workspace registered later counts for them
  from the running one's next policy change, or for the sandbox program, its next start.
- A program outside every root that hard-links a file inside one runs, as Buckle cannot see a
  file's other names: keep such links off `PATH`.
- On Windows, Buckle judges each program, `PATH` entry, and browser profile folder by the real
  path Windows gives every place on its way too, links included, so a `subst` drive or a drive mapped to a folder cannot hide a
  workspace, and in long names, so an 8.3 short name such as `PROJEC~1` cannot either. A real path
  Buckle cannot read or that lies on a network share is refused, and so is a short name it cannot
  read back. Only an imitated Windows has tested this so far, not a Windows machine.
- The git tools refuse a repository reaching outside the workspace or scratch root holding the
  folder named, such as a home folder kept in git, a bare repository, or one whose git directory
  lies elsewhere.

## Windows shims

- npm installs a command on Windows as a `.cmd` shim, a small batch file that Node.js starts only
  through `cmd.exe`, which Buckle never runs: the agent's arguments would pass through its quoting.
  Buckle reads the shim instead, at most 64 KiB, and runs the `.exe` it names, or the script it
  names under Buckle's own Node.js. A `.exe` or `.com` of the same name in any place wins.
- Buckle reads two shapes of shim, each matched exactly, line by line and in order: the one npm
  writes for a script it runs with Node.js, and the two-line form agent-browser's own install
  writes, `@ECHO off` and a quoted `.exe` or `.com` beside the shim followed by `%*`. A script
  named in the two-line form is refused, as cmd would hand it to Windows Script Host, not Node.js.
  A shim holding a comment, a caret, a character outside printable ASCII, or a space or tab where
  its shape has none is refused too, and so is every other shim: one that sets an environment
  variable, passes arguments or Node.js flags of its own, starts its script with another program,
  or runs `/bin/sh`. The reason names the shim's file, never its folder.
- pnpm's shim is neither shape, and sets `NODE_PATH` by default, so Buckle refuses every command
  pnpm installs. For agent-browser and the environment validator, point
  `BUCKLE_AGENT_BROWSER_COMMAND` or `BUCKLE_ENV_VALIDATOR_COMMAND` at the `.exe` or the script
  inside the package, which Buckle's own Node.js then runs. A program with no setting, such as a
  language server like `typescript-language-server` or `pyright-langserver`, needs npm's shim or a
  native `.exe` where Buckle looks: on Windows, install it with `npm i -g`. `buckle init` does not
  check language servers, so a refused one shows only when a call needs it.

## Files a browser command writes

- A screenshot, PDF, or download is copied beside its target and renamed onto it, taking the old
  file's mode or, for a new file, the mode `fs_write` gives one. A delivered file replaces the
  target, so a per-file ACL on the old one is not kept.
