/**
 * Turns a URL as a person or an agent writes it into the URL a browser would load, so the rule
 * that judges it sees the same host the browser reaches. `example.com` and
 * `https://example.com` must be judged alike, or writing the short form skips the check.
 *
 * - `scheme://...` and other explicit schemes (`about:blank`, `file:`) are parsed as written; the
 *   egress rule refuses anything but http and https, with its reason.
 * - `host:port` is a host with a port, not a URL whose scheme is the host.
 * - anything else without a scheme is `https://<input>`, which is what agent-browser loads.
 */
export class UrlNormaliseError extends Error {}

const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const HOST_AND_PORT = /^[^/?#@:\s]+:\d{1,5}(?:[/?#]|$)/

export function normaliseUrl(input: string): URL {
  const trimmed = input.trim()
  if (!trimmed || /\s/.test(trimmed) || /^[/\\]/.test(trimmed)) throw notAUrl(input)
  const hasScheme = EXPLICIT_SCHEME.test(trimmed) && !HOST_AND_PORT.test(trimmed)
  try {
    return new URL(hasScheme ? trimmed : `https://${trimmed}`)
  } catch {
    throw notAUrl(input)
  }
}

function notAUrl(input: string): UrlNormaliseError {
  return new UrlNormaliseError(`Not an http or https URL or a host: ${JSON.stringify(input.slice(0, 200))}`)
}
