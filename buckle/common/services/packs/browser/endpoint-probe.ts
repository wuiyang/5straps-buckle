import { connect } from 'node:net'
import { cdpEndpointKey } from './mode.js'

/** How long one address may take to answer or refuse; one that does neither is not found closed. */
const PROBE_TIMEOUT_MS = 1_000

/** What a loopback address gives where nothing can listen on it: a node with no IPv6 loopback, say. */
const LOOPBACK_ABSENT = new Set(['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH'])

/**
 * Whether the Chrome an attached endpoint reaches is closed (Codex review L2): every address of its host and port, as
 * cdpEndpointKey reads them, the loopback's IPv4 and IPv6 both, refuses a connection. One that answers, or does not
 * answer in time, or a host that cannot be reached, is not found closed, so the hold its pages need stays.
 */
export async function endpointClosed(endpoint: string): Promise<boolean> {
  const key = cdpEndpointKey(endpoint)
  const at = key.lastIndexOf(':')
  const port = Number(key.slice(at + 1))
  if (at <= 0 || !Number.isInteger(port) || port <= 0 || port > 65_535) return false
  const host = key.slice(0, at)
  const loopback = host === '127.0.0.1'
  const refused = await Promise.all((loopback ? ['127.0.0.1', '::1'] : [host]).map(address => refuses(address, port, loopback)))
  return refused.every(Boolean)
}

function refuses(host: string, port: number, loopback: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (closed: boolean) => {
      socket.destroy()
      resolve(closed)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => settle(false))
    socket.once('connect', () => settle(false))
    socket.once('error', (error: NodeJS.ErrnoException) => settle(loopback ? LOOPBACK_ABSENT.has(error.code ?? '') : error.code === 'ECONNREFUSED'))
  })
}
