export const InteractionErrorCode = Object.freeze({
  consumerAttached: 'CliConsumerAlreadyAttachedError',
  consumerFailed: 'CliConsumerFailedError',
  noCompletion: 'CliNoCompletionError',
  listenerFailed: 'CliListenerFailedError',
  listenerUnavailable: 'CliListenerUnavailableError',
  requestConflict: 'CliRequestConflictError',
  invalidWait: 'CliInvalidWaitError',
} as const)
