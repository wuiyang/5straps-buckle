import type { ToolCapability } from '@5straps/protocol'
import type { ScriptVm } from '../../../types/ports/script-vm.js'

/**
 * What a built-in tool's call resolves to inside a script, for the declaration comment: Buckle tools carry no output
 * schema, so a call is `Promise<unknown>`, and a script that filters a result needs its fields (D82 brief, point 9).
 * A tool not named here, a plugin's, resolves to the JSON its direct call returns.
 */
const RETURNS: Readonly<Record<string, string>> = {
  fs_read: '{ path, encoding, hash, content: string, size, firstLine?, lineCount?, totalLines?, truncated? }',
  fs_read_batch: '{ files: Array<{ path, encoding, hash, content: string, size, truncated? }> }',
  fs_write: '{ path, size, hash }',
  fs_write_batch: '{ files: Array<{ path, size, hash }> }',
  fs_patch: '{ path, replacements: number[], size }',
  fs_move: '{ from, to, replaced: boolean, copied?, leftOver? }',
  fs_delete: '{ removed: number, results: Array<{ path, removed: boolean, missing?, refused?, code?, notAttempted? }> }',
  fs_list: '{ path, entries: Array<{ path (inside the listed path), name, type: "file" | "directory" | "symlink", size, modifiedAt }>, truncated }',
  fs_find_names: '{ path, matches: string[], truncated }',
  fs_search_content: '{ matches: Array<{ path, line, text, ranges }>, truncated, excludedFiles }',
  web_fetch: '{ url, status, headers, body: string, truncated }',
  web_search: '{ query, results: Array<{ title, url, description }> }',
  git_status: '{ branch, upstream, entries: Array<{ state, path }>, clean }',
  git_diff: '{ diff: string }',
  git_log: '{ commits: Array<{ hash, author, date, subject }> }',
  git_blame: '{ lines: Array<{ hash, author, text }> }',
  git_branch: '{ branches: Array<{ name, upstream, commit, current }> }',
  git_commit: '{ hash, subject, files: string[] }',
  git_push: '{ branch, remote, headSha }',
  pr_open: '{ number, url, headSha, state }',
  pr_read: '{ number, state, title, head, base, diff?, files?, comments? }',
  lsp_discover: '{ servers: Array<{ pid, serverId, commandLine, attach, port }> }',
  lsp_definition: '{ locations } (the language server\'s answer)',
  lsp_references: '{ locations } (the language server\'s answer)',
  lsp_hover: '{ hover } (the language server\'s answer)',
  lsp_rename: '{ workspaceEdit } (the language server\'s answer, not applied)',
  lsp_diagnostics: '{ uri, diagnostics: object[] }',
  browser_command: '{ result, stderr, truncated, notice? } (result: agent-browser\'s JSON, or its text)',
  shell_exec: '{ exitCode, signal, stdout, stderr, truncated, timedOut, sandbox }',
  script_run: '{ exitCode, signal, stdout, stderr, truncated, timedOut, sandbox }',
  env_validate: '{ valid, timedOut }',
}

/** The estimated tokens (characters / 4) the declarations in code_run's description may take. */
export const DECLARATION_BUDGET_TOKENS = 4_000
const CHARS_PER_TOKEN = 4

/** One tool's comment: its own description, then what its call resolves to. */
function described(tool: Pick<ToolCapability, 'name' | 'description'>): string {
  const returns = RETURNS[tool.name]
  return `${tool.description.trim()}\nResolves to ${returns ?? 'the JSON its direct call returns'}.`
}

/** The declarations of the named tools, in the order given. */
export function declare(vm: ScriptVm, tools: ReadonlyArray<Pick<ToolCapability, 'name' | 'description' | 'inputSchema'>>): string {
  return tools.length === 0 ? '' : vm.declare(tools.map(tool => ({ name: tool.name, description: described(tool), inputSchema: tool.inputSchema })))
}

/**
 * The tools whose declarations fit the budget, in manifest order, each taking what its own declaration costs; a
 * tool that does not fit is left to be named, and the ones after it may still fit.
 */
export function withinBudget(vm: ScriptVm, tools: readonly ToolCapability[], budgetTokens = DECLARATION_BUDGET_TOKENS): { declared: ToolCapability[]; named: ToolCapability[] } {
  const declared: ToolCapability[] = []
  const named: ToolCapability[] = []
  let left = budgetTokens * CHARS_PER_TOKEN
  for (const tool of tools) {
    const cost = declare(vm, [tool]).length
    if (cost <= left) {
      declared.push(tool)
      left -= cost
    } else {
      named.push(tool)
    }
  }
  return { declared, named }
}

/** How a script is written, ahead of the declarations in code_run's description. */
const GUIDE = [
  'Run a JavaScript script that calls this node\'s other tools, and get back only what it prints and returns. Use it to batch calls, chain them, or filter large results before you read them.',
  'The script is the body of an async function in a QuickJS sandbox: top-level `await` and `return` work. It has no files, network, processes, timers, or modules of its own; it reaches the machine only through `tools`.',
  '- `await tools.<name>(args)` calls a tool and resolves to its JSON output. A failed or refused call rejects with an Error whose message is `<code>: <message>` and which carries `code` and `retryable`. A name not in `ALL_TOOLS` throws a TypeError.',
  '- Every call is judged, approved, and audited as a direct call. If one needs a person, this tool answers `approval_required`: relay it, then send the same script again once it is answered (`timeoutMs` may change); Buckle replays the calls that already ran. Never change the script to get around an ask.',
  '- After a timeout or a cancel, the same script sent again within ten minutes goes on where it stopped; past 32 MiB of results it cannot, and each call that ran answers `REQUEST_ALREADY_EXECUTED` instead. Change one character of it to run it from its start.',
  '- `text(value)` and `console.log(...)` print one line each; `return value` gives the result; `exit()` ends the script.',
  '- `ALL_TOOLS` lists `{ name, description }`; `await searchTools(query, { limit })` resolves to the ones whose name or description holds every word, 8 by default; `await describeTool(name)` resolves to a tool\'s declaration; `code_api` returns them all.',
  '- At most 256 calls per script, refused ones counted, and 10000 describeTool and searchTools calls; 8 run at once and the rest wait their turn; one call\'s arguments are held to the node\'s request size. Output and the return value are cut to 1048576 characters each, keeping the start and the end; past 100000 output lines or 16777216 characters the script fails.',
].join('\n')

/** code_run's description: the guide, the declarations within the budget, and the names of the rest. */
export function codeRunDescription(vm: ScriptVm, tools: readonly ToolCapability[]): string {
  const { declared, named } = withinBudget(vm, tools)
  return [
    GUIDE,
    ...(declared.length > 0 ? [`Tools a script can call:\n\n${declare(vm, declared)}`] : ['No other tool is reachable from a script here.']),
    ...(named.length > 0 ? [`Also callable, declared by code_api or describeTool(name): ${named.map(tool => tool.name).join(', ')}.`] : []),
  ].join('\n\n')
}
