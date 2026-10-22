import { printable } from './approval-instruction.js'

/**
 * What each tool does, in a few words Buckle wrote, for the head line of a question on the serve terminal (the CLI
 * display slice, C4): `action pending approval: run command`. Never the agent's text (owner decision D9), and never in
 * the call's description, which sits inside the signed challenge; the whole action follows below it (D17).
 */
const PHRASES: Readonly<Record<string, string>> = {
  shell_exec: 'run command',
  script_run: 'run a script',
  code_run: 'run code',
  code_api: 'read the code API',
  browser_command: 'use the agent browser',
  web_fetch: 'fetch a URL',
  web_search: 'search the web',
  fs_read: 'read a file',
  fs_read_batch: 'read files',
  fs_write: 'write a file',
  fs_write_batch: 'write files',
  fs_patch: 'patch a file',
  fs_list: 'list a folder',
  fs_find_names: 'find files by name',
  fs_search_content: 'search file contents',
  git_status: 'read the git status',
  git_diff: 'read a git diff',
  git_log: 'read the git log',
  git_branch: 'read the git branches',
  git_blame: 'read a git blame',
  git_commit: 'make a git commit',
  git_push: 'push to a git remote',
  pr_open: 'open a pull request',
  pr_read: 'read a pull request',
  lsp_discover: 'find language servers',
  lsp_definition: 'find a definition',
  lsp_references: 'find references',
  lsp_hover: 'read a symbol\'s details',
  lsp_diagnostics: 'read diagnostics',
  lsp_rename: 'rename a symbol',
  env_validate: 'check the environment',
}

/** The words for a tool, or its own name, escaped, for a tool the list does not know. */
export function actionPhrase(tool: string): string {
  return Object.hasOwn(PHRASES, tool) ? PHRASES[tool]! : printable(tool)
}
