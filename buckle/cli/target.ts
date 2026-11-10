/** The workspace a command names: `--workspace <name>`, or `--dir <path>`, relative to where it runs (D83 (4)). */
export interface CommandTarget { workspace?: string; dir?: string }

const FLAGS = { '--workspace': 'workspace', '--dir': 'dir' } as const

/**
 * Takes `--workspace` and `--dir` out of a command's words, before a `--`, in either spelling (`--dir x`, `--dir=x`),
 * so no command's own parser sees them and a tool's arguments after `--` are never read as one. A flag given twice,
 * or with no value, is refused rather than guessed at.
 */
export function takeTarget(argv: readonly string[]): { target: CommandTarget; argv: string[] } {
  const target: CommandTarget = {}
  const kept: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!
    if (word === '--') {
      kept.push(...argv.slice(index))
      break
    }
    const [flag, inline] = word.startsWith('--') && word.includes('=') ? [word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] : [word, undefined]
    const key = Object.hasOwn(FLAGS, flag) ? FLAGS[flag as keyof typeof FLAGS] : undefined
    if (key === undefined) {
      kept.push(word)
      continue
    }
    const value = inline ?? argv[++index]
    if (!value || value === '--') throw new TargetError(`${flag} needs a value`)
    if (target[key] !== undefined) throw new TargetError(`${flag} is given twice`)
    target[key] = value
  }
  if (target.workspace !== undefined && target.dir !== undefined) throw new TargetError('Name the workspace with --workspace or --dir, not both')
  return { target, argv: kept }
}

export class TargetError extends Error {}
