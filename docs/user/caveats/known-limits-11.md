# Known limits, part eleven

Limits of keeping the node's settings files from tools
([who can change the settings](../how-to/approvals-06.md#who-can-change-it)). The
[first part](known-limits.md) lists the other limits.

## The node's settings files

- `buckle.env`, or the file `BUCKLE_ENV_FILE` names, is refused to every tool wherever it lies,
  in every Buckle process once `buckle init`, a service install, or a serve has named it, and a
  sandboxed shell command sees an empty, read-only file where a folder the sandbox binds holds
  it. With `BUCKLE_SANDBOX=none`, a shell command you allowed reaches it.
- A process already running when a file is named takes it up at its next call. A shell command
  or a workbench terminal running then keeps the masks it started with until it ends.
- A shell command running an owner command such as `buckle settings` is refused by its words, so
  a quoted subcommand (`buckle 'settings'`) passes once you allow a shell wrapper such as `sh -c`.
  The sandbox, which hides the files that hold the settings, is then what stops it.
- While `BUCKLE_ENV_FILE` names no file yet, bubblewrap refuses a shell command that writes the
  folder holding that path, as its mask would make one there. Run `buckle init --out <file>` first.

## Files you no longer use

- `environment-files.json` in the state directory keeps every settings file named outside it, and
  Buckle never drops one itself: a service or a serve you start later may still read it.
- A recorded file you deleted counts as one not made yet, so bubblewrap refuses a shell command
  that writes the folder that held it.
- A mount, or an isolated shell's scratch root outside the folder, whose source holds a recorded
  file is refused, as one holding the state directory is.
- To forget them, remove `environment-files.json`, then start the node at once: each serve,
  `buckle init --out`, and `buckle service install` records its own file again. Until one does, a
  process whose own environment does not name a file treats it as any other file.
