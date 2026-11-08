import { describe, expect, it } from 'vitest'
import { FLOOR_ASKS, keptBy, MODES_HELP, reachedBy, SECRET_FILE, UNREAD_CODE, wordsOf } from '../cli/dangerously-allow-words.js'
import { FILE_FLOOR_MARKS, PLAIN_MARKS, ask, type PermissionDecision } from '../common/domain/permission/decision.js'
import { createPermissionEngine } from '../common/domain/permission/engine.js'
import { coversAsk, DANGEROUSLY_ALLOW_REACH, withDangerouslyAllow, type ModeReach } from '../common/domain/permission/rules/dangerously-allow.js'
import { createDestructiveCommandRule } from '../common/domain/permission/rules/destructive-command-rule.js'
import { compileCommandGlob } from '../common/domain/command-glob.js'
import type { DangerouslyAllowMode } from '../common/types/ports/dangerously-allow-store.js'

// What each mode of the dangerously-allow switch answers at the command floor and for code Buckle cannot read, with the
// real command rule behind the switch, and what each field of a mode's reach does on its own.

type Ask = Extract<PermissionDecision, { kind: 'ask' }>

const ROOT = '/w'
const NO_GRANTS = { subjectsFor: () => [] }

function command(name: string, args: string[], added: string[] = []): Ask {
  const decision = createDestructiveCommandRule({ added: added.map(compileCommandGlob) }).evaluate({ tool: 'shell_exec', effect: { kind: 'exec', command: name, args }, grants: NO_GRANTS })
  if (decision?.kind !== 'ask') throw new Error(`${name} ${args.join(' ')} did not ask`)
  return decision
}

function underSwitch(mode: DangerouslyAllowMode, name: string, args: string[]) {
  const engine = withDangerouslyAllow(createPermissionEngine([createDestructiveCommandRule()]), { mode: () => mode, root: () => ROOT })
  return engine.evaluate({ tool: 'shell_exec', effects: [{ kind: 'exec', command: name, args }], grants: NO_GRANTS })
}

const UNKNOWN_CODE: Array<[string, string[]]> = [
  ['python3', ['-c', 'import os; os.system("sudo id")']],
  ['node', ['-e', 'require("child_process").execSync("sudo id")']],
  ['perl', ['-e', 'system("sudo id")']],
  ['python3', ['job.py']],
  ['python3', ['-c', 'import shutil; shutil.rmtree("/w")']],
]

const FLOOR: Array<[string, string[]]> = [
  ['sudo', ['id']],
  ['bash', ['-c', 'sudo id']],
  ['env', ['sudo', 'id']],
  ['doas', ['id']],
  ['pkexec', ['id']],
  ['su', ['-c', 'id']],
  ['rm', ['-rf', 'build']],
  ['mkfs.ext4', ['/dev/sdb1']],
  ['git', ['push', '--force']],
]

describe('the modes at the command floor', () => {
  it('pins each mode\'s reach as one row of one table', () => {
    expect(DANGEROUSLY_ALLOW_REACH).toEqual({
      on: { floor: true, secretFile: true, unreadCode: true },
      safe: { floor: false, secretFile: false, unreadCode: false },
    })
  })

  it.each(UNKNOWN_CODE)('%s %j asks while off and safe, and runs while on', (name, args) => {
    expect(underSwitch('off', name, args)).toMatchObject({ kind: 'ask', asks: [{ rule: 'destructive_command', cause: 'interpreter' }] })
    expect(underSwitch('safe', name, args)).toMatchObject({ kind: 'ask', asks: [{ rule: 'destructive_command', cause: 'interpreter' }] })
    expect(underSwitch('on', name, args)).toMatchObject({ kind: 'allow', allowedBy: [expect.stringMatching(/^dangerously_allow:on:destructive_command:/)] })
  })

  it.each(FLOOR)('%s %j asks while off and safe, and runs while on', (name, args) => {
    expect(underSwitch('off', name, args)).toMatchObject({ kind: 'ask' })
    expect(underSwitch('safe', name, args)).toMatchObject({ kind: 'ask', asks: [{ rule: 'destructive_command', floor: true }] })
    expect(underSwitch('on', name, args)).toMatchObject({ kind: 'allow' })
  })

  it('asks the interpreter alone of a call whose other asks the switch lifts', () => {
    const engine = withDangerouslyAllow({
      evaluate: () => ({ kind: 'ask', asks: [command('python3', ['job.py']), ask({ rule: 'write_scope', subject: '/w/out', reason: 'first write', marks: PLAIN_MARKS })] }),
    }, { mode: () => 'safe', root: () => ROOT })
    expect(engine.evaluate({ tool: 'shell_exec', effects: [], grants: NO_GRANTS })).toMatchObject({ kind: 'ask', asks: [{ rule: 'destructive_command', cause: 'interpreter' }] })
  })
})

