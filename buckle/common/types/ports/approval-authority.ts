/**
 * Whose answer a decision carries. `BUCKLE-D14` keeps a persisted approval on the admin credential alone: a face reachable
 * with an agent's token answers as `agent`, which the decision guard admits for `once` and nothing that outlives the call.
 */
export type ApprovalAuthority = 'admin' | 'agent'
