// agh-blender: drive a local Blender from Agnes Harness.
//
// The plugin starts Blender itself (no add-on, nothing installed into Blender), talks to a
// loopback bridge inside that process, and can only ask it to perform operations declared in a
// fixed whitelist. There is no endpoint that runs arbitrary Python.
//
// What this file is careful about, and why (all of it measured on this machine):
//   * the launch argv goes through tctx.sandbox.confine() before spawning; enforcement is reported
//     as it actually is (partial/file), never as confinement we do not have,
//   * the per-instance token travels only in the child's environment and is kept only in daemon
//     memory, so a plugin reload orphans a running Blender on purpose,
//   * PowerShell payloads travel inline via -EncodedCommand, because a script path outside the
//     workspace under a file-scoped confine timed out (P0-F163),
//   * every side-effecting tool lands its report on disk before returning: the harness replaces a
//     slow mutating call's result with TOOL_OUTCOME_UNKNOWN (P0-F58, P0-F164),
//   * tool schemas are normalised with tb(): TypeBox needs a Kind marker on every node, while
//     service schemas must stay plain JSON, because JCS rejects symbol keys (P0-F141 family).

import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishCapture } from './capture-artifact.mjs'

const MODULE_ID = randomUUID()
const workspaces = new Map()
const recentCalls = []

function normalizeCwd(cwd) {
  const raw = typeof cwd === 'string' && cwd.length > 0 ? cwd : 'unknown'
  return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function workspaceFor(cwd) {
  const key = normalizeCwd(cwd)
  let entry = workspaces.get(key)
  if (entry === undefined) {
    entry = {
      key,
      counter: 0,
      bumps: 0,
      serviceReads: 0,
      toolReads: 0,
      firstSeenAt: new Date().toISOString(),
    }
    workspaces.set(key, entry)
  }
  return entry
}

function note(kind, key) {
  recentCalls.push({ at: new Date().toISOString(), kind, key })
  while (recentCalls.length > 20) recentCalls.shift()
}

function describe(entry, extra) {
  return {
    moduleId: MODULE_ID,
    workspaceKey: entry.key,
    counter: entry.counter,
    bumps: entry.bumps,
    serviceReads: entry.serviceReads,
    toolReads: entry.toolReads,
    workspaceCount: workspaces.size,
    knownWorkspaces: [...workspaces.keys()],
    recentCalls: recentCalls.slice(-5),
    ...(extra ?? {}),
  }
}

const TB_KIND = Symbol.for('TypeBox.Kind')

// TypeBox resolves each schema node from a `Symbol.for('TypeBox.Kind')` marker. A hand-written node
// without one makes Value.Check throw "Unknown type", and the kernel swallows that into a bare
// TOOL_ARGS_INVALID with no hint — exactly what blocked every tool in 0.5.0 after the harness update
// added strict argument checking. Normalizing here means a hand-written schema is still checkable.
const TB_KINDS = {
  object: 'Object',
  array: 'Array',
  string: 'String',
  number: 'Number',
  integer: 'Integer',
  boolean: 'Boolean',
  null: 'Null',
}

function tb(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  const out = { ...node }
  if (out.type === 'object' && out.properties === undefined) {
    // TypeBox throws "Cannot convert undefined or null to object" when an object node has no
    // `properties`. A node written as just { type: 'object' } means "any object" — spell out the
    // empty property map so the check can run instead of refusing every payload.
    out.properties = {}
  }
  const kind = typeof node.type === 'string' ? TB_KINDS[node.type] : undefined
  if (kind !== undefined && out[TB_KIND] === undefined) out[TB_KIND] = kind
  if (node.properties !== undefined) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([key, value]) => [key, tb(value)]),
    )
  }
  if (node.items !== undefined) out.items = tb(node.items)
  for (const branch of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[branch])) out[branch] = node[branch].map(tb)
  }
  return out
}

// Service schemas are canonicalised with JCS (RFC 8785), which rejects symbol keys as invalid
// input — so these stay plain JSON. Tool schemas need the opposite (see tb): the kernel checks
// tool arguments with TypeBox, which needs a Kind marker on every node. tb() marks a copy.
const EMPTY_INPUT = { type: 'object', properties: {}, required: [], additionalProperties: false }

const ENVELOPE_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    data: { type: 'object', additionalProperties: true },
  },
  required: ['ok'],
  additionalProperties: false,
}

