import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { describe, expect, it } from 'vitest'
import { serviceCommand } from '../cli/service.js'
import { serviceManagerFor } from '../common/adapters/service-manager/index.js'
import { createTaskSchedulerManager, readTask, renderTask, schtasksPath, stateDigest, taskFileBytes, taskFileText, TASK_NAME, windowsArgument, windowsArguments } from '../common/adapters/service-manager/task-scheduler.js'
import type { ProcessRequest, ProcessResult } from '../common/types/ports/process-runner.js'
import { ServiceManagerError } from '../common/types/ports/service-manager.js'

// Phase 3, item 3 of the workspace-model slice (Q4, D73 experimental): on Windows, a Task Scheduler task. Neither
// Windows nor Task Scheduler runs here or on CI, so the platform is imitated through the win32 seams and a runner
// that records each schtasks.exe call and answers as Task Scheduler would; the task is checked as XML. The owner tests
// it on a Windows machine.

const DEFINITION = { node: 'C:\\Program Files\\nodejs\\node.exe', main: 'C:/Users/Owner/AppData/Roaming/npm/node_modules/@5straps/buckle/dist/main.js', stateDirectory: 'C:/Users/Owner/.5straps/buckle', environmentFile: null, userId: 'DESKTOP-1\\Owner' }

describe('the Task Scheduler task', () => {
  it('starts at the owner\'s logon with least privilege, no time limit, no battery rule, hidden, node.exe and its arguments apart', () => {
    const task = renderTask(DEFINITION)
    expect(task).toContain('<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">')
    expect(task).toContain('    <LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>DESKTOP-1\\Owner</UserId>\n    </LogonTrigger>')
    expect(task).toContain('      <LogonType>InteractiveToken</LogonType>\n      <RunLevel>LeastPrivilege</RunLevel>')
    for (const setting of ['<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', '<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>', '<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>', '<Hidden>true</Hidden>', '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>']) expect(task).toContain(setting)
    expect(task).toContain(`      <Command>C:\\Program Files\\nodejs\\node.exe</Command>
      <Arguments>C:\\Users\\Owner\\AppData\\Roaming\\npm\\node_modules\\@5straps\\buckle\\dist\\main.js serve --background --service task-scheduler --state-dir C:\\Users\\Owner\\.5straps\\buckle</Arguments>
      <WorkingDirectory>C:\\Users\\Owner\\.5straps\\buckle</WorkingDirectory>`)
    expect(task).toContain(`<Source>5straps Buckle sha256:${stateDigest(DEFINITION.stateDirectory)}</Source>`)
    expect(task).not.toMatch(/cmd\.exe|powershell/i)
  })

  it('quotes an argument with a space, names the environment file, escapes XML, and reads it all back', () => {
    const odd = { ...DEFINITION, main: 'C:/Program Files/Buckle & Co/dist/main.js', stateDirectory: 'D:/Owner <state>/', environmentFile: 'D:/Owner state/node.env' }
    const task = renderTask(odd)
    expect(task).toContain('<Arguments>&quot;C:\\Program Files\\Buckle &amp; Co\\dist\\main.js&quot; serve --background --service task-scheduler --state-dir &quot;D:\\Owner &lt;state&gt;\\\\&quot; --env-file &quot;D:\\Owner state\\node.env&quot;</Arguments>')
    expect(readTask(task)).toEqual({ node: DEFINITION.node, main: 'C:\\Program Files\\Buckle & Co\\dist\\main.js', source: `5straps Buckle sha256:${stateDigest(odd.stateDirectory)}`, enabled: true })
  })

  it.each([
    ['plain', 'plain'],
    ['with space', '"with space"'],
    ['C:\\dir\\', 'C:\\dir\\'],
    ['C:\\my dir\\', '"C:\\my dir\\\\"'],
    ['say "hi"', '"say \\"hi\\""'],
    ['back\\"quote', '"back\\\\\\"quote"'],
    ['', '""'],
  ])('quotes %j as the C runtime splits it, and splits it back', (argument, quoted) => {
    expect(windowsArgument(argument)).toBe(quoted)
    expect(windowsArguments(`${quoted} next`)).toEqual([argument, 'next'])
  })

  it('is written as UTF-16 with its byte order mark, and read back from it or from UTF-8', () => {
    const bytes = taskFileBytes('<Task>é</Task>')
    expect([...bytes.subarray(0, 4)]).toEqual([0xff, 0xfe, 0x3c, 0x00])
    expect(taskFileText(bytes)).toBe('<Task>é</Task>')
    expect(taskFileText(Buffer.from('\uFEFF<Task/>', 'utf8'))).toBe('<Task/>')
  })

  it('finds schtasks.exe under SystemRoot by absolute path, in any case of the name, and nowhere else', () => {
    expect(schtasksPath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\schtasks.exe')
    expect(schtasksPath({ SYSTEMROOT: 'D:/WINDOWS/' })).toBe('D:\\WINDOWS\\System32\\schtasks.exe')
    expect(schtasksPath({ SystemRoot: 'Windows' })).toBeNull()
    expect(schtasksPath({ PATH: 'C:\\Windows\\System32' })).toBeNull()
  })
})

interface Recorder { calls: ProcessRequest[]; run(request: ProcessRequest): Promise<ProcessResult> }

/** A runner that records each schtasks.exe call and answers /Query with the task last created, as Task Scheduler would. */
function taskScheduler(options: { fail?: string; queried?: (xml: string) => string } = {}): Recorder {
  const calls: ProcessRequest[] = []
  let task: string | null = null
  const answer = (exitCode: number, stdout = ''): ProcessResult => ({ exitCode, signal: null, stdout, stderr: '', truncated: false, timedOut: false })
  return {
    calls,
    async run(request) {
      calls.push(request)
      const [verb] = request.args
      if (verb === options.fail) return answer(1)
      if (verb === '/Create') task = taskFileText(readFileSync(request.args[request.args.indexOf('/XML') + 1]!.replaceAll('\\', '/')))
      if (verb === '/Delete') task = null
      if (verb === '/Query') return task === null ? answer(1) : answer(0, options.queried ? options.queried(task) : task)
      return answer(0)
    },
  }
}

function windowsNode(): { root: string; state: string; environment: NodeJS.ProcessEnv } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buckle-task-scheduler-')))
  const state = join(root, 'state')
  mkdirSync(state)
  writeFileSync(join(state, 'buckle.env'), 'BUCKLE_ADMIN_TOKEN=file-admin-fixture\n')
  // The shell's environment, with what a careless owner sets: none of it may reach schtasks.exe.
  return { root, state, environment: { SystemRoot: 'C:\\Windows', USERNAME: 'Owner', USERDOMAIN: 'DESKTOP-1', Path: 'C:\\Windows\\System32', USERPROFILE: root, BUCKLE_STATE_DIR: state, BUCKLE_ADMIN_TOKEN: 'shell-admin-fixture', GITHUB_TOKEN: 'shell-forge-fixture' } }
}

