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
  ]),
  prefixes: Object.freeze(['LD_', 'DYLD_', 'NODE_', 'PYTHON', 'PERL', 'RUBY', 'GEM_', 'BUN_', 'DENO_']),
})

/** One variable a call sets for its command, as the decision AI is shown it. */
export interface CallVariable { name: string; value: string }

/** The variables a call's `env` argument sets, sorted by name, each value as the agent gave it. */
export function callVariables(args: JsonObject): CallVariable[] {
  const env = args.env
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return []
  return Object.entries(env).flatMap(([name, value]) => (typeof value === 'string' ? [{ name, value }] : [])).sort((one, other) => (one.name < other.name ? -1 : one.name > other.name ? 1 : 0))
}

/** The first variable, by name, that changes what code runs, or undefined where the call sets none. */
export function codeLoadingVariable(variables: ReadonlyArray<{ name: string }>): string | undefined {
  return variables.find(({ name }) => {
    // The child reads an entry up to its first `=`: `PATH=/w/bin` as a name sets PATH (fix brief 2, H4).
    const upper = name.split('=')[0]!.toUpperCase()
    return CODE_LOADING_VARIABLES.names.includes(upper) || CODE_LOADING_VARIABLES.prefixes.some(prefix => upper.startsWith(prefix))
  })?.name
}

/** Why a call that sets a code-loading variable is not rated: its name alone, quoted where it is not a plain name, never its value. */
export function codeLoadingReason(name: string): string {
  return `the call sets ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name)}, which changes what code runs; the decision AI does not rate it`
}

/**
 * Every variable the call sets with a value, as the stages are shown them (fix brief 2, H3): its `env` argument, then
 * the values its own words and shell text assign, each once, sorted by name and then value.
 */
export function joinedVariables(env: readonly CallVariable[], assigned: ReadonlyArray<{ name: string; value: string | null }>): CallVariable[] {
  const all = [...env, ...assigned.flatMap(({ name, value }) => (value === null ? [] : [{ name, value }]))]
  const order = (item: CallVariable) => `${item.name}\0${item.value}`
  return all.filter((item, index) => all.findIndex(other => order(other) === order(item)) === index).sort((one, other) => (order(one) < order(other) ? -1 : order(one) > order(other) ? 1 : 0))
}

/**
 * The variables as the stages are shown them: the agent's own text, so each value is sent, with a value under a name that
 * reads as a secret hidden whole and every other value through the redaction the shown command's words take.
 */
export function shownVariables(variables: readonly CallVariable[]): CallVariable[] {
  return variables.map(({ name, value }) => ({ name, value: isSecretName(name) || isNamedCredentialKey(name, value) ? '[redacted]' : redactCredentials(value, 'value') }))
}
