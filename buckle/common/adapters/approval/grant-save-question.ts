import type { ApprovalError, DecisionBody, GrantSave, SkipReceipt } from '../../types/ports/approval-backend.js'

// What a route does with a decision whose grant did not save (the owner's ruling: a warning, and a retry or a skip): it
// warns its person, then sends what they choose until it saves, they skip it, or they leave it.

/** A lasting scope as a person reads it beside a failed save. */
const LASTING_SCOPE_WORDS: Readonly<Record<'session' | 'always', string>> = { session: 'for the session', always: 'for every session' }

/** The warning of a lasting denial whose grant could not be written: nothing is recorded, and the call still waits. */
export function unsavedDenial(input: { scope: 'session' | 'always'; reason: string | undefined }): string {
  return `Not denied ${LASTING_SCOPE_WORDS[input.scope]}: saving failed${input.reason === undefined ? '' : `: ${input.reason}`}; the call still waits`
}

/** The warning of an approval whose lasting grant could not be written: the call that asked runs once on it. */
export function unsavedApproval(input: { scope: 'session' | 'always'; reason: string | undefined }): string {
  return `Approved for this call; saving it ${LASTING_SCOPE_WORDS[input.scope]} failed${input.reason === undefined ? '' : `: ${input.reason}`}`
}

/**
 * The warning of a skip whose grant is not confirmed removed: one that had saved and could not be removed stands; where the
 * grants could not be read, it may never have saved.
 */
export function unfinishedSkip(input: { stands: boolean; reason: string | undefined }): string {
  const why = input.reason === undefined ? '' : `: ${input.reason}`
  return input.stands ? `Skipped, but its grant had saved and could not be removed${why}` : `Skipped, but its grant, if it saved, could not be confirmed removed${why}`
}

/** A decision's receipt as each route reads it for its save: a backend's and a core client's alike. */
export type SaveReceipt =
  | { status: 'applied' | 'repeated'; save?: GrantSave; saveError?: string }
  | { status: 'refused'; error: ApprovalError }

/** What did not save: an approval's lasting grant, a lasting denial, or the removal of a grant a skip gave up. */
export type UnsavedKind = 'approval' | 'denial' | 'removal'
export interface Unsaved { kind: UnsavedKind; warning: string }
export type SaveAnswer = 'retry' | 'skip'

export type SaveEnding =
  | { ending: 'saved' }
  | { ending: 'skipped'; removed: boolean }
  | { ending: 'denied_once' }
  | { ending: 'left'; kind: UnsavedKind }
  | { ending: 'refused'; error: ApprovalError }

/** How a route reaches its person and core: `retry` sends the same decision again, `denyOnce` denies the call once. */
export interface SaveRoute {
  /** The person's answer to the warning; undefined where they gave none. */
  ask(unsaved: Unsaved): Promise<SaveAnswer | undefined>
  retry(): Promise<SaveReceipt>
  skipSave(): Promise<SkipReceipt>
  denyOnce(): Promise<SaveReceipt>
}

/** Per kind: the keys its question takes, the choices it shows beside the warning, and what leaving it means. */
const SAVE_QUESTIONS: Readonly<Record<UnsavedKind, { keys: ReadonlyMap<string, SaveAnswer>; choices: string; left: string }>> = {
  approval: {
    keys: new Map([['r', 'retry'], ['s', 'skip']]),
    choices: 'r retries the save; s skips it, so later calls ask again; anything else leaves it to be saved later',
    left: 'Left unsaved: it is written at the next decision, when the workspace opens again, or when the same decision is sent again',
  },
  denial: {
    keys: new Map([['r', 'retry'], ['s', 'skip']]),
    choices: 'r retries the save; s denies this call once instead; anything else leaves the call waiting',
    left: 'Left unsaved: nothing was denied',
  },
  removal: {
    keys: new Map([['r', 'retry']]),
    choices: 'r retries the removal; anything else leaves it to the next decision or the workspace opening again, which remove it',
    left: 'Left: the next decision or the workspace opening again removes it',
  },
}

