import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ApprovalNotice } from '@5straps/protocol'

/** A stand-in for the approval webhook, keeping every notice it receives. */
export async function captureWebhook() {
  const notices: ApprovalNotice[] = []
  const bodies: unknown[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { notices?: ApprovalNotice[] }
      bodies.push(parsed)
      notices.push(...parsed.notices ?? [])
      response.writeHead(202).end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/approvals`, notices, bodies, close: () => new Promise(resolve => server.close(resolve)) }
}
