import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildChildEnvironment, hostEnvironment } from '../common/domain/environment.js'
import { rootsOf } from '../common/domain/executable.js'

// On the owner's Windows node agent-browser's screenshot hung under Buckle and worked by hand with the same flags:
// every program Buckle started ran without SystemRoot, TEMP, USERPROFILE, and the rest, as the inherited list named
// Unix variables only. Windows is imitated through the platform the functions take.

afterEach(() => { vi.unstubAllEnvs() })

const WINDOWS = {
  SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD',
  OS: 'Windows_NT', TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp', TMP: 'C:\\Users\\me\\AppData\\Local\\Temp', USERPROFILE: 'C:\\Users\\me',
  HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\me', USERNAME: 'me', USERDOMAIN: 'DESK', COMPUTERNAME: 'DESK', APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramData: 'C:\\ProgramData', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramW6432: 'C:\\Program Files', CommonProgramFiles: 'C:\\Program Files\\Common Files', 'CommonProgramFiles(x86)': 'C:\\Program Files (x86)\\Common Files',
  CommonProgramW6432: 'C:\\Program Files\\Common Files', ALLUSERSPROFILE: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public', NUMBER_OF_PROCESSORS: '8',
  PROCESSOR_ARCHITECTURE: 'AMD64', PROCESSOR_IDENTIFIER: 'Intel64 Family 6', PROCESSOR_LEVEL: '6', PROCESSOR_REVISION: '9e0a',
}
const SECRETS = { BUCKLE_AUTH_TOKEN: 'agent-token', GITHUB_TOKEN: 'forge-token', OPENAI_API_KEY: 'provider-key', SOME_OTHER_SETTING: 'x' }

describe('the environment a child inherits', () => {
  it('on Linux and macOS never gains the Windows variables, and keeps the Unix list as it was', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const child = buildChildEnvironment({ parent: { ...WINDOWS, ...SECRETS, PATH: '/usr/bin', HOME: '/home/me', LANG: 'C.UTF-8' }, extra: {}, platform })
      expect(child).toEqual({ PATH: '/usr/bin', HOME: '/home/me', LANG: 'C.UTF-8' })
    }
  })

  it('on Windows passes every Windows variable through, and still no secret or other setting', () => {
    const child = buildChildEnvironment({ parent: { ...WINDOWS, ...SECRETS, Path: 'C:\\Windows\\system32' }, extra: {}, platform: 'win32' })
    expect(child).toEqual({ ...WINDOWS, Path: 'C:\\Windows\\system32' })
  })

  it('on Windows matches a name without regard to case, under the parent\'s spelling, and an extra replaces every spelling', () => {
    const parent = { Path: 'C:\\Tools', systemroot: 'C:\\Windows', Temp: 'C:\\Temp', home: 'C:\\Users\\me' }
    expect(buildChildEnvironment({ parent, extra: {}, platform: 'win32' })).toEqual(parent)
    expect(buildChildEnvironment({ parent, extra: { PATH: 'C:\\Other', TEMP: 'C:\\Elsewhere' }, platform: 'win32' })).toEqual({ PATH: 'C:\\Other', systemroot: 'C:\\Windows', TEMP: 'C:\\Elsewhere', home: 'C:\\Users\\me' })
    expect(buildChildEnvironment({ parent, extra: {}, platform: 'linux' })).toEqual({})
  })

  it('for a program Buckle runs on Windows judges PATH under the parent\'s spelling, so an agent\'s folder is left out', () => {
    vi.stubEnv('PATH', undefined)
    vi.stubEnv('Path', 'C:\\Tools;C:\\ws\\node_modules\\.bin')
    vi.stubEnv('systemroot', 'C:\\Windows')
    const child = hostEnvironment(() => ({ untrustedRoots: rootsOf('workspace', ['C:/ws']) }), 'win32')({ GIT_TERMINAL_PROMPT: '0' })
    expect(child).toMatchObject({ Path: 'C:\\Tools', systemroot: 'C:\\Windows', GIT_TERMINAL_PROMPT: '0' })
    expect(Object.keys(child).filter(name => name.toUpperCase() === 'PATH')).toEqual(['Path'])
  })
})
