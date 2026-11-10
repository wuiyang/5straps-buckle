export const RESULT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  web_fetch: '{ url, status, headers, body: string, truncated }',
  web_search: '{ query, results: Array<{ title, url, description }> }',
}
