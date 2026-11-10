export const RESULT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  git_commit: '{ hash, subject, files: string[] }',
  git_revert: '{ hash, subject, reverted, files: string[] }',
  git_push: '{ branch, remote, headSha }',
  pr_open: '{ number, url, headSha, state }',
  pr_read: '{ number, state, title, head, base, diff?, files?, comments? }',
}
