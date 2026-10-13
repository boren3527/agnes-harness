import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('constructs cloud recognition SDKs from an isolated ESM distribution without installed SDK packages or network IO', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agh-recognition-bundle-'))
  try {
    const outfile = join(directory, 'recognition.mjs')
    await build({
      entryPoints: [fileURLToPath(new URL('../../host/src/adapters/ali-recognition.ts', import.meta.url))],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    })
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `globalThis.fetch = () => { throw new Error('Unexpected network IO') };
       const { createAliRecognitionPipeline } = await import(${JSON.stringify(pathToFileURL(outfile).href)});
       const pipeline = await createAliRecognitionPipeline({ accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret' });
       pipeline.close(); console.log('SDK construction passed');`,
      ],
      { windowsHide: true, timeout: 10000 },
    )
    expect(stdout.trim()).toBe('SDK construction passed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)
