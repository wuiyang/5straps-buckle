# Using your own browser

Buckle, the approval and sandbox runtime on your machine, gives every agent session a fresh
browser by default: no cookies, no saved logins, and nothing kept after `close`. Three node
settings let the owner choose otherwise: a profile folder that keeps logins, your own Chrome
attached over its DevTools port, or extra Chromium arguments. Only the owner's settings set them,
in `buckle.env` or the shell Buckle starts from, whose value wins; nothing an agent sends can
select one. After a change, restart every Buckle process on the node: `buckle serve` and each
`buckle mcp`.

Install agent-browser, the browser Buckle drives, outside any workspace: `npm i -g agent-browser`,
then `agent-browser install`; Buckle also looks beside `buckle` itself.

## Logging in without a setting

With `BUCKLE_BROWSER_HEADED=true` the browser opens a visible window, and a person logs in there
by hand. The agent never sees the credentials, only the pages after.
That session lives until `close`, 5 idle minutes, or a change to the approved hosts, which
relaunches the browser.

## The settings

| Setting | Value | What Buckle passes to `agent-browser` |
|---|---|---|
| `BUCKLE_BROWSER_PROFILE` | an absolute folder that already exists | `--profile <folder>`, so cookies, storage, and cache survive `close`, idle shutdown, and node restarts |
| `BUCKLE_BROWSER_CDP` | a DevTools port such as `9222`, or a `ws://`, `wss://`, `http://`, or `https://` URL | `--cdp <value>` on every command, which then runs in your Chrome |
| `BUCKLE_BROWSER_ARGS` | Chromium arguments, separated by commas or new lines | `--args <value>` for a browser Buckle launches |

`BUCKLE_BROWSER_CDP` stands alone. An attached browser keeps the profile, arguments, and window
you started it with, so Buckle refuses to start when it is set beside `BUCKLE_BROWSER_PROFILE`,
`BUCKLE_BROWSER_ARGS`, or `BUCKLE_BROWSER_HEADED=true`, and the message names them.

The profile folder is judged by the rule that judges `BUCKLE_AGENT_BROWSER_COMMAND`: Buckle does
not load from where an agent can write. A folder inside or around a workspace, a scratch root, or
the node's state directory, or one reached through a link there, is refused, and so is one that
does not exist yet. A path an argument names, such as `--load-extension=<folder>`, is judged
the same way. The browser pack is then withheld, its reason naming the setting, never the path, in
`buckle manifest`.

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
- `--user-data-dir` or `--profile-directory`: name a profile folder with `BUCKLE_BROWSER_PROFILE`;
- `--restore-last-session`, `--restore-session`, `--app`, `--app-id`,
  `--app-launch-url-for-shortcuts-menu-item`, or `--load-and-launch-app`, which restore or open
  pages, so `agent-browser` refuses them beside an approved list.

Whatever is set, a site may still refuse a browser it takes for an automated one.

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
for Buckle, sign in there to the sites the agent needs, and leave your everyday profile out of it.
Then set `BUCKLE_BROWSER_CDP=9222` in `buckle.env` and restart every Buckle process.
`agent-browser` expects an approval prompt only from the switch at
`chrome://inspect/#remote-debugging` (Chrome 144 and later), not from a port on Chrome's command
line; if Chrome shows one, approve it and have the agent retry.

Buckle never closes that browser. `close` only disconnects, and so does an idle session after 5
minutes or Buckle's own shutdown: your browser, its tabs, and its logins stay open. Every agent
session works in that one browser: sessions share its cookies, and the agent can see and use every
tab open there. A session starts on a tab you already have open, so its first `open` replaces
that tab's page, and `tab close` can close any of your tabs but the last.

The DevTools port answers anything on this machine that reaches it. Shell commands have no
network unless `BUCKLE_SHELL_NETWORK=true` or `BUCKLE_SANDBOX=none`; with either, a command could
drive the browser around Buckle's rules.

## What containment is lost, and what is still judged

With a fresh browser and an approved list, Buckle passes the list's hosts as `agent-browser`'s
`--allowed-domains`, so clicks, redirects, and page requests stay on them inside the browser.
`agent-browser` refuses that flag with a profile folder or an attached browser, because
Chrome can open or restore pages before the containment is installed. In those modes Buckle passes
no list, and says so in a warning naming the setting at pack start, in the tool description, and
in the agent's skill.

Still judged in every mode:

- the page each command names, by the network rules down to its port and path;
- every file a screenshot, PDF, download, or upload names, by the path rules;
- every flag, refused by name unless Buckle knows it. `--cdp`, `--auto-connect`, `--profile`, and
  `--args` stay refused to the agent, and so do `--session`, `--namespace`, `--restore`,
  `--restore-save`, `--state`, `--load`, `--credential-provider`, and `--action-policy`.

No longer judged in those modes: where a page goes after it loads, and what it requests. Every
login kept in that profile folder or browser is within the agent's reach, so it should hold only
the logins the agent's work needs.

Chrome opens a profile folder in one browser at a time, so every agent session, in every
workspace and every Buckle process, shares the one browser on it, with its tabs and logins. A
Buckle process that stops leaves it running; `close` from any session, or 5 idle minutes, ends it
for all. Buckle tells its processes apart by process id alone, so after a settings change restart
every one rather than rely on it to close or reuse the right browser.

## Checking the mode

The setup face's `/setup/status` reports `browser.mode` as `fresh`, `profile`, or `attached`,
`browser.setting` as the setting that chose it, never its value, and `browser.withheld` as why
the browser pack is withheld, or null while it runs.
