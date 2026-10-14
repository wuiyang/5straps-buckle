# Third-party notices

The build of `@5straps/buckle` bundles code from the packages below into its `.output` server.
Each is published under the MIT License, whose text follows the list. Every other dependency
is installed from npm and is not copied into this package. Each carries its own license file,
except the code mode packages named below, whose notices this file keeps.

| Package | Version | License | Copyright |
|---|---|---|---|
| hookable | 6.1.1 | MIT | Copyright (c) Pooya Parsa <pooya@pi0.io> |
| nitro | 3.0.260903-beta | MIT | Copyright (c) Pooya Parsa <pooya@pi0.io> and Nitro contributors |
| rou3 | 0.9.2 | MIT | Copyright (c) Pooya Parsa <pooya@pi0.io> |
| srvx | 1.0.5 | MIT | Copyright (c) Pooya Parsa <pooya@pi0.io> |

The nitro package carries the notices of the code it bundles itself in
`dist/THIRD-PARTY-LICENSES.md` inside its npm package.

Code mode runs an agent's script in the packages below. They are not bundled: npm installs them
beside `@5straps/buckle`, which loads them from there. Their notices are kept here because the
pi-codemode npm package ships no license file, and the quickjs-wasi package ships its own notice
but not the engine's. Each is published under the MIT License, whose text follows.

| Package | Version | License | Copyright |
|---|---|---|---|
| @earendil-works/pi-codemode | 1.2.0 | MIT | Copyright (c) 2025 Mario Zechner |
| quickjs-wasi | 3.6.2 | MIT | Copyright (c) 2026 Vercel, Inc. |
| QuickJS-NG, the JavaScript engine compiled into quickjs-wasi's `quickjs.wasm` | 0.17.0, as built into quickjs-wasi 3.6.2 | MIT | Copyright (c) 2017-2026 Fabrice Bellard; Copyright (c) 2017-2024 Charlie Gordon; Copyright (c) 2023-2026 Ben Noordhuis; Copyright (c) 2023-2026 Saúl Ibarra Corretgé |

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
