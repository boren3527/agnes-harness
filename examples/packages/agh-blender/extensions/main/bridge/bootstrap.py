"""P0-3 minimal Blender-side bridge.

Launched by the AGH host exactly as:

    blender.exe --factory-startup --disable-autoexec --python-exit-code 1 \
        --python <this file> -- --agh-bridge-config <config.json>

Contract for this probe (deliberately small):
  * binds 127.0.0.1 only; prefers the port requested by the config and falls back
    to an ephemeral port when that port is taken,
  * the shared secret comes from the environment variable
    AGH_BLENDER_BRIDGE_TOKEN and from nowhere else,
  * every read of bpy state happens on Blender's main thread through
    bpy.app.timers; the HTTP threads only enqueue work and wait,
  * there is no endpoint that runs arbitrary Python,
  * user preferences are never written back: --factory-startup means the factory
    preferences are in memory, so `save_userpref()` would destroy the real ones.
"""

import json
import os
import queue
import secrets
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import bpy
except ImportError:  # only reachable when run outside Blender
    sys.stderr.write('[agh-bridge] this script must run inside Blender\n')
    raise SystemExit(2)

# P0-F160: this bridge runs from a content-addressed runtime snapshot, so writing .pyc files beside
# these modules changes that snapshot's tree hash -- after which every package operation (disable,
# enable, update, remove) fails with E_PACKAGE_INTEGRITY until the cache is deleted by hand.
# Measured 2026-10-06: Blender's embedded CPython IGNORES PYTHONDONTWRITEBYTECODE=1 (the variable
# reaches the process, sys.dont_write_bytecode still reads False, and __pycache__ is still written),
# so this assignment is the only effective guard -- and it has to happen BEFORE the sibling imports
# below, otherwise those imports have already written the cache.
sys.dont_write_bytecode = True

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import agh_capture
except Exception:  # a broken capture module must not take the whole bridge down
    agh_capture = None
try:
    import agh_ops
except Exception:  # same rule for the opcode table
    agh_ops = None
PROTOCOL = 1
BRIDGE = 'agh-blender-bridge'
VERSION = '0.0.2'
JOURNAL_LOCK = threading.Lock()


def journal_append(record):
    """Append-only trail beside the instance.

    A mutating tool's only result copy must not live in the return value, because a
    synthetic TOOL_OUTCOME_UNKNOWN can discard it; the journal is the copy that survives.
    """
    try:
        with JOURNAL_LOCK:
            with open(os.path.join(INSTANCE_DIR, 'journal.jsonl'), 'a', encoding='utf-8') as handle:
                handle.write(json.dumps(record, sort_keys=True) + '\n')
    except Exception as exc:  # journaling must never take the bridge down
        sys.stderr.write('[agh-bridge] journal append failed: %r\n' % (exc,))
TOKEN = os.environ.get('AGH_BLENDER_BRIDGE_TOKEN') or ''

CONFIG = {}
INSTANCE_DIR = ''
STARTED_AT = time.time()
JOBS = queue.Queue()
STATE = {'ticks': 0, 'handshakes': 0, 'mainThreadId': None, 'splashWasVisible': None, 'documentEpoch': 0}


def log(message):
    sys.stderr.write('[agh-bridge] %s\n' % message)
    sys.stderr.flush()


def script_args():
    argv = list(sys.argv)
    if '--' in argv:
        return argv[argv.index('--') + 1:]
    return []


def load_config():
    args = script_args()
    path = None
    for index, value in enumerate(args):
        if value == '--agh-bridge-config' and index + 1 < len(args):
            path = args[index + 1]
    if path is None:
        raise RuntimeError('missing --agh-bridge-config argument')
    # utf-8-sig: tolerate a BOM. Node writes plain UTF-8, but a hand-written or
    # PowerShell-written config must not take the whole bridge down.
    with open(path, 'r', encoding='utf-8-sig') as handle:
        return json.load(handle)


def write_json_atomic(path, payload):
    temp = path + '.tmp'
    with open(temp, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def _win32_creation_ticks(pid):
    """Process creation time as Windows FILETIME ticks, or None off-Windows.

    PID reuse is the reason this exists: `pid` alone cannot tell this Blender from a later
    process that inherited its number. Node records the same ticks at spawn time and refuses
    the token-less stop path if they differ.
    """
    if os.name != 'nt':
        return None
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
        ctypes.POINTER(wintypes.FILETIME),
    ]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return None
    try:
        created = wintypes.FILETIME()
        exit_time = wintypes.FILETIME()
        kernel_time = wintypes.FILETIME()
        user_time = wintypes.FILETIME()
        if not kernel32.GetProcessTimes(
            handle,
            ctypes.byref(created),
            ctypes.byref(exit_time),
            ctypes.byref(kernel_time),
            ctypes.byref(user_time),
        ):
            return None
        return (created.dwHighDateTime << 32) | created.dwLowDateTime
    finally:
        kernel32.CloseHandle(handle)


