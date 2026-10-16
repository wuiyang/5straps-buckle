# Running Buckle as a service

Buckle, the approval and sandbox runtime that runs an AI agent's tool calls on your machine, can
keep its node running with no terminal open: started at every login by the operating system's own
service manager, or detached from a terminal once. This page covers the commands, Linux, and
Windows; [part two](service-02.md) covers macOS, a node detached once, approvals with no terminal,
logs and status, upgrades, and removal.

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

Next: [Running Buckle as a service, part two](service-02.md), for macOS and the rest.
