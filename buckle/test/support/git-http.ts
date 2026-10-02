import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface GitHttpServer {
  /** `http://127.0.0.1:<port>`; a repository under the project root is `<url>/<path>`. */
  url: string
  /** Every Authorization header a request carried, in order, so a test can say what reached the server. */
  authorizations: string[]
  close(): Promise<void>
}

/**
 * git's smart HTTP over `git http-backend`, the CGI program git ships, for pushes a test makes over the
 * network: optionally behind Basic auth (a request without the credential is answered 401). Receiving
 * is on for every repository under the project root.
 */
export async function startGitHttp(input: { projectRoot: string; basic?: { user: string; password: string } }): Promise<GitHttpServer> {
  const authorizations: string[] = []
  const expected = input.basic ? `Basic ${Buffer.from(`${input.basic.user}:${input.basic.password}`).toString('base64')}` : null
  const server = createServer((request, response) => {
    const authorization = request.headers.authorization ?? ''
    authorizations.push(authorization)
    if (expected !== null && authorization !== expected) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="git"' })
      response.end()
      return
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH ?? '', HOME: input.projectRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_PROJECT_ROOT: input.projectRoot, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: input.basic?.user ?? 'test', REMOTE_ADDR: '127.0.0.1',
        REQUEST_METHOD: request.method ?? 'GET', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers['content-type'] ?? '', HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
        GIT_HTTP_MAX_REQUEST_BUFFER: '100M',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    request.pipe(child.stdin)
    let head = Buffer.alloc(0)
    let started = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (started) { response.write(chunk); return }
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of head.subarray(0, end).toString('utf8').split('\r\n')) {
        const colon = line.indexOf(':')
        const name = line.slice(0, colon).trim().toLowerCase()
        const value = line.slice(colon + 1).trim()
        if (name === 'status') status = Number.parseInt(value, 10)
        else headers[name] = value
      }
      response.writeHead(status, headers)
      started = true
      if (head.length > end + 4) response.write(head.subarray(end + 4))
    })
    child.stdout.on('end', () => { if (!started) response.writeHead(500); response.end() })
    child.on('error', () => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    authorizations,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
