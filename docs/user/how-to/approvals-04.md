# Approvals: the dangerously-allow switch

Buckle, the local permission node that runs an AI agent's tool calls, asks a person about what it
will not decide alone. The dangerously-allow switch removes that person for the asks its mode
covers. [Approvals](approvals.md) covers what asks and where to answer.

## The modes

`buckle policy dangerously-allow on|safe|off [--workspace <name>]` sets the mode for one
workspace; `true` and `false` read as `on` and `off`. It is off by default.

- `off`: every ask waits for a person.
- `on` allows every ask about a path inside the workspace, and every command, host, and process
  ask.
- `safe` allows the same but floor asks (the built-in floor, such as sudo and rm -rf, the
  destructive list, and the file floor), code run through an unknown interpreter or a script
  file, and a secret reference's file, which still ask a person.

The [destructive floor](approvals.md#the-destructive-floor) names the built-in floor, and
[the file floor](policy-04.md) the file asks. An unknown interpreter is one the workspace's
[policy](policy-02.md#reading-limits) does not allow: `python3 -c`, `node -e`, `perl -e`, and
`python3 job.py` all run code Buckle cannot read. So does a [script file](policy-03.md#script-files)
run directly: `bash deploy.sh`, `source ./env.sh`, and `./deploy.sh`.

## What stays asked

- A [history restore](change-history.md) asks in both modes.
- Outside the workspace, or its mount when one is set, nothing changes. Deny rules, the mount, and
  the state directory still refuse.
- A call holding an ask the mode answers and one it keeps asks the kept one alone.
- A destructive command never takes `always`, whoever answers it.
- At `safe`, an unknown interpreter's or a script file's ask goes to the [decision AI](judge.md)
  first where it is set to answer it, as with the switch off, and to a person otherwise. The decision AI's quick
  stage still rates allowed commands where it is set to; at `on` it rates nothing.

`npm run` and other package scripts do not ask: they are judged by their own words, and a
`package.json` the agent edits can still run anything, malware included
([known limits](../caveats/known-limits.md)). Keep the switch `off` where that matters.

## Setting and audit

Only the local CLI sets it, per workspace: `buckle policy import` refuses a file naming it, and
`buckle policy clear` keeps it. Its file lies in the workspace's state directory, which no tool
reaches and the sandbox hides from shell commands; with `BUCKLE_SANDBOX=none`, a shell command you
allowed can change it. It applies at the next call. Each use is logged as
`policy_dangerously_allowed` with its mode, and each change as `policy_dangerously_allow_changed`
([the audit log](audit-log.md)). `buckle policy show` prints the mode and what it covers.

## From an earlier build

An earlier build took the levels `command` and `all`, which are refused now. Its switch file
reads as off, and `buckle policy show` and `buckle workspace init` say so where it held the
switch on. The first time the switch is set, that file is kept whole as
`dangerously-allow.earlier.json` beside the new one, as it can hold entries this build does not
read. Entries in the audit log keep the level they were written with.
