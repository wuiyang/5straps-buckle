import { expect, it } from 'vitest'
import { historyCapturePath } from '../common/services/history/capture-hashes.js'

it('normalizes native Windows drive and share keys to the history path form', () => {
  expect(historyCapturePath({ path: 'C:\\workspace\\folder\\file', platform: 'win32' })).toBe('C:/workspace/folder/file')
  expect(historyCapturePath({ path: '\\\\server\\share\\folder', platform: 'win32' })).toBe('//server/share/folder')
})
it('preserves literal backslash names on POSIX hosts', () => {
  expect(historyCapturePath({ path: '/workspace/name\\part', platform: 'linux' })).toBe('/workspace/name\\part')
})
