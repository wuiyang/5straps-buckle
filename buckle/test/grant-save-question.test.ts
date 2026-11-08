import { describe, expect, it } from 'vitest'
import { saveAnswerOf, saveChoices, saveEndingLine, settleUnsaved, unsavedOf, type SaveAnswer, type SaveReceipt, type SaveRoute, type Unsaved } from '../common/adapters/approval/grant-save-question.js'
import type { DecisionBody, SkipReceipt } from '../common/types/ports/approval-backend.js'

// What every route does with a decision whose grant did not save: it warns, and its person retries, skips, or leaves it.

const SESSION: DecisionBody = { token: 't-1', outcome: 'approve', scope: 'session' }
const DENY_SESSION: DecisionBody = { token: 't-1', outcome: 'deny', scope: 'session' }
const OWED: SaveReceipt = { status: 'applied', save: 'owed', saveError: 'permission denied' }
const SAVED: SaveReceipt = { status: 'repeated', save: 'saved' }
const UNSAVED_DENIAL: SaveReceipt = { status: 'refused', error: { code: 'grant_unsaved', message: 'The denial could not be saved (permission denied), so nothing was recorded and the call still waits', retryable: true, saveError: 'permission denied' } }

/** A route whose person answers in turn, and whose core answers each retry, skip, and once denial in turn. */
function scripted(input: { answers: Array<SaveAnswer | undefined>; retries?: SaveReceipt[]; skips?: Array<SkipReceipt | Error>; denials?: SaveReceipt[] }) {
  const asked: Unsaved[] = []
  const sent: string[] = []
  const route: SaveRoute = {
    async ask(unsaved) {
      asked.push(unsaved)
      return input.answers.shift()
    },
    async retry() {
      sent.push('retry')
      return input.retries?.shift() ?? SAVED
    },
    async skipSave() {
      sent.push('skip')
      const next = input.skips?.shift() ?? { status: 'skipped' }
      if (next instanceof Error) throw next
      return next
    },
    async denyOnce() {
      sent.push('deny once')
      return input.denials?.shift() ?? { status: 'applied' }
    },
  }
  return { route, asked, sent }
}

describe('a decision whose grant did not save', () => {
  it('is an approval left owed, warned of by its scope and reason, or a lasting denial refused grant_unsaved', () => {
    expect(unsavedOf({ decision: SESSION, receipt: OWED })).toEqual({ kind: 'approval', warning: 'Approved for this call; saving it for the session failed: permission denied' })
    expect(unsavedOf({ decision: { ...SESSION, scope: 'always' }, receipt: { status: 'repeated', save: 'owed' } })).toEqual({ kind: 'approval', warning: 'Approved for this call; saving it for every session failed' })
    expect(unsavedOf({ decision: DENY_SESSION, receipt: UNSAVED_DENIAL })).toEqual({ kind: 'denial', warning: 'Not denied for the session: saving failed: permission denied; the call still waits' })
  })

  it('is nothing for a saved, skipped, or once decision, or another refusal', () => {
    expect(unsavedOf({ decision: SESSION, receipt: SAVED })).toBeUndefined()
    expect(unsavedOf({ decision: SESSION, receipt: { status: 'repeated', save: 'skipped' } })).toBeUndefined()
    expect(unsavedOf({ decision: { ...SESSION, scope: 'once' }, receipt: { status: 'applied' } })).toBeUndefined()
    expect(unsavedOf({ decision: DENY_SESSION, receipt: { status: 'refused', error: { code: 'ask_closed', message: 'closed', retryable: false } } })).toBeUndefined()
  })

  it('takes r and s for an approval or a denial, r alone for a removal, and nothing else', () => {
    expect(saveAnswerOf('approval', ' R ')).toBe('retry')
    expect(saveAnswerOf('denial', 's')).toBe('skip')
    expect(saveAnswerOf('removal', 's')).toBeUndefined()
    for (const typed of ['', 'yes', 'constructor', '__proto__', 'rs']) expect(saveAnswerOf('approval', typed)).toBeUndefined()
    expect(saveChoices('removal')).not.toContain('s skips')
  })
})

