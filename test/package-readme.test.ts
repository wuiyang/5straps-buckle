import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { generatePackageReadme, rewriteRelativeLinks } from '../scripts/sync-package-readme.mjs'

// buckle/README.md ships in the npm package and renders on npmjs.com, where a repository-relative link
// breaks. The root README keeps relative links for GitHub; the package README is generated from it with
// every relative link made absolute, so the two files never drift by hand.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BLOB = 'https://github.com/wuiyang/5straps-buckle/blob/main/'

describe('rewriteRelativeLinks', () => {
  it('makes a relative path absolute', () => {
    expect(rewriteRelativeLinks('[Security](SECURITY.md)')).toBe(`[Security](${BLOB}SECURITY.md)`)
  })

  it('drops a ./ prefix', () => {
    expect(rewriteRelativeLinks('[Security](./SECURITY.md)')).toBe(`[Security](${BLOB}SECURITY.md)`)
  })

  it('keeps a nested docs path', () => {
    expect(rewriteRelativeLinks('[Building](./docs/developer/building-and-testing.md)')).toBe(`[Building](${BLOB}docs/developer/building-and-testing.md)`)
  })

  it('keeps the anchor', () => {
    expect(rewriteRelativeLinks('[limits](./docs/user/caveats/known-limits.md#credential-hiding)')).toBe(`[limits](${BLOB}docs/user/caveats/known-limits.md#credential-hiding)`)
  })

  it('normalises dot segments from the repository root', () => {
    expect(rewriteRelativeLinks('[a](./docs/../docs/./a.md)')).toBe(`[a](${BLOB}docs/a.md)`)
  })

  it('leaves an absolute URL untouched', () => {
    const text = '[issues](https://github.com/wuiyang/5straps-buckle/issues) and [plain](http://example.com/a)'
    expect(rewriteRelativeLinks(text)).toBe(text)
  })

  it('leaves a bare anchor untouched', () => {
    expect(rewriteRelativeLinks('[top](#install)')).toBe('[top](#install)')
  })

  it('leaves a mailto link untouched', () => {
    expect(rewriteRelativeLinks('[mail](mailto:security@example.com)')).toBe('[mail](mailto:security@example.com)')
  })

  it('rewrites several links on a line and across lines, and leaves the other text alone', () => {
    const text = 'See [one](./a.md), then\n[two](docs/b.md#c) or `code` with [three](https://example.com).\n'
    expect(rewriteRelativeLinks(text)).toBe(`See [one](${BLOB}a.md), then\n[two](${BLOB}docs/b.md#c) or \`code\` with [three](https://example.com).\n`)
  })

  it('leaves a fenced code block alone', () => {
    const text = '```md\n[x](./a.md)\n```\n[y](./a.md)\n'
    expect(rewriteRelativeLinks(text)).toBe(`\`\`\`md\n[x](./a.md)\n\`\`\`\n[y](${BLOB}a.md)\n`)
  })

  it('refuses a link that leaves the repository', () => {
    expect(() => rewriteRelativeLinks('[out](../outside.md)')).toThrow(/outside the repository/)
  })
})

describe('the package readme', () => {
  it('equals the text generated from the root readme', () => {
    expect(readFileSync(join(ROOT, 'buckle/README.md'), 'utf8')).toBe(generatePackageReadme({ root: ROOT }))
  })

  it('holds no relative link, so it renders the same on npmjs.com', () => {
    const links = [...readFileSync(join(ROOT, 'buckle/README.md'), 'utf8').matchAll(/\]\(([^)\s]+)/g)].map(match => match[1] ?? '')
    expect(links.filter(link => !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(link))).toEqual([])
  })

  it('links the root readme relatively', () => {
    const links = [...readFileSync(join(ROOT, 'README.md'), 'utf8').matchAll(/\]\(([^)\s]+)/g)].map(match => match[1] ?? '')
    expect(links.filter(link => link.startsWith('https://github.com/wuiyang/5straps-buckle/blob/'))).toEqual([])
  })
})
