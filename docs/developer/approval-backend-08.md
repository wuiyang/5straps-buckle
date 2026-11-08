# Approval backend: the settings files

Which files hold the node's settings, and how each process keeps them from tools. [MCP
forms](approval-backend-04.md) covers the setting they hold, and [known
limits](../user/caveats/known-limits-11.md) what is not covered yet. Paths are in `buckle/`.

## The record

`workspace.json` lies in the state directory, and `NodeConfig.environmentFile` names the node's
environment file, there or wherever `BUCKLE_ENV_FILE` puts it (`common/runtime/config.ts`). A
process knows only the file its own environment names, so `buckle init`, `buckle service
install`, and each serve start record one in the state directory's `environment-files.json`
(`common/runtime/environment-files.ts`), unless it lies inside that directory where each really
is: one named there through a link to a file outside is recorded. `loadConfig` reads the record
into `recordedEnvironmentFiles`, and `createRuntime` reads it again, so a `buckle mcp`, whose
environment names none, protects them too. Nothing drops an entry; removing the file clears them
all.

## Taking a new file up

A process may start before a file is recorded. `recordedEnvironmentFilesReader` reads the record
again whenever its file's version changes, and each call's start (`pickUp` in
`common/services/workspaces/workspace-runtime.ts`) compares it with the files the rules and packs
were built with. A change is applied as an owner's write is, with no wait: the permission engine
and the packs are rebuilt, the history's exclusions widened (`configure`), and a call already
running keeps what it started with. A record that will not read, or will not apply, refuses every
call with `WORKSPACE_REFUSED`, naming no path, and the owner's log says why. No call admits a
workbench step, so its staging, review, apply, and terminal read the record as it stands.

## Each route

`protectedStateRoots` returns all of them, typed and real, and each route reads that one set: the
`sensitive_path` rule over every effect a tool, a script's call, a browser command, a secret
reference, or a restore makes; the shell's hidden paths, sorted in
`common/services/shell/shell-filesystem.ts` so a file is masked by binding `/dev/null` over it and
a folder by a tmpfs; the workbench terminal; a workbench's review and apply, which refuse a change
inside or holding one, naming no path; the change history's exclusions, which every promotion
meets as a restore does; and the mount checks. With `BUCKLE_SANDBOX=none` a shell command reaches
them; the user pages say so beside each setting.

`protectedSettingsFiles` names the environment files among them, so one not made yet is masked as
no folder: bubblewrap would make its mount point on the host. A shell call that writes the folder
holding one is refused, an isolated call's publish refuses a change that makes one, and Seatbelt
denies the path as it stands. A workbench copy holds no such file to leave out, so a terminal can
make one there, which its review refuses.

## Tests

`test/settings-files-protected.test.ts` covers each route, a file recorded after a runtime
started (the file tools, a shell layout, the history, and a workbench apply), a link in the state
directory, and a record that will not read. `test/workbench.test.ts` covers a copy that makes a
protected file and a promotion the history's own exclusions refuse.
