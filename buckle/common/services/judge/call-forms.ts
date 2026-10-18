import { baseCommand } from '../../domain/argv.js'
import { allForms, type CommandForms } from '../../domain/command-forms.js'

/** Why a call whose working directory changes before its code runs is not rated (fix brief 2, H2). */
export const CHANGES_DIRECTORY = 'the call changes its working directory before the code runs'

/** The shell builtins that change the working directory of every statement after them. */
const DIRECTORY_COMMANDS = new Set(['cd', 'pushd', 'popd'])

/**
 * The options, by program, that run a command or a script from another folder: env's and sudo's (read among the
 * wrapper's own words alone, so an option of the command after them is not one), and those of the runtimes and package
 * managers that take a folder to run in (read anywhere before a `--`, which fails closed for a script's own argument).
 */
const WRAPPER_CHDIR: Readonly<Record<string, string>> = { env: 'C', sudo: 'D' }
const PROGRAM_CHDIR: Readonly<Record<string, readonly string[]>> = {
  bun: ['--cwd'], 'ts-node': ['--cwd'], ruby: ['-C', '-X'],
  npx: ['-C', '--prefix', '--dir', '--cwd'], pnpx: ['-C', '--prefix', '--dir', '--cwd'], bunx: ['-C', '--prefix', '--dir', '--cwd'],
  npm: ['-C', '--prefix', '--dir', '--cwd'], pnpm: ['-C', '--prefix', '--dir', '--cwd'], yarn: ['-C', '--prefix', '--dir', '--cwd'],
}

/**
 * Whether a call moves to another folder before its code runs (fix brief 2, H2), so the code read at the call's own
 * working directory may not be the code that runs: a `cd`, `pushd`, or `popd` anywhere in it, `env -C` or `--chdir`,
 * `sudo -D` or `--chdir`, `bun --cwd`, or a runner's or package manager's `-C`, `--prefix`, `--dir`, or `--cwd`.
 */
export function changesDirectory(forms: CommandForms): boolean {
  const all = allForms(forms)
  return all.some((form, index) => {
    const program = baseCommand(form[0] ?? '')
    if (DIRECTORY_COMMANDS.has(program)) return true
    const short = WRAPPER_CHDIR[program]
    if (short !== undefined) return wrapperWords(all, index).some(word => namesOption(word, short, 'chdir'))
    const options = PROGRAM_CHDIR[program]
    if (options === undefined) return false
    const end = form.indexOf('--')
    return form.slice(1, end < 0 ? form.length : end).some(word => options.some(option => word === option || word.startsWith(option.startsWith('--') ? `${option}=` : option)))
  })
}

/**
 * The words a wrapper form reads before the command it runs: its options, their values, and its NAME=value words. The
 * command behind it is the next form of its chain, which ends the form; where none does, every word after the wrapper.
 */
export function wrapperWords(all: readonly string[][], index: number): string[] {
  const form = all[index]!
  const next = all[index + 1]
  const start = next ? form.length - next.length : -1
  const ends = next !== undefined && start > 0 && baseCommand(form[start] ?? '') === next[0] && next.slice(1).every((word, offset) => form[start + 1 + offset] === word)
  return form.slice(1, ends ? start : form.length)
}

/**
 * Whether a word is an option: a cluster of short options holding `short` (`-iC`; a value letter's own value may read as
 * one too, which fails closed), or a long one getopt would take for `long`, by any prefix typed (`--ch`).
 */
function namesOption(word: string, short: string, long: string): boolean {
  if (word.startsWith('--')) {
    const typed = word.slice(2).split('=')[0]!
    return typed.length > 0 && long.startsWith(typed)
  }
  return word.startsWith('-') && word.slice(1).includes(short)
}
