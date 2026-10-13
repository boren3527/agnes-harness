"""Offline bridge queue regressions; does not import bpy or start a server."""
import ast
import io
import queue
import threading
import time
import traceback
import unittest
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from types import SimpleNamespace

source = Path(__file__).resolve().parent.parent / 'packages/agh-blender/extensions/main/bridge/bootstrap.py'
tree = ast.parse(source.read_text(encoding='utf-8'))
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)
             and node.name in ('run_on_main_thread', 'pump')]


class QueueChecks(unittest.TestCase):
    def setUp(self):
        self.scope = {
            'queue': queue, 'threading': threading, 'time': time, 'traceback': traceback,
            'JOBS': queue.Queue(), 'STATE': {'ticks': 4},
            'log': lambda message: None,
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), 'exec'), self.scope)

    def test_expired_queued_operation_never_mutates_scene(self):
        changes = []
        with self.assertRaises(TimeoutError):
            self.scope['run_on_main_thread'](lambda: changes.append('changed'), .01)
        self.scope['pump']()
        self.assertEqual(changes, [])

    def test_completed_operation_returns_result(self):
        result = []
        worker = threading.Thread(target=lambda: result.append(
            self.scope['run_on_main_thread'](lambda: 'done', 1)))
        worker.start()
        deadline = time.monotonic() + 1
        while self.scope['JOBS'].empty() and time.monotonic() < deadline:
            time.sleep(.001)
        self.scope['pump']()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(result, ['done'])

    def test_failed_operation_does_not_block_the_next_job(self):
        results = []

        def broken():
            raise ValueError('fixture failure')

        def request(fn):
            try:
                results.append(self.scope['run_on_main_thread'](fn, 1))
            except RuntimeError as error:
                results.append(str(error))

        workers = [threading.Thread(target=request, args=(fn,)) for fn in (broken, lambda: 'next result')]
        for worker in workers:
            worker.start()
        deadline = time.monotonic() + 1
        while self.scope['JOBS'].qsize() < 2 and time.monotonic() < deadline:
            time.sleep(.001)
        self.scope['pump']()
        for worker in workers:
            worker.join(1)
            self.assertFalse(worker.is_alive())
        self.assertCountEqual(results, ['ValueError: fixture failure', 'next result'])

    def test_running_timeout_is_unknown_and_not_replayed(self):
        started, release = threading.Event(), threading.Event()
        outcomes, changes = [], []

        def operation():
            started.set()
            release.wait(1)
            changes.append('once')

        def request():
            try:
                self.scope['run_on_main_thread'](operation, .03)
            except TimeoutError as error:
                outcomes.append(str(error))

        caller = threading.Thread(target=request)
        caller.start()
        deadline = time.monotonic() + 1
        while self.scope['JOBS'].empty() and time.monotonic() < deadline:
            time.sleep(.001)
        main = threading.Thread(target=self.scope['pump'])
        main.start()
        self.assertTrue(started.wait(1))
        caller.join(1)
        release.set()
        main.join(1)
        self.assertEqual(changes, ['once'])
        self.assertEqual(len(outcomes), 1)
        self.assertIn('already running', outcomes[0])

    def test_request_budget_reaches_queue_and_invalid_budget_is_refused(self):
        handler_node = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                            and node.name == 'Handler')
        self.scope.update({
            'BaseHTTPRequestHandler': BaseHTTPRequestHandler, 'BRIDGE': 'test', 'VERSION': 'test',
            'TOKEN': 'fixture', 'secrets': __import__('secrets'), 'json': __import__('json'),
            'PROTOCOL': 1, 'os': __import__('os'), 'scene_summary': lambda: {},
            'STATE': {'handshakes': 0},
        })
        exec(compile(ast.Module(body=[handler_node], type_ignores=[]), str(source), 'exec'), self.scope)
        budgets = []
        self.scope['run_on_main_thread'] = lambda fn, timeout: budgets.append(timeout) or fn()
        for budget, expected in [('29000', 200), ('-1', 400), ('bad', 400), ('95001', 400)]:
            handler = self.scope['Handler'].__new__(self.scope['Handler'])
            handler.path = '/hello'
            handler.headers = {'X-AGH-Token': 'fixture', 'X-AGH-Timeout-Ms': budget}
            handler.rfile = io.BytesIO(b'')
            handler.server = SimpleNamespace(server_address=('127.0.0.1', 1234))
            replies = []
            handler.send_json = lambda status, payload: replies.append((status, payload))
            handler.do_POST()
            self.assertEqual(replies[0][0], expected)
        self.assertEqual(budgets, [20.0])  # /hello retains its lower 20 s bound.

    def test_expired_request_does_not_enqueue_and_short_budget_is_honored(self):
        method = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'Handler')
        run_job = next(node for node in method.body if isinstance(node, ast.FunctionDef) and node.name == 'run_job')
        exec(compile(ast.Module(body=[run_job], type_ignores=[]), str(source), 'exec'), self.scope)
        budgets = []
        self.scope['run_on_main_thread'] = lambda fn, timeout: budgets.append(timeout)
        with self.assertRaises(TimeoutError):
            self.scope['run_job'](SimpleNamespace(request_deadline=time.monotonic() - 1), lambda: None, 90)
        self.assertEqual(budgets, [])
        self.scope['run_job'](SimpleNamespace(request_deadline=time.monotonic() + 2), lambda: None, 90)
        self.assertGreater(budgets[0], 1)
        self.assertLessEqual(budgets[0], 2)


if __name__ == '__main__':
    unittest.main(argv=[str(source)])
