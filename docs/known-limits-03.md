# Known limits, part three

What Buckle, the approval and sandbox runtime on this machine, does not yet handle in code mode and
on the command line. [Known limits](known-limits.md) covers reading commands, credential hiding, and
paths, and [part two](known-limits-02.md) the programs Buckle starts itself.

## Code mode

[Code mode](code-mode.md) runs an agent's script that calls Buckle's tools.

- A script that stopped at an ask, its deadline, a cancel, or a shutdown resumes only within ten
  minutes, as long as Buckle keeps its record of the calls that ran. Sent again later, the script
  runs from its start, and the calls before the stop run again.
- A script whose calls returned more than 32 MiB cannot be resumed: sent again, it gets
  `REQUEST_ALREADY_EXECUTED` for each call that ran, and at an ask `code_run` answers
  `CODE_REPLAY_TOO_LARGE` and withdraws the asks. A workspace keeps 128 MiB of such records and
  drops the oldest first.
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

- `buckle serve --help` and `buckle mcp --help` start the service rather than print help.
  `buckle --help` lists the commands without reading any configuration.
