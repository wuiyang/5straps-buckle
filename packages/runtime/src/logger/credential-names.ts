// Credential words, matched inside each key word so plurals and run-together names (accesstoken, PGPASSWORD) count.
const CREDENTIAL_WORDS = ['authorization', 'bearer', 'secret', 'passw(?:or)?d', 'passphrase', 'cookie', 'credential', 'signature', 'apikey', 'privatekey']
const SECRET_WORD = new RegExp(['token', ...CREDENTIAL_WORDS].join('|'))
const CREDENTIAL_WORD = new RegExp(CREDENTIAL_WORDS.join('|'))
const SECRET_WHOLE_WORDS = new Set(['auth'])
// Two-word names such as 'api key' and 'private keys'.
const KEY_PREFIXES = new Set(['api', 'private'])
const KEY_WORD = /^keys?$/
// A token count is a numeric value under a key ending in a count word (inputTokens, tokenCount, max_tokens, tokensUsed).
// A key ending in singular 'token' (inputToken, cacheToken) is always a credential.
const COUNT_KEY_END = /(?:tokens|count|total|limit|usage|budget|used)$/
const NUMERIC_TEXT = /^\d+$/
// Credential parameters whose names are not credential words: Google API keys, SAS signatures, OAuth codes, and the
// `pwd` some services take a password in (slice 7b review R7B-CR-8).
const SECRET_QUERY_NAMES = new Set(['key', 'sig', 'code', 'pwd'])
// Owner ruling B (2026-10-03): the words whose key's value an approval display hides whole, found anywhere in the key.
const NAMED_KEY = /passw(?:or)?d|secret|token/
// What else names a credential query value in a whole URL: a signature, or a word that is key, auth, sig or pwd, or ends
// in key (apikey, accessKey).
const QUERY_NAME = /signature/
const QUERY_WORDS = new Set(['key', 'keys', 'auth', 'sig', 'pwd'])

export function keyWords(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * Whether a key names a credential: a credential word inside any of its words (Authorization, Bearer,
 * Cookie, Set-Cookie, X-Api-Key, api key, private key, auth, passphrase, signature, secret, password,
 * token), whatever its case or nesting; a number under a count key (max_tokens) is not one. One matcher
 * for every redaction by name, so the process log and what else redacts by it agree.
 */
export function isCredentialKey(key: string, value?: unknown): boolean {
  const words = keyWords(key)
  const secretWord = isTokenCount({ words, value }) ? CREDENTIAL_WORD : SECRET_WORD
  // A word and the next one are judged joined too, so a camel-case split of one credential word (passWord,
  // PassWord, passPhrase) still names it (review L7 of the second re-review).
  return words.some((word, index) => isSecretWord({ word, next: words[index + 1], secretWord }) || (index + 1 < words.length && secretWord.test(`${word}${words[index + 1]}`)))
}

/**
 * Whether a URL query or fragment parameter carries a credential: a credential-named key
 * (isCredentialKey), or a name services give keys, signatures, codes and passwords in (key, sig, code,
 * pwd). The process log's matcher (log-credentials.ts); an approval display uses isCredentialQueryName.
 */
export function isCredentialParameter(name: string, value?: string): boolean {
  return isCredentialKey(name, value) || SECRET_QUERY_NAMES.has(name.toLowerCase())
}

/**
 * Whether an approval display hides a key's value whole (owner ruling B): the key holds password, secret or token,
 * whatever its case or what comes before or after (api_token, DB_PASSWORD, clientSecret, PGPASSWORD); a number under
 * a count key (max_tokens) is not one.
 */
export function isNamedCredentialKey(key: string, value?: unknown): boolean {
  return NAMED_KEY.test(squashed(key)) && !isTokenCount({ words: keyWords(key), value })
}

/** Whether a whole URL's query parameter carries a credential an approval display hides (owner ruling B). */
export function isCredentialQueryName(name: string, value?: string): boolean {
  if (isNamedCredentialKey(name, value) || QUERY_NAME.test(squashed(name))) return true
  return keyWords(name).some(word => QUERY_WORDS.has(word) || word.endsWith('key'))
}

function squashed(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSecretWord({ word, next, secretWord }: { word: string; next?: string; secretWord: RegExp }): boolean {
  if (SECRET_WHOLE_WORDS.has(word)) return true
  if (KEY_PREFIXES.has(word) && next !== undefined && KEY_WORD.test(next)) return true
  return secretWord.test(word)
}

function isTokenCount({ words, value }: { words: string[]; value: unknown }): boolean {
  const numeric = typeof value === 'number' || (typeof value === 'string' && NUMERIC_TEXT.test(value))
  return numeric && COUNT_KEY_END.test(words.at(-1) ?? '')
}
