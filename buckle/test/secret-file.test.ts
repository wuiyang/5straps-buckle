import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPathView, type PathView } from '../common/domain/path-view.js'
import { readDotenv } from '../common/services/secrets/dotenv.js'
import { MAX_SECRET_FILE_BYTES, readSecretValues, resolveSecretFile } from '../common/services/secrets/secret-file.js'

// The secret-references slice, part 3 (docs/secrets.md): Buckle reads the named file itself as the call runs, as
// dotenv with no interpolation, and only where it lands inside the workspace or a mount the owner declared.

const DECOY = 'decoy-value-0123456789'

describe('the dotenv reader', () => {
  const read = (text: string) => Object.fromEntries(readDotenv(text).values)

  it('reads plain, exported, and spaced assignments, skipping comments and blank lines', () => {
    expect(read('# a comment\n\nPLAIN=one-two\nexport EXPORTED=three\n  SPACED  =  four  \n#HIDDEN=x\n')).toEqual({ PLAIN: 'one-two', EXPORTED: 'three', SPACED: 'four' })
  })

  it('reads double quotes with the usual escapes and single quotes as written', () => {
    expect(read('DOUBLE="a\\nb\\tc \\"q\\" \\\\ \\$x"\nSINGLE=\'a\\nb "q" $x\'\n')).toEqual({ DOUBLE: 'a\nb\tc "q" \\ \\$x', SINGLE: 'a\\nb "q" $x' })
  })

  it('takes a quoted value across lines, as a key file is written', () => {
    expect(read('KEY="-----BEGIN-----\nabc\n-----END-----"\nNEXT=1\n')).toEqual({ KEY: '-----BEGIN-----\nabc\n-----END-----', NEXT: '1' })
  })

  it('ends an unquoted value at a # after a blank, and keeps one with none before it', () => {
    expect(read('A=value # note\nB=val#ue\nC= # only a note\nD="quoted # kept" # note\n')).toEqual({ A: 'value', B: 'val#ue', C: '', D: 'quoted # kept' })
  })

  it('interpolates nothing', () => {
    expect(read('BASE=root\nURL=${BASE}/x\nOTHER=$BASE\n')).toEqual({ BASE: 'root', URL: '${BASE}/x', OTHER: '$BASE' })
  })

  it('reads CRLF line ends and a byte order mark as a file saved on Windows has them', () => {
    expect(read('\uFEFFFIRST=one\r\nSECOND="two"\r\n')).toEqual({ FIRST: 'one', SECOND: 'two' })
  })

  it('lets a later line for a NAME win', () => {
    expect(read('A=first\nA=second\n')).toEqual({ A: 'second' })
  })

  it('marks a NAME whose line does not read as dotenv, and gives it no value', () => {
    const reading = readDotenv('A="closed"trailing\nB=fine\nC="never closed\nD=after\n')
    expect(Object.fromEntries(reading.values)).toEqual({ B: 'fine' })
    expect([...reading.unreadable].sort()).toEqual(['A', 'C'])
  })

  it('skips a line that names no variable', () => {
    expect(read('not an assignment\n9BAD=x\nexport\nGOOD=y\n')).toEqual({ GOOD: 'y' })
  })
})

