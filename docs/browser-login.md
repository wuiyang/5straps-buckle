# Using your own browser

Buckle, the approval and sandbox runtime on your machine, gives every agent session a fresh
browser by default: no cookies, no saved logins, and nothing kept after `close`. A workspace's
[browser settings](workspaces-02.md#settings) choose otherwise: a profile folder that keeps
logins, your own Chrome attached over its DevTools port, or extra Chromium arguments. `buckle
workspace set browser.<key>` applies from the workspace's next call; `BUCKLE_BROWSER_*` in
`buckle.env`, every workspace's default, at a restart. Nothing an agent sends can select one.

Install agent-browser, the browser Buckle drives, outside any workspace
([Sandbox and tools](sandbox-and-tools.md#the-browsers-allowed-hosts)).

## Logging in without a setting

With `browser.headed` on, the browser opens a visible window, and a person logs in there
by hand. The agent never sees the credentials, only the pages after.
That session lives until `close`, its idle timeout (`browser.idleTimeoutMs`, 5 minutes unless
set, 1 minute to 1 day), or a change to the approved hosts, which relaunches the browser.

## The settings

| Setting (node default) | Value | What Buckle passes to `agent-browser` |
|---|---|---|
| `browser.profile` (`BUCKLE_BROWSER_PROFILE`) | an absolute folder that already exists | `--profile <folder>`, so cookies, storage, and cache survive `close`, idle shutdown, and node restarts |
| `browser.cdp` (`BUCKLE_BROWSER_CDP`) | a DevTools port such as `9222`, or a `ws://`, `wss://`, `http://`, or `https://` URL | `--cdp <value>` on every command, which then runs in your Chrome |
| `browser.args` (`BUCKLE_BROWSER_ARGS`) | Chromium arguments, separated by commas or new lines | `--args <value>` for a browser Buckle launches |

An attached browser stands alone: it keeps the profile, arguments, and window you started it
with, so Buckle refuses one set beside a profile, arguments, or a window, in either file, naming
the settings.

The profile folder is judged by the rule that judges `BUCKLE_AGENT_BROWSER_COMMAND`: Buckle does
not load from where an agent can write. A folder inside or around a workspace, a scratch root, a
read-write mount's source, or the node's state directory, or one reached through a link there, is
refused, and so is one that does not exist yet. A path an argument names, such as `--load-extension=<folder>`, is judged
the same way. The browser pack is then withheld, its reason naming the setting, never the path.

For example:

```bash
BUCKLE_BROWSER_ARGS=--disable-blink-features=AutomationControlled
```

`agent-browser` splits the value at commas, so one argument cannot itself hold a comma. Buckle
refuses to start, naming the setting, when the value holds:

- an argument that is not a switch, such as a page, a path, or what follows a comma inside a switch;
  a `/` starts a switch on Windows alone;
- a path spelled with a `..` segment, a leading `./` or `~`, a `file:` URL, or on Windows a drive
  or a root alone: give the absolute path, which is judged like the profile folder. A bare relative
  name, such as `ext`, resolves against Buckle's browser state directory, where no agent writes;
- `--user-data-dir` or `--profile-directory`: name a profile folder with `browser.profile`;
- `--restore-last-session`, `--restore-session`, `--app`, `--app-id`,
  `--app-launch-url-for-shortcuts-menu-item`, or `--load-and-launch-app`, which restore or open
  pages, so `agent-browser` refuses them beside an approved list.

A site may still refuse a browser it takes for automated.

## Attaching your own Chrome

Start Chrome with a DevTools port and a profile folder of its own. On Linux:

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/buckle-chrome"
```

On macOS:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/buckle-chrome"
```

On Windows, in PowerShell:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\buckle-chrome"
```

Since Chrome 136, Chrome ignores the port on its default profile, so keep a second profile folder
for Buckle, sign in there to the sites the agent needs, and leave your everyday profile out.
Then set `browser.cdp` to `9222` for the workspace that drives it.
`agent-browser` expects an approval prompt only from the switch at
`chrome://inspect/#remote-debugging` (Chrome 144 and later), not from a port on Chrome's command
line; if Chrome shows one, approve it and have the agent retry.

Buckle never closes that browser: `close`, an idle session, and Buckle's own shutdown only
disconnect, so your browser, tabs, and logins stay open. Every agent
session works in that one browser, sharing its cookies and every open tab. A session starts on a tab you already have open, so its first `open` replaces
that tab's page, and `tab close` can close any of your tabs but the last.

The DevTools port answers anything on this machine that reaches it. Shell commands have no
network unless `shell.network` is on or `BUCKLE_SANDBOX=none`; with either, a command could
drive the browser around Buckle's rules.

## What containment is lost, and what is still judged

With a fresh browser and an approved list, Buckle passes the list's hosts as `agent-browser`'s
`--allowed-domains`, so clicks, redirects, and page requests stay on them inside the browser.
`agent-browser` refuses that flag with a profile folder or an attached browser, because
Chrome can open or restore pages before the containment is installed. In those modes Buckle passes
no list, and says so in a pack-start warning naming the setting, in the tool description, and in
the agent's skill.

Still judged in every mode:

- the page each command names, by the network rules down to its port and path;
- every file a screenshot, PDF, download, or upload names, by the path rules;
- every flag, refused by name unless Buckle knows it. `--cdp`, `--auto-connect`, `--profile`, and
  `--args` stay refused to the agent, and so do `--session`, `--namespace`, `--restore`,
  `--restore-save`, `--state`, `--load`, `--credential-provider`, and `--action-policy`.

No longer judged in those modes: where a page goes after it loads, and what it requests. Every
login kept in that profile folder or browser is within the agent's reach, so it should hold only
the logins the agent's work needs.

A profile folder or an attached Chrome belongs to one workspace at a time: the one naming it as
its own setting, else the first online workspace offering the browser that takes the node's.
Another naming it as its own is refused, and a browser call elsewhere is refused, naming the holder. Every agent session of
that workspace, in every Buckle process, shares the one browser on it, with its tabs and logins;
`close` from any session, or the idle timeout, ends it for all. Buckle tells its processes apart
by process id alone, so after a node settings change restart every one.

## Checking the mode

The setup face's `/workspaces/<name>/setup/status` reports `browser.mode` as `fresh`, `profile`, or `attached`,
`browser.setting` as the setting that chose it, never its value, and `browser.withheld` as why
the browser pack is withheld or which workspace holds its folder or Chrome, else null while it runs.
