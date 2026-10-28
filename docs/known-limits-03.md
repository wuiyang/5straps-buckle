# Known limits, part three

What Buckle, the approval and sandbox runtime on this machine, does not yet handle in code mode, on
the command line, and in workspaces. [Known limits](known-limits.md) covers reading commands, credential hiding, and
paths, [part two](known-limits-02.md) the programs Buckle starts itself, and [part four](known-limits-04.md) mounts,
the sandbox layout, the URL list, the browser, and the forge pack.

## Code mode

[Code mode](code-mode.md) runs an agent's script that calls Buckle's tools.

- A script that stopped at an ask, its deadline, a cancel, or a shutdown resumes only within ten
  minutes, as long as Buckle keeps its record of the calls that ran. Sent again later, the script
  runs from its start, and the calls before the stop run again.
- A script whose calls returned more than 32 MiB cannot be resumed: for the ten minutes its
  record is kept, every unchanged send gets `REQUEST_ALREADY_EXECUTED` for each call that ran, and
  at an ask `code_run` answers `CODE_REPLAY_TOO_LARGE` and withdraws the asks. A workspace keeps
  128 MiB of such records: the oldest go first, the record just written last.
- Without its record, only the Buckle process remembers, in memory and for ten minutes, which of a
  script's calls ran, and answers them `REQUEST_ALREADY_EXECUTED`. A restart forgets that, and
  once a send has ended on that error, the next unchanged send runs every call again.
- Buckle writes a script's record to disk when the script stops, not as each call runs. A crash or
  kill of the Buckle process mid-script loses every call since the script's last stop: the next
  unchanged send runs them again. A script resumed after an approval falls back to its first
  run's record. Approved once, it asks again for the approved call, which already ran; approved
  for the session or always, that grant lets the call run again with no ask. Either way, the
  calls after it run again too.
- A nested call's error text reaches the script, which can read it, branch on it, and return it:
  a refusal's message, with the path, host, or command a rule names, reaches the agent through the
  script as it would from a direct call, and the script can try another call in response, each of
  which is judged on its own.
- The audit log keeps the script's size, not its text, as it keeps every argument.
  `buckle approvals show <token>` prints the text of a script that stopped at an ask for ten
  minutes, but not while the call still waits inside the script, and nothing keeps it after.
- A script that keeps calling once refused 256 times more past its cap is ended as a script error,
  and its answer lists its first 256 calls.

## The command line

- `buckle --help`, `buckle serve --help`, and `buckle mcp --help` print the usage without reading
  any configuration. `--help` or `-h` after `init`, `settings`, `approve`, `approvals`, `check-url`,
  `grants`, `history`, `plugin`, `policy`, `workspace`, `workspaces`, or `keys` prints that command's
  usage and writes no [audit log](audit-log.md) entry. `buckle mcp` takes `--workspace <name>` and `--dir <path>` alone: any other
  argument stops it with "Buckle failed to start", where 0.1 ignored one, so an MCP config left
  with an old argument starts nothing until the argument goes. `buckle serve` ignores an argument
  it does not know.

## Workspaces

The first release of [workspaces](workspaces.md) leaves these open for a later release.

- `approvals.json` is keyed by the workspace's folder path, inside each workspace's own state
  directory. A workspace's folder is fixed once registered, and its id comes from the folder, so a
  removed workspace's records are taken up only by adding the same folder again and the key cannot
  drift; keying it by workspace id is left for a later release.
- `disable` and `remove` check for running calls, then change the registry: a call that begins in
  another process between the two runs on, and `remove --purge` can delete its records under it.
  A call that begins in the process making the change keeps its runtime open until it ends, and
  `remove --purge` then keeps the records for `buckle workspace prune`, which refuses to delete
  them while a call still runs in that workspace.
- The settings and registry watchers are a latency improvement, not a guarantee: where `fs.watch`
  cannot start (an unsupported platform, or too many open files), Buckle logs it once and falls
  back to the per-call check and the `buckle serve` poll, so a change is taken up at the next call
  or poll rather than at once.
- A name given now is at most 64 characters, holds no `/`, `\`, or `%`, and begins with no `-`,
  as a command line would read it as an option; the move drops a leading `-` from a folder's
  name, and holds a name typed at its question to the same rule. A workspace named
  longer by 0.1 or by the move keeps its name, which `buckle client` cannot sign for: it says so,
  and the workspace's id, which `buckle workspace list` prints, takes its place.
- The node level serves no workspace: apart from the registry's routes and the node-scoped setup
  session, a `/setup` route without `/workspaces/<name>/` answers 404, so scripts and Rings
  address `/workspaces/<name>/setup/`.
- [Rings](rings.md), the separate 5straps control plane for agents, keeps its own copy of a
  node's workspace list; a workspace renamed, added, or removed here is not pushed to it, so Rings
  re-reads the list to see the change. Upgrading from 0.1 gives every workspace a new UUID id, and
  the node's folder loses the id `default`, so a Rings holding the old ids has to re-read the list;
  a registered workspace's old id stays as its name.
- [Node defaults](workspaces-03.md) cover the settings a 0.1 node kept in `buckle.env`. The node
  names no command variables and no tool lists there, as `buckle.env` takes `BUCKLE_` settings
  alone: a workspace's variables and tool lists are its own, and each resolves over an empty node
  set.
- An empty list is no list of a workspace's own, so a workspace cannot hold an empty command
  allow list, approved list, or interpreter list over the node's. To free one workspace from a
  node list, unset the node's and give each other workspace its own.
