/**
 * What Buckle needs from a code-hosting forge. One port, so the pack never names GitHub and a
 * second forge is a new adapter rather than a branch at every call site.
 */

export interface ForgeRepository {
  owner: string
  name: string
}

export interface ForgePullRequest {
  number: number
  url: string
  state: string
  title: string
  head: { ref: string; sha: string }
  base: { ref: string; sha: string }
}

export interface ForgePullRequestFile {
  path: string
  status: string
  additions: number
  deletions: number
}

export interface ForgeComment {
  author: string
  at: string
  body: string
}

export interface ForgeRequest {
  repository: ForgeRepository
  number: number
  signal: AbortSignal
}

export interface ForgeClient {
  openPullRequest(input: {
    repository: ForgeRepository
    head: string
    base: string
    title: string
    body: string
    signal: AbortSignal
  }): Promise<ForgePullRequest>
  readPullRequest(input: ForgeRequest): Promise<ForgePullRequest>
  readPullRequestDiff(input: ForgeRequest & { maxBytes: number }): Promise<{ diff: string; truncated: boolean }>
  readPullRequestFiles(input: ForgeRequest): Promise<ForgePullRequestFile[]>
  readPullRequestComments(input: ForgeRequest): Promise<ForgeComment[]>
}

/**
 * The git host that belongs to an API origin: `api.github.com` serves `github.com`, while an
 * Enterprise host serves git and its API from the same name.
 */
export function forgeGitHost(apiUrl: URL): string {
  const host = apiUrl.hostname.toLowerCase()
  return host.startsWith('api.') ? host.slice('api.'.length) : host
}
