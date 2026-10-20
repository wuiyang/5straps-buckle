# Mounts

Each [workspace](workspaces.md) of Buckle, the approval and sandbox runtime on this machine,
has a mount table in its `workspace.json`: where its folder shows to the agent, `/workspace` by
default, and the host folders or files the owner shares into it beside the folder. The file,
git, code, and browser tools reach every mount, and so does the shell under bubblewrap.

## The table

`buckle workspace mount` changes the table of the workspace holding the current directory, or
the one `--workspace <name>` or `--dir <path>` names. The form follows Docker's `-v`:

```bash
buckle workspace mount add ~/datasets:/data          # read-write
buckle workspace mount add ~/docs:/docs:ro           # read-only
buckle workspace mount add --read-only ~/.gitconfig:/tmp/home/.gitconfig
buckle workspace mount remove /data
buckle workspace mount list                          # source:target:access, one per line
```

A mount is read-write unless `:ro` or `--read-only` says otherwise. The source is stored as the
disk names it, links followed; it must exist, as a folder or a file. A source gone since, or
swapped for a link, is refused at each use, by its target, until the owner re-adds or removes
the mount; the folder itself is checked the same way at each call. History never covers where
such a link lands. `mount list` prints the
folder's own entry first, then each mount; `--json` prints the same as data. The folder's own
entry cannot be removed here; `buckle workspace set mount <path>` moves it.

Buckle refuses, and writes nothing, where:

- the target is `/`, or at, above, or inside `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`,
  `/dev`, `/proc`, `/sys`, or `/tmp`, except inside the sandbox home, `/tmp/home`;
- the target overlaps where the folder shows, another mount's target, or a toolchain the sandbox
  binds at its own path (the Node install and `BUCKLE_MOUNT_READ_ONLY`);
- the source holds, or sits inside, Buckle's state, the workspace's own folder, or another
  mount's source;
- a writable source holds, or sits inside, a folder every sandbox runs programs from: share
  such a folder with `:ro`;
- the folder shows at its real path: mounts need it mounted, so `buckle workspace set mount
  /workspace` comes first;
- the workspace already holds 32 mounts of its own, not counting its folder.

Taking the folder's mount away, or moving it onto a mount, is refused while mounts need it.

`buckle init` and `buckle workspace init` take the same form as `--volume`, once per mount, and
`buckle init` asks for more at a terminal. Each is checked as `mount add` checks one: a typed answer
naming no mount is asked again, and any other refused entry stops the command before anything is
written. In a folder a workspace already serves, `buckle init` asks no mount question and refuses
`--volume`, pointing at `buckle workspace mount add`. `buckle policy show` lists the table too.

## The node's mounts

`buckle.env` can give every workspace mounts of its own until the workspace has some:
`BUCKLE_MOUNTS`, a JSON list of read-only `{source, target}` entries, and
`BUCKLE_SCRATCH_ROOTS`, folders writable without asking, shown at their own path. A workspace
with any mount of its own uses its table alone, as a list of its own does
([node defaults](workspaces-03.md)); removing its last mount gives it the node's again. Both are
read from `buckle.env` alone, never from a shell's or an MCP config's environment, and
`buckle settings set mounts` and `scratch-roots` write them. A scratch root holding a folder that
shows at a mount would show it twice, so the shell refuses each call there, and the commands
that make it so say it.
`BUCKLE_MOUNT_READ_ONLY` names toolchains outside `/usr`, which every sandbox binds read-only at
their own path, beside the Node install; they are never listed as mounts.

## What the agent sees

Inside the bubblewrap sandbox, `ls /` shows the folder's target, each mount's, and the folders
every sandbox keeps: `/usr`, `/bin`, `/sbin`, `/lib`, and `/lib64`, read-only, as the kernel
opens a program's loader at a fixed path and scripts need `/bin/sh` and `/usr/bin/env`; an
`/etc` built from the loader cache, name lookup, certificate, and time zone files, and the
program alternatives (`/etc/alternatives`, the links Debian and Ubuntu reach `awk` and `cc`
through), with its own `passwd`, `group`, and `hosts`; `/dev`;
`/proc`; and a fresh `/tmp`, holding the home folder `/tmp/home`. The Node install and the
node's toolchains show at their own paths. No mount table lists these, and none removes them.

A command runs as the user `agent` on a host named `buckle`, with Buckle's own `PATH` (the Node
install, the toolchains, then the system folders), `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, and
`HOME`, never the node's. The workspace's variables, then the call's own `env`, are set over them.

The file tools read inside a mount without asking. A write into a read-only mount is refused,
and the git tools read a repository there on a private copy of its index, so they write nothing
in it; `git_push` from one moves no tracking ref and sets no upstream there. A write into a
read-write one asks as a write to the workspace does, and its history and the workspace's write
lock cover it. A mount shares what it holds: Buckle hides credential files in the workspace's
folder from the shell, not those inside a mount, though the file tools still ask before reading
one.

[Shell isolation](sandbox-and-tools.md#shell-isolation) copies the workspace's folder alone. Under
it, each read-write mount, and a scratch root outside the folder, is read-only to the command,
and the result's `readOnlyMounts` and `note` name them. Credential files in such a scratch root
stay hidden from the command, and one that holds, or sits inside, Buckle's state is refused.

A change to the table applies once the workspace has no active work, such as a running call or
a shell copy awaiting review; until then calls are refused with a 409.

## Platforms

- Linux with bubblewrap: as above.
- macOS and Windows: the table is path policy for the file, git, code, and browser tools. The
  shell stays withheld wherever the folder is mounted, as Seatbelt and an unsandboxed node cannot
  show a command the same view.
- Windows: a mount's source may be a network share ([Windows shares](mounts-02.md)).

[Known limits, part four](known-limits-04.md) lists what this does not yet cover.
