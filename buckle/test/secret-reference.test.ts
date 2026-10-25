import { describe, expect, it } from 'vitest'
import { maskLabel, mentionsReference, PLATFORM_REASON, readReferences } from '../common/domain/secret-reference.js'

// The secret-references slice, part 1 (docs/secrets.md): the grammar names its source. A file reference is read; a
// platform reference is reserved and refused; any other text written as a reference refuses the call, naming the form.

const refusalOf = (text: string): string => {
  const read = readReferences(text)
  if (!('refusal' in read)) throw new Error(`expected a refusal for ${text}`)
  return read.refusal
}

describe('file references', () => {
  it('reads each file reference with its path, NAME, and where it stands', () => {
    const text = 'Bearer {{file:.env.local:API_TOKEN}} and {{file:config/keys.env:_second2}}'
    expect(readReferences(text)).toEqual({
      references: [
        { raw: '{{file:.env.local:API_TOKEN}}', start: 7, end: 36, path: '.env.local', name: 'API_TOKEN' },
        { raw: '{{file:config/keys.env:_second2}}', start: 41, end: 74, path: 'config/keys.env', name: '_second2' },
      ],
    })
  })

  it('takes a path holding a colon, its NAME after the last one, and a ./ segment', () => {
    expect(readReferences('{{file:./a:b.env:TOKEN}}')).toEqual({ references: [{ raw: '{{file:./a:b.env:TOKEN}}', start: 0, end: 24, path: './a:b.env', name: 'TOKEN' }] })
  })

  it('leaves text with no {{ untouched, and text no reference shapes', () => {
    expect(readReferences('plain text, $HOME and {single} braces')).toEqual({ references: [] })
    // A template's or JSX's double braces hold blanks or no scheme: they are no reference.
    expect(readReferences('{{ item.name }} {{name}} style={{ color: "red" }}')).toEqual({ references: [] })
  })

  it.each([
    ['/etc/app.env', 'no leading /'],
    ['../outside.env', 'no .. segment'],
    ['a/../../b.env', 'no .. segment'],
    ['C:/keys.env', 'no drive letter'],
    ['c:keys.env', 'no drive letter'],
    ['dir\\keys.env', 'never \\'],
    ['', 'empty'],
  ])('refuses the path %s, naming the form', (path, said) => {
    const refusal = refusalOf(`curl {{file:${path}:TOKEN}}`)
    expect(refusal).toContain(`{{file:${path}:TOKEN}}`)
    expect(refusal).toContain(said)
  })

  it.each(['9TOKEN', 'API-TOKEN', 'API.TOKEN', ''])('refuses the NAME %s', (name) => {
    expect(refusalOf(`{{file:.env:${name}}}`)).toMatch(/NAME|names no NAME/)
  })

  it('refuses a reference with no NAME at all', () => {
    expect(refusalOf('{{file:.env}}')).toContain('names no NAME')
  })

  it('refuses a control character in the path', () => {
    expect(refusalOf('{{file:a\u0007b:TOKEN}}')).toContain('control character')
  })
})

describe('other forms written as a reference', () => {
  it('reserves a platform reference and refuses it, never passing it through as text', () => {
    const refusal = refusalOf('token {{env:rings:ADMIN_TOKEN}}')
    expect(refusal.startsWith(PLATFORM_REASON)).toBe(true)
    expect(refusal).toContain('rings')
    expect(refusalOf('{{env:1password:API_KEY}}').startsWith(PLATFORM_REASON)).toBe(true)
  })

  it('refuses a bare env reference, which names no source', () => {
    const refusal = refusalOf('{{env:API_KEY}}')
    expect(refusal).toContain('names no source')
    expect(refusal).toContain('{{file:<path>:API_KEY}}')
  })

  it('refuses a malformed platform reference', () => {
    expect(refusalOf('{{env:rings:sub:NAME}}')).toContain('is not a platform reference')
    expect(refusalOf('{{env:Rings:NAME}}')).toContain('is not a platform reference')
  })

  it.each(['{{vault:secret/db:PASSWORD}}', '{{secret:TOKEN}}', '{{op:vault/item:field}}'])('refuses %s, an unknown scheme', (text) => {
    expect(refusalOf(`x ${text} y`)).toContain('which Buckle does not read')
  })

  it.each(['{{FILE:.env:TOKEN}}', '{{Env:rings:TOKEN}}'])('refuses %s, a known scheme in another case', (text) => {
    expect(refusalOf(text)).toContain('lower case')
  })

  it.each(['{{ file:.env:TOKEN }}', '{{file :.env:TOKEN}}', '{{file: .env:TOKEN}}', '{{env: rings:X}}', '{{ ENV:x}}'])('refuses %s, a known scheme with a blank', (text) => {
    expect(refusalOf(text)).toContain('is not written as a reference')
  })

  it('refuses the whole text when any one reference in it is refused', () => {
    expect('refusal' in readReferences('{{file:.env:GOOD}} then {{env:BAD}}')).toBe(true)
  })
})

describe('outside the places references are read', () => {
  it('finds a file, platform, or bare env reference in any case', () => {
    for (const text of ['{{file:.env:A}}', 'x{{env:rings:A}}', '{{env:A}}', '{{FILE:x:Y}}', '{{file:/abs:9}}']) expect(mentionsReference(text)).toBe(true)
  })

  it('takes another scheme, a near miss with blanks, and template braces as plain text', () => {
    for (const text of ['{{vault:a:B}}', '{{ file:.env:A }}', '{{ x }}', 'style={{color:red}}', 'no braces']) expect(mentionsReference(text)).toBe(false)
  })
})

it('shows a value as [secret:NAME]', () => {
  expect(maskLabel('API_TOKEN')).toBe('[secret:API_TOKEN]')
})
