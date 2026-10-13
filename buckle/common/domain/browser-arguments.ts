/** Chromium switches that choose a profile folder, which BUCKLE_BROWSER_PROFILE alone names, under its path rule. */
const PROFILE_SWITCHES = ['user-data-dir', 'profile-directory']

/** Switches that restore or open pages, which agent-browser refuses beside an approved list (its allowed_domains_disallowed_chrome_arg). */
const PAGE_SWITCHES = ['restore-last-session', 'restore-session', 'app', 'app-id', 'app-launch-url-for-shortcuts-menu-item', 'load-and-launch-app']

const NOT_A_SWITCH = 'BUCKLE_BROWSER_ARGS holds an argument that is not a switch, such as a page, a path, or the part of one switch after a comma: agent-browser splits the value at commas and new lines, and refuses a page or a path beside an approved list'

/** Fixed text for a path an argument spells so that Buckle cannot place it, which never names the path. */
const RELATIVE_PATH = 'BUCKLE_BROWSER_ARGS names a path by a spelling Buckle cannot place: a .. segment, a leading ./ or ~, or on Windows a drive or a root alone; give its absolute path, which Buckle judges where it lies'

/** Fixed text for a path an argument names where Buckle does not load from, which never names the path. */
export const ARGS_UNTRUSTED = 'BUCKLE_BROWSER_ARGS names a path inside or around a workspace, a scratch root, or the node\'s state directory, where an agent can write or Buckle keeps its state, so Buckle does not pass it'

/**
 * BUCKLE_BROWSER_ARGS as agent-browser reads its `--args`: split at commas and new lines, each piece trimmed, and the
 * empty ones dropped, so one argument can never hold a comma.
 */
export function browserArguments(value: string): string[] {
  return value.split(/[,\n]/).map(argument => argument.trim()).filter(Boolean)
}

/**
 * One argument read as a Chromium switch: after `--` or `-`, and after `/` on Windows alone, where Chromium reads it as
 * a switch prefix too, a name that runs to `=` or a space and holds no slash, in lower case, with the value after `=`
 * when there is one. Null for anything else, which Chrome opens as a page or a path.
 */
export function chromiumSwitch(argument: string, platform: NodeJS.Platform = process.platform): { name: string; value: string | null } | null {
  const body = argument.replace(platform === 'win32' ? /^(?:--|\/|-)/ : /^(?:--|-)/, '')
  if (body === argument) return null
  const [name = ''] = body.split(/[= ]/)
  if (!name || /[/\\]/.test(name)) return null
  const equals = body.indexOf('=')
  return { name: name.toLowerCase(), value: equals === name.length ? body.slice(equals + 1) : null }
}

/**
 * A switch value that spells a path Buckle cannot place: a `..` segment, which climbs out of where it starts; a leading
 * `~`, the home folder; a leading `./` or `.\`; and on Windows a drive-relative `C:x`, or a value rooted at `/` or `\`
 * alone, which names whichever drive is current, as isFullPath reads it. A bare relative name resolves against Chrome's
 * working directory, Buckle's browser state directory, where no agent writes, and anything else, such as text/plain,
 * 10.0.0.0/8, or .example.com, is no path Buckle reads; an absolute path is judged where it lies.
 */
function unplacedPath(value: string, platform: NodeJS.Platform): boolean {
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(value) || value.startsWith('~') || /^\.[/\\]/.test(value)) return true
  return platform === 'win32' && (/^[a-z]:(?![/\\])/i.test(value) || /^[/\\](?![/\\])/.test(value))
}

/**
 * Why BUCKLE_BROWSER_ARGS is refused at start, or null. Every argument agent-browser would refuse beside an approved
 * list is refused, as a list can be set while the node runs: a page or path, and a switch that restores or opens
 * pages. So is a profile switch, which BUCKLE_BROWSER_PROFILE alone names, and a value that spells a path Buckle cannot
 * place (unplacedPath); an absolute one is judged where it lies when the pack is built. A refusal names a switch from these lists,
 * never what the owner wrote.
 */
export function browserArgumentsRefusal(value: string, platform: NodeJS.Platform = process.platform): string | null {
  for (const argument of browserArguments(value)) {
    const parsed = chromiumSwitch(argument, platform)
    if (parsed === null) return NOT_A_SWITCH
    if (PROFILE_SWITCHES.includes(parsed.name)) return `BUCKLE_BROWSER_ARGS may not pass --${parsed.name}: name a profile folder with BUCKLE_BROWSER_PROFILE, which Buckle checks against the places an agent can write`
    if (PAGE_SWITCHES.includes(parsed.name)) return `BUCKLE_BROWSER_ARGS may not pass --${parsed.name}: it restores or opens pages before the approved list holds, so agent-browser refuses it beside one`
    if (parsed.value && unplacedPath(parsed.value, platform)) return RELATIVE_PATH
  }
  return null
}
