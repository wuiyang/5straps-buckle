/** A gated call waits for a person: no terminal could ask, so the command reports the ask back. */
export const APPROVAL_REQUIRED_EXIT = 3
/**
 * A decision was recorded, or refused, with its grant not saved, and was left so: no terminal asked, no answer came, or a
 * revoke, a session end, or a lasting denial dropped it before it saved.
 */
export const SAVE_FAILED_EXIT = 5
/**
 * The owner's command did not run: its record could not be written to the audit log, and --ignore-warning was not passed
 * (APPROVAL-16).
 */
export const RECORD_FAILED_EXIT = 6
