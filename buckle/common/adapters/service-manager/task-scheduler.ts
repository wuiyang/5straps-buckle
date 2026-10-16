import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'pathe'
import { buildChildEnvironment } from '../../domain/environment.js'
import { realPathOf } from '../../runtime/config.js'
import type { ProcessRunner } from '../../types/ports/process-runner.js'
import { ServiceManagerError, type InstalledService, type NodeLocation, type ServiceDefinition, type ServiceManager } from '../../types/ports/service-manager.js'
import { SKIP_OWNER_ONLY_FLAG } from '../../domain/global-flags.js'
import { replaceFile } from '../json-file-store.js'
import { taskDefinitionCopy } from '../../services/node-service/serve-record.js'

/** The one Buckle task a machine has (Phase 3, Q4, D73 experimental), in a folder of its own in Task Scheduler. */
export const TASK_NAME = '\\5straps\\Buckle'
const QUICK_MS = 30_000
const SOURCE_PREFIX = '5straps Buckle sha256:'

/**
 * Where schtasks.exe is: %SystemRoot%\System32, by absolute path, so neither PATH nor the working directory chooses the
 * program, and no shell (Buckle never runs cmd.exe). Null where Windows names no SystemRoot on a drive.
 */
export function schtasksPath(environment: NodeJS.ProcessEnv): string | null {
  const root = variable(environment, 'SystemRoot')
  if (root === undefined || !/^[A-Za-z]:[\\/]/.test(root)) return null
  return `${root.replace(/[\\/]+$/, '').replaceAll('/', '\\')}\\System32\\schtasks.exe`
}

/** A variable as Windows reads one, its name in any case. */
function variable(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(environment).find(candidate => candidate.toUpperCase() === name.toUpperCase())
  return key === undefined ? undefined : environment[key]
}

/** A path in Windows' own form, as Task Scheduler and node.exe read one. */
function windowsPath(path: string): string {
  return path.replaceAll('/', '\\')
}

/**
 * One argument as the Microsoft C runtime splits a command line (CommandLineToArgvW), which node.exe uses: quoted where
 * it holds a space, a tab, or a quote, with the backslashes before a quote, or before the closing one, doubled.
 */
