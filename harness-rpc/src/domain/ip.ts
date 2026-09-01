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

function matchesBytes(candidate: number[], range: number[], prefix: number): boolean {
  for (let index = 0; index * 8 < prefix; index += 1) {
    const remaining = prefix - index * 8
    const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff
    if (((candidate[index] ?? 0) & mask) !== ((range[index] ?? 0) & mask)) return false
  }
  return true
}