def hide_splash():
    """Session-only: never persisted (see the module docstring)."""
    try:
        view = bpy.context.preferences.view
        was = bool(getattr(view, 'show_splash', False))
        if STATE['splashWasVisible'] is None:
            STATE['splashWasVisible'] = was
        view.show_splash = False
        return was
    except Exception:
        return None


def scene_summary():
    scene = bpy.context.scene
    names = [{'name': obj.name, 'type': obj.type} for obj in scene.objects]
    return {
        'executedOnMainThread': True,
        'mainThreadId': threading.get_ident(),
        'mainThreadTicks': STATE['ticks'],
        'blenderVersion': bpy.app.version_string,
        'binaryPath': bpy.app.binary_path,
        'factoryStartup': bool(bpy.app.factory_startup),
        'background': bool(bpy.app.background),
        'file': bpy.data.filepath,
        'isDirty': bool(bpy.data.is_dirty),
        'scene': scene.name,
        'sceneCount': len(bpy.data.scenes),
        'frameCurrent': scene.frame_current,
        'objectCount': len(names),
        'objects': names[:20],
        'sysArgv': list(sys.argv),
        # What the requested `empty: true` actually did at startup (None when not requested).
        # Reported rather than assumed: the caller must be able to see whether the clear happened.
        'clearedAtStartup': STATE.get('clearedAtStartup'),
    }


def clear_startup_scene():
    """Remove every object the factory startup scene carries (Cube / Light / Camera).

    Runs through the main-thread queue. Rationale: `file.stage_export` writes the WHOLE scene, so
    unless this happens here, every delivered .blend carries the factory cube. Doing it at startup
    (instead of asking the caller to emit object.delete + purge) keeps "the scene is what our ops
    created" true, so an exported file and its ops.json describe the same thing.

    Orphaned meshes/materials are left for `data.purge_unused`; Blender does not write zero-user
    datablocks into a saved file anyway.
    """
    removed = [obj.name for obj in bpy.data.objects]
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    bpy.context.view_layer.update()
    return {
        'removed': removed,
        'removedCount': len(removed),
        'objectCount': len(bpy.data.objects),
        'isDirtyAfterClear': bool(bpy.data.is_dirty),
    }


def run_on_main_thread(fn, timeout):
    job = {'fn': fn, 'done': threading.Event(), 'result': None, 'error': None,
           'state': 'queued', 'lock': threading.Lock(), 'deadline': time.monotonic() + timeout}
    JOBS.put(job)
    if not job['done'].wait(max(0, job['deadline'] - time.monotonic())):
        with job['lock']:
            if job['state'] == 'queued':
                job['state'] = 'cancelled'
                job['done'].set()
                raise TimeoutError('queued operation expired before execution; nothing was applied')
            if job['state'] == 'running':
                # Blender cannot safely interrupt an executing render/opcode. Check the journal
                # and scene before any subsequent write; never replay the timed-out operation.
                raise TimeoutError('operation already running; outcome unknown, do not replay')
    if job['error']:
        raise RuntimeError(job['error'])
    return job['result']


def pump():
    """Runs on Blender's main thread. Drains queued jobs, then re-arms."""
    STATE['ticks'] += 1
    STATE['mainThreadId'] = threading.get_ident()
    if STATE['ticks'] <= 3:
        hide_splash()
    while True:
        try:
            job = JOBS.get_nowait()
        except queue.Empty:
            break
        with job['lock']:
            if job['state'] == 'cancelled' or time.monotonic() >= job['deadline']:
                job['state'] = 'cancelled'
                job['error'] = 'queued operation expired before execution; nothing was applied'
                job['done'].set()
                continue
            job['state'] = 'running'
        try:
            job['result'] = job['fn']()
        except Exception as exc:
            job['error'] = '%s: %s' % (type(exc).__name__, exc)
            log('job failed: %s\n%s' % (job['error'], traceback.format_exc()))
        finally:
            with job['lock']:
                job['state'] = 'finished'
                job['done'].set()
    return 0.05


