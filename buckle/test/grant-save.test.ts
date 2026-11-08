import { describe, expect, it } from 'vitest'
import { StateBusyError, StateFileError } from '../common/adapters/json-file-store.js'
import { unsavedDenial } from '../common/adapters/approval/grant-save-question.js'
import { saveFailure } from '../common/services/approvals/grant-save.js'

const PATH = '/home/someone/.5straps/buckle/grants.json'
const nodeError = (code: string) => Object.assign(new Error(`${code}: failed, open '${PATH}'`), { code })

describe('why a grant was not saved', () => {
  it.each([
    [nodeError('EACCES'), 'permission denied'],
    [nodeError('EROFS'), 'the file system is read-only'],
    [nodeError('ENOSPC'), 'no space is left on the disk'],
    [nodeError('EMFILE'), 'system error EMFILE'],
    [new StateBusyError(`${PATH} is busy in another Buckle process; retry shortly`), 'another Buckle process holds the file'],
    [new StateFileError(`State file is unreadable or invalid: ${PATH}; owner repair is required`, { repeated: false }), 'a state file is unreadable or invalid'],
    [Object.assign(new Error(PATH), { code: PATH }), 'an unexpected error'],
    [new Error(PATH), 'an unexpected error'],
    ['not an error', 'an unexpected error'],
  ])('reads %s as words that name no path', (error, words) => {
    expect(saveFailure(error)).toBe(words)
  })

  it('names the scope and the reason in a lasting denial\'s refusal', () => {
    expect(unsavedDenial({ scope: 'always', reason: 'permission denied' })).toBe('Not denied for every session: saving failed: permission denied; the call still waits')
  })
})
