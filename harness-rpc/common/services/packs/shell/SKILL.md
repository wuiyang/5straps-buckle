---
name: buckle-shell
description: Run commands and scripts on a 5straps Buckle node, with sandboxing and destructive-command gating. Use when you need to execute something on the machine Buckle runs on.
---

# Buckle shell

## Two tools

`shell_exec` takes a program and an argument array. There is no shell, so quoting and globbing
are never a hazard. Prefer it.

```
buckle shell exec -- pnpm build
buckle shell exec -- git status --porcelain
```

`script_run` takes a script body when you genuinely need pipes, redirection, or loops.

```
buckle shell script --runtime bash --script 'for f in *.log; do wc -l "$f"; done'
```

## What gets gated

Destructive commands ask for approval whether or not they are inside the sandbox:
recursive or forced `rm`, `dd of=`, `mkfs`, `shred`, recursive `chmod`/`chown`, `sudo`,
`git push --force`, `git reset --hard`, `git clean -f`, writes to `/dev/*`, and scripts that
pipe a download into a shell. You will get `approval_required`. Relay it, and do not try to
work around it by rephrasing the command.

The first write into any directory also asks, once, and is then remembered.

## Sensitive files

Only `.env.schema` is exempt from the environment-file credential rule. Before executing a
command that reads `.env.local` or another sensitive file, supply exact workspace paths in
`sensitiveFiles`. Each call requests WARNING approval; only Allow once is available.

```json
{"command":"node","args":["scripts/seed.mjs"],"cwd":"/workspace","sensitiveFiles":["/workspace/.env.local"]}
```

Relay the approval request. The owner can Allow once, Deny, Deny this session, or Always deny.
A denied path stays denied for that scope. Do not retry through another tool to bypass it.
Approved files are mounted read-only into this call's isolated Bubblewrap workspace. They are
not copied into its checkpoint. Commands can still disclose secrets in output or copied files;
never print their contents. Use filesystem tools for separately approved edits.

Undeclared sensitive files stay hidden. Buckle does not intercept filesystem system calls:
if a script reports a missing sensitive input, retry with an explicit file request, not a
changed path or relaxed sandbox. Interactive terminals do not support these per-call requests.

## Sandboxing

These tools only exist on a node that can sandbox them. Where nothing is available, the pack is
withheld and `buckle manifest` says so, so a missing `shell_exec` means the machine cannot run
commands safely rather than that something broke.

Every result carries a `sandbox` field naming the active mode: `bubblewrap` on Linux,
`seatbelt` on macOS, or `none`. When it reads `none`, the operator explicitly accepted running
unsandboxed. Treat the machine as fully exposed and be careful in proportion.

Set `allowNetwork: false` for commands that have no business reaching the network; the
sandbox enforces it where a real sandbox is active.

## Timeouts

A timed-out command still returns whatever it printed, with `timedOut: true`. Read the
partial output before retrying, because it usually says what hung.