describe('settling a decision that did not save', () => {
  const approval = unsavedOf({ decision: SESSION, receipt: OWED })!
  const denial = unsavedOf({ decision: DENY_SESSION, receipt: UNSAVED_DENIAL })!

  it('retries the same decision as often as its person asks, warning again after each failure, until it saves', async () => {
    const { route, asked, sent } = scripted({ answers: ['retry', 'retry', 'retry'], retries: [OWED, { status: 'repeated', save: 'owed', saveError: 'no space is left on the disk' }, SAVED] })
    expect(await settleUnsaved({ decision: SESSION, unsaved: approval, route })).toEqual({ ending: 'saved' })
    expect(sent).toEqual(['retry', 'retry', 'retry'])
    expect(asked.map(unsaved => unsaved.warning)).toEqual([approval.warning, approval.warning, 'Approved for this call; saving it for the session failed: no space is left on the disk'])
  })

  it('skips an approval\'s save, and says where its grant had saved and was removed', async () => {
    expect(await settleUnsaved({ decision: SESSION, unsaved: approval, route: scripted({ answers: ['skip'] }).route })).toEqual({ ending: 'skipped', removed: false })
    const removed = scripted({ answers: ['skip'], skips: [{ status: 'skipped', removed: true }] })
    const ending = await settleUnsaved({ decision: SESSION, unsaved: approval, route: removed.route })
    expect(ending).toEqual({ ending: 'skipped', removed: true })
    expect(saveEndingLine(ending)).toContain('It had already saved; removed.')
  })

  it('denies the call once in place of a lasting denial it skips, and retries that denial on r', async () => {
    const skipped = scripted({ answers: ['skip'] })
    expect(await settleUnsaved({ decision: DENY_SESSION, unsaved: denial, route: skipped.route })).toEqual({ ending: 'denied_once' })
    expect(skipped.sent).toEqual(['deny once'])
    const retried = scripted({ answers: ['retry'], retries: [{ status: 'applied' }] })
    expect(await settleUnsaved({ decision: DENY_SESSION, unsaved: denial, route: retried.route })).toEqual({ ending: 'saved' })
  })

  it('leaves it as it is when its person gives no answer', async () => {
    const { route, sent } = scripted({ answers: [undefined] })
    expect(await settleUnsaved({ decision: SESSION, unsaved: approval, route })).toEqual({ ending: 'left', kind: 'approval' })
    expect(sent).toEqual([])
    expect(saveEndingLine({ ending: 'left', kind: 'denial' })).toContain('nothing was denied')
  })

  it('asks again about a skip whose grant is not confirmed removed, saying whether it stands, and r skips again', async () => {
    const stands: SkipReceipt = { status: 'unfinished', stands: true, saveError: 'permission denied' }
    const unread: SkipReceipt = { status: 'unfinished', stands: false, saveError: 'permission denied' }
    const { route, asked, sent } = scripted({ answers: ['skip', 'retry', 'retry'], skips: [stands, unread, { status: 'repeated', removed: true }] })
    expect(await settleUnsaved({ decision: SESSION, unsaved: approval, route })).toEqual({ ending: 'skipped', removed: true })
    expect(asked.slice(1)).toEqual([
      { kind: 'removal', warning: 'Skipped, but its grant had saved and could not be removed: permission denied' },
      { kind: 'removal', warning: 'Skipped, but its grant, if it saved, could not be confirmed removed: permission denied' },
    ])
    expect(sent).toEqual(['skip', 'skip', 'skip'])
    expect(saveEndingLine({ ending: 'left', kind: 'removal' })).toBe('Left: the next decision or the workspace opening again removes it.')
  })

  it('takes a decision whose skip is not confirmed removed as that removal', () => {
    expect(unsavedOf({ decision: SESSION, receipt: { status: 'repeated', save: 'skipping', saveError: 'permission denied' } })).toEqual({ kind: 'removal', warning: 'Skipped, but its grant, if it saved, could not be confirmed removed: permission denied' })
  })

  it('says saved only for a retry whose grant saved, never one a revoke or a session end dropped', async () => {
    const dropped = scripted({ answers: ['retry'], retries: [{ status: 'repeated', save: 'dropped' }] })
    const ending = await settleUnsaved({ decision: SESSION, unsaved: approval, route: dropped.route })
    expect(ending).toEqual({ ending: 'dropped' })
    expect(saveEndingLine(ending)).not.toContain('Saved')
    expect(await settleUnsaved({ decision: SESSION, unsaved: approval, route: scripted({ answers: ['retry'], retries: [{ status: 'repeated' }] }).route })).toEqual({ ending: 'dropped' })
  })

  it('ends with a refusal of the retry or the skip, and a skip answered after its save had been skipped elsewhere', async () => {
    const closed = { status: 'refused' as const, error: { code: 'ask_closed' as const, message: 'This ask is closed', retryable: false } }
    expect(await settleUnsaved({ decision: DENY_SESSION, unsaved: denial, route: scripted({ answers: ['retry'], retries: [closed] }).route })).toEqual({ ending: 'refused', error: closed.error })
    expect(await settleUnsaved({ decision: SESSION, unsaved: approval, route: scripted({ answers: ['retry'], retries: [{ status: 'repeated', save: 'skipped' }] }).route })).toEqual({ ending: 'skipped', removed: false })
    const other = new Error('The state directory went away')
    await expect(settleUnsaved({ decision: SESSION, unsaved: approval, route: scripted({ answers: ['skip'], skips: [other] }).route })).rejects.toBe(other)
  })
})
