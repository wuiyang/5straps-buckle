export interface BuildInfo { commit: string; dirty: boolean; builtAt: string }
export const BUILD_INFO_FILE: string
export function readBuildInfo(input: { cwd: string; version: string; now?: () => Date }): BuildInfo | null
export function writeBuildInfo(outDir: string, info: BuildInfo | null): void
