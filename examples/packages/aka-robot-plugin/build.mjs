import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Reuse the repository's pinned build tool. Installed packages need no workspace resolver.
const require = createRequire(new URL('../../../packages/cli/package.json', import.meta.url))
const { build } = require('esbuild')
// Serve one browser module rather than serially verifying every source import over IPC.
await build({
  entryPoints: [fileURLToPath(new URL('client/index.js', import.meta.url))],
  outfile: fileURLToPath(new URL('client/bundle.js', import.meta.url)),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  external: ['react', 'react/*'],
  legalComments: 'eof',
})
await build({
  stdin: {
    contents: "export { runtime } from './src/plugin.ts'",
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    sourcefile: 'runtime-entry.ts',
  },
  outfile: fileURLToPath(new URL('runtime.cjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['@agnes/extension-api', '@agnes/protocol'],
  legalComments: 'eof',
})
