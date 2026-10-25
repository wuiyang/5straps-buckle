# Known limits, part two

More of what Buckle, the approval and sandbox runtime on this machine, does not yet handle: the
programs it starts itself, such as `rg`, `git`, and `agent-browser`, a browser for agents.
[Known limits](known-limits.md) covers reading commands, credential hiding, and paths,
[part three](known-limits-03.md) code mode, the command line, and workspaces, and
[part four](known-limits-04.md) mounts, the sandbox layout, the URL list, the browser and the files
its commands write, and the forge pack.

## Where programs come from

- Buckle runs each program it needs, such as `rg`, `git`, the sandbox program `bwrap`, or the
  environment validator, from where `PATH`, or a place it looks after `PATH`, really leads, and
  refuses one an agent could have written: one found in, or through a link in, any workspace or
  scratch root this node knows, or the source of any workspace's read-write
  [mount](mounts.md), whichever workspace runs it. A read-only mount's source is no such place,
  so a program there runs. `npx` and `pnpm exec` put a workspace's `node_modules/.bin`
  first on `PATH`, so an `rg` there leaves content search out of every workspace, and a `bwrap`
  there leaves no sandbox: the shell tools are withheld rather than run without one. A node
  started while its workspace registry cannot be read runs no program: repair the registry, then
  restart the node (`buckle service restart` where a service runs it).
- Each program Buckle runs gets a `PATH` with those places taken out, so a script it runs that
  starts `#!/usr/bin/env node` never finds a `node` an agent planted. Under bubblewrap, a shell
  command gets Buckle's own `PATH` instead ([what the agent sees](mounts.md#what-the-agent-sees)).
  Under Seatbelt, or with the sandbox off, it keeps the node's `PATH`.
- After `PATH`, Buckle looks beside its own `buckle` command, as npm lays out a global install,
  beside the Node.js it runs on, and on Windows in `%APPDATA%\npm`. A program another installer
  put elsewhere is found only on `PATH`.
- A running workspace keeps the programs it found: a workspace registered later counts for them
  from the running one's next settings change, or for the sandbox program, its next start.
- A program outside every root that hard-links a file inside one runs, as Buckle cannot see a
  file's other names: keep such links off `PATH`.
- On Windows, Buckle judges each program, `PATH` entry, and browser profile folder by the real
  path Windows gives every place on its way too, links included, so a `subst` drive or a drive mapped to a folder cannot hide a
  workspace, and in long names, so an 8.3 short name such as `PROJEC~1` cannot either. A real path
  Buckle cannot read or that lies on a network share is refused, and so is a short name it cannot
  read back, unless a [mount](mounts-02.md#windows-shares) of the workspace holds the share. Only an
  imitated Windows has tested this so far, not a Windows machine.
- The git tools refuse a repository reaching outside the workspace or scratch root holding the
  folder named, such as a home folder kept in git, a bare repository, or one whose git directory
  lies elsewhere.
- `git_diff` with no paths, or a folder, still names every tracked file it changed, a `.env`
  included, with its added and removed line counts and no ask: a file the read rules would not
  let the agent read, and a tracked link, show `[content hidden: <rule>]` in place of their content,
  after the rest of the diff. Name a file to be asked about it. `git_log` with no path lists the
  commits of every file, names and messages only.
- The `git` pack checks the work tree, the git folder, the common folder, each `objects` folder,
  and the stores `objects/info/alternates` names, resolving each line as git does. It refuses a
  line through `/proc`, `/dev/fd`, or a link into `/proc/` or `/dev/`, which git's own process
  reads as other places, and a repository that borrows from over 32 stores, names over 256 lines,
  walks over 8,192 path names, or reaches places hundreds of folders deep. Two changes go unseen:
  a folder swapped and swapped back while git runs, and a link anywhere inside the git folder, to
  a file or a folder outside it, such as a pack file, `objects/pack`, a folder of loose objects, or
  `refs`.
- The `git` pack shows nothing of a submodule's changes or history, but git still opens its
  `HEAD`, config, and refs through the `.git` pointer in its folder to compare the recorded commit,
  even where that pointer leads outside the workspace. A planned follow-up will refuse a submodule
  whose pointer leads outside the workspace and its mounts. The git tools' error text is git's own
  and can name a host path, such as the pointer's target; scrubbing it is a later item.

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
