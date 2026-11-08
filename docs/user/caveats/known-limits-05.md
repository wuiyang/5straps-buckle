# Known limits, part five

Limits of running Buckle as a service ([part one](../how-to/service.md) and
[part two](../how-to/service-02.md)) or at a terminal. [Part eleven](known-limits-11.md) covers
the settings files, and the [first part](known-limits.md) lists the other limits.

## Tested without the service managers

- No systemd user session runs on CI or on the machine the service was built on. The unit is checked as text, and `systemctl` is a program on `PATH`
  in the tests that runs the unit's `ExecStart` as the user manager would; a real user manager
  has not run it.
- Windows is experimental, and Task Scheduler has not run the task on a machine yet. The task's XML and each `schtasks.exe` call are checked on
  Linux, imitating Windows. Whether a node the task's start detached outlives that start on every
  Windows version, and which encoding `schtasks.exe` writes its answers in, are for the owner's
  Windows machine to confirm.
- No Mac has run the launchd agent yet. The agent is checked as the text launchd
  reads, and `launchctl` is a program the tests imitate at a path of their own, as the Windows task
  is checked without Windows.

## What a service does not do

- A node the Windows task detached is not restarted after a crash: Task Scheduler sees its start
  end, not the node. systemd restarts a failed node on Linux, and launchd on macOS.
- launchd has no setting like the unit's `RestartPreventExitStatus`, which keeps a refused start
  from starting again. So a node the agent started that finds another node serving its state
  directory exits 0, which launchd leaves alone: the agent stays loaded and starts again at the next
  login or `buckle service start`. Every other failed exit starts again five seconds later, as on
  Linux.
- The launchd agent starts at login only: nothing starts Buckle on a Mac before someone logs in.
- The node does not restart itself after an upgrade. Until `buckle service restart`, it runs the
  old version, and files a newer install replaced may be read by it; `buckle service status`
  says when the versions differ.
- `buckle service` acts on the unit, agent, or task Buckle wrote. A shell command that names
  Buckle's unit, agent, or task through `systemctl`, `loginctl`, `launchctl`, or `schtasks.exe`, or
  reloads the user manager, is refused and audited. An agent with an unsandboxed shell, as under
  `BUCKLE_SANDBOX=none`, can still reach the service manager by other means. On Linux a sandboxed
  shell cannot, as no `/run/user` is bound; the macOS sandbox lets a command reach launchd, so
  there the refusal is all that stands in the way. The file tools refuse Buckle's own unit, its
  link, its drop-ins, a copy in `user.control`, and on macOS the agent's file; what the user
  manager gives every service, such as `environment.d`, and another agent in
  `~/Library/LaunchAgents` ask like any other file.
- The unit and the agent capture `PATH` once, at install. A program installed later in a folder
  that `PATH` did not name then is not found until `buckle service install` runs again.
- A node started before login, with lingering on, has no desktop: a visible browser window or your
  own Chrome may not open there.
- A log line a node writes before it reads its settings, such as a refusal of `buckle.env`, goes to
  the service's log file; a crash before even that goes to the systemd journal on Linux, to
  `logs/launchd.log` on macOS, which nothing rotates and `buckle service logs` does not show, and
  nowhere on Windows or for `buckle serve --background`.

## A serve at a terminal

- Closing the terminal sends SIGHUP, which Buckle handles on Windows alone. On Linux and macOS a
  `buckle serve` then stops at once, with any open question unanswered, and runs none of its close
  steps. Stop it with Ctrl-C instead.
- The terminal's log is for people: local time, a date line when the day changes, one line per
  request, and the startup and shutdown steps only at `BUCKLE_LOG_LEVEL=debug` or `trace`.
  Machines read the JSON lines, which Buckle writes wherever stderr is not a terminal and to the
  service log; `BUCKLE_LOG_FORMAT=json` writes them at a terminal too.
- A line logged while a question is open is drawn above its prompt, and a tag written back on the
  prompt's row, only while the prompt and what was typed fit one row: a long workspace name on a
  narrow terminal, or typing past the row's end, wraps it, and the redraw or the tag then lands a
  row off. A question a one-shot command asks at a terminal is not redrawn at all.
- The console writer sends cursor escapes only to a terminal whose `TERM` is not `dumb`, read as the
  node starts, as Node's readline does; Buckle still passes `TERM` to child processes and sets
  `xterm-256color` for shell commands. Under `dumb`, a line logged while a question is open is
  written on its own line, and the prompt and what was typed are written again below it, so the
  earlier prompt row stays above the line; a denial or an ending is written as a row of its own
  below the typed one, not on it. Node's readline still
  redraws the row with escapes when a key edits the typed text, such as Backspace or an arrow, and
  for keys typed in the half second before the prompt shows; a terminal that does not act on them
  shows them as text. The typed answer still counts: the next keys and Enter add to it.
- Lines logged before the node reads `buckle.env` follow the terminal and the shell's
  `BUCKLE_LOG_FORMAT`, not the file's.
