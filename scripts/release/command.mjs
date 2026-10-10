// What the release scripts share to run a command and to run as a script. Each script takes its
// command runner as an argument, so the tests answer for git, gh, npm, and pnpm without a network.
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** A release the scripts refuse, with a message for the person releasing in place of a stack trace. */
export class Refusal extends Error {}

/**
 * Runs a command in the repository and returns its stdout. Its stderr passes through, and a command
 * that fails throws an error carrying its exit status and stderr, so a caller can tell one answer,
 * such as gh's HTTP 404, from another. `show` lets stdout through as well, for a long step such as
 * pnpm pack, which builds the package first.
 */
export function runCommand(command, args, { show = false } = {}) {
  const result = spawnSync(command, args, { cwd: REPOSITORY_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', show ? 'inherit' : 'pipe', show ? 'inherit' : 'pipe'] })
  if (result.error) throw result.error
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) {
    throw Object.assign(new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`), { status: result.status, stderr: result.stderr ?? '' })
  }
  return result.stdout ?? ''
}

/** Appends name=value lines to the step outputs file GitHub Actions names, when there is one. */
export function writeStepOutputs(outputs, file = process.env.GITHUB_OUTPUT) {
  if (!file) return
  appendFileSync(file, Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join(''))
}

/**
 * Runs `main` when the module is the script node started: prints what it returns, or a refusal's
 * message, and sets the exit code. Any other error keeps its stack trace.
 */
export async function runAsScript(moduleUrl, main) {
  if (!process.argv[1] || resolve(process.argv[1]) !== fileURLToPath(moduleUrl)) return
  try {
    process.stdout.write(`${await main()}\n`)
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
