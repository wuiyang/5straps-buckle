/**
 * Whether a command's words ask for its usage: `--help` or `-h`, before any `--`. A help request is answered before
 * anything is read or recorded, so it needs no configuration, no workspace, and leaves no audit entry.
 */
export function asksForHelp(argv: readonly string[]): boolean {
  const terminator = argv.indexOf('--')
  return argv.slice(0, terminator === -1 ? argv.length : terminator).some(word => word === '--help' || word === '-h')
}
