import { DANGEROUSLY_ALLOW_REACH, type FloorReach, type ModeReach } from '../common/domain/permission/rules/dangerously-allow.js'
import { wordList } from '../common/domain/word-list.js'
import type { DangerouslyAllowOnMode, DangerouslyAllowReading } from '../common/types/ports/dangerously-allow-store.js'

// What the dangerously-allow switch covers, said once for the help, `buckle policy show`, the switch's warning, and the
// pages that pin them, each worded from the mode's reach (DANGEROUSLY_ALLOW_REACH).

export const FLOOR_ASKS = 'floor asks (the built-in floor, such as sudo and rm -rf, the destructive list, and the file floor)'
export const PRIVILEGE_ASKS = 'a privilege command (sudo, su, doas, or pkexec)'
export const UNREAD_CODE = 'code run through an unknown interpreter'
export const SECRET_FILE = 'a secret reference\'s file'
export const OUTSIDE = 'Paths outside it keep their normal outcome: they ask, or the mount refuses them.'
export const RESTORE_ASKS = 'A history restore asks a person in every mode.'
export const EARLIER_BUILD = 'off: an earlier build of Buckle set it on, and this build reads its file as off; buckle policy dangerously-allow on or safe sets it again'

const FLOOR_WORDS: Readonly<Record<FloorReach, { reached: string[]; kept: string[] }>> = {
  all: { reached: [FLOOR_ASKS], kept: [] },
  unprivileged: { reached: [FLOOR_ASKS], kept: [PRIVILEGE_ASKS] },
  none: { reached: [], kept: [FLOOR_ASKS] },
}

/** The switch as a sentence names it: its mode in capitals where on, the earlier build's note where one set it, null where it is plainly off. */
export function switchWords(reading: DangerouslyAllowReading): string | null {
  if (reading.mode !== 'off') return reading.mode.toUpperCase()
  return reading.setByEarlierBuild ? EARLIER_BUILD : null
}

/** What a reach answers beyond the asks every mode covers, and what it leaves to a person. */
export function wordsOf(reach: Readonly<ModeReach>): { reached: string[]; kept: string[] } {
  const floor = FLOOR_WORDS[reach.floor]
  return {
    reached: [...floor.reached, ...(reach.unreadCode ? [UNREAD_CODE] : []), ...(reach.secretFile ? [SECRET_FILE] : [])],
    kept: [...floor.kept, ...(reach.unreadCode ? [] : [UNREAD_CODE]), ...(reach.secretFile ? [] : [SECRET_FILE])],
  }
}

export const reachedBy = (mode: DangerouslyAllowOnMode): string[] => wordsOf(DANGEROUSLY_ALLOW_REACH[mode]).reached

export const keptBy = (mode: DangerouslyAllowOnMode): string[] => wordsOf(DANGEROUSLY_ALLOW_REACH[mode]).kept

/** What the switch covers in a mode: asks about paths inside the boundary, and every ask that names no path, wherever it points. */
export function coversOf(mode: DangerouslyAllowOnMode): string {
  const kept = keptBy(mode)
  const exception = kept.length === 0 ? '' : `, except ${wordList(kept)}, which still ${kept.length === 1 ? 'asks' : 'ask'} a person`
  return `Every ask about a path inside it, and every command, host, and process ask, is allowed without a person, ${wordList(['sensitive files', 'file writes', ...reachedBy(mode)])} included${exception}. ${RESTORE_ASKS} ${OUTSIDE}`
}

function modeSentence(mode: DangerouslyAllowOnMode): string {
  const kept = keptBy(mode)
  return kept.length === 0 ? `${mode} allows every ask there` : `${mode} still asks a person for ${wordList(kept)}`
}

/** What both helps say of the modes. */
export const MODES_HELP = `each use is audited, deny rules still refuse, and a history restore still asks. ${modeSentence('on')}; ${modeSentence('safe')}. true and false read as on and off`

/** The text as help lines of at most `width` columns, each after `indent` spaces; an option such as `-rf` stays with the word before it. */
export function helpLines(input: { text: string; indent: number; width: number }): string {
  const lines: string[] = []
  let line = ''
  for (const word of input.text.split(/\s+/).filter(Boolean)) {
    if (line !== '' && !word.startsWith('-') && input.indent + line.length + 1 + word.length > input.width) {
      lines.push(line)
      line = word
    } else line = line === '' ? word : `${line} ${word}`
  }
  if (line !== '') lines.push(line)
  return lines.map(item => ' '.repeat(input.indent) + item).join('\n')
}
