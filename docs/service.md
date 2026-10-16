# Running Buckle as a service

Buckle, the approval and sandbox runtime that runs an AI agent's tool calls on your machine, can
keep its node running with no terminal open: started at every login by the operating system's own
service manager, or detached from a terminal once. This page covers both, and how to stop, read,
upgrade, and remove them.

| Command | What it does |
|---|---|
| `buckle service install` | writes the definition and enables it at login; `--now` starts it too |
| `buckle service start`, `stop`, `restart` | starts, stops, or restarts the node |
| `buckle service status` | what is installed and running; `--json` for a script |
| `buckle service logs` | the last 50 lines of its log; `-n <lines>` for another count, `-f` to follow |
| `buckle service uninstall` | stops it and removes the definition; the state directory stays |
| `buckle serve --background` | starts the node detached from this terminal, once |

`install`, `uninstall`, `start`, `stop`, and `restart` print one line on success; `status` and `logs`
print their report; each refusal is a plain reason. Run `buckle init` first: `install` refuses a node
with no `buckle.env`. A machine runs one service, for one state directory: `install` refuses while
another node's service is installed. The definition names paths alone: Node, Buckle's `main.js`, the
state directory, and `BUCKLE_ENV_FILE` where you set it; `--skip-owner-only-check` stays in it where
the install had it. The node reads its settings, credentials among them, from its own `buckle.env`, as `buckle serve`
does. `buckle service` runs before that file is read, and starts the service manager's program with
a fixed list of variables, so no credential reaches it.

## Linux: a systemd user unit

systemd is Linux's own service manager, and each user has one of their own.
`buckle service install` writes `~/.config/systemd/user/buckle.service` (under `$XDG_CONFIG_HOME`
where set), owner-only, then runs `systemctl --user daemon-reload` and `enable`; `--now` starts it
as well. The unit runs the Node binary and `main.js` by absolute path with `serve`, with the `PATH`
of the shell you installed from, so it finds the programs your terminal finds. It works in the
state directory, restarts after a failure, and stops on SIGTERM, which closes it as Ctrl-C does.

The user manager starts it when you log in. To start it at boot, before anyone logs in, turn on
lingering for your user, the system's own setting:

```bash
loginctl enable-linger "$USER"
```

`buckle service status` prints this command where lingering is off; Buckle never runs it, as it may
ask for an administrator's password. A node started before login has no desktop, so a visible
browser window (`browser.headed`) or your own Chrome may not open there.

Where no systemd user session answers (no `XDG_RUNTIME_DIR`, a container, or WSL, the Windows
Subsystem for Linux, without systemd),
`install` refuses and names `buckle serve --background`.

## Windows: a Task Scheduler task

Windows support is experimental. Task Scheduler is Windows' own way to start a program at logon.
`buckle service install` creates the task `\5straps\Buckle`
through `%SystemRoot%\System32\schtasks.exe` from an XML definition, kept as `service\task.xml` in
the state directory. The task starts at your logon with your own token and least privilege, so your
mapped drives and desktop are there; it has no time limit and no battery rule, and is hidden from
Task Scheduler's list (View, Show Hidden Tasks shows it).

Its action runs `node.exe`, with `main.js serve --background` as separate arguments: never a command
string, and never cmd.exe. That start detaches the node with no console window and ends, so the task
shows as Ready while the node runs; a window may flash at logon. Task Scheduler delivers no SIGTERM,
so `buckle service stop` writes a stop request the node looks for each second, and it closes as
Ctrl-C would close it.

## macOS

Not supported yet: `buckle service install`, `start`, `restart`, and `uninstall` say so and exit 2.
`buckle serve --background` runs the node until it stops, and `stop`, `status`, and `logs` work on
it; nothing starts it at login.

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

A node with no terminal writes one log, `logs/buckle.log` in the state directory, as JSON lines:
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
