import { describe, expect, it } from 'vitest'
import { createPathView, OUTSIDE_PATH } from '../common/domain/path-view.js'

const ROOT = '/work/project'
const SCRATCH = '/tmp/scratch'

describe('a mounted workspace', () => {
  const view = createPathView({ root: ROOT, mount: '/workspace', scratchRoots: [SCRATCH] })

  it('names itself by the mount', () => {
    expect(view.displayRoot).toBe('/workspace')
    expect(view.displayRoots).toEqual(['/workspace', SCRATCH])
  })

  it('resolves relative, virtual and real paths to the same real place', () => {
    expect(view.resolve('src/app.ts')).toBe(`${ROOT}/src/app.ts`)
    expect(view.resolve('/workspace/src/app.ts')).toBe(`${ROOT}/src/app.ts`)
    expect(view.resolve('/workspace')).toBe(ROOT)
    expect(view.resolve(`${ROOT}/src/app.ts`)).toBe(`${ROOT}/src/app.ts`)
  })

  it('resolves a scratch root, which the agent names as it really is', () => {
    expect(view.resolve(`${SCRATCH}/notes.md`)).toBe(`${SCRATCH}/notes.md`)
  })

  it('refuses a real host path rather than resolving it', () => {
    expect(() => view.resolve('/etc/hosts')).toThrow('/etc/hosts is outside the mounted workspace')
  })

  it('names the mount and the scratch roots when it refuses, so the caller can correct itself', () => {
    expect(() => view.resolve('/etc/hosts')).toThrow(`Reachable: /workspace, ${SCRATCH}`)
  })

  it('refuses a relative path that climbs out of the workspace', () => {
    expect(() => view.resolve('../../etc/hosts')).toThrow('is outside the mounted workspace')
  })

  it('does not mistake a sibling of the mount for the mount', () => {
    expect(() => view.resolve('/workspaces/other')).toThrow('is outside the mounted workspace')
  })

  it('shows workspace paths relative and everything else as is', () => {
    expect(view.display(`${ROOT}/src/app.ts`)).toBe('src/app.ts')
    expect(view.display(ROOT)).toBe('.')
  })

  it('turns a real path back into the virtual one the agent knows', () => {
    expect(view.toVirtual(`${ROOT}/src/app.ts`)).toBe('/workspace/src/app.ts')
    expect(view.toVirtual(ROOT)).toBe('/workspace')
    expect(view.toVirtual(`${SCRATCH}/notes.md`)).toBe(`${SCRATCH}/notes.md`)
  })

  it('gives a path outside the workspace no name at all', () => {
    expect(view.toVirtual('/etc/hosts')).toBe(OUTSIDE_PATH)
  })
})

describe('an unmounted workspace', () => {
  const view = createPathView({ root: ROOT, mount: null })

  it('shows the real root through', () => {
    expect(view.displayRoot).toBe(ROOT)
    expect(view.toVirtual(`${ROOT}/a`)).toBe(`${ROOT}/a`)
    expect(view.resolve('a')).toBe(`${ROOT}/a`)
  })

  it('leaves a path outside the workspace to be judged by the rules, as it always did', () => {
    expect(view.resolve('/etc/hosts')).toBe('/etc/hosts')
    expect(view.toVirtual('/etc/hosts')).toBe('/etc/hosts')
  })
})
