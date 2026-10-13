import { createReadStream, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { seams as baseSeams } from '@agnes/base'
import { createTestHost } from '@agnes/host/testkit'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { buildRuntimeTarget, createPluginRow } from '@agnes/plugin-runtime/host'

// Real worker/Host/plugin/storage; only the physical robot transport is substituted.
const akaEntry = '../../../examples/packages/aka-robot-plugin/index.js'
const httpEntry = '../../../examples/packages/aka-robot-plugin/src/http-driver.js'
const controlEntry = '../../../examples/packages/aka-robot-plugin/src/control-channel.js'
const { runtime } = await import(akaEntry)
const { AkaHttpDriver } = await import(httpEntry)
const { AkaControlChannel } = await import(controlEntry)
const image = readFileSync(new URL('../../host/test/fixtures/aka-camera-test.jpg', import.meta.url))
AkaHttpDriver.prototype.heartbeat = async () => ({
  service: 'AKA-00',
  identity: { macAddress: '12:34:56:78:90:ab', validity: 'reported' },
})
let cameraOpen = false
AkaHttpDriver.prototype.cameraStatus = async () => cameraOpen
AkaHttpDriver.prototype.setCamera = async (open: boolean) => {
  cameraOpen = open
  return cameraOpen
}
AkaControlChannel.prototype.open = async () => undefined
AkaHttpDriver.prototype.stream = (_url: string, signal: AbortSignal, receive: (frame: unknown) => void) =>
  new Promise<void>((resolve) => {
    const timer = setInterval(() => receive({ bytes: image, width: 320, height: 240 }), 50)
    const stop = () => {
      clearInterval(timer)
      resolve()
    }
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })

const env = { ...process.env }
delete process.env.AGNES_WORKER_TOKEN
const { runWorker } = await import('../src/worker/main.js')
const gateFd = Number(env.AGNES_GATE_FD ?? 3)
const gate = Number.isInteger(gateFd) && gateFd >= 0 ? createReadStream('', { fd: gateFd }) : null
const rowId = 'ext:agnes-examples/aka-robot'
const packageId = '@agnes-examples/aka-robot-plugin'
const snapshotId = `sha256-${'7'.repeat(64)}`
void runWorker(
  env,
  {
    connect: (path) =>
      new Promise((resolve, reject) => {
        const socket = connect(path)
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      }),
    gate,
  },
  {
    buildHost: async (profile, _prompter, resources) => {
      if (
        !resources.serviceAuthority ||
        !resources.deviceSession ||
        !resources.deviceSessionRetain ||
        !resources.deviceCaptureSelection
      )
        throw new Error('Missing production capture ports')
      const directory = `${profile.dataDir}/aka-package`
      const source: RuntimePluginSnapshot = {
        snapshot: {
          snapshotId,
          profile: 'local-dev',
          packageId,
          version: '0.1.0',
          integrity: snapshotId,
          treeIntegrity: hashDirectory(directory, { exclude: [] }),
          capabilityHash: 'fixture',
          directory,
          contributions: [],
        },
        generation: 1,
        trusted: true,
      }
      const { host } = await createTestHost({
        dataDir: profile.dataDir,
        script: [],
        disableSessionTitle: true,
        runtimePluginCatalogue: [source],
        extensionLoader: { import: async () => ({ runtime }) },
        serviceAuthority: resources.serviceAuthority,
        deviceSession: resources.deviceSession,
        deviceSessionRetain: resources.deviceSessionRetain,
        deviceCaptureSelection: resources.deviceCaptureSelection,
        seamFactories: { artifacts: baseSeams.artifacts },
        seams: {
          principals: {
            resolve: async () => ({ id: 'owner', org: 'test', role: 'owner', deptPath: [], attrs: {} }),
          },
        },
      })
      const result = await host.applyRuntimeTarget(
        buildRuntimeTarget({
          rows: [
            createPluginRow({
              id: rowId,
              inject: ['extension'],
              plugin: `${packageId}@${snapshotId}/runtime`,
              snapshotDigest: snapshotId,
              exportName: 'runtime',
              entryRevision: snapshotId,
              extrasRevision: 'none',
              mountRevision: 'aka-capture-fixture:v1',
              config: { devices: [] },
            }),
          ],
          resources: { mcp: [], skills: {} },
          resourceRevision: '0'.repeat(64),
          compositeRevision: '0'.repeat(64),
        }),
      )
      if (!result.ok) throw new Error('AKA fixture row failed to mount')
      return host
    },
  },
).catch((error) => {
  console.error('AKA capture worker failed to start:', error)
  process.exit(1)
})
