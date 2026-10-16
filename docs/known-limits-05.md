# Known limits, part five

What [running Buckle as a service](service.md) does not yet cover. Buckle is the approval and
sandbox runtime that runs an AI agent's tool calls on your machine; the [first part](known-limits.md)
lists the other limits.

## Tested without the service managers

- No systemd user session (Linux's own service manager, per user) runs on CI or on the machine
  the service was built on. The unit is checked as text, and `systemctl` is a program on `PATH`
  in the tests that runs the unit's `ExecStart` as the user manager would; a real user manager
  has not run it.
- Windows is experimental, and Task Scheduler, Windows' own way to start a program at logon, has
  not run the task on a machine yet. The task's XML and each `schtasks.exe` call are checked on
  Linux, imitating Windows. Whether a node the task's start detached outlives that start on every
  Windows version, and which encoding `schtasks.exe` writes its answers in, are for the owner's
  Windows machine to confirm.
- Nothing for macOS: `buckle service install`, `start`, `restart`, and `uninstall` say they are
  not supported yet. `buckle serve --background` works there, with nothing to start it at login.

## What a service does not do

- A node the Windows task detached is not restarted after a crash: Task Scheduler sees its start
  end, not the node. systemd restarts a failed node on Linux.
- The node does not restart itself after an upgrade. Until `buckle service restart`, it runs the
  old version, and files a newer install replaced may be read by it; `buckle service status`
  says when the versions differ.
- `buckle service` acts on the unit or task Buckle wrote. A shell command that names Buckle's unit
  or task through `systemctl`, `loginctl`, or `schtasks.exe`, or reloads the user manager, is
  refused and audited. An agent with an unsandboxed shell, as under `BUCKLE_SANDBOX=none`, can
  still reach the service manager by other means; a sandboxed shell cannot, as no `/run/user` is
  bound. The file tools refuse Buckle's own unit, its link, its drop-ins, and a copy in
  `user.control`; what the user manager gives every service, such as `environment.d`, asks like
  any other file.
- The unit captures `PATH` once, at install. A program installed later in a folder that `PATH` did
  not name then is not found until `buckle service install` runs again.
- A node started before login, with lingering on, has no desktop: a visible browser window or your
  own Chrome may not open there.
- A log line a node writes before it reads its settings, such as a refusal of `buckle.env`, goes to
  the service's log file; a crash before even that goes to the systemd journal on Linux, and
  nowhere on Windows or for `buckle serve --background`.