def quit_soon():
    log('shutdown requested; quitting Blender')
    try:
        bpy.ops.wm.quit_blender()
    except Exception:
        log('quit_blender failed: %s' % traceback.format_exc())
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = BRIDGE + '/' + VERSION

    def log_message(self, fmt, *args):
        return

    def token_ok(self):
        supplied = self.headers.get('X-AGH-Token') or ''
        return bool(TOKEN) and secrets.compare_digest(supplied, TOKEN)

    def run_job(self, fn, timeout):
        remaining = self.request_deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('request expired before execution; nothing was applied')
        return run_on_main_thread(fn, min(timeout, remaining))

    def send_json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {
                'ok': True,
                'bridge': BRIDGE,
                'protocol': PROTOCOL,
                'version': VERSION,
                'pid': os.getpid(),
                'port': self.server.server_address[1],
                'blenderVersion': bpy.app.version_string,
                'mainThreadTicks': STATE['ticks'],
                'handshakes': STATE['handshakes'],
                'uptimeMs': int((time.time() - STARTED_AT) * 1000),
                'authRequired': True,
            })
            return
        self.send_json(404, {'ok': False, 'error': 'not_found', 'path': self.path})

    def do_POST(self):
        received_at = time.monotonic()
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b''
        if not self.token_ok():
            self.send_json(401, {'ok': False, 'error': 'unauthorized'})
            return
        try:
            budget_ms = int(self.headers.get('X-AGH-Timeout-Ms') or 95000)
            if not 1 <= budget_ms <= 95000:
                raise ValueError('invalid request budget')
        except ValueError:
            self.send_json(400, {'ok': False, 'error': 'bad_timeout'})
            return
        # Finish before the Host network timeout. The budget includes queueing and body reading.
        self.request_deadline = received_at + budget_ms / 1000.0 - .25
        try:
            body = json.loads(raw.decode('utf-8')) if raw else {}
        except ValueError:
            self.send_json(400, {'ok': False, 'error': 'bad_json'})
            return
        if self.path == '/hello':
            try:
                summary = self.run_job(scene_summary, timeout=20.0)
            except Exception as exc:
                self.send_json(504, {'ok': False, 'error': 'main_thread_unavailable',
                                     'detail': '%s: %s' % (type(exc).__name__, exc)})
                return
            STATE['handshakes'] += 1
            self.send_json(200, {
                'ok': True,
                'bridge': BRIDGE,
                'protocol': PROTOCOL,
                'version': VERSION,
                'pid': os.getpid(),
                'port': self.server.server_address[1],
                'echo': body,
                'handshake': summary,
            })
            return
        if self.path == '/shutdown':
            # Measured 2026-10-06: bpy.ops.wm.quit_blender() does NOT run Blender's save-confirmation
            # flow, so closing this way discards unsaved work silently (Blender only leaves a session
            # recovery file in the OS temp directory). A dirty scene is therefore refused unless the
            # caller explicitly says force. Reading bpy state has to happen on the main thread, so the
            # check is queued like every other read.
            force = bool(body.get('force', False))

            def check_dirty():
                return bool(bpy.data.is_dirty)

            try:
                dirty = bool(self.run_job(check_dirty, timeout=5.0))
            except Exception as exc:  # a failed check must never become a silent discard
                self.send_json(500, {
                    'ok': False,
                    'error': 'dirty_check_failed',
                    'detail': '%s: %s' % (type(exc).__name__, exc),
                    'note': 'nothing was closed',
                })
                return
            if dirty and not force:
                self.send_json(409, {
                    'ok': False,
                    'code': 'E_DIRTY',
                    'isDirty': True,
                    'note': ('the scene has unsaved changes, and closing this way never asks to save '
                             'them; save in Blender first, or call again with force=true to discard them'),
                })
                return
            self.send_json(200, {'ok': True, 'closing': True, 'isDirty': dirty, 'forced': bool(dirty and force)})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            bpy.app.timers.register(quit_soon, first_interval=0.3)
            return
        if self.path == '/capture':
            if agh_capture is None:
                self.send_json(503, {'ok': False, 'error': 'capture_module_unavailable'})
                return
            width = body.get('width')
            height = body.get('height')
            color_management = bool(body.get('colorManagement', True))
            # 'all' (default) frames the scene bounds before reading the matrices; 'none' keeps
            # the previous behaviour. Unknown values fall back to 'all' rather than failing the
            # capture: an unframed image is the defect, not a preference.
            frame = body.get('frame') if body.get('frame') in ('all', 'none') else 'all'

            def job():
                if body.get('camera') is not None:
                    return agh_capture.capture_scene(INSTANCE_DIR, camera=body['camera'], width=width, height=height)
                return agh_capture.capture_viewport(
                    INSTANCE_DIR,
                    width=width,
                    height=height,
                    color_management=color_management,
                    frame=frame,
                )

            try:
                result = self.run_job(job, timeout=90.0)
            except Exception as exc:
                self.send_json(500, {
                    'ok': False,
                    'error': 'capture_failed',
                    'detail': '%s: %s' % (type(exc).__name__, exc),
                    'traceback': traceback.format_exc()[-1200:],
                })
                return
            self.send_json(200, result)
            return
        if self.path == '/catalog':
            if agh_ops is None:
                self.send_json(503, {'ok': False, 'error': 'ops_module_unavailable'})
                return
            self.send_json(200, {'ok': True, 'catalog': agh_ops.catalog()})
            return
        if self.path == '/open':
            # Replaces the whole document, so it reuses the same guard as /shutdown: a dirty scene is
            # refused unless the caller explicitly says force. Auto-execution of scripts embedded in
            # the opened file is off for the whole session (the launcher passes --disable-autoexec),
            # and the file itself is opened by Blender, not by this bridge.
            path = body.get('path')
            force = bool(body.get('force', False))
            if not isinstance(path, str) or not path:
                self.send_json(400, {'ok': False, 'code': 'E_ARG_MISSING', 'note': 'path is required'})
                return
            target = os.path.abspath(path)

            def open_job():
                if not os.path.isfile(target):
                    return {'ok': False, 'code': 'E_NO_SUCH_FILE', 'note': 'no such file: %s' % target}
                was_dirty = bool(bpy.data.is_dirty)
                if was_dirty and not force:
                    return {
                        'ok': False,
                        'code': 'E_DIRTY',
                        'isDirty': True,
                        'note': ('the current scene has unsaved changes, and opening another file '
                                 'discards them; save first, or call again with force=true'),
                    }
                before = bpy.data.filepath
                bpy.ops.wm.open_mainfile(filepath=target)
                STATE['documentEpoch'] = int(STATE.get('documentEpoch', 0)) + 1
                return {
                    'ok': True,
                    'path': target,
                    'previousFilepath': before,
                    'wasDirty': was_dirty,
                    'forced': bool(was_dirty and force),
                    # Measured: read immediately after the operator this can still be True even
                    # though the freshly opened document is clean -- it settles on the next tick
                    # (the follow-up open in the preflight was accepted without force). The field
                    # is named so nobody mistakes it for the settled state.
                    'isDirtyImmediatelyAfterOpen': bool(bpy.data.is_dirty),
                    'documentEpoch': STATE['documentEpoch'],
                    'scene': agh_ops.describe_scene() if agh_ops is not None else None,
                }

            try:
                opened = self.run_job(open_job, timeout=90.0)
            except Exception as exc:
                self.send_json(500, {
                    'ok': False,
                    'error': 'open_failed',
                    'detail': '%s: %s' % (type(exc).__name__, exc),
                    'traceback': traceback.format_exc()[-1200:],
                })
                return
            if opened.get('ok'):
                self.send_json(200, opened)
            elif opened.get('code') == 'E_DIRTY':
                self.send_json(409, opened)
            else:
                self.send_json(400, opened)
            return
        if self.path == '/scene':
            if agh_ops is None:
                self.send_json(503, {'ok': False, 'error': 'ops_module_unavailable'})
                return
            try:
                result = self.run_job(agh_ops.describe_scene, timeout=30.0)
            except Exception as exc:
                self.send_json(500, {'ok': False, 'error': 'scene_failed', 'detail': '%s: %s' % (type(exc).__name__, exc)})
                return
            self.send_json(200, {'ok': True, 'scene': result, 'documentEpoch': int(STATE.get('documentEpoch', 0))})
            return
        if self.path == '/op':
            if agh_ops is None:
                self.send_json(503, {'ok': False, 'error': 'ops_module_unavailable'})
                return
            unknown_body = sorted(set(body.keys()) - {'ops', 'op', 'args', 'undo'})
            if unknown_body:
                # Fail closed: a top-level key we do not understand must never be dropped
                # silently, or a caller could smuggle a field past the validator.
                self.send_json(400, {
                    'ok': False,
                    'error': 'E_BAD_RECORD',
                    'detail': 'unknown body keys: %s' % ', '.join(unknown_body),
                })
                return
            records = body.get('ops')
            if records is None:
                records = [{'op': body.get('op'), 'args': body.get('args', {})}]
            undo = bool(body.get('undo', True))

            def job():
                # The ops module needs to know where the instance lives: checkpoint and staging
                # targets are derived from it, and it must never fall back to a user directory.
                agh_ops.set_instance_dir(INSTANCE_DIR)
                if undo:
                    # One undo step for the whole batch: a wrong batch is one Ctrl+Z away.
                    try:
                        bpy.ops.ed.undo_push(message='agh op batch')
                    except Exception:
                        pass
                # run_on_main_thread re-wraps exceptions, so a batch-level rejection is
                # turned into the same shape as a per-op one here, and still reports 400.
                try:
                    outcome = agh_ops.apply_batch(records)
                except agh_ops.OpError as exc:
                    outcome = {
                        'ok': False,
                        'applied': [],
                        'failed': {'index': -1, 'code': exc.code, 'message': exc.message},
                    }
                bpy.context.view_layer.update()
                outcome['scene'] = agh_ops.describe_scene()
                journal_append({
                    'kind': 'op-batch',
                    'at': time.time(),
                    'ops': [record.get('op') for record in records],
                    'ok': outcome.get('ok'),
                    'applied': len(outcome.get('applied', [])),
                    'failed': outcome.get('failed'),
                    'objectCount': outcome['scene'].get('objectCount'),
                })
                return outcome

            try:
                result = self.run_job(job, timeout=90.0)
            except agh_ops.OpError as exc:
                self.send_json(400, {'ok': False, 'error': exc.code, 'detail': exc.message})
                return
            except Exception as exc:
                self.send_json(500, {
                    'ok': False,
                    'error': 'op_failed',
                    'detail': '%s: %s' % (type(exc).__name__, exc),
                    'traceback': traceback.format_exc()[-1200:],
                })
                return
            self.send_json(200 if result.get('ok') else 400, result)
            return
        self.send_json(404, {'ok': False, 'error': 'not_found', 'path': self.path})


