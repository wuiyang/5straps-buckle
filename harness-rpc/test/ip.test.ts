import { describe, expect, it } from 'vitest'
import { reservedRangeOf } from '../src/domain/ip.js'

describe('reservedRangeOf', () => {
  it('flags the cloud metadata address', () => {
    expect(reservedRangeOf('169.254.169.254')).toBe('link-local')
  })

  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.101.102.103', 'carrier-grade-nat'],
    ['0.0.0.0', 'this-network'],
  ])('flags %s as %s', (address, label) => {
    expect(reservedRangeOf(address)).toBe(label)
  })

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34'])('allows public address %s', address => {
    expect(reservedRangeOf(address)).toBeNull()
  })

  it('flags IPv6 loopback and unique-local', () => {
    expect(reservedRangeOf('::1')).toBe('loopback')
    expect(reservedRangeOf('fd00::1')).toBe('unique-local')
    expect(reservedRangeOf('fe80::1')).toBe('link-local')
  })

  it('unwraps IPv4-mapped IPv6, which is the classic filter bypass', () => {
    expect(reservedRangeOf('::ffff:127.0.0.1')).toBe('loopback')
    expect(reservedRangeOf('::ffff:169.254.169.254')).toBe('link-local')
    expect(reservedRangeOf('::ffff:7f00:1')).toBe('loopback')
  })

  it('allows a public address written in IPv4-mapped form', () => {
    expect(reservedRangeOf('::ffff:8.8.8.8')).toBeNull()
  })

  it('returns null for hostnames, which need DNS resolution first', () => {
    expect(reservedRangeOf('example.com')).toBeNull()
  })
})
