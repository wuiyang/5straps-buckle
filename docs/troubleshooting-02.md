# Troubleshooting: refused commands

The command refusals people meet with Buckle, the approval and sandbox runtime on their machine,
each with its message and the fix. [Troubleshooting](troubleshooting.md) covers installing and
starting Buckle. A refusal comes back to the agent as `PERMISSION_DENIED` with the reason.

## A bash script is refused

```
PERMISSION_DENIED: A shell wrapper hides its command from the word globs, so it needs an allow rule of its own: buckle policy allow-command 'bash -c *'
```

`script_run` with the `bash` runtime, and a `bash -c` the call starts with or reaches through a
prefix such as `sudo` or `env`, is refused until a rule allows the wrapper; one reached through
`find -exec`, `su -c`, or `sudo -s` meets only the deny rules and the destructive floor. Prefer
`shell_exec` with the program and its arguments, or allow the wrapper with the rule the message
names. An allow rule admits a call only as typed, so behind a prefix the message names the prefix
too: `sudo bash -c ls` names `sudo bash -c *`, and `env bash -c ls` names
`env bash -c *`. [Policy](policy.md#commands) explains why.

## An interpreter is refused or asks

With a deny glob in the policy, a call that runs code with `python3`, `node`, or another
[interpreter](policy-02.md#interpreters) is refused:

```
PERMISSION_DENIED: Runs code Buckle cannot read as shell, with an interpreter the policy does not allow (unknown interpreter): python3 (allow it with buckle policy allow-interpreter python3), so the workspace command policy's deny list cannot meet all of it; refused rather than asked
```

With none, the destructive floor asks with the same reason. Buckle cannot read the code, so no
deny glob can meet what it runs. When the owner trusts that interpreter as an ordinary command,
judged by its own words, allow it by its exact name:

```bash
buckle policy allow-interpreter python3
```

It applies to that workspace alone, from its next call. `python3` and `python3.12` are separate
names. A version or help call, such as `python3 --version`, never needs it.

## A call Buckle cannot read whole is refused

With a deny glob in the policy, a call Buckle could not read to the end is refused, since the
part left unread might hold a denied command:

```
PERMISSION_DENIED: Runs a command word or shell text an expansion supplies, or a command an expansion among a wrapper's own words may move, which exists only once the shell has run ($cmd args, eval "$x", bash -c "$(...)", timeout $t cmd), so Buckle cannot read it (expansion), so the workspace command policy's deny list cannot meet all of it; refused rather than asked
```

With none, the destructive floor asks instead. The name in parentheses, or a constant such as
`MAX_DEPTH`, is the limit that stopped the reading. [Reading limits](policy-02.md#reading-limits)
lists each with an example and the fix, which is usually to spell the command out, quote a
variable after an option that takes one (`nice -n "$n" make`), or hand a shell its script with
`-c`. [What stays unread](policy-03.md) shows the forms an expansion leaves read, and
[Known limits](known-limits.md) what Buckle does not read at all.

## A rule changes another workspace than you meant

`buckle policy` acts on the workspace `--workspace <id>` or `--dir <path>` names, or else on the
one whose folder holds the current directory, and `buckle policy show` names it on its first
line. A rule `buckle policy` adds is that workspace's own, so it does nothing in another; only the
node's lists in `buckle.env` reach every workspace ([Node defaults](workspaces-03.md)). `buckle workspace list` shows each workspace's id and folder
([Workspaces](workspaces.md#which-workspace-a-command-means)).