def bind_server():
    requested = int(CONFIG.get('port') or 0)
    attempts = [requested, 0] if requested else [0]
    last = None
    for candidate in attempts:
        try:
            server = ThreadingHTTPServer(('127.0.0.1', candidate), Handler)
            server.daemon_threads = True
            return server
        except OSError as exc:
            last = exc
            log('bind 127.0.0.1:%s failed: %s' % (candidate, exc))
    raise RuntimeError('no loopback port available: %s' % last)


def main():
    global CONFIG, INSTANCE_DIR
    CONFIG = load_config()
    INSTANCE_DIR = CONFIG['instanceDir']
    if not TOKEN:
        raise RuntimeError('AGH_BLENDER_BRIDGE_TOKEN is empty; refusing to start')
    if not os.path.isdir(INSTANCE_DIR):
        os.makedirs(INSTANCE_DIR, exist_ok=True)

    hide_splash()
    bpy.app.timers.register(pump, first_interval=0.01, persistent=True)

    # `empty: true` in the launch config: clear the factory startup scene before anything can be
    # observed. Called DIRECTLY, like hide_splash() above: main() already runs on Blender's main
    # thread, and run_on_main_thread() would deadlock here (the pump timer cannot fire while the
    # main thread is blocked waiting for it).
    if CONFIG.get('empty') is True:
        try:
            result = clear_startup_scene()
            STATE['clearedAtStartup'] = result
            log('startup scene cleared: removed %d object(s), %d left'
                % (result['removedCount'], result['objectCount']))
        except Exception:
            # A failed clear must not leave a half-started instance claiming to be empty.
            STATE['clearedAtStartup'] = {'error': traceback.format_exc()[-400:]}
            log('startup clear failed: %s' % STATE['clearedAtStartup']['error'])
            raise

    server = bind_server()
    port = server.server_address[1]
    write_json_atomic(os.path.join(INSTANCE_DIR, 'port.json'), {
        'port': port,
        'pid': os.getpid(),
        # Creation time (100ns ticks since 1601-01-01). PIDs are reused, so a bare `pid` is not
        # an identity. Node records the same value at spawn and re-checks it before any
        # token-less stop, so a recycled PID cannot be mistaken for this instance.
        'startedAtWin32': _win32_creation_ticks(os.getpid()),
        'bridge': BRIDGE,
        'protocol': PROTOCOL,
        'version': VERSION,
        'blenderVersion': bpy.app.version_string,
        'requestedPort': CONFIG.get('port'),
        'wroteAt': time.time(),
    })
    log('listening on 127.0.0.1:%d (pid %d, requested %s)' % (port, os.getpid(), CONFIG.get('port')))
    sys.stdout.write('[agh-bridge] ready port=%d pid=%d\n' % (port, os.getpid()))
    sys.stdout.flush()

    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.2}, daemon=True)
    thread.start()


if __name__ == '__main__':
    main()
