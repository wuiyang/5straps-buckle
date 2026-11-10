/** Names the setting, never its value, which can be a path outside the workspace. */
export const BROWSER_UNAVAILABLE = 'BUCKLE_AGENT_BROWSER_COMMAND names a path that holds no program Buckle can run'
/** As BROWSER_UNAVAILABLE, for a command found where the agent writes. */
export const BROWSER_UNTRUSTED = 'BUCKLE_AGENT_BROWSER_COMMAND names a program inside the workspace or a scratch root, where an agent can write, so Buckle does not run it'
/** How the owner installs agent-browser where Buckle looks, outside any workspace (docs/user/how-to/browser-login.md). */
export const BROWSER_INSTALL = 'install it with npm i -g agent-browser, then run agent-browser install'
