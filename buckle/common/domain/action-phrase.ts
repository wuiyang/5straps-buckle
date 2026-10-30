import { printable } from './approval-instruction.js'

/**
 * What each tool does, in a few words Buckle wrote, for the head line of a question on the serve terminal (the CLI
 * display slice, C4): `action pending approval: run command`. Never the agent's text (owner decision D9), and never in
 * the call's description, which sits inside the signed challenge; the whole action follows below it (D17).
 */
const ACTIONS: Readonly<Record<string, { pack: string; phrase: string }>> = {
  shell_exec: { pack: 'shell', phrase: 'run command' },
  script_run: { pack: 'shell', phrase: 'run a script' },
  code_run: { pack: 'code', phrase: 'run code' },
  code_api: { pack: 'code', phrase: 'read the code API' },
  browser_command: { pack: 'browser', phrase: 'use the agent browser' },
  web_fetch: { pack: 'web', phrase: 'fetch a URL' },
  web_search: { pack: 'web', phrase: 'search the web' },
  fs_read: { pack: 'fs', phrase: 'read a file' },
  fs_read_batch: { pack: 'fs', phrase: 'read files' },
  fs_write: { pack: 'fs', phrase: 'write a file' },
  fs_write_batch: { pack: 'fs', phrase: 'write files' },
  fs_patch: { pack: 'fs', phrase: 'patch a file' },
  fs_delete: { pack: 'fs', phrase: 'delete files' },
  fs_move: { pack: 'fs', phrase: 'move a file' },
  fs_apply_patch: { pack: 'fs', phrase: 'apply a patch' },
  fs_list: { pack: 'fs', phrase: 'list a folder' },
  fs_find_names: { pack: 'fs', phrase: 'find files by name' },
  fs_search_content: { pack: 'fs', phrase: 'search file contents' },
  fs_receive: { pack: 'fs', phrase: 'receive a copied file' },
  fs_send: { pack: 'fs', phrase: 'send a copied file' },
  history_list: { pack: 'history', phrase: 'read the change history' },
  history_restore: { pack: 'history', phrase: 'restore files from the change history' },
  git_status: { pack: 'git', phrase: 'read the git status' },
  git_diff: { pack: 'git', phrase: 'read a git diff' },
  git_log: { pack: 'git', phrase: 'read the git log' },
  git_branch: { pack: 'git', phrase: 'read the git branches' },
  git_blame: { pack: 'git', phrase: 'read a git blame' },
  git_commit: { pack: 'forge', phrase: 'make a git commit' },
  git_revert: { pack: 'forge', phrase: 'revert a git commit' },
  git_push: { pack: 'forge', phrase: 'push to a git remote' },
  pr_open: { pack: 'forge', phrase: 'open a pull request' },
  pr_read: { pack: 'forge', phrase: 'read a pull request' },
  lsp_discover: { pack: 'dev', phrase: 'find language servers' },
  lsp_definition: { pack: 'dev', phrase: 'find a definition' },
  lsp_references: { pack: 'dev', phrase: 'find references' },
  lsp_hover: { pack: 'dev', phrase: 'read a symbol\'s details' },
  lsp_diagnostics: { pack: 'dev', phrase: 'read diagnostics' },
  lsp_rename: { pack: 'dev', phrase: 'rename a symbol' },
  env_validate: { pack: 'environment', phrase: 'check the environment' },
}

/**
 * The message a node logs for a question nobody can be asked (the CLI display slice, C5), which a person's console tags
 * `[approval]` and words with the phrase above.
 */
export const APPROVAL_PENDING = 'Approval pending'
export const TOOL_CALL_COMPLETED = 'Tool call completed'

/** The words for a tool, or its own name, escaped, for a tool the list does not know. */
export function actionPhrase(tool: string): string {
  return Object.hasOwn(ACTIONS, tool) ? ACTIONS[tool]!.phrase : printable(tool)
}

export function builtinToolPack(tool: string): string | null {
  return Object.hasOwn(ACTIONS, tool) ? ACTIONS[tool]!.pack : null
}
