#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runCli, runInitCommand, runSettingsCommand } from './cli/main.js'
import { loadConfig } from './common/runtime/config.js'
import { loadEnvironmentFile } from './common/runtime/environment.js'
import { logger } from './common/runtime/logger.js'
import { serveMcpStdio } from './mcp/stdio.js'
import { serveHttp } from './server/hono/serve.js'

export type Mode =
  | { kind: 'init' | 'settings' | 'cli'; argv: string[] }
  | { kind: 'serve' | 'mcp' }

export function selectMode(argv: readonly string[]): Mode {
  const [command, ...rest] = argv
  if (command === 'init' || command === 'settings') return { kind: command, argv: rest }
  if (command === 'serve' || command === 'mcp') return { kind: command }
  return { kind: 'cli', argv: [...argv] }
}

/** The exit code of a one-shot command; undefined once serve or mcp is running. */
export async function main(argv: readonly string[]): Promise<number | undefined> {
  const mode = selectMode(argv)
  // Before the file is loaded, so `settings show` can tell the file's values from the shell's.
  if (mode.kind === 'init') return (await runInitCommand(mode.argv)).exitCode
  if (mode.kind === 'settings') return (await runSettingsCommand(mode.argv)).exitCode

  loadEnvironmentFile()
  const config = loadConfig()
  if (mode.kind === 'cli') return (await runCli({ argv: mode.argv, config })).exitCode
  await (mode.kind === 'serve' ? serveHttp(config) : serveMcpStdio(config))
  return undefined
}

/**
 * `buckle tools | head -3` closes stdout while we are still writing to it. Without this the
 * process dies on an unhandled EPIPE and prints a stack trace over the user's terminal.
 */
function exitQuietlyOnClosedPipe(): void {
  process.stdout.on('error', error => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0)
    throw error
  })
}

// Node realpaths the main module, so an npm bin symlink still matches; the mode-dispatch test imports this file.
function isProcessEntry(): boolean {
  return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url))
}

if (isProcessEntry()) {
  exitQuietlyOnClosedPipe()
  main(process.argv.slice(2)).then(
    exitCode => { if (exitCode !== undefined) process.exitCode = exitCode },
    error => {
      logger.error('Buckle failed to start', { message: error instanceof Error ? error.message : 'Unknown error' })
      process.exitCode = 1
    },
  )
}