describe('the file a reference names', () => {
  let base: string
  let root: string
  let mounted: string
  let outside: string
  let scratch: string
  let view: PathView
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-secret-file-')))
    root = join(base, 'workspace')
    mounted = join(base, 'shared')
    outside = join(base, 'outside')
    scratch = join(base, 'scratch')
    for (const directory of [root, mounted, outside, scratch]) mkdirSync(directory)
    writeFileSync(join(root, '.env.local'), `API_TOKEN=${DECOY}\nBROKEN="open\n`)
    writeFileSync(join(mounted, 'team.env'), `TEAM_TOKEN=${DECOY}\n`)
    writeFileSync(join(outside, 'planted.env'), `API_TOKEN=${DECOY}\n`)
    writeFileSync(join(scratch, 'scratch.env'), `API_TOKEN=${DECOY}\n`)
    view = createPathView({ root, mount: '/workspace', mounts: [{ source: mounted, target: '/data', access: 'ro' }, { source: scratch, target: scratch, access: 'rw', scratch: true }] })
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const values = (written: string, names: string[]) => readSecretValues({ real: resolveSecretFile(written, view), written, names, protectedRoots: [], roots: [root] })

  it('reads a file in the workspace by its relative path, and the NAMEs asked for alone', () => {
    expect(resolveSecretFile('.env.local', view)).toBe(join(root, '.env.local'))
    expect(resolveSecretFile('./.env.local', view)).toBe(join(root, '.env.local'))
    expect(Object.fromEntries(values('.env.local', ['API_TOKEN']))).toEqual({ API_TOKEN: DECOY })
  })

  it('follows a link into a mount the owner declared', () => {
    symlinkSync(join(mounted, 'team.env'), join(root, 'team.env'))
    expect(resolveSecretFile('team.env', view)).toBe(join(mounted, 'team.env'))
    expect(Object.fromEntries(values('team.env', ['TEAM_TOKEN']))).toEqual({ TEAM_TOKEN: DECOY })
  })

  it('refuses a link out of the workspace and its mounts, and one into a scratch root', () => {
    symlinkSync(join(outside, 'planted.env'), join(root, 'planted.env'))
    symlinkSync(outside, join(root, 'linked-folder'))
    symlinkSync(join(scratch, 'scratch.env'), join(root, 'scratch.env'))
    for (const written of ['planted.env', 'linked-folder/planted.env', 'scratch.env']) {
      expect(() => resolveSecretFile(written, view)).toThrow(`The secret reference names ${written}, which lands outside the workspace and its mounts`)
    }
  })

  it('refuses a path that names nothing or a folder, naming the path', () => {
    expect(() => resolveSecretFile('missing.env', view)).toThrow('The secret reference names missing.env, which does not exist in the workspace')
    mkdirSync(join(root, 'folder.env'))
    expect(() => resolveSecretFile('folder.env', view)).toThrow('which is not a regular file')
  })

  it('reads an unmounted view from the folder itself, where no other mount is reached', () => {
    const plain = createPathView({ root, mount: null, mounts: [{ source: mounted, target: '/data', access: 'ro' }] })
    symlinkSync(join(mounted, 'team.env'), join(root, 'team.env'))
    expect(resolveSecretFile('.env.local', plain)).toBe(join(root, '.env.local'))
    expect(() => resolveSecretFile('team.env', plain)).toThrow('lands outside the workspace and its mounts')
  })

  it('refuses a missing NAME and an unreadable line, naming the file and the NAME and never a value', () => {
    for (const [name, said] of [['OTHER', 'The secret file .env.local does not define OTHER'], ['BROKEN', 'The secret file .env.local defines BROKEN on a line Buckle cannot read as dotenv']] as const) {
      let message = ''
      try { values('.env.local', [name]) } catch (error) { message = (error as Error).message }
      expect(message).toBe(said)
      expect(message).not.toContain(DECOY)
    }
  })

  it('refuses a file swapped for a link after it was judged, and one gone since', () => {
    const real = resolveSecretFile('.env.local', view)
    renameSync(real, join(root, 'moved.env'))
    symlinkSync(join(outside, 'planted.env'), real)
    expect(() => readSecretValues({ real, written: '.env.local', names: ['API_TOKEN'], protectedRoots: [], roots: [root] })).toThrow('moved since the call was judged')
    rmSync(real)
    expect(() => readSecretValues({ real, written: '.env.local', names: ['API_TOKEN'], protectedRoots: [], roots: [root] })).toThrow('is gone since the call was judged')
  })

  it('refuses a hard link on the disk that holds Buckle\'s state', () => {
    const state = join(base, 'state')
    mkdirSync(state)
    writeFileSync(join(state, 'buckle.env'), `BUCKLE_ADMIN_TOKEN=${DECOY}\n`)
    linkSync(join(state, 'buckle.env'), join(root, 'linked.env'))
    expect(() => readSecretValues({ real: resolveSecretFile('linked.env', view), written: 'linked.env', names: ['BUCKLE_ADMIN_TOKEN'], protectedRoots: [state], roots: [root] })).toThrow('hard link')
  })

  it('refuses a file over the size bound and one that is not UTF-8', () => {
    writeFileSync(join(root, 'big.env'), `A=${'x'.repeat(MAX_SECRET_FILE_BYTES)}\n`)
    expect(() => values('big.env', ['A'])).toThrow(`larger than ${MAX_SECRET_FILE_BYTES} bytes`)
    writeFileSync(join(root, 'latin.env'), Buffer.from([0x41, 0x3d, 0xe9, 0x0a]))
    expect(() => values('latin.env', ['A'])).toThrow('is not UTF-8 text')
  })
})
