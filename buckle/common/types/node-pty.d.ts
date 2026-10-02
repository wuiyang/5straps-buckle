// node-pty is an optional native dependency (see package.json). It may be entirely absent from
// node_modules on machines where its native build failed or was skipped, which otherwise makes
// `tsc` fail with "Cannot find module" wherever pty-process.ts imports it. This ambient fallback
// keeps that import resolvable at compile time in that case. TypeScript still prefers node-pty's
// own shipped types over this fallback whenever the package is actually installed.
declare module 'node-pty'
