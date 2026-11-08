# Known limits, part four

[Part three](known-limits-03.md) covers code mode, the command line, and workspaces.

## The sandbox layout

- A command in the sandbox can read `/proc/self/mountinfo`, which names the host folder behind
  each bind: the workspace's folder, each mount's source, the toolchains, and the folder holding
  the sandbox's own account files. No bind layout hides it.
- No test starts a real `bwrap`: neither this project's machines nor CI install bubblewrap, so the
  layout (`--tmpfs /`, the system folders, the `/etc` files, each mount, and `--hostname buckle`) is
  checked as the arguments Buckle passes. A distribution that keeps its certificates or loader
  elsewhere, such as NixOS or Alpine, may need a toolchain folder named in
  `BUCKLE_MOUNT_READ_ONLY`.
- The sandbox's own `/etc/passwd` and `/etc/group` name the user and group the command runs as
  `agent`, and its `/etc/hosts` names `localhost`, `buckle`, and the IPv6 aliases `ip6-localhost` and
  `ip6-loopback` alone. A program that looks up another
  account, a group the owner belongs to, or a name the machine's hosts file holds, finds none.
- A mount's source, and the workspace's folder, are checked where they land at each shell call,
  then bound by path: a swap for a link in the moment between the two is not caught.
- Buckle hides credential files in the workspace's folder from shell commands, but not those
  inside a mount, and does not read a mount through for them: a mount shares what it holds.
- Without a mount, the folder shows at its real path, and the node's `BUCKLE_MOUNTS` reach the
  shell alone, as before: the file tools cannot name a target there.
- A workbench terminal shows its copy of the folder at `/workspace` whatever the workspace's
  mount, and every mount read-only, the node's scratch roots outside the folder included. It
  sees the workspace's variables, as a shell does.
- The [dangerously-allow switch](../how-to/approvals-04.md) answers asks about paths inside
  the workspace's folder, not inside its mounts: a write into a read-write mount still asks.

## Windows shares

- A share is judged by the mount table alone: Buckle reaches a path on one where a mount holds
  it, and cannot tell a share another program redirects. Only an imitated Windows has tested
  shares and mapped drives so far, not a Windows machine.
- A program on a share runs only from a read-only mount; a share a program's `PATH` entry names
  outside every mount is dropped from that `PATH`, as before workspaces.

## The URL list

- `web_fetch` checks where a host resolves, then fetches it: a name that resolves elsewhere
  between the two (DNS rebinding) can still reach a private address. A host a wildcard entry
  covers is checked this way; one an entry names exactly is not checked, as the owner named it.
- `BUCKLE_ALLOWED_HOSTS` is now the node's URL list too, so a node that set it and no
  `BUCKLE_NETWORK_ALLOW` turns the list on for every workspace that has none of its own: an
  unlisted public host is refused, where 0.1 reached it. A wildcard entry no longer lets
  `web_fetch` reach a private address.
- Browser navigation and forge pushes judge a host by its name and never resolve it: a host a
  wildcard entry covers is reached wherever it resolves, a private address included, where
  `web_fetch` refuses it.
- A [private range](../how-to/sandbox-and-tools-02.md#private-ranges) covers every name that
  resolves into it: with `10.0.0.0/8` listed, a public name pointed at an address there reaches
  it, as the address itself would.
- With a list, no grant decides: an unlisted host is refused, never asked, so the browser's
  `--allowed-domains` is the list's entries alone; grants join it once a mode that asks about
  an unlisted host exists.

## The browser

- A profile folder or an attached Chrome serves one workspace at a time, judged at each
  `browser_command` by the folder it really is and the Chrome's host and port. A browser another
  workspace started on it before the change keeps running until its `close` or its idle timeout;
  meanwhile a profile folder's browser here does not start.
- [Part ten](known-limits-10.md) lists what an attached Chrome's host and port leave: which names
  count as one Chrome, and what a refused connection proves.
- The holder of the node's profile folder or Chrome is chosen by the packs and tool policy in force,
  not by whether the pack runs. A workspace whose browser pack is withheld for its own reason, such as
  a refused setting, still holds it until the setting changes or the pack is switched off.
- The setup face's `/workspaces/<name>/setup/status` still names the node's `BUCKLE_BROWSER_*`
  setting in `browser.setting`, whether the workspace's own setting or the node's chose the mode.
- On Windows, Buckle passes `--no-startup-window`, so a launch opens one window, not Chrome's own New
  Tab window beside the page, and starts `agent-browser` with no console window of its own.
  `agent-browser` before 0.37.1 still shows a headless browser's windows on the desktop, and can leave
  a browser open when its daemon ends; Buckle names that version in its log at start, and
  `npm i -g agent-browser@latest` fixes both.
- A screenshot, PDF, or download is copied beside its target and renamed onto it, taking the old
  file's mode or, for a new file, the mode `fs_write` gives one. A delivered file replaces the
  target, so a per-file ACL on the old one is not kept.

## The forge pack

- The forge pack, which commits, pushes, and opens pull requests on GitHub, runs `git_commit` and
  `git_push` against the repository as given, with no pin to the directories Buckle checked and no
  `objects/info/alternates` check. `git_commit` refuses a repository whose `.git` is a file or a
  link, whose git folder holds a `commondir` or `gitdir` file, or with a link at the top of its git
  folder, directly in `objects`, or under `refs` or `logs`, and a local push checks its destination
  the same way. A link deeper in `objects`, such as one pack file, goes unseen, and `git_push` makes
  none of these checks on the repository it pushes from, except in a read-only mount
  ([part nine](known-limits-09.md)), so a commit or push can carry objects from
  a store outside the workspace. `git_commit` judges none of the paths it stages: a named `.env` is
  committed with no credential-file ask.
