# Policy

The policy is the owner's standing answer about what an agent may run and reach through Buckle,
the approval and sandbox runtime on this machine. What it refuses is refused without a question.
Buckle's file tools cannot read or change it. Only a process sandbox hides it from shell
commands: with `BUCKLE_SANDBOX=none`, a shell command can read and change the files that hold it,
and Buckle does not ask about them.

## Where it lives

Each [workspace](workspaces.md) has its own policy, in its `workspace.json`, which `buckle policy`
writes: its command lists, its approved list, its [allowed interpreters](policy-02.md#interpreters),
its tool lists, its filesystem rules, and where the agent sees its folder. The node's lists in
`buckle.env` are every workspace's defaults: an allow list a workspace has none of is the node's,
and the node's deny and destructive lists apply to every workspace ([Node
defaults](workspaces-03.md)). No other workspace's applies. `buckle policy` acts on the workspace `--workspace
<name>` or `--dir <path>` names, or else on the one whose folder holds the current directory.

## Commands

```bash
buckle policy allow-command 'pnpm {build,test} *'
buckle policy deny-command '{curl,wget}'
buckle policy destructive-command 'terraform destroy *'
```

A pattern is a glob read one shell word at a time, never a regular expression. `*` inside a word
matches any characters, and a `*` word matches one word, or the rest of the line when it comes
last. `**` matches any run of words, and `{a,b}` one alternative. Buckle refuses the characters
`^ $ ( ) | \ + ? [ ]` in a pattern.

- An allow list with an entry admits only command lines a glob covers whole, as typed, so a
  prefix such as `env` never carries another command past it. A command written as a path that a
  glob covers only by its bare word asks, unless a glob spells that path
  ([bare words](policy-02.md#a-command-written-as-a-path)).
- A deny glob refuses every command line that starts with it, wherever Buckle finds that line.
- A destructive glob adds to the [destructive floor](approvals.md#the-destructive-floor), which
  asks, once or for the session.

A shell wrapper (`bash -c`, or `-c` with `sh`, `zsh`, `dash`, `ksh`, `fish`, `rbash`, `ash`,
`mksh`, `yash`, or `posh`) that a call starts with, or reaches through a prefix such as `sudo`,
`env`, or `xargs`, hides its command from word globs, so it needs its own allow rule, such as
`buckle policy allow-command 'bash -c *'`, even with no allow list; `script_run` with the `bash`
runtime is one. Behind a prefix the rule names the prefix as typed, `sudo bash -c *`, since
`bash -c *` alone does not admit `sudo bash -c ls`; the refusal names that rule
([Troubleshooting](troubleshooting-02.md#a-bash-script-is-refused)). A shell reached through
`find -exec`, `su -c`, `sudo -s`, or an `ssh` remote command needs no such rule: the deny rules
and the destructive floor judge its commands.

No pattern lets a tool run Buckle's admin commands, such as `buckle approve`, `buckle policy`,
or `buckle settings`.

[What Buckle reads](policy-02.md) in a call, where that reading stops, and how interpreters count
continue on the next page, and [what stays unread](policy-03.md), with what to do about it, on the
one after. [Known limits](known-limits.md) lists what Buckle does not yet read or hide.

## Network

```bash
buckle policy allow-url localhost:3000
buckle policy allow-url https://app.example.com/admin
```

An entry is a host (`example.com`), a host and port (`example.com:8443`), a pattern
(`*.example.com` covers the apex and every subdomain), or an http(s) URL prefix. A
wildcard anywhere but the whole leftmost label is refused.

Each workspace has one approved list, shared by `web_fetch`, browser navigation, and forge
pushes: its own, else the node's (`BUCKLE_NETWORK_ALLOW` and `BUCKLE_ALLOWED_HOSTS` as one). With
a list, they reach only what it names. An entry naming a host exactly, or a URL prefix, lets
`web_fetch` reach it even at a private address; a host a wildcard covers is refused there where it
resolves into one. Browser navigation and forge pushes judge the name as written and never resolve
it ([known limits](known-limits-04.md#the-url-list)). Without a list, public hosts are reachable,
and loopback, private, and other reserved addresses ask, per host and port. `web_fetch` checks every resolved address and every redirect hop, up to
five. With no public-suffix list, `*.com` would cover every `.com` name. An empty approved list is
no list: `buckle policy remove` warns when it takes out the last entry.

`buckle check-url <url|host>` shows what an address would meet, with no node running; it exits 0
approved, 1 denied, 3 asks, 4 not listed, or 2 on bad input.

## Tools and files

- `buckle policy deny-tool fs_write` refuses a tool outright; `allow-tool` lifts that. A tool
  in a withheld pack stays withheld.
- `buckle policy mount /workspace` shows the workspace to the agent at that path; every path
  outside it and its [mounts](mounts.md) is then refused, not asked. The folder may not show under
  `/bin`, `/etc`, `/home`, `/tmp`, `/usr`, or another system directory; extra mounts follow that
  page's list.
- Sensitive files ask every time, matched on the exact path, so a granted directory never unlocks
  one: anything under `.ssh`, `.gnupg`, `.aws`, `.kube`, `.docker`, `.config/gcloud`,
  `.password-store`, browser and mail profiles, or `keychains`; `.env` files except
  `.env.schema`; and names such as `.netrc`, `.npmrc`, `.git-credentials`, `id_rsa`, `*.pem`,
  `*.key`, and `secrets.yaml`.
- Filesystem rules exist only in a file loaded with `buckle policy import`:
  `{"version":1,"filesystem":{"rules":[{"path":"secrets","read":"deny","write":"deny"}]}}`. Each
  rule names a workspace-relative path and `allow`, `ask`, or `deny` for `read` and `write`; any
  deny wins, otherwise the longest path decides. Any rule stops plugins loading, and a deny or
  ask rule withholds the `git`, `forge`, and `dev` packs.

## Inspecting and changing it

```bash
buckle policy show          # every list, the mount table, and the dangerously-allow switch
buckle policy export > policy.json
buckle policy import policy.json
buckle policy remove 'pnpm {build,test} *'
buckle policy clear         # empties every list, keeping the mount
```

`buckle policy` exits 0 when done, 1 on a refused change, and 2 on a conflict: an open workbench,
active work such as a shell copy awaiting review for a mount, or an imported file naming the
dangerously-allow switch. A list changes while a shell copy awaits review.

A running `buckle serve` or `buckle mcp` takes a change up at the workspace's next call
([When a change applies](workspaces-02.md#when-a-change-applies)), and reads the
dangerously-allow switch on every call. If the stored policy stops loading, the workspace refuses
to open and names the file; `buckle policy show`, `export`, `remove`, and `clear` still run to
repair it.
