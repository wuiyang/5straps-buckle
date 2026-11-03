# Browser sessions

Buckle, the approval and sandbox runtime on your machine, drives a browser for an agent through `agent-browser`, a
browser for agents, and records each browser it starts in the workspace's state, so it can end every one. [Using your own browser](browser-login.md) covers the settings that choose the browser,
and [Secret masking](secrets-02.md#after-a-browser-fill) the hold a secret fill leaves.

## Which browser a call reaches

A fresh browser serves one caller, stage, and alias: the agent's connection, the stage a client sends
with each call, and the `session` alias the agent names, `default` where absent. Calls with the same three reach one browser across turns; a new stage or alias starts another,
so two stages never share a page. A profile folder has one browser that every caller of the workspace shares, and an
attached Chrome is one browser every caller connects to. Another workspace, or another Buckle node, on the same folder has
its own; Chrome opens a folder in one browser at a time, so a call there fails, saying so, until the other's browser ends.

A change to the browser settings, such as `browser.headed`, `browser.args`, `browser.idleTimeoutMs`, the mode, or the
approved hosts, closes the caller's browser at its next call and starts a new one for the same caller, stage, and alias.
A Buckle process still running under the old settings keeps its own browser beside the new one, and the log asks you
once to restart every Buckle process on the node.

One launch shows one window: Buckle passes `--no-startup-window` in `agent-browser`'s `--args`, after your own
`browser.args`, so Chrome opens no New Tab window of its own beside the page. A session's first command runs alone, as it
starts the browser, so two calls never start two browsers for one session.

## What ends a browser

| Event | What it ends |
|---|---|
| The agent's `close` | That caller's browser for its stage and alias, or the profile folder's one browser. An attached Chrome only disconnects. Where no browser is recorded, nothing runs, and the answer says no browser was open. |
| The idle timeout, `browser.idleTimeoutMs` (five minutes unless set) | `agent-browser` ends an unused browser. Buckle ends its record, and its hold, once that time and the longest call, `BUCKLE_MAX_TIMEOUT_MS`, have passed since its last use. |
| A Buckle process that stops with its close step: Ctrl-C, `buckle service stop`, or an MCP client closing `buckle mcp` | Every browser that process used last, a profile folder's included. |
| The next start after a stop that skipped it: a crash, a closed console window, or a killed `buckle mcp` | Every browser whose process no longer runs, and every one past its idle timeout, before any call runs. Every Buckle process that opens the workspace checks first: `buckle serve`, `buckle mcp`, and each CLI command. |
| A close while a call runs on the browser | The browser, once the last call on it ends; it keeps its hold until then, and a profile folder's calls are refused meanwhile, saying so. |
| `buckle browser close` | Every browser the workspace recorded, in every Buckle process. |

Every close Buckle sends is a bare close, the session and Buckle's empty configuration alone, never `--headed`, `--args`,
or the allowed hosts, so `agent-browser` never starts a browser only to close it. A close that fails leaves the browser
recorded with its hold, and is tried again at the next start. The agent's `close` takes no arguments: `close --all`
would end every `agent-browser` session on the machine, your own among them.

## The owner's command

```bash
buckle browser close [--workspace <name>]
```

It ends every browser the workspace's agents left open, in every Buckle process on this machine, and drops what their
pages held. It holds the workspace's sessions lock while it closes, so no call starts a browser meanwhile; a call in
another process waits, or is refused with `STATE_BUSY`, to retry. It prints what it did:

```
Closed 2 of 2 browsers of workspace site, and dropped 1 held secret value.
```

It exits 1, saying what stays, where it could not end everything:

- A browser whose close failed stays recorded with its hold; the next start, or the command run again, ends it.
- A browser a call still runs on closes when the last call on it ends.
- An attached Chrome keeps its pages through a close, so its hold stays until the command, run while the workspace
  attaches to it, finds that Chrome closed, its host and port refusing connections. Close it first.

It needs no running node, and works on an offline workspace too, or one whose `packs.enabled` leaves the browser out.
A running node shares the same records, so its next call finds them gone and starts a fresh browser. The audit log
records it as `cli_browser_close`.

## What ends a hold

A fill from a secret reference is held by the browser it went into, not by the workspace. A call is masked by what the
browser it reaches holds: its own fresh browser's, the profile folder's one browser's, or the attached Chrome's. A hold
keeps every value a reference was filled with, and a fill of another value of it into the same browser is refused. A
hold ends with its browser: at its `close`, its idle timeout, the start after its process stopped, or that process's
shutdown. An attached Chrome keeps its pages through `close` and a restart, so its hold lasts until `buckle browser close`
finds that Chrome closed.

When the file behind a held value is gone or changed, a call on that browser is refused, as its result could not be
masked. The refusal names each browser that holds the value, by caller, session alias, stage, and last use, with the
`close` that ends it, and `buckle browser close --workspace <name>`, which ends them all. Put the file back, or end the
browser.

## After upgrading from 0.1.9

Buckle 0.1.9 kept one hold for the whole workspace and never ended a browser a stopped process left. The first start
after the upgrade ends every browser 0.1.9 recorded, and its hold with it. A hold 0.1.9 kept with no browser recorded, as
an attached Chrome's close left one, masks every attached Chrome until `buckle browser close` finds the workspace's
attached Chrome closed. Restart every Buckle process on the node after
the upgrade.
