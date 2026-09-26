import { fileURLToPath } from 'node:url'
import { defineConfig } from 'nitro'

// Absolute on purpose: the root config resolves relative scanDirs against its own rootDir.
export default defineConfig({ scanDirs: [fileURLToPath(new URL('./server', import.meta.url))] })