export const runtime = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()

    // Every registered tool schema goes through tb(), so a hand-written node can never reach the
    // kernel unmarked (see the note on tb above).
    const registerTool = (definition) =>
      agnes.registerTool({ ...definition, parameters: tb(definition.parameters) })

    // ---------- query: managed instance status (the panel reads this) ----------
    ctx.services.register({
      name: 'blender.status',
      kind: 'query',
      inputSchema: EMPTY_INPUT,
      outputSchema: ENVELOPE_OUTPUT,
      // Room for one bridge round trip: the handler reads the scene when the instance is alive, so
      // the panel shows what Blender actually holds instead of only "a process exists".
      timeoutMs: 2500,
      maxResultBytes: 32768,
      async handler(_input, sctx) {
        const key = normalizeCwd(sctx?.cwd)
        const record = instances.get(key) ?? null
        const alive = record === null ? false : pidAlive(record.pid)
        const data = {
          moduleId: MODULE_ID,
          workspaceKey: key,
          cwd: sctx?.cwd ?? null,
          instance: record
            ? {
                pid: record.pid,
                port: record.port,
                instanceId: record.instanceId,
                blenderVersion: record.blenderVersion,
                alive,
              }
            : null,
          scene: null,
          sceneError: null,
        }
        if (record && alive) {
          // A service context has no net seam (that belongs to tools), so this is a plain fetch.
          // Kept to a compact summary: the full scene payload would blow the result budget on a
          // large file, and the panel only needs the shape of it.
          try {
            const response = await fetch(`http://127.0.0.1:${record.port}/scene`, {
              method: 'POST',
              headers: { 'X-AGH-Token': record.token, 'Content-Type': 'application/json' },
              body: '{}',
              signal: AbortSignal.timeout(1500),
            })
            const body = await response.json().catch(() => null)
            const scene = body?.scene ?? null
            if (scene) {
              const objects = Array.isArray(scene.objects) ? scene.objects : []
              data.scene = {
                scene: scene.scene,
                objectCount: scene.objectCount ?? objects.length,
                meshCount: objects.filter((item) => item?.type === 'MESH').length,
                materialCount: Array.isArray(scene.materials) ? scene.materials.length : 0,
                knownOps: Array.isArray(scene.knownOps) ? scene.knownOps.length : 0,
              }
            } else {
              data.sceneError = body?.detail ?? body?.error ?? `HTTP ${response.status}`
            }
          } catch (error) {
            data.sceneError = String(error?.message ?? error)
          }
        }
        return { ok: true, data }
      },
    })

    // ==================== P0-3：Blender 启动链（发现 → confine → spawn → 握手） ====================

    const BRIDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'bridge')
    // Node-side process helpers. Deliberately NOT under bridge/: that directory is
    // GPL-declared because its scripts call bpy, while these are invoked from the
    // Apache-2.0 side and need no bpy at all.
    const BOOTSTRAP_PY = join(BRIDGE_DIR, 'bootstrap.py')
    const MANAGED_DIR_NAME = '.agh-blender'
    const BRIDGE_PROTOCOL = 1
    const MIN_BLENDER = [4, 2]
    const instances = new Map()

    const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

    function readJsonFile(path) {
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        return null
      }
    }

    function writeJsonFile(path, value) {
      const temp = `${path}.tmp`
      writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      renameSync(temp, path)
    }

    function readFileSafe(path) {
      try {
        return readFileSync(path, 'utf8').split(/\r?\n/).slice(-25).join('\n').slice(0, 4000)
      } catch {
        return null
      }
    }

    // P0-F57: `isJsonValue` (packages/core/src/effects/tool-dispatch.ts) rejects `undefined`,
    // non-finite numbers and non-plain objects. When a mutating tool returns an invalid
    // ToolResult the kernel settles the call as TOOL_OUTCOME_UNKNOWN and throws the whole
    // result away without any exception reaching this code, so every result is normalised
    // through JSON first.
    function jsonSafe(value) {
      return JSON.parse(JSON.stringify(value))
    }

    function versionParts(name) {
      const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(name ?? ''))
      return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : [0, 0, 0]
    }

    function newerFirst(a, b) {
      const left = versionParts(a)
      const right = versionParts(b)
      for (let index = 0; index < 3; index += 1) {
        if (left[index] !== right[index]) return right[index] - left[index]
      }
      return 0
    }

    function blenderCandidates() {
      const found = []
      if (process.env.AGH_BLENDER_EXE) found.push(process.env.AGH_BLENDER_EXE)
      const bases = [
        'C:\\Program Files\\Blender Foundation',
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Blender Foundation') : null,
        'D:\\Blender Foundation',
      ]
      for (const base of bases) {
        if (!base || !existsSync(base)) continue
        let entries = []
        try {
          entries = readdirSync(base, { withFileTypes: true })
        } catch {
          continue
        }
        const names = entries
          .filter((entry) => entry.isDirectory() && /^blender/i.test(entry.name))
          .map((entry) => entry.name)
          .sort(newerFirst)
        for (const name of names) found.push(join(base, name, 'blender.exe'))
      }
      return [...new Set(found)].filter((path) => existsSync(path))
    }

    function pidAlive(pid) {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    // PowerShell payloads travel with -EncodedCommand, never -File. The helper used to be a .ps1
    // inside this package (that is, outside the workspace), and running a script by path under a
    // file-scoped confine is what made the token-less stop time out (19s ~ the identity probe's
    // 15s timeout, P0-F163). An inline payload leaves no path for the sandbox to reason about.
    // -EncodedCommand takes UTF-16LE base64 (exactly what Buffer.from(text, 'utf16le') gives) and
    // it does not forward positional arguments, so the pid is baked into the body.
    const psArgv = (body) => [
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-OutputFormat',
      'Text',
      '-EncodedCommand',
      Buffer.from(body, 'utf16le').toString('base64'),
    ]
    // Identity, not liveness: PIDs are reused, so "pid 1234 is alive" may be an unrelated process.
    // StartTime.ToFileTime() gives the same FILETIME epoch (100ns ticks since 1601) as Python's
    // GetProcessTimes; ManagementDateTimeConverter does not exist on PS 5.1 (measured 2026-10-05).
    const identityScript = (pid) =>
      "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; " +
      'try { $p = Get-Process -Id ' +
      pid +
      " -ErrorAction Stop } catch { Write-Output 'GONE'; exit 3 }; " +
      "try { $ticks = $p.StartTime.ToFileTime() } catch { Write-Output ('NO_STARTTIME|' + $_.Exception.Message); exit 4 }; " +
      "Write-Output ($p.ProcessName + '|' + $ticks)"
    // Asks the window to close; never force-kills. A save prompt nobody answers leaves the process
    // running, and STILL_RUNNING is reported honestly instead of escalating to taskkill /F.
    const closeScript = (pid) =>
      "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; " +
      'try { $p = Get-Process -Id ' +
      pid +
      " -ErrorAction Stop } catch { Write-Output 'GONE'; exit 3 }; " +
      '$r = $p.CloseMainWindow(); $p.WaitForExit(8000) | Out-Null; ' +
      "if ($p.HasExited) { Write-Output ('EXITED|requested=' + $r) } else { Write-Output ('STILL_RUNNING|requested=' + $r) }"

    // Identity, not liveness. PIDs are reused, so "pid 1234 is alive" may be an unrelated
    // process. ToolContext.exec owns sandbox enforcement; give it original argv so the
    // process identity probe is not wrapped in the sandbox twice.
    async function queryProcess(tctx, pid) {
      const rawArgv = psArgv(identityScript(Number(pid)))
      try {
        const r = await tctx.exec(rawArgv, { timeoutMs: 15000 })
        const stdout = String(r?.stdout ?? '')
        const text = stdout.trim().split(/\r?\n/).pop()
        if (text === 'GONE') return { ok: true, gone: true }
        if (!text.includes('|'))
          return {
            ok: false,
            code: r?.code ?? null,
            stdout: text.slice(0, 200),
            stderr: String(r?.stderr ?? '').slice(0, 200),
          }
        const [imageName, ticks] = text.split('|')
        // ticksRaw stays a string on purpose: a FILETIME like 134356859898245176 exceeds 2^53, so
        // Number() would round it silently and a comparison could pass on the rounded value.
        return { ok: true, gone: false, imageName, ticksRaw: ticks }
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    }

    function findDiskInstance(workspaceRoot) {
      const root = join(workspaceRoot, MANAGED_DIR_NAME, 'instances')
      let names = null
      try {
        names = readdirSync(root)
      } catch {
        return null
      }
      const key = normalizeCwd(workspaceRoot)
      const found = []
      for (const name of names) {
        const record = readJsonFile(join(root, name, 'instance.json'))
        if (!record) continue
        if (normalizeCwd(record.workspaceRoot ?? workspaceRoot) !== key) continue
        found.push(record)
      }
      found.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
      return found[0] ?? null
    }

    async function pickFreePort() {
      return new Promise((done, fail) => {
        const probe = createServer()
        probe.once('error', fail)
        probe.listen(0, '127.0.0.1', () => {
          const port = probe.address().port
          probe.close(() => done(port))
        })
      })
    }

    async function fetchJson(tctx, url, init) {
      const timeoutMs = init?.timeoutMs ?? 5000
      const response = await tctx.net.fetch(url, {
        ...(init ?? {}),
        timeoutMs,
        headers: { ...(init?.headers ?? {}), 'X-AGH-Timeout-Ms': String(timeoutMs) },
      })
      const text = await response.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: response.status, ok: response.ok === true, json, text: text.slice(0, 400) }
    }
    const bridgeJobTimeout = (tctx) => Math.max(1000, Math.min(95000, (tctx.timeoutMs ?? 120000) - 1000))

    // Run directories accumulate one per start, and nothing ever removed them (measured: 11 stale
    // directories, all with dead pids, in one workspace). Pruning happens before the new directory
    // is created, so a workspace cannot grow without bound. Two things are never removed: the
    // directory about to be used, and any directory whose pid is still alive -- deleting a live
    // instance's records would strand it the same way a plugin reload does.
    function pruneInstances(root, keepId, keepCount) {
      const removed = []
      let names = []
      try {
        names = readdirSync(root)
      } catch {
        return { kept: 0, removed, available: 0 }
      }
      const entries = []
      for (const name of names) {
        if (name === keepId) continue
        const full = join(root, name)
        const record = readJsonFile(join(full, 'instance.json'))
        let stamp = 0
        try {
          stamp = statSync(full).mtimeMs
        } catch {
          stamp = 0
        }
        entries.push({ name, full, record, stamp })
      }
      entries.sort((a, b) => b.stamp - a.stamp)
      const survivors = []
      for (const entry of entries) {
        const alive = entry.record ? pidAlive(Number(entry.record.pid)) : false
        if (alive || survivors.length < keepCount) {
          survivors.push(entry)
          continue
        }
        try {
          rmSync(entry.full, { recursive: true, force: true })
          removed.push(entry.name)
        } catch {
          survivors.push(entry)
        }
      }
      return { kept: survivors.length, removed, available: entries.length }
    }

    async function runStart(tctx, args = {}) {
      tctx?.signal?.throwIfAborted()
      const workspaceRoot = resolve(tctx?.cwd ?? process.cwd())
      const dir = join(workspaceRoot, MANAGED_DIR_NAME)
      // Default false: the behaviour stays exactly as before (and matches the probe's argv).
      const empty = args?.empty === true
      const report = {
        ok: false,
        startedAt: new Date().toISOString(),
        workspaceRoot,
        sessionKey: tctx?.session?.key ?? null,
        toolTimeoutMs: tctx?.timeoutMs ?? null,
        enforcement: null,
        empty,
        steps: [],
        blockers: [],
      }
      const workspaceKey = normalizeCwd(workspaceRoot)
      const current = instances.get(workspaceKey)
      if (current && pidAlive(current.pid)) {
        if (
          typeof args.executable === 'string' &&
          normalizeCwd(resolve(args.executable)) !== normalizeCwd(resolve(current.blenderExe))
        ) {
          report.blockers.push(
            'A different Blender executable was requested while a managed instance is alive; stop/save that instance before switching versions.',
          )
          return report
        }
        // Reuse only our live authenticated bridge. Never clear an existing document
        // merely because a caller passed empty:true for a fresh startup.
        try {
          const hello = await fetchJson(tctx, `http://127.0.0.1:${current.port}/hello`, {
            method: 'POST',
            headers: { 'X-AGH-Token': current.token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              protocol: BRIDGE_PROTOCOL,
              role: 'agh-host',
              sessionKey: tctx?.session?.key ?? null,
            }),
          })
          tctx.signal?.throwIfAborted()
          report.ok = hello.status === 200 && hello.json?.ok === true
          report.reused = report.ok
          report.emptyApplied = false
          report.instance = { pid: current.pid, port: current.port, instanceId: current.instanceId }
          report.note =
            'Existing document preserved; empty applies only to a newly started instance. Use unique object names.'
          if (!report.ok)
            report.blockers.push(
              'existing Blender handshake failed; inspect it before starting another instance',
            )
        } catch (error) {
          report.blockers.push(`existing Blender unavailable: ${error?.message ?? error}`)
        }
        writeJsonFile(join(current.instanceDir, 'reuse-report.json'), jsonSafe(report))
        return report
      }
      if (current) instances.delete(workspaceKey)
      if (!existsSync(BOOTSTRAP_PY)) {
        report.blockers.push(`bootstrap.py missing: ${BOOTSTRAP_PY}`)
        return report
      }
      try {
        report.enforcement = tctx.sandbox.enforcement()
      } catch (error) {
        report.blockers.push(`sandbox.enforcement() failed: ${error?.message ?? error}`)
      }

      const candidates =
        typeof args.executable === 'string' && args.executable.trim()
          ? [args.executable]
          : blenderCandidates()
      report.steps.push({ step: 'discover', candidates })
      if (candidates.length === 0) {
        report.blockers.push('no blender.exe candidate found')
        return report
      }

      let exe = null
      let versionLine = ''
      for (const candidate of candidates) {
        try {
          const result = await tctx.exec([candidate, '--version'], { timeoutMs: 30000 })
          const line = String(result.stdout ?? '')
            .split(/\r?\n/)
            .find((text) => text.trim().length > 0)
          report.steps.push({ step: 'version', exe: candidate, code: result.code, line: line ?? '' })
          if (result.code === 0 && /^blender\s+\d+/i.test(String(line ?? '').trim())) {
            exe = candidate
            versionLine = String(line).trim()
            break
          }
        } catch (error) {
          report.steps.push({ step: 'version', exe: candidate, error: `${error?.message ?? error}` })
        }
      }
      if (!exe) {
        report.blockers.push('could not verify a Blender version line from any candidate')
        return report
      }
      const parts = versionParts(versionLine)
      if (parts[0] < MIN_BLENDER[0] || (parts[0] === MIN_BLENDER[0] && parts[1] < MIN_BLENDER[1])) {
        report.blockers.push(`Blender ${versionLine} is older than 4.2`)
        return report
      }
      report.blender = { exe, versionLine, parsed: parts }

      const instanceId = randomUUID()
      const instanceDir = join(dir, 'instances', instanceId)
      const pruned = pruneInstances(join(dir, 'instances'), instanceId, 20)
      if (pruned.removed.length > 0) {
        report.steps.push({ step: 'prune', kept: pruned.kept, removed: pruned.removed })
      }
      mkdirSync(instanceDir, { recursive: true })
      const markerPath = join(dir, 'marker.json')
      if (!existsSync(markerPath)) {
        writeJsonFile(markerPath, {
          schema: 'agh-blender/1',
          workspaceRoot,
          owner: 'AGH Blender bridge probe (P0-3)',
          createdAt: new Date().toISOString(),
        })
      }

      const token = randomBytes(32).toString('base64url')
      const tokenFingerprint = createHash('sha256').update(token).digest('hex').slice(0, 16)
      const requestedPort = await pickFreePort()
      const configPath = join(instanceDir, 'bootstrap.json')
      writeJsonFile(configPath, {
        protocol: BRIDGE_PROTOCOL,
        instanceDir,
        port: requestedPort,
        workspaceRoot,
        // The bridge clears the startup scene when this is true. Kept in the config (rather than
        // left to the caller to script) because agh_blender_export exports the whole scene: a
        // factory-startup Cube/Light/Camera would otherwise land in every delivered .blend.
        empty,
        createdAt: new Date().toISOString(),
      })
      report.instanceId = instanceId
      report.instanceDir = instanceDir
      report.requestedPort = requestedPort
      report.tokenFingerprint = tokenFingerprint

      const rawArgv = [
        exe,
        '--factory-startup',
        '--disable-autoexec',
        '--python-exit-code',
        '1',
        '--python',
        BOOTSTRAP_PY,
        '--',
        '--agh-bridge-config',
        configPath,
      ]
      report.rawArgv = rawArgv

      let confinedArgv = null
      try {
        confinedArgv = await tctx.sandbox.confine(rawArgv)
      } catch (error) {
        report.blockers.push(`sandbox.confine refused the launch: ${error?.message ?? error}`)
        return report
      }
      report.confinedArgv = confinedArgv
      report.argvChanged = JSON.stringify(confinedArgv) !== JSON.stringify(rawArgv)
      if (!Array.isArray(confinedArgv) || confinedArgv.length === 0) {
        report.blockers.push('sandbox.confine returned an empty argv')
        return report
      }

      const stdoutPath = join(instanceDir, 'bridge.stdout.log')
      const stderrPath = join(instanceDir, 'bridge.stderr.log')
      let child = null
      let spawnError = null
      let outFd = null
      let errFd = null
      try {
        tctx?.signal?.throwIfAborted()
        outFd = openSync(stdoutPath, 'a')
        errFd = openSync(stderrPath, 'a')
        child = spawn(confinedArgv[0], confinedArgv.slice(1), {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            AGH_BLENDER_BRIDGE_TOKEN: token,
            // P0-F160: Blender writes __pycache__/*.pyc next to the bridge modules, and the bridge
            // runs from a content-addressed runtime snapshot — so one Blender run changed the tree
            // hash and every later package operation failed with E_PACKAGE_INTEGRITY until the .pyc
            // files were deleted by hand. bootstrap.py sets sys.dont_write_bytecode as a second
            // guard, because this variable could be absent from an inherited environment.
            PYTHONDONTWRITEBYTECODE: '1',
          },
          shell: false,
          windowsHide: true,
          detached: true,
          stdio: ['ignore', outFd, errFd],
        })
        // spawn errors are normally asynchronous; an unhandled error would terminate the worker.
        child.on('error', (error) => {
          spawnError = error
        })
        child.unref()
      } catch (error) {
        report.blockers.push(`spawn failed: ${error?.message ?? error}`)
        return report
      } finally {
        if (outFd !== null) closeSync(outFd)
        if (errFd !== null) closeSync(errFd)
      }
      report.spawn = {
        executable: confinedArgv[0],
        pid: child.pid,
        detached: true,
        windowsHide: true,
        shell: false,
        stdoutPath,
        stderrPath,
      }
      // A cancelled startup must not leave an unregistered Blender consuming memory.
      // Release this listener once startup finishes; an established instance outlives a tool call.
      const cancelStartup = () => {
        try {
          child.kill()
        } catch {}
      }
      let registered = false
      tctx?.signal?.addEventListener('abort', cancelStartup, { once: true })
      try {
        tctx?.signal?.throwIfAborted()
        // Record who this pid actually is, while the ChildProcess object is still ours. A bare
        // pid is not an identity: Windows reuses pids, and a later token-less stop must not
        // close a stranger's window. Best effort — a null identity disables that path, not start.
        report.processIdentity = await queryProcess(tctx, child.pid)

        const kill = (why) => {
          try {
            report.cleanup = { pid: child.pid, requested: child.kill(), why }
          } catch (error) {
            report.cleanup = { pid: child.pid, why, error: `${error?.message ?? error}` }
          }
        }

        const budgetMs = Math.max(15000, Math.min(60000, (tctx?.timeoutMs ?? 90000) - 10000))
        const deadline = Date.now() + budgetMs
        let portInfo = null
        let health = null
        let lastError = null
        let rounds = 0
        while (Date.now() < deadline) {
          tctx?.signal?.throwIfAborted()
          if (spawnError) {
            report.blockers.push(`spawn failed: ${spawnError.message ?? spawnError}`)
            break
          }
          if (!pidAlive(child.pid)) {
            report.blockers.push(
              `blender process ${child.pid} is gone during startup (code=${child.exitCode} signal=${child.signalCode})`,
            )
            break
          }
          rounds += 1
          portInfo = readJsonFile(join(instanceDir, 'port.json'))
          if (portInfo?.port) {
            try {
              const response = await fetchJson(tctx, `http://127.0.0.1:${portInfo.port}/health`)
              if (response.status === 200 && response.json?.ok === true) {
                health = response
                break
              }
              lastError = `status ${response.status}`
            } catch (error) {
              lastError = `${error?.message ?? error}`
            }
          }
          await sleep(400)
        }
        report.readiness = { rounds, budgetMs, portInfo, health: health?.json ?? null, lastError }
        if (!health) {
          report.blockers.push('bridge did not answer /health in time')
          kill('bridge never became healthy')
          report.stderrTail = readFileSafe(stderrPath)
          return report
        }

        const base = `http://127.0.0.1:${portInfo.port}`
        try {
          const unauthorized = await fetchJson(tctx, `${base}/hello`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
          report.tokenEnforced = unauthorized.status === 401
          if (!report.tokenEnforced) report.blockers.push('bridge did not enforce the startup token')
          const hello = await fetchJson(tctx, `${base}/hello`, {
            method: 'POST',
            headers: { 'X-AGH-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              protocol: BRIDGE_PROTOCOL,
              role: 'agh-host',
              sessionKey: tctx?.session?.key ?? null,
            }),
          })
          report.handshake = {
            status: hello.status,
            ok: hello.status === 200 && hello.json?.ok === true,
            body: hello.json,
            text: hello.ok ? undefined : hello.text,
          }
        } catch (error) {
          report.blockers.push(`handshake failed: ${error?.message ?? error}`)
        }
        report.stderrTail = readFileSafe(stderrPath)

        tctx?.signal?.throwIfAborted()
        if (report.blockers.length > 0 || report.handshake?.ok !== true) {
          if (report.blockers.length === 0) report.blockers.push('bridge rejected the startup handshake')
          return report
        }
        const key = normalizeCwd(workspaceRoot)
        const record = {
          token,
          pid: child.pid,
          port: portInfo.port,
          instanceId,
          instanceDir,
          blenderExe: exe,
          blenderVersion: versionLine,
          tokenFingerprint,
          enforcement: report.enforcement,
          argvChanged: report.argvChanged,
          tokenEnforced: report.tokenEnforced ?? null,
          rawArgv,
          confinedArgv,
          startedAt: Date.now(),
        }
        writeJsonFile(join(instanceDir, 'instance.json'), {
          schema: 'agh-blender/1',
          instanceId,
          instanceDir,
          workspaceRoot,
          pid: child.pid,
          port: portInfo.port,
          requestedPort,
          blenderExe: exe,
          blenderVersion: versionLine,
          tokenSha256Prefix: tokenFingerprint,
          rawArgv,
          confinedArgv,
          argvChanged: report.argvChanged,
          enforcement: report.enforcement,
          tokenEnforced: report.tokenEnforced ?? null,
          startedAt: new Date().toISOString(),
          // Persisted so a post-reload stop can prove the pid is still ours before closing it.
          processIdentity: report.processIdentity ?? null,
          owner: 'AGH Blender bridge probe (P0-3)',
        })
        report.ok = report.blockers.length === 0 && report.handshake?.ok === true
        // P0-F58: a mutating tool's only result copy must not live in the return value. This file is
        // written before returning, so the outcome survives a synthetic TOOL_OUTCOME_UNKNOWN.
        report.startReportPath = join(instanceDir, 'start-report.json')
        writeJsonFile(report.startReportPath, jsonSafe(report))
        instances.set(key, record)
        registered = true
        return report
      } finally {
        tctx?.signal?.removeEventListener('abort', cancelStartup)
        if (!registered) {
          report.ok = false
          cancelStartup()
          report.cleanup ??= { pid: child.pid, why: 'startup did not complete', killAttempted: true }
          try {
            rmSync(join(instanceDir, 'instance.json'), { force: true })
          } catch {}
          report.startReportPath = join(instanceDir, 'start-report.json')
          try {
            writeJsonFile(report.startReportPath, jsonSafe(report))
          } catch {}
        }
      }
    }

    async function runProbe(tctx) {
      const workspaceRoot = resolve(tctx?.cwd ?? process.cwd())
      const key = normalizeCwd(workspaceRoot)
      const report = {
        cwd: workspaceRoot,
        seenAt: new Date().toISOString(),
        source: 'none',
        alive: false,
        health: null,
        handshake: null,
      }
      let record = instances.get(key) ?? null
      if (record) report.source = 'memory'
      if (!record) {
        const dir = join(workspaceRoot, MANAGED_DIR_NAME, 'instances')
        if (existsSync(dir)) {
          let names = []
          try {
            names = readdirSync(dir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
          } catch {
            names = []
          }
          for (const name of names) {
            const disk = readJsonFile(join(dir, name, 'instance.json'))
            if (disk) {
              record = { ...disk, token: null, fromDisk: true }
              report.source = 'disk'
              break
            }
          }
        }
      }
      if (!record) {
        report.note = 'no managed Blender instance recorded for this workspace'
        return report
      }
      report.instance = {
        pid: record.pid,
        port: record.port,
        instanceId: record.instanceId ?? null,
        instanceDir: record.instanceDir ?? null,
        blenderVersion: record.blenderVersion ?? null,
        argvChanged: record.argvChanged ?? null,
        tokenEnforced: record.tokenEnforced ?? null,
        enforcement: record.enforcement ?? null,
        processAlive: pidAlive(record.pid),
      }
      // P0-F58/F59: the on-disk report is the copy that survives a synthetic outcome, so the probe
      // reads it back instead of trusting whatever the model was shown.
      const reportPath = record.instanceDir ? join(record.instanceDir, 'start-report.json') : null
      const disk = reportPath ? readJsonFile(reportPath) : null
      report.diskStartReport = disk
        ? {
            path: reportPath,
            ok: disk.ok ?? null,
            enforcement: disk.enforcement ?? null,
            argvChanged: disk.argvChanged ?? null,
            tokenEnforced: disk.tokenEnforced ?? null,
            rawArgv: disk.rawArgv ?? null,
            confinedArgv: disk.confinedArgv ?? null,
            blockers: disk.blockers ?? null,
            readiness: disk.readiness
              ? {
                  rounds: disk.readiness.rounds,
                  budgetMs: disk.readiness.budgetMs,
                  lastError: disk.readiness.lastError ?? null,
                }
              : null,
            handshakeOk: disk.handshake?.ok ?? null,
            blender: disk.blender ?? null,
          }
        : null
      try {
        const health = await fetchJson(tctx, `http://127.0.0.1:${record.port}/health`)
        report.health = health.json ?? { status: health.status, text: health.text }
        report.alive = health.status === 200
      } catch (error) {
        report.health = { error: `${error?.message ?? error}` }
      }
      if (report.alive && record.token) {
        try {
          const hello = await fetchJson(tctx, `http://127.0.0.1:${record.port}/hello`, {
            method: 'POST',
            headers: { 'X-AGH-Token': record.token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ protocol: BRIDGE_PROTOCOL, role: 'agh-probe' }),
          })
          report.handshake = { status: hello.status, body: hello.json }
        } catch (error) {
          report.handshake = { error: `${error?.message ?? error}` }
        }
      } else if (report.alive) {
        report.handshake = {
          skipped: 'the token only lives in the daemon process memory; a disk-only record cannot handshake',
        }
      }
      return report
    }

    // Token-less graceful stop for an orphaned instance: the token only ever lived in daemon
    // memory (deliberate), so after a plugin reload the bridge can no longer authorise us — but
    // closing the window is an OS-level request that needs no token. Two guards replace it:
    //   1. identity — pid AND creation time AND image name must match what start recorded;
    //   2. the Host approval gate on the tool (requiresApproval always, isDestructive true).
    // It only ever ASKS. If Blender shows a save prompt, that prompt is the user's to answer,
    // and a failure is reported as "requested, unconfirmed" — never escalated to a force kill.
    async function tokenlessStop(tctx, pid, expected) {
      const identity = await queryProcess(tctx, pid)
      if (identity.refused) return { ok: false, stage: 'identity', refused: true, error: identity.error }
      if (!identity.ok)
        return { ok: false, stage: 'identity', error: identity.error ?? 'identity probe failed' }
      if (identity.gone) return { ok: false, stage: 'identity', error: 'process is gone' }
      const expectedTicks = expected?.ticksRaw ?? null
      const expectedName = expected?.imageName ?? null
      if (expectedTicks === null || expectedName === null)
        return {
          ok: false,
          stage: 'identity',
          error: 'no recorded process identity for this instance; refusing a token-less stop',
        }
      if (String(identity.ticksRaw) !== String(expectedTicks) || identity.imageName !== expectedName)
        return {
          ok: false,
          stage: 'identity',
          error: 'pid now belongs to a different process',
          observed: { pid, imageName: identity.imageName, ticks: identity.ticksRaw },
          expected: { imageName: expectedName, ticks: expectedTicks },
        }
      const rawArgv = psArgv(closeScript(Number(pid)))
      try {
        const r = await tctx.exec(rawArgv, { timeoutMs: 20000 })
        const text = String(r?.stdout ?? '')
          .trim()
          .split(/\r?\n/)
          .pop()
        // Never escalate to taskkill /F: losing unsaved work is the one outcome this whole
        // path exists to prevent. A prompt that is still up means the request is unconfirmed.
        return {
          ok: text.startsWith('EXITED'),
          stage: 'close',
          requested: true,
          confirmed: text.startsWith('EXITED'),
          observed: { pid, imageName: identity.imageName, ticks: identity.ticksRaw },
          expected: { imageName: expectedName, ticks: expectedTicks },
          status: text.slice(0, 100),
          exec: {
            code: r?.code ?? null,
            stdout: String(r?.stdout ?? '').slice(0, 400),
            stderr: String(r?.stderr ?? '').slice(0, 400),
          },
          code: r?.code ?? null,
          note: text.startsWith('EXITED')
            ? "window closed through Blender's normal exit path"
            : 'close was requested but the process is still running (likely an unsaved-changes prompt); nothing was force-killed',
        }
      } catch (error) {
        return { ok: false, stage: 'close', error: String(error?.message ?? error) }
      }
    }

    // P0-F58, learned the hard way twice: a tool with side effects must land its result on disk
    // before returning. The harness replaces a slow mutating call's result with
    // TOOL_OUTCOME_UNKNOWN, and then the reason is gone for good — which is exactly what happened
    // here: stop ran 19s and its only copy of the outcome was discarded (P0-F164).
    function finishStop(report, instanceDir) {
      const payload = jsonSafe(report)
      if (typeof instanceDir === 'string' && instanceDir.length > 0) {
        try {
          const path = join(instanceDir, 'stop-report.json')
          writeJsonFile(path, payload)
          payload.stopReportPath = path
        } catch (error) {
          payload.stopReportPath = null
          payload.stopReportError = String(error?.message ?? error)
        }
      } else {
        payload.stopReportPath = null
        payload.stopReportError = 'no instance directory to write a stop report into'
      }
      return payload
    }

    async function runStop(tctx, args) {
      const force = args?.force === true
      const workspaceRoot = resolve(tctx?.cwd ?? process.cwd())
      const key = normalizeCwd(workspaceRoot)
      const record = instances.get(key)
      if (!record) {
        // No in-memory handle: either nothing was ever started here, or the module was
        // reloaded and the token (memory-only, by design) is gone. Read the disk record and,
        // if it names a process that still matches, ask that window to close gracefully.
        const disk = findDiskInstance(workspaceRoot)
        if (!disk) return { ok: false, note: 'no managed instance held in memory for this workspace' }
        const pid = Number(disk.pid)
        if (!Number.isInteger(pid) || pid <= 0)
          return { ok: false, note: 'disk record has no usable pid', instanceDir: disk.instanceDir }
        if (!pidAlive(pid))
          return { ok: false, note: 'recorded process is already gone', pid, instanceDir: disk.instanceDir }
        const graceful = await tokenlessStop(tctx, pid, disk.processIdentity)
        const report = {
          tool: 'agh_blender_stop',
          at: new Date().toISOString(),
          mode: 'graceful (tokenless)',
          pid,
          instanceId: disk.instanceId ?? null,
          stage: graceful.stage ?? null,
          identity: { observed: graceful.observed ?? null, expected: graceful.expected ?? null },
          confineRefused: graceful.refused === true,
          exec: graceful.exec ?? null,
          requested: graceful.requested === true,
          confirmed: graceful.confirmed === true,
          ok: graceful.ok === true,
          note: graceful.note ?? graceful.error ?? null,
          forceKilled: false,
        }
        return finishStop(report, disk.instanceDir)
      }
      const startedAt = Date.now()
      try {
        const bye = await fetchJson(tctx, `http://127.0.0.1:${record.port}/shutdown`, {
          method: 'POST',
          headers: { 'X-AGH-Token': record.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ force }),
        })
        const dirtyRefusal = bye.status === 409 || bye.json?.code === 'E_DIRTY'
        if (dirtyRefusal) {
          // The bridge refuses to quit a dirty scene, because this path never asks to save.
          return finishStop(
            {
              tool: 'agh_blender_stop',
              at: new Date().toISOString(),
              mode: 'token',
              pid: record.pid,
              instanceId: record.instanceId ?? null,
              stage: 'close',
              ok: false,
              refused: true,
              blockers: ['E_DIRTY'],
              bridge: { status: bye.status, body: bye.json ?? null },
              note: bye.json?.note ?? 'the scene has unsaved changes; nothing was closed',
              forceKilled: false,
              elapsedMs: Date.now() - startedAt,
            },
            record.instanceDir,
          )
        }
        await sleep(2000)
        instances.delete(key)
        return finishStop(
          {
            tool: 'agh_blender_stop',
            at: new Date().toISOString(),
            mode: 'token',
            pid: record.pid,
            instanceId: record.instanceId ?? null,
            stage: 'close',
            ok: bye.json?.ok === true,
            requested: true,
            confirmed: bye.json?.ok === true,
            isDirty: bye.json?.isDirty ?? null,
            forced: bye.json?.forced ?? null,
            bridge: { status: bye.status, body: bye.json ?? null },
            note: 'closed through the bridge; this path never prompts to save, so E_DIRTY is the guard',
            forceKilled: false,
            elapsedMs: Date.now() - startedAt,
          },
          record.instanceDir,
        )
      } catch (error) {
        // The bridge could not be reached. That usually means the process has ALREADY exited
        // (measured twice: a tiny elapsedMs is the tell), and reporting ok:false then is wrong --
        // the instance is, in fact, no longer running. So fall back to process identity, not just
        // PID liveness: "pid 1234 is alive" may be an unrelated process that reused the number.
        const transportElapsedMs = Date.now() - startedAt
        let fallback = null
        try {
          const alive = pidAlive(record.pid)
          if (!alive) {
            fallback = { concluded: 'process already gone', alive: false }
          } else {
            const identity = await queryProcess(tctx, record.pid)
            const expected = record.processIdentity ?? null
            if (identity?.ok && identity?.gone === true) {
              fallback = { concluded: 'process already gone', alive: true, gone: true }
            } else if (
              identity?.ok &&
              expected?.ticksRaw != null &&
              String(identity.ticksRaw) === String(expected.ticksRaw) &&
              identity.imageName === expected.imageName
            ) {
              // Same process, still running, bridge unreachable: NOT a success, and do not
              // escalate to a kill. Say what is true.
              fallback = {
                concluded: 'process is still running but the bridge is unreachable',
                alive: true,
                identity: { observed: identity.imageName, ticks: identity.ticksRaw },
              }
            } else {
              fallback = {
                concluded: 'pid no longer belongs to the recorded instance',
                alive: true,
                identity: identity?.ok
                  ? {
                      observed: `${identity.imageName}|${identity.ticksRaw}`,
                      expected: expected ? `${expected.imageName}|${expected.ticksRaw}` : null,
                    }
                  : null,
                probeError: identity?.error ?? null,
              }
            }
          }
        } catch (probeError) {
          fallback = { concluded: 'fallback probe failed', error: String(probeError?.message ?? probeError) }
        }
        const gone = fallback?.concluded === 'process already gone'
        if (gone) instances.delete(key)
        return finishStop(
          {
            tool: 'agh_blender_stop',
            at: new Date().toISOString(),
            mode: 'token',
            pid: record.pid,
            instanceId: record.instanceId ?? null,
            stage: 'close',
            // Confirmed by identity, not by the bridge: the bridge is what went missing.
            ok: gone,
            requested: true,
            confirmed: gone,
            bridge: { status: null, error: `transport: ${error?.message ?? error}` },
            transportFailed: true,
            pidFallback: fallback,
            note: gone
              ? 'the bridge was unreachable, but the recorded process is confirmed gone (pid + creation time); nothing left running'
              : 'the bridge was unreachable and the process could NOT be confirmed gone; the instance was kept so a later call can retry',
            forceKilled: false,
            elapsedMs: transportElapsedMs,
          },
          record.instanceDir,
        )
      }
    }

    const PROBE_EMPTY_INPUT = { type: 'object', properties: {}, required: [], additionalProperties: false }

    async function runCapture(tctx, args) {
      const workspaceRoot = resolve(tctx?.cwd ?? process.cwd())
      const record = instances.get(normalizeCwd(workspaceRoot))
      const report = { ok: false, startedAt: new Date().toISOString(), blockers: [] }
      if (!record) {
        report.blockers.push('no managed Blender instance in this workspace; call agh_blender_start first')
        return report
      }
      const width = Number.isInteger(args?.width) ? args.width : null
      const height = Number.isInteger(args?.height) ? args.height : null
      const colorManagement = args?.colorManagement === undefined ? true : Boolean(args.colorManagement)
      // Default 'all': framing on the scene bounds is what makes one capture comparable with
      // another. 'none' keeps the old behaviour (whatever the region was already looking at).
      const frame = args?.frame === 'none' ? 'none' : 'all'
      let response = null
      try {
        response = await fetchJson(tctx, `http://127.0.0.1:${record.port}/capture`, {
          method: 'POST',
          headers: { 'X-AGH-Token': record.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            width,
            height,
            colorManagement,
            frame,
            ...(args?.camera ? { camera: args.camera } : {}),
          }),
          timeoutMs: bridgeJobTimeout(tctx),
        })
      } catch (error) {
        report.blockers.push(`bridge capture request failed: ${error?.message ?? error}`)
        return report
      }
      report.bridge = {
        status: response.status,
        ok: response.json?.ok === true,
        error: response.json?.error ?? null,
        detail: response.json?.detail ?? null,
        traceback: response.json?.traceback ?? null,
      }
      if (!(response.status === 200 && response.json?.ok === true)) {
        report.blockers.push('bridge capture failed')
        return report
      }
      const shot = response.json
      if (args?.camera && (shot.source !== 'scene-camera' || shot.camera !== args.camera)) {
        report.blockers.push(
          'Bridge did not return the requested scene camera render; update and restart the managed Blender instance',
        )
        return report
      }
      let bytes = null
      try {
        if (
          typeof shot.file !== 'string' ||
          !/^[0-9a-f-]+\.png$/i.test(shot.file) ||
          typeof shot.path !== 'string' ||
          normalizeCwd(resolve(shot.path)) !== normalizeCwd(join(record.instanceDir, 'captures', shot.file))
        )
          throw new Error('Capture path is outside the managed instance')
        if (statSync(shot.path).size > 8 * 1024 * 1024) throw new Error('Capture PNG exceeds 8 MiB')
        bytes = readFileSync(shot.path)
      } catch (error) {
        report.blockers.push(`could not read the capture back from disk: ${error?.message ?? error}`)
        return report
      }
      const diskSha = createHash('sha256').update(bytes).digest('hex')
      report.capture = {
        path: shot.path,
        file: shot.file,
        width: shot.width,
        height: shot.height,
        channels: shot.channels,
        colorManagement: shot.colorManagement,
        bytes: shot.bytes,
        sha256: shot.sha256,
        rowOrder: shot.rowOrder,
        origin: shot.origin,
        stats: shot.stats,
        framing: shot.framing ?? null,
        source: shot.source ?? null,
        camera: shot.camera ?? null,
        diskBytes: bytes.length,
        shaMatchesDisk: diskSha === shot.sha256,
        sessionKey: tctx?.session?.key ?? null,
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      report.png = {
        path: shot.path,
        file: shot.file,
        bytes: bytes.length,
        sha256,
        shaMatchesBridge: sha256 === shot.sha256,
      }
      try {
        report.artifact = await publishCapture(tctx, bytes, shot)
      } catch (error) {
        report.blockers.push(`capture image publication failed: ${error?.message ?? error}`)
        return report
      }
      report.ok = true
      return report
    }

    registerTool({
      name: 'agh_blender_start',
      description:
        '启动或复用当前工作区的受管理Blender：已有存活实例先认证复用，不再开新窗口，empty仅对新启动生效，不清空已有工程。发现本机 blender.exe（校验版本）→ 构造固定 argv → 经 tctx.sandbox.confine() → 在 127.0.0.1 上拉起一个受管理的 GUI Blender 并完成 token 握手。会真实打开 Blender 窗口；不安装扩展、不改用户偏好、不执行任意 Python。',
      parameters: tb({
        type: 'object',
        properties: {
          executable: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            description:
              'Optional locally configured Blender executable; still version-checked and sandbox-confined.',
          },
          empty: {
            type: 'boolean',
            description:
              'true 时启动后清空场景再握手，使实例从真正空文档开始（默认 false，与之前行为一致）。因为 agh_blender_export 是整场景导出，factory-startup 的 Cube/Light/Camera 会跟着进每个交付的 .blend；清空会把”场景内容 = 我们发出的 ops“重新变成事实。',
          },
        },
        required: [],
        additionalProperties: false,
      }),
      meta: {
        isReadOnly: false,
        isDestructive: false,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never',
        costHint: { wallMs: 90000 },
        deferLoading: false,
        requiresApproval: 'always',
      },
      async execute(args, tctx) {
        const payload = jsonSafe(await runStart(tctx, args))
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structured: payload,
          ...(payload.ok === true ? {} : { isError: true }),
        }
      },
    })

    registerTool({
      name: 'agh_blender_probe',
      description:
        'P0-3 只读探针：查当前工作区受管理 Blender 实例是否还活着（/health），并在 token 仍在内存中时做一次 /hello 握手。用来证明实例在工具调用返回之后是否继续存活。',
      parameters: tb({
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      }),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: { wallMs: 10000 },
        deferLoading: false,
        requiresApproval: 'never',
      },
      async execute(_args, tctx) {
        const payload = jsonSafe(await runProbe(tctx))
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structured: payload,
          ...(payload.ok === true ? {} : { isError: true }),
        }
      },
    })

    registerTool({
      name: 'agh_blender_stop',
      description:
        '停止当前工作区的受管理 Blender 实例。走 bridge 的 /shutdown（有 token）时：场景若有未保存改动会被**拒绝**（E_DIRTY），除非显式传 force=true；无 token（实例已成孤儿）时改为请求关窗，走 Blender 正常退出流程，绝不强杀。两条路都会先落盘 stop-report.json。',
      parameters: tb({
        type: 'object',
        properties: {
          force: { type: 'boolean' },
        },
        required: [],
        additionalProperties: false,
      }),
      meta: {
        isReadOnly: false,
        isDestructive: true,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never',
        costHint: { wallMs: 15000 },
        deferLoading: false,
        requiresApproval: 'always',
      },
      async execute(args, tctx) {
        const payload = jsonSafe(await runStop(tctx, args))
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structured: payload,
          ...(payload.ok === true ? {} : { isError: true }),
        }
      },
    })

    registerTool({
      name: 'agh_blender_capture',
      description:
        '生成实际模型图片并显示在AGH对话。提供camera名称时渲染场景相机，包含真实材质和灯光，适合最终展示；不提供则截图3D视口，仅适合几何检查。校验PNG并返回图片块。几何主体完成时先截图展示过程；材质灯光调整完成必须再用camera渲染，比较主体参考图后再简短报告结果。工具会提供预览卡片，回复不要编写artifact://或本地路径的Markdown图片链接。只在实例目录保存，不保留渲染设置变化。',
      parameters: {
        [Symbol.for('TypeBox.Kind')]: 'Object',
        type: 'object',
        properties: {
          width: { type: 'integer', minimum: 16, maximum: 4096 },
          height: { type: 'integer', minimum: 16, maximum: 4096 },
          colorManagement: { type: 'boolean' },
          camera: {
            type: 'string',
            minLength: 1,
            maxLength: 96,
            pattern: '^[A-Za-z0-9_.-]+$',
            description:
              'Existing scene camera name. Render its actual materials and lighting instead of the grey viewport.',
          },
          frame: {
            type: 'string',
            enum: ['all', 'none'],
            description:
              '默认 all：渲染前先取景到场景包围盒（固定视角、按包围球算出距离），使两张 capture 之间有可比性；none 保持旧行为（region 看向哪里就渲哪里）。',
          },
        },
        required: [],
        additionalProperties: false,
      },
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: { wallMs: 30000 },
        deferLoading: false,
        requiresApproval: 'never',
        returnsImages: true,
      },
      async execute(args, tctx) {
        const payload = jsonSafe(await runCapture(tctx, args))
        const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
        if (payload.ok && payload.artifact?.ref)
          content.push({ type: 'image', ref: payload.artifact.ref, mime: 'image/png' })
        return { content, structured: payload, ...(payload.ok ? {} : { isError: true }) }
      },
    })

    // ---- 第 ④ 环：把桥上的 opcode 白名单接到模型的调用面上 ----

    function managedInstance(tctx) {
      const workspaceRoot = resolve(tctx?.cwd ?? process.cwd())
      return { workspaceRoot, record: instances.get(normalizeCwd(workspaceRoot)) ?? null }
    }

    async function runOps(tctx, args) {
      const { record } = managedInstance(tctx)
      const report = { ok: false, startedAt: new Date().toISOString(), blockers: [] }
      if (!record) {
        report.blockers.push('no managed Blender instance in this workspace; call agh_blender_start first')
        return report
      }
      const ops = Array.isArray(args?.ops) ? args.ops : null
      if (!ops || ops.length === 0) {
        report.blockers.push('ops must be a non-empty array of opcode records')
        return report
      }
      const undo = args?.undo === undefined ? true : Boolean(args.undo)
      report.opCount = ops.length
      report.ops = ops.map((item) => item?.op ?? null)
      let response = null
      try {
        response = await fetchJson(tctx, `http://127.0.0.1:${record.port}/op`, {
          method: 'POST',
          headers: { 'X-AGH-Token': record.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ops, undo }),
          timeoutMs: bridgeJobTimeout(tctx),
        })
      } catch (error) {
        report.blockers.push(`op request failed: ${error?.message ?? error}`)
        report.outcome = 'unknown'
        report.replaySafe = false
        report.journalPath = join(record.instanceDir, 'journal.jsonl')
        return report
      }
      report.bridge = { status: response.status }
      report.result = response.json ?? { raw: response.text }
      report.ok = response.status === 200 && response.json?.ok === true
      report.outcome = report.ok
        ? 'completed'
        : Array.isArray(response.json?.applied) && response.json.applied.length
          ? 'partial'
          : 'refused'
      report.replaySafe = false
      if (!report.ok && report.blockers.length === 0) {
        report.blockers.push(response.json?.failed?.code ?? response.json?.error ?? 'op request rejected')
      }
      // The bridge also appends to <instanceDir>/journal.jsonl, so the outcome is
      // recoverable from disk even if this return value is discarded.
      report.journalPath = record.instanceDir ? join(record.instanceDir, 'journal.jsonl') : null
      return report
    }

    async function runScene(tctx) {
      const { record } = managedInstance(tctx)
      const report = { ok: false, startedAt: new Date().toISOString(), blockers: [] }
      if (!record) {
        report.blockers.push('no managed Blender instance in this workspace; call agh_blender_start first')
        return report
      }
      try {
        const response = await fetchJson(tctx, `http://127.0.0.1:${record.port}/scene`, {
          method: 'POST',
          headers: { 'X-AGH-Token': record.token, 'Content-Type': 'application/json' },
          body: '{}',
        })
        report.scene = response.json?.scene ?? null
        report.ok = response.status === 200 && response.json?.ok === true
        if (!report.ok) report.blockers.push(response.json?.error ?? 'scene read failed')
      } catch (error) {
        report.blockers.push(`scene request failed: ${error?.message ?? error}`)
      }
      return report
    }

    registerTool({
      name: 'agh_blender_apply_ops',
      description:
        '先查agh_blender_ops_catalog的真实参数，再把一批结构化opcode应用到受管理实例的场景上（白名单：mesh.primitive_add / mesh.revolve_profile / mesh.sweep_tube / object.transform / object.duplicate / object.delete / material.set / material.assign / object.join）。每批小步执行，整批一个undo步；失败可能已部分执行，先读scene/journal确认，不能整批重发。完成后用agh_blender_capture把实际渲染图交给模型对照原图，不把ops回执当作外形复核。不执行任意Python。',
      parameters: {
        [Symbol.for('TypeBox.Kind')]: 'Object',
        type: 'object',
        properties: {
          ops: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: {
              type: 'object',
              properties: {
                op: { type: 'string' },
                args: { type: 'object' },
              },
              required: ['op'],
              additionalProperties: false,
            },
          },
          undo: { type: 'boolean' },
        },
        required: ['ops'],
        additionalProperties: false,
      },
      meta: {
        isReadOnly: false,
        isDestructive: false,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never',
        costHint: { wallMs: 30000 },
        deferLoading: false,
        requiresApproval: 'always',
      },
      async execute(args, tctx) {
        const payload = jsonSafe(await runOps(tctx, args))
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structured: payload,
          ...(payload.ok === true ? {} : { isError: true }),
        }
      },
    })

    registerTool({
      name: 'agh_blender_scene',
      description:
        'P1 第 ④ 环（只读）：回报受管理实例当前场景的对象/材质/变换与已知 opcode 清单，用于确认上一步到底改成了什么。不修改任何东西。',
      parameters: PROBE_EMPTY_INPUT,
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: { wallMs: 5000 },
        deferLoading: false,
        requiresApproval: 'never',
      },
      async execute(_args, tctx) {
        const payload = jsonSafe(await runScene(tctx))
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structured: payload,
          ...(payload.ok === true ? {} : { isError: true }),
        }
      },
    })

    async function runCatalog(tctx) {
      const { record } = managedInstance(tctx)
      const report = { ok: false, startedAt: new Date().toISOString(), blockers: [] }
      if (!record) {
        report.blockers.push('no managed Blender instance in this workspace; call agh_blender_start first')
        return report
      }
      try {
        const response = await fetchJson(tctx, `http://127.0.0.1:${record.port}/catalog`, {
          method: 'POST',
          headers: { 'X-AGH-Token': record.token, 'Content-Type': 'application/json' },
          body: '{}',
        })
        report.catalog = response.json?.catalog ?? null
        report.ok = response.status === 200 && response.json?.ok === true
        if (!report.ok) report.blockers.push(response.json?.error ?? 'catalog read failed')
      } catch (error) {
        report.blockers.push(`catalog request failed: ${error?.message ?? error}`)
      }
      return report
    }

    registerTool({
      name: 'agh_blender_ops_catalog',
      description:
        'P1 第 ④ 环（只读）：回报 opcode 白名单的完整契约 —— 每个 op 的参数名、类型、默认值、范围、示例与限额，以及全部拒绝码。**在写 ops 批次之前先调它**，不要凭记忆猜参数名。',
      parameters: PROBE_EMPTY_INPUT,
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: { wallMs: 5000 },
        deferLoading: false,
        requiresApproval: 'never',
      },
      async execute(_args, tctx) {
        const payload = jsonSafe(await runCatalog(tctx))
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structured: payload,
          ...(payload.ok === true ? {} : { isError: true }),
        }
      },
    })

    // ---- 第 ⑤ 环：把成品交付出去。Blender 只写进实例的 staging/，最终落盘由 Host 执行 ----

    async function runExport(tctx, args) {
      const { record } = managedInstance(tctx)
      const report = { ok: false, startedAt: new Date().toISOString(), blockers: [] }
      if (!record) {
        report.blockers.push('no managed Blender instance in this workspace; call agh_blender_start first')
        return report
      }
      const destination = typeof args?.destination === 'string' ? args.destination : ''
      if (!destination) {
        report.blockers.push('destination is required: a file path that does not exist yet')
        return report
      }
      // 1) Blender writes a standalone copy into the instance staging area.
      let staged = null
      try {
        const response = await fetchJson(tctx, `http://127.0.0.1:${record.port}/op`, {
          method: 'POST',
          headers: { 'X-AGH-Token': record.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ops: [{ op: 'file.stage_export', args: args?.name ? { name: args.name } : {} }],
            undo: false,
          }),
          timeoutMs: bridgeJobTimeout(tctx),
        })
        staged = response.json?.applied?.[0]?.result ?? null
        if (response.status !== 200 || response.json?.ok !== true || !staged?.path) {
          report.bridge = { status: response.status, body: response.json ?? response.text }
          report.blockers.push(response.json?.failed?.code ?? 'staging failed')
          return report
        }
      } catch (error) {
        report.blockers.push(`staging request failed: ${error?.message ?? error}`)
        return report
      }
      report.staged = { path: staged.path, bytes: staged.bytes, sha256: staged.sha256 }
      report.mainFileUntouched = staged.mainFileUntouched === true
      report.relativeWarning = staged.relativeWarning ?? null
      let bytes
      try {
        if (
          dirname(resolve(staged.path)) !== resolve(record.instanceDir, 'staging') ||
          !/^[a-f0-9]{64}$/.test(staged.sha256)
        )
          throw new Error('Staged export is outside this instance or has no valid digest')
        bytes = readFileSync(staged.path)
        if (
          bytes.length !== staged.bytes ||
          createHash('sha256').update(bytes).digest('hex') !== staged.sha256
        )
          throw new Error('Staged export changed before delivery')
      } catch (error) {
        report.blockers.push(`staging verification failed: ${error?.message ?? error}`)
        return report
      }
      // Refuse an existing destination. The Host seam is audited, but has no
      // exclusive-create option: use unique destinations, not same-path concurrency.
      let existing = null
      try {
        existing = await tctx.fs.stat(destination)
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          report.blockers.push('could not confirm that the export destination is absent')
          return report
        }
      }
      if (existing) {
        report.blockers.push(`destination already exists: ${destination} (this tool never overwrites)`)
        return report
      }
      // 3) The final write is the Host's, so it is audited and subject to the host's own fs policy.
      try {
        await tctx.fs.write(destination, bytes)
      } catch (error) {
        report.blockers.push(`host write failed: ${error?.message ?? error}`)
        return report
      }
      report.destination = destination
      report.bytes = bytes.length
      report.sha256 = createHash('sha256').update(bytes).digest('hex')
      report.ok = report.sha256 === staged.sha256
      if (!report.ok) report.blockers.push('delivered bytes do not match the staged artifact')
      return report
    }

    agnes.registerTool({
      name: 'agh_blender_export',
      description:
        '把当前完整场景导出成独立.blend；先校验实例staging中的字节和摘要，再通过Host审计写盘。目标在检查时已存在则拒绝。每次使用新的UUID/时间戳路径；Host写入接口没有原子排他新建，同名并发写入不受保护。相对贴图路径会告警。导出成功不等于外形与照片相符，必须另看实际渲染图。',
      parameters: tb({
        type: 'object',
        properties: {
          destination: { type: 'string', minLength: 2, maxLength: 4096 },
          name: { type: 'string', maxLength: 96 },
        },
        required: ['destination'],
        additionalProperties: false,
      }),
      meta: {
        isReadOnly: false,
        isDestructive: false,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never',
        costHint: { wallMs: 60000 },
        deferLoading: false,
        requiresApproval: 'always',
      },
      async execute(args, tctx) {
        const payload = jsonSafe(await runExport(tctx, args))
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structured: payload,
          ...(payload.ok === true ? {} : { isError: true }),
        }
      },
    })

    // ---- opening an existing .blend: the difference between a demo scene and a real tool ----

    // Same rule as every other side-effecting tool (P0-F58): the report lands on disk before the
    // result is returned, because opening a document discards the current one and the harness can
    // replace a slow mutating call's result with TOOL_OUTCOME_UNKNOWN.
    function finishOpen(report, instanceDir) {
      const payload = jsonSafe(report)
      if (typeof instanceDir === 'string' && instanceDir.length > 0) {
        try {
          const path = join(instanceDir, 'open-report.json')
          writeJsonFile(path, payload)
          payload.openReportPath = path
        } catch (error) {
          payload.openReportPath = null
          payload.openReportError = String(error?.message ?? error)
        }
      }
      return payload
    }

    async function runOpen(tctx, args) {
      const { record } = managedInstance(tctx)
      const report = { tool: 'agh_blender_open', at: new Date().toISOString(), ok: false, blockers: [] }
      if (!record) {
        report.blockers.push('no managed Blender instance in this workspace; call agh_blender_start first')
        return report
      }
      const path = typeof args?.path === 'string' ? args.path : ''
      if (!path) {
        report.blockers.push('path is required')
        return report
      }
      report.path = path
      report.force = args?.force === true
      let response = null
      try {
        response = await fetchJson(tctx, `http://127.0.0.1:${record.port}/open`, {
          method: 'POST',
          headers: { 'X-AGH-Token': record.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, force: args?.force === true }),
          timeoutMs: bridgeJobTimeout(tctx),
        })
      } catch (error) {
        report.blockers.push(`open request failed: ${error?.message ?? error}`)
        return finishOpen(report, record.instanceDir)
      }
      const body = response.json ?? null
      report.bridge = { status: response.status, body }
      report.ok = response.status === 200 && body?.ok === true
      if (!report.ok) report.blockers.push(body?.code ?? body?.error ?? 'open refused')
      report.documentEpoch = body?.documentEpoch ?? null
      report.previousFilepath = body?.previousFilepath ?? null
      report.wasDirty = body?.wasDirty ?? null
      report.forced = body?.forced ?? null
      report.isDirtyImmediatelyAfterOpen = body?.isDirtyImmediatelyAfterOpen ?? null
      report.opened = body?.scene
        ? { scene: body.scene.scene, objectCount: body.scene.objectCount, materials: body.scene.materials }
        : null
      return finishOpen(report, record.instanceDir)
    }

    agnes.registerTool({
      name: 'agh_blender_open',
      description:
        'P1：在受管理实例里打开一个已有的 .blend（这是"在用户自己的工程上工作"的入口）。它是破坏性操作——当前文档会被替换，所以当前场景有未保存改动时**默认拒绝**（回报 E_DIRTY），除非传 force=true。启动带 --disable-autoexec，文件内嵌脚本不会自动执行。结果（含 documentEpoch）会先落盘到实例目录的 open-report.json。',
      parameters: tb({
        type: 'object',
        properties: {
          path: { type: 'string', minLength: 2, maxLength: 4096 },
          force: { type: 'boolean' },
        },
        required: ['path'],
        additionalProperties: false,
      }),
      meta: {
        isReadOnly: false,
        isDestructive: true,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never',
        costHint: { wallMs: 90000 },
        deferLoading: false,
        requiresApproval: 'always',
      },
      async execute(args, tctx) {
        const payload = jsonSafe(await runOpen(tctx, args))
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          structured: payload,
          ...(payload.ok === true ? {} : { isError: true }),
        }
      },
    })
  },
}
