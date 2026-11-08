import { isIPv4, isIPv6 } from 'node:net'

interface Cidr {
  label: string
  bytes: number[]
  prefix: number
}

const IPV4_RESERVED: Cidr[] = [
  { label: 'this-network', bytes: [0, 0, 0, 0], prefix: 8 },
  { label: 'private', bytes: [10, 0, 0, 0], prefix: 8 },
  { label: 'carrier-grade-nat', bytes: [100, 64, 0, 0], prefix: 10 },
  { label: 'loopback', bytes: [127, 0, 0, 0], prefix: 8 },
  { label: 'link-local', bytes: [169, 254, 0, 0], prefix: 16 },
  { label: 'private', bytes: [172, 16, 0, 0], prefix: 12 },
  { label: 'ietf-protocol', bytes: [192, 0, 0, 0], prefix: 24 },
  { label: 'private', bytes: [192, 168, 0, 0], prefix: 16 },
  { label: 'benchmark', bytes: [198, 18, 0, 0], prefix: 15 },
  { label: 'multicast', bytes: [224, 0, 0, 0], prefix: 4 },
  { label: 'reserved', bytes: [240, 0, 0, 0], prefix: 4 },
]

const IPV6_RESERVED: Array<{ label: string; prefixHextets: number[]; prefix: number }> = [
  { label: 'unique-local', prefixHextets: [0xfc00], prefix: 7 },
  { label: 'link-local', prefixHextets: [0xfe80], prefix: 10 },
  { label: 'nat64', prefixHextets: [0x0064, 0xff9b], prefix: 96 },
]

/** Returns the reserved-range label when the address is not publicly routable. */
export function reservedRangeOf(address: string): string | null {
  if (isIPv4(address)) return ipv4Range(address)
  if (isIPv6(address)) return ipv6Range(address)
  return null
}

