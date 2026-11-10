/**
 * Why a terminal question ended unanswered, where the route that closed its ask knows and the terminal cannot: the
 * requester ends a question's prompt with no reason, so the terminal backend tells it here, by the question's id, before
 * it closes the question, and the terminal reads it as the question's row ends (APPROVAL-36; finding 4 of the
 * APPROVAL-36/37 review). Process-wide, as the requester the two share is.
 */
export type QuestionEnding = 'no_response'

/** A question closed before the terminal showed it is never read, so only the latest are kept. */
const KEPT = 256
const told = new Map<string, QuestionEnding>()

export function tellQuestionEnding(id: string, ending: QuestionEnding): void {
  told.delete(id)
  told.set(id, ending)
  for (const oldest of told.keys()) {
    if (told.size <= KEPT) break
    told.delete(oldest)
  }
}

/** The ending told for a question, read once. */
export function takeQuestionEnding(id: string): QuestionEnding | undefined {
  const ending = told.get(id)
  told.delete(id)
  return ending
}
