# Running Buckle as a service, part two

Buckle, the approval and sandbox runtime that runs an AI agent's tool calls on your machine, keeps
its node running with no terminal through the commands on [part one](service.md), which also
covers Linux and Windows. This page covers macOS, a node detached once, approvals with no terminal,
logs and status, upgrades, and removal.

## macOS: a launchd agent

launchd is macOS's own service manager, and an agent is a program it runs in your login session.
`buckle service install` writes `~/Library/LaunchAgents/com.5straps.buckle.plist`, owner-only,
making the folder where it is missing, and enables it; `--now` also loads it, which starts the
node. The agent runs the Node binary and `main.js` by absolute path with `serve`, each a separate
argument, never through a shell, with the `PATH` of the shell you installed from. It works in the
state directory, restarts five seconds after a failure, and stops on SIGTERM, which closes it as
Ctrl-C does. A node that finds another one serving the state directory exits 0 there, so launchd
does not start it again every five seconds.

Each command runs `/bin/launchctl`, by that path, on `gui/<uid>/com.5straps.buckle`, the agent in
your login session:

| Command | What launchctl does |
|---|---|
| `install` | `print gui/<uid>`, to find your login session, then `enable`; with `--now`, `bootout` where it is loaded, then `bootstrap` |
| `start`, `restart` | `bootout` where it is loaded, then `bootstrap`, so the file as installed is what runs |
| `stop` | `bootout`, which unloads it until the next login or `buckle service start` |
| `status` | `print-disabled`, which says whether it starts at login |
| `uninstall` | `bootout`, then the file is removed |

It starts when you log in, not at boot. An agent belongs to a login session, which is also what
lets it open a visible browser window or your own Chrome. A start before anyone logs in would need a
launchd daemon, which runs as root, and Buckle writes none, so `buckle service status` prints no
line about starting before login on macOS.

Run `install` from a terminal in your login session at the Mac. Over SSH (a remote shell) with
nobody logged in at the Mac, no login session answers, and `install` refuses, naming
`buckle serve --background`.

What the node writes before it opens its own log, such as a crash at start, goes to
`logs/launchd.log` in the state directory, owner-only, which `buckle service logs` does not show;
nothing rotates it.

## In the background, once

`buckle serve --background` checks that no node serves the state directory already, starts one
detached from the terminal, waits until it listens, and prints its pid, its address, and the
command that answers its approvals. It is the fallback where no service manager answers.
`buckle service stop`, `status`, and `logs` work on it too; `start` and `restart` need a service.

A `buckle serve` at a terminal holds the state directory too: `--background`, `start`, `restart`,
and `install --now` refuse beside it, `status` shows it, and `stop` says to press Ctrl-C there.

## Approvals with no terminal

A node with no terminal asks nobody at a prompt: an ask waits for `approvalWaitMs`, then the agent
gets a token to retry with. Answer from any terminal with `buckle approvals --watch`, which answers
the workspace holding the current directory, or `--all` for every online one.

`buckle serve` typed while the node runs this way starts nothing: it says Buckle is already running
in service mode, prints that command, and exits 1 ([Troubleshooting](troubleshooting.md)).

## Logs and status

A node with no terminal writes its own log, `logs/buckle.log` in the state directory, as JSON lines:
owner-only (folder 700, file 600), rotated at 10 MiB with five earlier files kept. Buckle's file
tools refuse it, as they refuse the whole state directory, and a process sandbox hides it from
shell commands.

`buckle service status` shows the definition and whether it starts at login, the running node's pid
and address, whether `/health` and `/health/ready` answer, the running version against the
installed one, and on Linux whether the node starts before login.

## Upgrade

After `npm i -g @5straps/buckle@latest`, the running node keeps the old version until it restarts;
`buckle service status` says so and names `buckle service restart`. Where Node itself moved, as nvm
(the Node Version Manager) moves it on an upgrade, the definition names a Node that is gone;
`status`, `start`, and `restart` say to run `buckle service install` again.

A node setting in `buckle.env` takes effect when the node restarts: `buckle settings set` names
`buckle service restart` for a service, and Ctrl-C, then `buckle serve`, at a terminal.

## Uninstall

`buckle service uninstall` stops the node and removes the definition; workspaces, grants, and logs
stay in the state directory. Run it before `npm uninstall -g @5straps/buckle`, or the definition
keeps naming a `main.js` that is gone, and before going back to 0.1, which cannot remove it and
ignores its flags ([Going back](workspaces-04.md)).

[Known limits, part five](known-limits-05.md) lists what is not covered yet.
