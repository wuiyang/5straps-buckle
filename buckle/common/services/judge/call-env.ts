import type { JsonObject } from '@5straps/protocol'
import { isNamedCredentialKey, redactCredentials } from '@5straps/runtime'
import { isSecretName } from '../../domain/environment.js'

/**
 * The variables that change what code an interpreter or the loader runs (D91, fix brief 1 item 14): a search path, a
 * startup file, a preloaded library, or an interpreter's own options. A call that sets one is not rated, so it asks a
 * person as before; under scope `all` nothing is screened and an allowed command runs as it would without the decision
 * AI. A name is compared upper-cased, as Windows reads `Path` as `PATH`.
 */
export const CODE_LOADING_VARIABLES = Object.freeze({
  names: Object.freeze([
    'PATH', 'IFS', 'ENV', 'BASH_ENV', 'ZDOTDIR', 'SHELLOPTS', 'BASHOPTS', 'CDPATH', 'GCONV_PATH', 'GLIBC_TUNABLES',
    'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'PHP_INI_SCAN_DIR', 'PHPRC', 'GOFLAGS', 'GOPATH', 'GOROOT',
    // SHELL: flock runs its `-c` text through `$SHELL -c`, so a call that sets it chooses the shell that runs that text
    // (fix brief 5, P3). HOME: zsh reads its startup files from HOME when ZDOTDIR is unset, and Python runs
    // usercustomize.py from the user site under HOME at startup (fix brief 5, P4). Both are coordinator defaults
    // recorded for the owner, reversible.
    'SHELL', 'HOME',
  ]),
  // BASH_FUNC_: bash imports a function from `BASH_FUNC_<name>%%`, which then runs in place of the command it names.
  prefixes: Object.freeze(['LD_', 'DYLD_', 'NODE_', 'PYTHON', 'PERL', 'RUBY', 'GEM_', 'BUN_', 'DENO_', 'BASH_FUNC_']),
})

/** One variable a call sets for its command, as the decision AI is shown it. */
export interface CallVariable { name: string; value: string }

/** The variables a call's `env` argument sets, sorted by name, each value as the agent gave it. */
export function callVariables(args: JsonObject): CallVariable[] {
  const env = args.env
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return []
  return Object.entries(env).flatMap(([name, value]) => (typeof value === 'string' ? [{ name, value }] : [])).sort((one, other) => (one.name < other.name ? -1 : one.name > other.name ? 1 : 0))
}

const CODE_LOADING_NAMES: ReadonlySet<string> = new Set(CODE_LOADING_VARIABLES.names)

/** The first variable, by name, that changes what code runs, or undefined where the call sets none; linear in the variables (fix brief 3, H3). */
export function codeLoadingVariable(variables: ReadonlyArray<{ name: string }>): string | undefined {
  return variables.find(({ name }) => {
    // The child reads an entry up to its first `=`: `PATH=/w/bin` as a name sets PATH (fix brief 2, H4).
    const equals = name.indexOf('=')
    const upper = (equals < 0 ? name : name.slice(0, equals)).toUpperCase()
    return CODE_LOADING_NAMES.has(upper) || CODE_LOADING_VARIABLES.prefixes.some(prefix => upper.startsWith(prefix))
  })?.name
}

/** The most of a variable's name a reason shows, in characters (fix brief 3, F4). */
export const SHOWN_NAME_LIMIT = 256

/**
 * Why a call that sets a code-loading variable is not rated: its name alone, the part before any `=` so no value is
 * quoted, clipped to SHOWN_NAME_LIMIT characters with ` [cut]` (fix brief 3, F4), and quoted where it is not a plain name.
 */
export function codeLoadingReason(name: string): string {
  const characters = Array.from(name.split('=')[0]!)
  const part = characters.slice(0, SHOWN_NAME_LIMIT).join('')
  const shown = /^[A-Za-z_][A-Za-z0-9_]*$/.test(part) ? part : JSON.stringify(part)
  return `the call sets ${shown}${characters.length > SHOWN_NAME_LIMIT ? ' [cut]' : ''}, which changes what code runs; the decision AI does not rate it`
}

/** The most variables, the env argument's and the assignments' together, a call may send the stages (fix brief 3, H3). */
export const MAX_SHOWN_VARIABLES = 256

/**
 * Every variable the call sets with a value, as the stages are shown them (fix brief 2, H3): its `env` argument, then
 * the values its own words and shell text assign, each once by a key built once, sorted by name and then value. Null
 * past `limit`, before any sort, so a call that sets more than the stages are sent is refused in linear time (fix brief
 * 3, H3).
 */
export function joinedVariables(env: readonly CallVariable[], assigned: ReadonlyArray<{ name: string; value: string | null }>, limit = Number.POSITIVE_INFINITY): CallVariable[] | null {
  const unique = new Map<string, CallVariable>()
  for (const item of [...env, ...assigned]) {
    if (item.value === null) continue
    const key = `${item.name}\0${item.value}`
    if (unique.has(key)) continue
    unique.set(key, { name: item.name, value: item.value })
    if (unique.size > limit) return null
  }
  return [...unique].sort(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0)).map(([, item]) => item)
}

/**
 * The variables as the stages are shown them: the agent's own text, so each value is sent, with a value under a name that
 * reads as a secret hidden whole and every other value through the redaction the shown command's words take.
 */
export function shownVariables(variables: readonly CallVariable[]): CallVariable[] {
  return variables.map(({ name, value }) => ({ name, value: isSecretName(name) || isNamedCredentialKey(name, value) ? '[redacted]' : redactCredentials(value, 'value') }))
}