describe('a floor reach of its own', () => {
  const reach = (floor: boolean): ModeReach => ({ floor, secretFile: false, unreadCode: false })
  const fileFloor = ask({ rule: 'write_scope', subject: 'delete:/w/doomed.txt', reason: 'a person decides', marks: FILE_FLOOR_MARKS })

  it('answers every floor ask where floor is set, a privilege command included, and none where it is not', () => {
    const rows: Array<[string, Ask]> = [
      ['sudo', command('sudo', ['id'])],
      ['a sudo behind an rm', command('bash', ['-c', 'rm -rf build; sudo id'])],
      ['an unreadable call', command('bash', ['-c', 'eval "$x"'])],
      ['rm -rf', command('rm', ['-rf', 'build'])],
      ['the destructive list', command('terraform', ['destroy', 'x'], ['terraform destroy *'])],
      ['the file floor', fileFloor],
    ]
    for (const [name, item] of rows) {
      for (const floor of [true, false]) expect({ name, floor, lifted: coversAsk({ ask: item, root: ROOT, reach: reach(floor) }) }).toEqual({ name, floor, lifted: floor })
    }
  })

  it('answers an unknown interpreter\'s ask only where unreadCode is set, whatever its floor reach', () => {
    const python = command('python3', ['job.py'])
    for (const floor of [true, false]) {
      expect(coversAsk({ ask: python, root: ROOT, reach: { floor, secretFile: false, unreadCode: false } })).toBe(false)
      expect(coversAsk({ ask: python, root: ROOT, reach: { floor, secretFile: false, unreadCode: true } })).toBe(true)
    }
  })
})

describe('the words that say what a mode covers', () => {
  it('names what safe leaves to a person, and that on leaves nothing', () => {
    expect(FLOOR_ASKS).toBe('floor asks (the built-in floor, such as sudo and rm -rf, the destructive list, and the file floor)')
    expect(keptBy('safe')).toEqual([FLOOR_ASKS, UNREAD_CODE, SECRET_FILE])
    expect(keptBy('on')).toEqual([])
    expect(reachedBy('on')).toEqual([FLOOR_ASKS, UNREAD_CODE, SECRET_FILE])
    expect(reachedBy('safe')).toEqual([])
    expect(MODES_HELP).toBe(`each use is audited, deny rules still refuse, and a history restore still asks. on allows every ask there; safe still asks a person for ${FLOOR_ASKS}, ${UNREAD_CODE}, and ${SECRET_FILE}. true and false read as on and off`)
  })

  it('words each field of a reach on its own, from the same table', () => {
    expect(wordsOf({ floor: true, secretFile: false, unreadCode: false })).toEqual({ reached: [FLOOR_ASKS], kept: [UNREAD_CODE, SECRET_FILE] })
    expect(wordsOf({ floor: false, secretFile: true, unreadCode: false })).toEqual({ reached: [SECRET_FILE], kept: [FLOOR_ASKS, UNREAD_CODE] })
  })
})
