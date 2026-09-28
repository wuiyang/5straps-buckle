/** A JSON body with an explicit status, for answers other than a plain 200. */
export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers } })
}

/** A workbench answer: never cached, since it carries a grant holder's view of their files. */
export function noStore(body: unknown, status = 200): Response {
  return json(body, { status, headers: { 'cache-control': 'no-store' } })
}

export function noContent(): Response {
  return new Response(null, { status: 204 })
}
