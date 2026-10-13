import { createMountProxy, type MountProxyMatch, matchMount } from '@agnes/daemon'
import { createClient, memoryJournal } from '@agnes/sdk'
import { localPipeFactories } from '../src/boot/pipe-factory.js'
import type { LocalBackend } from './backend.js'

type MountProxyLookup = Parameters<typeof createMountProxy>[0]['lookup']

/** Background refresh cadence; one reusable authenticated connection per feed. */
export const SURFACE_MOUNT_REFRESH_MS = 8_000

/** Reserved URL prefixes the Web server answers with its own fixed branches (design WC3): the admin
 *  surfaces, the skin asset route and the client module asset route. A Surface mount at or under one
 *  of these could never receive traffic anyway (every fixed branch returns before mountProxy is
 *  consulted), so the rows are dropped from the fetched table instead of being proxied -- this turns
 *  what used to be a comment convention in `packages/web-server/src/server.ts` into an enforced rule. */
const RESERVED_MOUNT_PREFIXES = ['/plugins', '/admin', '/skins'] as const

/** True when a Surface mount prefix collides with a reserved Web server namespace. */
export function isReservedMount(mount: string): boolean {
  return RESERVED_MOUNT_PREFIXES.some((prefix) => mount === prefix || mount.startsWith(`${prefix}/`))
}

export type SurfaceMountFeed = Readonly<{
  lookup: MountProxyLookup
  /** Stops the refresh ticker. Idempotent; safe to call before the first fetch resolved. */
  close(): Promise<void>
}>

/**
 * Bridges `createMountProxy`'s synchronous lookup() across the OS-process boundary between `agnesd`
 * and `agh serve` (see packages/daemon/src/local/methods/surfaces.ts for the RPC method this calls,
 * and the design note at packages/daemon/src/surfaces/mount-proxy.ts for why a closure alone cannot
 * do this in production).
 *
 * Reuses a private SDK connection. The SDK reauthenticates on transport reconnection; a failed
 * refresh retires the client and retries with bounded backoff. Polls never overlap.
 *
 * Fails soft in both directions: an unreachable daemon or a query error on the very first fetch leaves
 * the lookup answering "no mount" for every path, the same degraded-but-serving behavior
 * `boot-coordination.ts`'s `coordinateSurfacesOnBoot` has when no deploy directory was ever trusted.
 * A LATER poll failing (after at least one success) keeps serving the last known-good table rather
 * than blanking out a page the user is currently viewing -- a transient daemon hiccup must not look
 * like every Surface vanished. Web itself remains reachable either way.
 */
export async function fetchSurfaceMountLookup(
  backend: LocalBackend,
  options: Readonly<{ intervalMs?: number; waitForInitial?: boolean }> = {},
): Promise<SurfaceMountFeed> {
  // `undefined` means "no successful fetch has ever landed" -- distinct from "the daemon reports an
  // empty table". Only a SUCCESSFUL fetch ever writes here: a later poll that throws must leave the
  // last-known-good table in place rather than blanking out a page the user is currently viewing.
  let mounts: readonly MountProxyMatch[] | undefined
  let inflight: Promise<void> | undefined
  let stopped = false
  let client: ReturnType<typeof createClient> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  const interval = options.intervalMs ?? SURFACE_MOUNT_REFRESH_MS

  const refresh = async (): Promise<void> => {
    client ??= createClient({
      transport: { kind: 'unix', path: backend.socketPath },
      transportFactories: localPipeFactories(backend.socketPath, backend.scope),
      auth: { kind: 'local' },
      journal: memoryJournal(`surface-mounts-${backend.scope.scopeID}`),
    })
    const current = client
    try {
      await current.initialize()
      const next = await current.surfaces.mounts()
      // M3 (final review, Minor): the Task-15 RPC row only ever carries {mount, host, port}; it used
      // to be padded with a fabricated `healthPath: ''` purely to satisfy createMountProxy's lookup()
      // return type, which has since been narrowed (mount-proxy.ts's `MountProxyMatch`) to exactly
      // this shape, so the padding is gone.
      if (!stopped) mounts = next.mounts.filter((row) => !isReservedMount(row.mount))
    } catch (error) {
      if (client === current) client = undefined
      await current.close().catch(() => undefined)
      throw error
    }
  }
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (inflight) return inflight
    inflight = refresh()
      .then(() => {
        if (failures && !stopped) console.info('agh serve: Surface mount table refresh recovered')
        failures = 0
      })
      .catch((error: unknown) => {
        if (stopped) return
        failures++
        if (failures !== 1) return
        console.error(
          mounts === undefined
            ? 'agh serve: could not read the Surface mount table; Surfaces will not be reachable'
            : 'agh serve: Surface mount table refresh failed; serving the last known table',
          error,
        )
      })
      .finally(() => {
        inflight = undefined
        if (!stopped) {
          timer = setTimeout(() => void tick(), Math.min(60_000, interval * 2 ** Math.min(failures, 4)))
          timer.unref()
        }
      })
    return inflight
  }

  const initial = tick()
  if (options.waitForInitial !== false) await initial
  return Object.freeze({
    // I3 (final review, Important): the match predicate itself comes from the shared `matchMount`
    // instead of being re-derived here.
    lookup: (pathname: string) => (mounts === undefined ? undefined : matchMount(mounts, pathname)),
    async close() {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      await client?.close().catch(() => undefined)
      client = undefined
      await inflight?.catch(() => undefined)
    },
  })
}

/** Convenience wrapper: `fetchSurfaceMountLookup` plus wiring the result into `createMountProxy`. */
export async function fetchSurfaceMountProxy(
  backend: LocalBackend,
  options: Readonly<{ intervalMs?: number; waitForInitial?: boolean }> = {},
): Promise<Readonly<{ proxy: ReturnType<typeof createMountProxy>; close(): Promise<void> }>> {
  const feed = await fetchSurfaceMountLookup(backend, options)
  return Object.freeze({ proxy: createMountProxy({ lookup: feed.lookup }), close: feed.close })
}
