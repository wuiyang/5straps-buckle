import { RESULT_DESCRIPTIONS as FS_RESULTS } from './fs/results.js'
import { RESULT_DESCRIPTIONS as HISTORY_RESULTS } from './history/results.js'
import { RESULT_DESCRIPTIONS as WEB_RESULTS } from './web/results.js'
import { RESULT_DESCRIPTIONS as GIT_RESULTS } from './git/results.js'
import { RESULT_DESCRIPTIONS as FORGE_RESULTS } from './forge/results.js'
import { RESULT_DESCRIPTIONS as DEV_RESULTS } from './dev/results.js'
import { RESULT_DESCRIPTIONS as BROWSER_RESULTS } from './browser/results.js'
import { RESULT_DESCRIPTIONS as SHELL_RESULTS } from './shell/results.js'
import { RESULT_DESCRIPTIONS as ENVIRONMENT_RESULTS } from './environment/results.js'

/**
 * What a built-in tool's call resolves to inside a script, for the declaration comment: Buckle tools carry no output
 * schema, so a call is `Promise<unknown>`, and a script that filters a result needs its fields (D82 brief, point 9).
 * A tool not named here, a plugin's, resolves to the JSON its direct call returns.
 */
export const BUILTIN_RESULT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ...FS_RESULTS,
  ...HISTORY_RESULTS,
  ...WEB_RESULTS,
  ...GIT_RESULTS,
  ...FORGE_RESULTS,
  ...DEV_RESULTS,
  ...BROWSER_RESULTS,
  ...SHELL_RESULTS,
  ...ENVIRONMENT_RESULTS,
}
