export const RESULT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  git_status: '{ branch, upstream, entries: Array<{ state, path }>, clean }',
  git_diff: '{ diff: string }',
  git_log: '{ commits: Array<{ hash, author, date, subject }> }',
  git_blame: '{ lines: Array<{ hash, author, text }> }',
  git_branch: '{ branches: Array<{ name, upstream, commit, current }> }',
}