function ipv4Range(address: string): string | null {
  const bytes = address.split('.').map(Number)
  if (bytes.length !== 4 || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return 'malformed'
  return IPV4_RESERVED.find(range => matchesBytes(bytes, range.bytes, range.prefix))?.label ?? null
}

function ipv6Range(address: string): string | null {
  const hextets = expandIpv6(address)
  if (!hextets) return 'malformed'

  // IPv4-mapped and IPv4-compatible forms must be judged as the IPv4 address they carry.
  const mapped = mappedIpv4(hextets)
  if (mapped) return ipv4Range(mapped)

  if (hextets.every(hextet => hextet === 0)) return 'unspecified'
  if (hextets.slice(0, 7).every(hextet => hextet === 0) && hextets[7] === 1) return 'loopback'

  const bytes = hextets.flatMap(hextet => [hextet >> 8, hextet & 0xff])
  return IPV6_RESERVED.find(range => {
    const rangeBytes = range.prefixHextets.flatMap(hextet => [hextet >> 8, hextet & 0xff])
    return matchesBytes(bytes, rangeBytes, range.prefix)
  })?.label ?? null
}

function mappedIpv4(hextets: number[]): string | null {
  const leadingZero = hextets.slice(0, 5).every(hextet => hextet === 0)
  if (!leadingZero) return null
  if (hextets[5] !== 0xffff && hextets[5] !== 0) return null
  const high = hextets[6] ?? 0
  const low = hextets[7] ?? 0
  if (hextets[5] === 0 && high === 0 && low <= 1) return null
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

function expandIpv6(address: string): number[] | null {
  const zoneless = address.split('%')[0] ?? address
  const [head, tail, ...rest] = zoneless.split('::')
  if (rest.length > 0) return null

  const parseGroups = (value: string | undefined): number[] => {
    if (!value) return []
    return value.split(':').filter(Boolean).flatMap(group => {
      if (group.includes('.')) {
        const octets = group.split('.').map(Number)
        if (octets.length !== 4) return [Number.NaN]
        return [((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)]
      }
      return [Number.parseInt(group, 16)]
    })
  }

  const left = parseGroups(head)
  const right = parseGroups(tail)
  if ([...left, ...right].some(Number.isNaN)) return null

  const hextets = tail === undefined
    ? left
    : [...left, ...new Array<number>(Math.max(0, 8 - left.length - right.length)).fill(0), ...right]

  return hextets.length === 8 ? hextets : null
}

function matchesBytes(candidate: readonly number[], range: readonly number[], prefix: number): boolean {
  for (let index = 0; index * 8 < prefix; index += 1) {
    const remaining = prefix - index * 8
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff
    if (((candidate[index] ?? 0) & mask) !== ((range[index] ?? 0) & mask)) return false
  }
  return true
}

/**
 * A range of addresses in CIDR notation, as the owner lists one for network egress to reach without asking
 * (network.privateRanges, APPROVAL-19). Only CIDR: never a hostname or a wildcard, so a range exposes exactly the
 * addresses it names.
 */
export interface AddressRange {
  /** As the owner wrote it. */
  readonly text: string
  readonly family: 4 | 6
  readonly bytes: readonly number[]
  readonly prefix: number
}

export class CidrError extends Error {}

const DECIMAL = /^(?:0|[1-9]\d{0,2})$/
/** The widest range each family takes: a wider one would cover every private, loopback, and link-local block at once. */
const LEAST_PREFIX: Readonly<Record<4 | 6, number>> = { 4: 8, 6: 8 }
const CIDR_FORM = 'not CIDR notation: write an address, a slash, and a prefix length, such as 10.0.0.0/8 or fd00::/8; a hostname or a wildcard is never taken'

/** Why `text` is not a range Buckle takes, worded to follow the entry it names, or null. */
export function cidrRefusal(text: string): string | null {
  try { parseCidr(text); return null } catch (error) {
    if (error instanceof CidrError) return error.message
    throw error
  }
}

/** The range `text` names; a CidrError where it is not CIDR, or sets a bit past its prefix. */
export function parseCidr(text: string): AddressRange {
  const [address = '', prefixText, ...rest] = text.split('/')
  if (prefixText === undefined || rest.length > 0) throw new CidrError(CIDR_FORM)
  const parsed = cidrAddress(address)
  if (!parsed) throw new CidrError(CIDR_FORM)
  const width = parsed.bytes.length * 8
  const prefix = DECIMAL.test(prefixText) ? Number(prefixText) : NaN
  if (!(prefix <= width)) throw new CidrError(`the prefix length is a whole number, 0 to ${width}`)
  const least = LEAST_PREFIX[parsed.family]
  if (prefix < least) throw new CidrError(`the prefix length is at least /${least}, so a range never covers every private, loopback, and link-local address at once; list each range you mean`)
  if (parsed.family === 6 && prefix >= 96 && mappedIpv4(parsed.hextets)) throw new CidrError('an IPv4-mapped range is read as the IPv4 addresses it carries; write the IPv4 range')
  if (!matchesBytes(parsed.bytes, networkBytes(parsed.bytes, prefix), width)) throw new CidrError(`it sets bits past its prefix; write ${networkText(parsed, prefix)}, or the one address with /${width}`)
  return { text, family: parsed.family, bytes: parsed.bytes, prefix }
}

/** Where the node's own serve listens (BUCKLE_HOST, BUCKLE_PORT), which no private range clears. */
export interface NodeListener { host: string; port: number }

/** Reserved blocks a connection to which reaches this machine. */
const THIS_MACHINE = new Set(['loopback', 'unspecified', 'this-network'])

/**
 * Whether `address` on `port` may reach the node's own listener: its port, at the address it listens on or one of this
 * machine's own blocks, or at any address where it listens on every one or under a name.
 */
export function reachesListener(input: { address: string; port: number; listener: NodeListener }): boolean {
  const { listener } = input
  if (input.port !== listener.port) return false
  const bare = input.address.replace(/^\[|\]$/g, '').toLowerCase()
  const host = listener.host.replace(/^\[|\]$/g, '').toLowerCase()
  const everywhere = !(isIPv4(host) || isIPv6(host)) || host === '0.0.0.0' || reservedRangeOf(host) === 'unspecified'
  return everywhere || bare === host || THIS_MACHINE.has(reservedRangeOf(bare) ?? '')
}

/** The port a URL reaches, its scheme's own where it names none. */
export function portOf(url: URL): number {
  return url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
}

/** The listed range that holds `address`, or null; an IPv4-mapped address is judged as the IPv4 address it carries. */
export function rangeCovering(address: string, ranges: readonly AddressRange[]): AddressRange | null {
  const bare = address.replace(/^\[|\]$/g, '')
  const target = addressBytes(bare)
  if (!target) return null
  return ranges.find(range => range.family === target.family && matchesBytes(target.bytes, range.bytes, range.prefix)) ?? null
}

function cidrAddress(address: string): { family: 4 | 6; bytes: number[]; hextets: number[] } | null {
  if (isIPv4(address)) {
    const octets = address.split('.')
    return octets.every(octet => DECIMAL.test(octet)) ? { family: 4, bytes: octets.map(Number), hextets: [] } : null
  }
  if (!isIPv6(address) || address.includes('%')) return null
  const hextets = expandIpv6(address)
  return hextets ? { family: 6, bytes: hextets.flatMap(hextet => [hextet >> 8, hextet & 0xff]), hextets } : null
}

function addressBytes(address: string): { family: 4 | 6; bytes: number[] } | null {
  if (isIPv4(address)) return { family: 4, bytes: address.split('.').map(Number) }
  if (!isIPv6(address)) return null
  const hextets = expandIpv6(address)
  if (!hextets) return null
  const mapped = mappedIpv4(hextets)
  if (mapped) return { family: 4, bytes: mapped.split('.').map(Number) }
  return { family: 6, bytes: hextets.flatMap(hextet => [hextet >> 8, hextet & 0xff]) }
}

function networkBytes(bytes: readonly number[], prefix: number): number[] {
  return bytes.map((byte, index) => {
    const kept = Math.min(8, Math.max(0, prefix - index * 8))
    return byte & ((0xff << (8 - kept)) & 0xff)
  })
}

function networkText(parsed: { family: 4 | 6; bytes: number[] }, prefix: number): string {
  const network = networkBytes(parsed.bytes, prefix)
  if (parsed.family === 4) return `${network.join('.')}/${prefix}`
  const groups = Array.from({ length: 8 }, (_, index) => ((network[index * 2]! << 8) | network[index * 2 + 1]!).toString(16))
  return `${groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::')}/${prefix}`
}
