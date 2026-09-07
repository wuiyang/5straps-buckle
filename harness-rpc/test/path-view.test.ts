import { describe, expect, it } from 'vitest'
import { createPathView } from '../src/domain/path-view.js'

const ROOT = '/work/project'

describe('a mounted workspace', () => {
  const view = createPathView({ root: ROOT, mount: '/workspace' })

  it('names itself by the mount', () => {
    expect(view.displayRoot).toBe('/workspace')
  })

  it('resolves relative, virtual and real paths to the same real place', () => {
    expect(view.resolve('src/app.ts')).toBe(`${ROOT}/src/app.ts`)
    expect(view.resolve('/workspace/src/app.ts')).toBe(`${ROOT}/src/app.ts`)
    expect(view.resolve('/workspace')).toBe(ROOT)
    expect(view.resolve(`${ROOT}/src/app.ts`)).toBe(`${ROOT}/src/app.ts`)
  })

  it('does not mistake a sibling of the mount for the mount', () => {
    expect(view.resolve('/workspaces/other')).toBe('/workspaces/other')
  })

  it('leaves a path outside the workspace to be judged as it is', () => {
    expect(view.resolve('/etc/hosts')).toBe('/etc/hosts')
  })

  it('shows workspace paths relative and everything else as is', () => {
    expect(view.display(`${ROOT}/src/app.ts`)).toBe('src/app.ts')
    expect(view.display(ROOT)).toBe('.')
    expect(view.display('/etc/hosts')).toBe('/etc/hosts')
  })

  it('turns a real path back into the virtual one the agent knows', () => {
    expect(view.toVirtual(`${ROOT}/src/app.ts`)).toBe('/workspace/src/app.ts')
    expect(view.toVirtual(ROOT)).toBe('/workspace')
    expect(view.toVirtual('/etc/hosts')).toBe('/etc/hosts')
  })
})

describe('an unmounted workspace', () => {
  const view = createPathView({ root: ROOT, mount: null })

  it('shows the real root through', () => {
    expect(view.displayRoot).toBe(ROOT)
    expect(view.toVirtual(`${ROOT}/a`)).toBe(`${ROOT}/a`)
    expect(view.resolve('a')).toBe(`${ROOT}/a`)
  })
})
