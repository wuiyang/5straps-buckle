// Test-only fault switches, read when plugins run (after import, never at module load).
export function activeFaults(): string[] {
  return (process.env.FIXTURE_FAULTS ?? '').split(',').filter(Boolean)
}
