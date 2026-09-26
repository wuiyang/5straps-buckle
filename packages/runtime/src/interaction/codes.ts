export const InteractionErrorCode = Object.freeze({
  consumerAttached: 'CliConsumerAlreadyAttachedError',
  consumerFailed: 'CliConsumerFailedError',
  noCompletion: 'CliNoCompletionError',
  listenerFailed: 'CliListenerFailedError',
  requestConflict: 'CliRequestConflictError',
  invalidWait: 'CliInvalidWaitError',
} as const)