type SaveStep = (input: { decision: DecisionBody; route: SaveRoute }) => Promise<Unsaved | SaveEnding>

const SAVE_STEPS: Readonly<Record<UnsavedKind, Partial<Record<SaveAnswer, SaveStep>>>> = {
  approval: { retry: retried, skip: skipped },
  denial: { retry: retried, skip: deniedOnce },
  removal: { retry: skipped },
}

/**
 * What did not save of a decision, by its receipt: an approval left owed, one whose skip is not confirmed removed, or a
 * lasting denial refused `grant_unsaved`.
 */
export function unsavedOf(input: { decision: DecisionBody; receipt: SaveReceipt }): Unsaved | undefined {
  const { decision: { scope }, receipt } = input
  if (scope === 'once') return undefined
  if (receipt.status === 'refused') return receipt.error.code === 'grant_unsaved' ? { kind: 'denial', warning: unsavedDenial({ scope, reason: receipt.error.saveError }) } : undefined
  if (receipt.save === 'skipping') return { kind: 'removal', warning: unfinishedSkip({ stands: false, reason: receipt.saveError }) }
  if (receipt.save !== 'owed') return undefined
  return { kind: 'approval', warning: unsavedApproval({ scope, reason: receipt.saveError }) }
}

export function saveChoices(kind: UnsavedKind): string {
  return SAVE_QUESTIONS[kind].choices
}

/** The answer a typed key gives a question of this kind, or undefined for one it does not take. */
export function saveAnswerOf(kind: UnsavedKind, typed: string): SaveAnswer | undefined {
  return SAVE_QUESTIONS[kind].keys.get(typed.trim().toLowerCase())
}

/** Asks, and sends what the person chooses, until the decision saves, its lasting part is given up, or they leave it. No cap. */
export async function settleUnsaved(input: { decision: DecisionBody; unsaved: Unsaved; route: SaveRoute }): Promise<SaveEnding> {
  let unsaved = input.unsaved
  for (;;) {
    const answer = await input.route.ask(unsaved)
    const step = answer === undefined ? undefined : SAVE_STEPS[unsaved.kind][answer]
    if (step === undefined) return { ending: 'left', kind: unsaved.kind }
    const next = await step(input)
    if ('ending' in next) return next
    unsaved = next
  }
}

/** The line a route shows once a save question ends. */
export function saveEndingLine(ending: SaveEnding): string {
  switch (ending.ending) {
    case 'saved': return 'Saved.'
    case 'skipped': return ending.removed ? 'Skipped: later calls ask again. It had already saved; removed.' : 'Skipped: later calls ask again.'
    case 'denied_once': return 'Denied this call once; nothing was saved.'
    case 'left': return `${SAVE_QUESTIONS[ending.kind].left}.`
    case 'refused': return `Not recorded: ${ending.error.message}.`
  }
}

async function retried(input: { decision: DecisionBody; route: SaveRoute }): Promise<Unsaved | SaveEnding> {
  const receipt = await input.route.retry()
  const again = unsavedOf({ decision: input.decision, receipt })
  if (again !== undefined) return again
  if (receipt.status === 'refused') return { ending: 'refused', error: receipt.error }
  return receipt.save === 'skipped' ? { ending: 'skipped', removed: false } : { ending: 'saved' }
}

// A skip whose grant is not confirmed removed asks again, about that removal.
async function skipped(input: { route: SaveRoute }): Promise<Unsaved | SaveEnding> {
  const receipt = await input.route.skipSave()
  if (receipt.status === 'unfinished') return { kind: 'removal', warning: unfinishedSkip({ stands: receipt.stands, reason: receipt.saveError }) }
  if (receipt.status === 'refused') return { ending: 'refused', error: receipt.error }
  return { ending: 'skipped', removed: receipt.removed === true }
}

async function deniedOnce(input: { route: SaveRoute }): Promise<SaveEnding> {
  const receipt = await input.route.denyOnce()
  return receipt.status === 'refused' ? { ending: 'refused', error: receipt.error } : { ending: 'denied_once' }
}
