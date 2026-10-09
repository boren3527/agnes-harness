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
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
      timeoutMs: 1000,
      maxResultBytes: 32768,
      async handler(_input, sctx) {
        const key = normalizeCwd(sctx?.cwd)
        const record = instances.get(key) ?? null
        const alive = record === null ? false : pidAlive(record.pid)
        return {
          ok: true,
          data: {
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
          },
        }
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
        process.env.LOCALAPPDATA
          ? join(process.env.LOCALAPPDATA, 'Programs', 'Blender Foundation')
          : null,
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
      "try { $p = Get-Process -Id " + pid + " -ErrorAction Stop } catch { Write-Output 'GONE'; exit 3 }; " +
      "try { $ticks = $p.StartTime.ToFileTime() } catch { Write-Output ('NO_STARTTIME|' + $_.Exception.Message); exit 4 }; " +
      "Write-Output ($p.ProcessName + '|' + $ticks)"
    // Asks the window to close; never force-kills. A save prompt nobody answers leaves the process
    // running, and STILL_RUNNING is reported honestly instead of escalating to taskkill /F.
    const closeScript = (pid) =>
      "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; " +
      "try { $p = Get-Process -Id " + pid + " -ErrorAction Stop } catch { Write-Output 'GONE'; exit 3 }; " +
      "$r = $p.CloseMainWindow(); $p.WaitForExit(8000) | Out-Null; " +
      "if ($p.HasExited) { Write-Output ('EXITED|requested=' + $r) } else { Write-Output ('STILL_RUNNING|requested=' + $r) }"

    // Identity, not liveness. PIDs are reused, so "pid 1234 is alive" may be an unrelated
    // process. Read image name + creation time (Windows FILETIME ticks) through a probe that
    // goes through tctx.sandbox.confine(); an unconfined probe would be a silent sandbox
    // bypass, so a refusal fails the probe closed instead of falling back.
    // Identity, not liveness. PIDs are reused, so "pid 1234 is alive" may be an unrelated
    // process. The probe is a checked-in .ps1 so it can be run, diffed and tested on its own;
    // it goes through tctx.sandbox.confine() first, because an unconfined probe would be a
    // silent sandbox bypass (a refusal fails the probe closed rather than falling back).
    async function queryProcess(tctx, pid) {
      const rawArgv = psArgv(identityScript(Number(pid)))
      let argv = rawArgv
      try {
        argv = await tctx.sandbox.confine(rawArgv)
      } catch (error) {
        return {
          ok: false,
          refused: true,
          error: 'sandbox.confine refused the process probe: ' + (error?.message ?? error),
        }
      }
      try {
        const r = await tctx.exec(argv, { timeoutMs: 15000 })
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
      const response = await tctx.net.fetch(url, { timeoutMs: 5000, ...(init ?? {}) })
      const text = await response.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: response.status, ok: response.ok === true, json, text: text.slice(0, 400) }
    }

    async function runStart(tctx, args = {}) {
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
      if (!existsSync(BOOTSTRAP_PY)) {
        report.blockers.push(`bootstrap.py missing: ${BOOTSTRAP_PY}`)
        return report
      }
      try {
        report.enforcement = tctx.sandbox.enforcement()
      } catch (error) {
        report.blockers.push(`sandbox.enforcement() failed: ${error?.message ?? error}`)
      }

      const candidates = blenderCandidates()
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
      try {
        const outFd = openSync(stdoutPath, 'a')
        const errFd = openSync(stderrPath, 'a')
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
        child.unref()
        closeSync(outFd)
        closeSync(errFd)
      } catch (error) {
        report.blockers.push(`spawn failed: ${error?.message ?? error}`)
        return report
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
      // Record who this pid actually is, while the ChildProcess object is still ours. A bare
      // pid is not an identity: Windows reuses pids, and a later token-less stop must not
      // close a stranger's window. Best effort — a null identity disables that path, not start.
      report.processIdentity = await queryProcess(tctx, child.pid)

      const kill = (why) => {
        try {
          process.kill(child.pid)
          report.cleanup = { killedPid: child.pid, why }
        } catch (error) {
          report.cleanup = { killedPid: child.pid, why, error: `${error?.message ?? error}` }
        }
      }

      const budgetMs = Math.max(15000, Math.min(60000, (tctx?.timeoutMs ?? 90000) - 10000))
      const deadline = Date.now() + budgetMs
      let portInfo = null
      let health = null
      let lastError = null
      let rounds = 0
      while (Date.now() < deadline) {
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
          ok: hello.json?.ok === true,
          body: hello.json,
          text: hello.ok ? undefined : hello.text,
        }
      } catch (error) {
        report.blockers.push(`handshake failed: ${error?.message ?? error}`)
      }
      report.stderrTail = readFileSafe(stderrPath)

      const key = normalizeCwd(workspaceRoot)
      instances.set(key, {
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
      })
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
      return report
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
            readiness: disk.readiness ? { rounds: disk.readiness.rounds, budgetMs: disk.readiness.budgetMs, lastError: disk.readiness.lastError ?? null } : null,
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
      if (identity.refused)
        return { ok: false, stage: 'identity', refused: true, error: identity.error }
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
      let argv = rawArgv
      try {
        argv = await tctx.sandbox.confine(rawArgv)
      } catch (error) {
        return {
          ok: false,
          stage: 'confine',
          refused: true,
          error: 'sandbox.confine refused the graceful stop: ' + (error?.message ?? error),
        }
      }
      try {
        const r = await tctx.exec(argv, { timeoutMs: 20000 })
        const text = String(r?.stdout ?? '').trim().split(/\r?\n/).pop()
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
          exec: { code: r?.code ?? null, stdout: String(r?.stdout ?? '').slice(0, 400), stderr: String(r?.stderr ?? '').slice(0, 400) },
          code: r?.code ?? null,
          note:
            text.startsWith('EXITED')
              ? 'window closed through Blender\'s normal exit path'
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
        if (!disk)
          return { ok: false, note: 'no managed instance held in memory for this workspace' }
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
        return finishStop(
          {
            tool: 'agh_blender_stop',
            at: new Date().toISOString(),
            mode: 'token',
            pid: record.pid,
            stage: 'close',
            ok: false,
            blockers: [`transport: ${error?.message ?? error}`],
            forceKilled: false,
            elapsedMs: Date.now() - startedAt,
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
      let response = null
      try {
        response = await fetchJson(tctx, `http://127.0.0.1:${record.port}/capture`, {
          method: 'POST',
          headers: { 'X-AGH-Token': record.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ width, height, colorManagement }),
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
      let bytes = null
      try {
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
        diskBytes: bytes.length,
        shaMatchesDisk: diskSha === shot.sha256,
        sessionKey: tctx?.session?.key ?? null,
      }
      // P0-F79/F91/F128/F174 -- the escape hatch is gone, deliberately.
      // An image block inside a tool result can never be read back: the request media surface only
      // admits artifacts that came from the computer-use channel, so the turn settles as
      // E_STEP_FAILED and that session is poisoned for good. Measured twice; the second time the
      // model reached the block by passing inline:true itself, so "off by default" is not a guard.
      // This tool therefore never returns an image block and never registers an artifact. It reports
      // the PNG's path, digest and size; the picture's audience is the human.
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      report.artifact = {
        ref: null,
        registered: false,
        note: 'never registered: an image block in a tool result fails the turn and poisons the session',
      }
      report.png = {
        path: shot.path,
        file: shot.file,
        bytes: bytes.length,
        sha256,
        shaMatchesBridge: sha256 === shot.sha256,
      }
      report.ok = true
      return report
    }

    registerTool({
      name: 'agh_blender_start',
      description:
        'P0-3 启动链探针：发现本机 blender.exe（校验版本）→ 构造固定 argv → 经 tctx.sandbox.confine() → 在 127.0.0.1 上拉起一个受管理的 GUI Blender 并完成 token 握手。会真实打开 Blender 窗口；不安装扩展、不改用户偏好、不执行任意 Python。',
      parameters: tb({
        type: 'object',
        properties: {
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
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structured: payload }
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
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structured: payload }
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
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structured: payload }
      },
    })

    registerTool({
      name: 'agh_blender_capture',
      description:
        'P0-4 图片链探针：在受管理实例里离屏渲染当前 3D 视图（一次颜色管理 + 标准库 PNG，不用 Pillow/save_render），**永不把图片作为内容块返回**（工具结果里的图片块会让这一轮直接失败并永久毒化会话，实测两次）；只回报 PNG 的磁盘路径、sha256 与字节数，图是给人看的。只读场景，只在实例目录里写文件。',
      parameters: {
        [Symbol.for('TypeBox.Kind')]: 'Object',
        type: 'object',
        properties: {
          width: { type: 'integer', minimum: 16, maximum: 4096 },
          height: { type: 'integer', minimum: 16, maximum: 4096 },
          colorManagement: { type: 'boolean' },
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
      },
      async execute(args, tctx) {
        const payload = jsonSafe(await runCapture(tctx, args))
        const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
        return { content, structured: payload }
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
        })
      } catch (error) {
        report.blockers.push(`op request failed: ${error?.message ?? error}`)
        return report
      }
      report.bridge = { status: response.status }
      report.result = response.json ?? { raw: response.text }
      report.ok = response.status === 200 && response.json?.ok === true
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
        'P1 第 ④ 环：把一批结构化 opcode 应用到受管理实例的场景上（白名单：mesh.primitive_add / object.transform / object.duplicate / object.delete / material.set / material.assign / object.join）。一次一小步，整批只推一个 undo 步。不执行任意 Python。',
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
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structured: payload }
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
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structured: payload }
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
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structured: payload }
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
        })
        staged = response.json?.applied?.[0]?.result ?? null
        if (!staged?.path) {
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
      // 2) Refuse to overwrite. Checked here as well as at the seam, because "the exporter replaced my
      //    file" is the one mistake that cannot be undone from inside this tool.
      let existing = null
      try {
        existing = await tctx.fs.stat(destination)
      } catch {
        existing = null
      }
      if (existing) {
        report.blockers.push(`destination already exists: ${destination} (this tool never overwrites)`)
        return report
      }
      // 3) The final write is the Host's, so it is audited and subject to the host's own fs policy.
      const bytes = readFileSync(staged.path)
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
        'P1 第 ⑤ 环：把当前场景导出成一个独立 .blend 交付出去。Blender 只写进实例的 staging/，最终落盘由 Host 的 fs.write 完成（有审计）。目标文件已存在时**拒绝**，绝不覆盖；场景里有相对贴图路径时会在结果里明确告警。',
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
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structured: payload }
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
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structured: payload }
      },
    })
  },
}
