export const RESULT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  shell_exec: '{ exitCode, signal, stdout, stderr, truncated, timedOut, sandbox }',
  script_run: '{ exitCode, signal, stdout, stderr, truncated, timedOut, sandbox }',
}