export function windowsArgument(argument: string): string {
  if (argument !== '' && !/[ \t\n\v"]/.test(argument)) return argument
  let quoted = '"'
  let backslashes = 0
  for (const character of argument) {
    if (character === '\\') { backslashes += 1; continue }
    quoted += character === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${character}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** A command line split as the Microsoft C runtime splits one: the inverse of windowsArgument. */
export function windowsArguments(line: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!
    if (character === '\\') {
      let count = 0
      while (line[index] === '\\') { count += 1; index += 1 }
      if (line[index] === '"') {
        word += '\\'.repeat(Math.floor(count / 2))
        if (count % 2 === 1) word += '"'
        else { quoted = !quoted; }
        inWord = true
      } else {
        word += '\\'.repeat(count)
        index -= 1
        inWord = true
      }
      continue
    }
    if (character === '"') { quoted = !quoted; inWord = true; continue }
    if (!quoted && (character === ' ' || character === '\t')) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
      continue
    }
    word += character
    inWord = true
  }
  if (inWord) words.push(word)
  return words
}

function xml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function unxml(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
}

/**
 * A digest of where the state directory really is, which the task carries as its Source: whether the machine's task is
 * this node's is told without reading a path back through schtasks.exe's output, whose encoding the console chooses.
 */
export function stateDigest(stateDirectory: string): string {
  return createHash('sha256').update(realPathOf(stateDirectory, 'win32').toLowerCase()).digest('hex').slice(0, 32)
}

/**
 * The task (Phase 3, item 3): at the owner's logon, with the owner's interactive token and least privilege, so mapped
 * drives and the desktop are there (Q8, Q10); no execution time limit and no battery rule, which would stop a node left
 * running; hidden from the Task Scheduler list. Its action runs node.exe as the Command and main.js with `serve
 * --background` as the Arguments, separate, so nothing parses a command string and no shell runs: that start detaches
 * the node with no console window and ends, and the node stops on a stop request, as Task Scheduler delivers no SIGTERM.
 */
export function renderTask(definition: ServiceDefinition & { userId: string }): string {
  const args = [windowsPath(definition.main), 'serve', '--background', '--service', 'task-scheduler', '--state-dir', windowsPath(definition.stateDirectory),
    ...(definition.environmentFile ? ['--env-file', windowsPath(definition.environmentFile)] : []), ...(definition.skipOwnerOnlyCheck ? [SKIP_OWNER_ONLY_FLAG] : [])]
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>5straps Buckle, the local permission node. Written by buckle service install; buckle service uninstall removes it.</Description>
    <Source>${SOURCE_PREFIX}${stateDigest(definition.stateDirectory)}</Source>
    <URI>${xml(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(definition.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(definition.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(windowsPath(definition.node))}</Command>
      <Arguments>${xml(args.map(windowsArgument).join(' '))}</Arguments>
      <WorkingDirectory>${xml(windowsPath(definition.stateDirectory))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** The text of an element's first occurrence inside `within` (or the whole document), or null. */
function element(text: string, name: string, within?: string): string | null {
  const scope = within === undefined ? text : new RegExp(`<${within}\\b[^>]*>([\\s\\S]*?)</${within}>`).exec(text)?.[1]
  if (scope === undefined) return null
  const found = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(scope)?.[1]
  return found === undefined ? null : unxml(found.trim())
}

/** What a task Buckle wrote runs, read back from its XML. */
export function readTask(text: string): { node: string | null; main: string | null; source: string | null; enabled: boolean; skipsOwnerOnlyCheck: boolean } {
  const args = element(text, 'Arguments', 'Exec')
  return {
    node: element(text, 'Command', 'Exec'),
    main: args === null ? null : windowsArguments(args)[0] ?? null,
    skipsOwnerOnlyCheck: args !== null && windowsArguments(args).includes(SKIP_OWNER_ONLY_FLAG),
    source: element(text, 'Source', 'RegistrationInfo'),
    enabled: element(text, 'Enabled', 'Settings') !== 'false',
  }
}

/** UTF-16 with its byte order mark, as Task Scheduler reads a definition. */
export function taskFileBytes(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

/** A definition's text, from UTF-16 with a byte order mark or from UTF-8, as schtasks.exe or this module wrote it. */
export function taskFileText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  return bytes.toString('utf8').replace(/^﻿/, '')
}

/**
 * Windows' service manager (Phase 3, item 3; D73, experimental): Task Scheduler, driven through schtasks.exe by its
 * absolute path under %SystemRoot%, with no shell and the fixed list of variables every child gets. It has no stop of
 * its own: the node is asked to stop through its stop request.
 */
export function createTaskSchedulerManager(input: { environment: NodeJS.ProcessEnv; run: ProcessRunner; location: NodeLocation }): ServiceManager {
  const environment = buildChildEnvironment({ parent: input.environment, extra: {}, platform: 'win32' })
  const copy = taskDefinitionCopy(input.location.stateDirectory)

  async function schtasks(args: string[]): Promise<{ exitCode: number | null; stdout: string }> {
    const program = schtasksPath(input.environment)
    if (program === null) throw new ServiceManagerError('Windows names no SystemRoot here, so Buckle cannot find schtasks.exe')
    try {
      const result = await input.run({ command: program, args, cwd: windowsPath(input.location.stateDirectory), timeoutMs: QUICK_MS, environment })
      return { exitCode: result.exitCode, stdout: result.stdout }
    } catch (error) {
      throw new ServiceManagerError(`schtasks.exe could not run (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`)
    }
  }

  async function required(args: string[]): Promise<void> {
    const result = await schtasks(args)
    if (result.exitCode !== 0) throw new ServiceManagerError(`schtasks.exe ${args[0]} for the task ${TASK_NAME} failed (exit code ${result.exitCode ?? 'none'}); Task Scheduler's history for the task says why`)
  }

  return {
    kind: 'task-scheduler',
    label: `the Task Scheduler task ${TASK_NAME}`,
    async unavailable() {
      if (schtasksPath(input.environment) === null) return 'Windows names no SystemRoot here, so Buckle cannot find schtasks.exe'
      if (!variable(input.environment, 'USERNAME')) return 'Windows does not say who is signed in here (USERNAME is not set), and the task starts at that person\'s logon'
      return null
    },
    async installed(): Promise<InstalledService | null> {
      const queried = await schtasks(['/Query', '/TN', TASK_NAME, '/XML'])
      if (queried.exitCode !== 0) return null
      // The console chooses schtasks.exe's encoding: UTF-16 read as UTF-8 leaves its ASCII with a NUL after each
      // character, which is all this reads (the Source digest and the Enabled flag). Paths come from the copy kept here.
      const task = readTask(queried.stdout.replaceAll('\u0000', '').replace(/^﻿/, ''))
      const thisNode = task.source === null ? null : task.source === `${SOURCE_PREFIX}${stateDigest(input.location.stateDirectory)}`
      const own = thisNode === true && existsSync(copy) ? readTask(taskFileText(readFileSync(copy))) : null
      return { node: own?.node ?? null, main: own?.main ?? null, thisNode, enabled: task.enabled, ...(own?.skipsOwnerOnlyCheck ? { skipsOwnerOnlyCheck: true } : {}) }
    },
    async install(definition, options) {
      const userId = [variable(input.environment, 'USERDOMAIN'), variable(input.environment, 'USERNAME')].filter(Boolean).join('\\')
      const text = renderTask({ ...definition, userId })
      mkdirSync(join(input.location.stateDirectory, 'service'), { recursive: true, mode: 0o700 })
      const temporary = `${copy}.${randomUUID()}.tmp`
      try {
        writeFileSync(temporary, taskFileBytes(text), { mode: 0o600, flag: 'wx' })
        await replaceFile(temporary, copy)
      } finally {
        rmSync(temporary, { force: true })
      }
      await required(['/Create', '/TN', TASK_NAME, '/XML', windowsPath(copy), '/F'])
      if (options.now) await required(['/Run', '/TN', TASK_NAME])
    },
    async uninstall() {
      await required(['/Delete', '/TN', TASK_NAME, '/F'])
      rmSync(copy, { force: true })
    },
    start: () => required(['/Run', '/TN', TASK_NAME]),
  }
}
