import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGitHubForgeClient } from '../src/adapters/forge/github.js'
import { loadConfig } from '../src/config.js'

const TOKEN = 'ghp-credential-test-value'
const REPOSITORY = { owner: 'wuiyang', name: 'demo' }

let server: Server
let apiUrl: string
const received: Array<{ path: string; headers: Record<string, string | undefined> }> = []

beforeAll(async () => {
  server = await startForge()
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.close() })

function startForge(): Promise<Server> {
  const scripted = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0] ?? ''
    received.push({ path, headers: request.headers as Record<string, string | undefined> })
    if (path.endsWith('/pulls/9') && request.headers.accept === 'application/vnd.github.v3.diff') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('diff --git a/x b/x\n')
      return
    }
    if (path.endsWith('/pulls/11') && request.headers.accept === 'application/vnd.github.v3.diff') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      // The é is two bytes, so a cap of three lands in the middle of it.
      response.end('ab\u00e9cd')
      return
    }
    if (path.endsWith('/pulls/404')) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: `Bad credentials for ${TOKEN}` }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      number: 9, html_url: 'https://github.com/wuiyang/demo/pull/9', state: 'open', title: 'a change',
      head: { ref: 'work', sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) },
    }))
  })
  return new Promise(resolve => scripted.listen(0, '127.0.0.1', () => resolve(scripted)))
}

const client = () => createGitHubForgeClient({ token: TOKEN, apiUrl })
const request = (number: number) => ({ repository: REPOSITORY, number, signal: AbortSignal.timeout(5_000) })

describe('the forge credential in configuration', () => {
  it('is absent by default, which is what withholds the pack', () => {
    expect(loadConfig({}).forgeGithubToken).toBeUndefined()
  })

  it('is read from BUCKLE_FORGE_GITHUB_TOKEN as owner configuration', () => {
    expect(loadConfig({ BUCKLE_FORGE_GITHUB_TOKEN: TOKEN }).forgeGithubToken).toBe(TOKEN)
  })

  it('reaches api.github.com unless the owner points it somewhere else', () => {
    expect(loadConfig({}).forgeApiUrl).toBe('https://api.github.com')
    expect(loadConfig({ BUCKLE_FORGE_GITHUB_API_URL: 'https://ghe.example.com/api/v3/' }).forgeApiUrl).toBe('https://ghe.example.com/api/v3')
  })

  it('refuses an API URL that is not http or https, rather than reaching it', () => {
    expect(() => loadConfig({ BUCKLE_FORGE_GITHUB_API_URL: 'file:///etc' })).toThrow(/not an http or https URL/)
    expect(() => loadConfig({ BUCKLE_FORGE_GITHUB_API_URL: 'nonsense' })).toThrow(/Invalid BUCKLE_FORGE_GITHUB_API_URL/)
  })

  it('carries a commit identity, defaulting to the agent one', () => {
    expect(loadConfig({}).forgeGitAuthor).toEqual({ name: '5straps agent', email: 'agent@5straps.local' })
    expect(loadConfig({ BUCKLE_FORGE_GIT_AUTHOR: 'Demo Bot <bot@example.com>' }).forgeGitAuthor).toEqual({ name: 'Demo Bot', email: 'bot@example.com' })
  })

  it('refuses an identity that is not "Name <email>", so no commit carries a broken author', () => {
    expect(() => loadConfig({ BUCKLE_FORGE_GIT_AUTHOR: 'just-a-name' })).toThrow(/expected "Name <email>"/)
  })

  it('refuses a state directory inside the workspace, where an agent could write the hooks git runs', () => {
    expect(() => loadConfig({ BUCKLE_WORKSPACE_ROOT: '/srv/work', BUCKLE_STATE_DIR: '/srv/work/.buckle' }))
      .toThrow(/BUCKLE_STATE_DIR .* inside the BUCKLE_WORKSPACE_ROOT/)
    expect(loadConfig({ BUCKLE_WORKSPACE_ROOT: '/srv/work', BUCKLE_STATE_DIR: '/srv/state' }).stateDirectory).toBe('/srv/state')
  })
})

describe('the GitHub adapter', () => {
  it('sends the credential as a bearer header with the versioned JSON media type', async () => {
    received.length = 0
    await client().readPullRequest(request(9))
    expect(received[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(received[0]?.headers.accept).toBe('application/vnd.github+json')
    expect(received[0]?.headers['x-github-api-version']).toBe('2022-11-28')
  })

  it('asks for the diff media type when the diff is what is wanted', async () => {
    received.length = 0
    const diff = await client().readPullRequestDiff({ ...request(9), maxBytes: 1_024 })
    expect(received[0]?.headers.accept).toBe('application/vnd.github.v3.diff')
    expect(diff).toEqual({ diff: 'diff --git a/x b/x\n', truncated: false })
  })

  it('truncates a diff past the cap rather than returning all of it', async () => {
    const diff = await client().readPullRequestDiff({ ...request(9), maxBytes: 4 })
    expect(diff).toEqual({ diff: 'diff', truncated: true })
  })

  it('cuts a diff at a character boundary, so one straddling the cap is dropped rather than mangled', async () => {
    const diff = await client().readPullRequestDiff({ ...request(11), maxBytes: 3 })
    expect(diff).toEqual({ diff: 'ab', truncated: true })
  })

  it('strips the credential out of an upstream refusal that echoes it back', async () => {
    const thrown = await client().readPullRequest(request(404)).catch((error: Error) => error)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('[redacted]')
    expect((thrown as Error).message).not.toContain(TOKEN)
  })
})
