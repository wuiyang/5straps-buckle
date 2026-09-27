// The stateless MCP SDK answers other methods with 405 but no Allow header; RFC 9110 requires one, and only POST is served.
export function allowPostOnly(response: Response): Response {
  if (response.status !== 405 || response.headers.has('allow')) return response
  const headers = new Headers(response.headers)
  headers.set('allow', 'POST')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
