export const RESULT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  history_list: '{ checkpoints: Array<{ id, createdAt, tool, sessionId, requestId?, stageId, turnId, restorable, reason?, changed, changedUnlisted?, notRestorable, notRestorableUnlisted?, ignored?: { count, reason }, status, current, restores?, undoes?, changes: Array<{ path, kind }>, unlisted? }>, more, turns: Array<{ id, checkpoints }> }',
  history_restore: '{ checkpoint, restores, undoes, changes: Array<{ path, kind }>, unlisted?, notRestorable?, notRestorableUnlisted? }',
}