describe('schtasks.exe, imitated', () => {
  it('creates the task from its XML kept in the state directory, runs it with now, and passes schtasks.exe no credential', async () => {
    const node = windowsNode()
    const scheduler = taskScheduler()
    const manager = createTaskSchedulerManager({ environment: node.environment, run: request => scheduler.run(request), location: { stateDirectory: node.state, environmentFile: null } })
    expect(await manager.unavailable()).toBeNull()
    await manager.install({ ...DEFINITION, stateDirectory: node.state }, { now: true })
    const copy = join(node.state, 'service', 'task.xml')
    expect(readFileSync(copy).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
    expect(scheduler.calls.map(call => [call.command, ...call.args])).toEqual([
      ['C:\\Windows\\System32\\schtasks.exe', '/Create', '/TN', TASK_NAME, '/XML', copy.replaceAll('/', '\\'), '/F'],
      ['C:\\Windows\\System32\\schtasks.exe', '/Run', '/TN', TASK_NAME],
    ])
    for (const call of scheduler.calls) {
      expect(call.environment).toMatchObject({ SystemRoot: 'C:\\Windows', USERNAME: 'Owner', Path: 'C:\\Windows\\System32' })
      expect(JSON.stringify(call.environment)).not.toMatch(/fixture|BUCKLE_/)
    }
    expect(await manager.installed()).toEqual({ node: DEFINITION.node, main: windowsPathOf(DEFINITION.main), thisNode: true, enabled: true })
  })

  it('reads the task through output a console wrote as UTF-16, and tells another node\'s task apart without reading its paths', async () => {
    const node = windowsNode()
    const asUtf16 = (xml: string) => Buffer.from(xml, 'utf16le').toString('utf8')
    const scheduler = taskScheduler({ queried: asUtf16 })
    const manager = createTaskSchedulerManager({ environment: node.environment, run: request => scheduler.run(request), location: { stateDirectory: node.state, environmentFile: null } })
    await manager.install({ ...DEFINITION, stateDirectory: node.state }, { now: false })
    expect(await manager.installed()).toMatchObject({ thisNode: true, enabled: true })
    const other = createTaskSchedulerManager({ environment: node.environment, run: request => scheduler.run(request), location: { stateDirectory: join(node.root, 'other'), environmentFile: null } })
    expect(await other.installed()).toEqual({ node: null, main: null, thisNode: false, enabled: true })
  })

  it('deletes the task and its copy, starts it with /Run, and has no stop of its own, as Task Scheduler delivers no SIGTERM', async () => {
    const node = windowsNode()
    const scheduler = taskScheduler()
    const manager = createTaskSchedulerManager({ environment: node.environment, run: request => scheduler.run(request), location: { stateDirectory: node.state, environmentFile: null } })
    await manager.install({ ...DEFINITION, stateDirectory: node.state }, { now: false })
    await manager.start()
    await manager.uninstall()
    expect(existsSync(join(node.state, 'service', 'task.xml'))).toBe(false)
    expect(await manager.installed()).toBeNull()
    expect(manager.stop).toBeUndefined()
    expect(scheduler.calls.map(call => call.args[0])).toEqual(['/Create', '/Run', '/Delete', '/Query'])
  })

  it('says why it cannot install without SystemRoot or USERNAME, and why a schtasks.exe call failed, naming no path', async () => {
    const node = windowsNode()
    const { SystemRoot: _root, ...noRoot } = node.environment
    const { USERNAME: _user, ...noUser } = node.environment
    const location = { stateDirectory: node.state, environmentFile: null }
    expect(await createTaskSchedulerManager({ environment: noRoot, run: taskScheduler().run, location }).unavailable()).toBe('Windows names no SystemRoot here, so Buckle cannot find schtasks.exe')
    expect(await createTaskSchedulerManager({ environment: noUser, run: taskScheduler().run, location }).unavailable()).toBe('Windows does not say who is signed in here (USERNAME is not set), and the task starts at that person\'s logon')
    const failing = taskScheduler({ fail: '/Create' })
    await expect(createTaskSchedulerManager({ environment: node.environment, run: request => failing.run(request), location }).install({ ...DEFINITION, stateDirectory: node.state }, { now: false }))
      .rejects.toThrow(new ServiceManagerError('schtasks.exe /Create for the task \\5straps\\Buckle failed (exit code 1); Task Scheduler\'s history for the task says why'))
  })
})

describe('the service manager each platform has', () => {
  it('is Task Scheduler on Windows and the systemd user manager on Linux', () => {
    const context = { environment: {}, run: taskScheduler().run, location: { stateDirectory: '/srv/state', environmentFile: null } }
    expect(serviceManagerFor({ ...context, platform: 'win32' })?.label).toBe('the Task Scheduler task \\5straps\\Buckle')
    expect(serviceManagerFor({ ...context, platform: 'linux' })?.label).toBe('the systemd user unit buckle.service')
  })
})

describe('buckle service on Windows, imitated', () => {
  it('installs the task for this node, and refuses a second node\'s, naming neither state directory', async () => {
    const node = windowsNode()
    const scheduler = taskScheduler()
    const main = join(node.root, 'dist', 'main.js')
    mkdirSync(join(node.root, 'dist'))
    writeFileSync(main, '')
    const run = async (environment: NodeJS.ProcessEnv, argv: string[]) => {
      let out = ''
      let err = ''
      const result = await serviceCommand({ argv, environment, platform: 'win32', cwd: node.root, run: request => scheduler.run(request), mainScript: main,
        manager: location => createTaskSchedulerManager({ environment, run: request => scheduler.run(request), location }), out: text => { out += text }, err: text => { err += text } })
      return { ...result, out, err }
    }
    expect(await run(node.environment, ['install'])).toMatchObject({ exitCode: 0, out: 'Installed the Buckle service (the Task Scheduler task \\5straps\\Buckle); it starts at every login. Start it now with buckle service start.\n' })
    const other = join(node.root, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'buckle.env'), '')
    const refused = await run({ ...node.environment, BUCKLE_STATE_DIR: other }, ['install'])
    expect(refused).toMatchObject({ exitCode: 1, err: 'A Buckle service for another state directory is installed, and this machine runs one service. Remove it with buckle service uninstall, then install this node\'s.\n' })
  })
})

function windowsPathOf(path: string): string {
  return path.replaceAll('/', '\\')
}
