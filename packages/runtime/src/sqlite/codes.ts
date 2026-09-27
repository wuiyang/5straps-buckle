export const SqliteErrorCode = Object.freeze({
  ownerClosed: 'ConnectionOwnerClosedError',
  nestedTransaction: 'NestedTransactionError',
  foreignTransaction: 'ForeignTransactionError',
  connectionOwned: 'ConnectionAlreadyOwnedError',
  rawHandleRefused: 'RawHandleRefusedError',
  notRegularFile: 'NotRegularFileError',
} as const)
