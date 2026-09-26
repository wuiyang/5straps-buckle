// Tiny Nitro app for the packaged smoke (F56): same preset, custom entry and external runtime as the fixture.
export default {
  preset: 'node_middleware',
  entry: './server/entry.mjs',
  serverEntry: false,
  serverDir: './',
  rolldownConfig: { external: [/^@5straps\/runtime(\/|$)/] },
}
