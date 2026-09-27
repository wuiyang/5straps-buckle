export const SqliteErrorCode = Object.freeze({
  ownerClosed: 'ConnectionOwnerClosedError',
  nestedTransaction: 'NestedTransactionError',
  sectionWaitTimeout: 'SectionWaitTimeoutError',
  connectionOwned: 'ConnectionAlreadyOwnedError',
  rawHandleRefused: 'RawHandleRefusedError',
  notRegularFile: 'NotRegularFileError',
} as const)
