// A cold Node process compiling TypeScript through tsx takes seconds, and the
// whole workspace runs its tests in parallel. Give any test that spawns such
// a process this generous timeout instead of vitest's 5000ms default.
export const SPAWN_TEST_TIMEOUT_MS = 60_000
