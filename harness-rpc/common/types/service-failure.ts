/**
 * A failure a transport answers by its fields: a stable code and the HTTP status it maps to, with a
 * message the caller may read. The Nitro layers see common code as types only, so they map a failure
 * by these fields and never by instanceof (Buckle phase plan, section B).
 */
export interface ServiceFailure extends Error {
  readonly code: string
  readonly status: number
}
