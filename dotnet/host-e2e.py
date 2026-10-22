#!/usr/bin/env python3
"""One bounded localhost end-to-end flow for the experimental .NET HTTP host."""
import http.client
import json
import os
import pathlib
import shutil
import signal
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

TOKEN = "local-test-api-token"
PROVIDER_TOKEN = "local-test-provider-token"
REQUESTS = []
REQUEST_LOCK = threading.Lock()
ALPHA_RELEASE = threading.Event()
HELD_REQUEST = threading.Event()
HELD_CLOSED = threading.Event()
PROGRESS_SEEN = threading.Event()
B_REQUEST_SEEN = threading.Event()


def wait_until(check, label, timeout=20):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = check()
        if value:
            return value
        time.sleep(.025)
    raise AssertionError(f"timeout waiting for {label}")


def response(output):
    return {"type": "response.completed", "response": {"output": output}}


def text_response(text):
    return response([{"type": "message", "role": "assistant", "phase": "final_answer",
                      "content": [{"type": "output_text", "text": text}]}])


def call_response(call_id, name, args):
    return response([{"type": "function_call", "call_id": call_id, "name": name,
                      "arguments": json.dumps(args, ensure_ascii=False, separators=(',', ':'))}])


class Provider(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def do_POST(self):
        assert self.path == '/responses'
        assert self.headers.get('Authorization') == 'Bearer ' + PROVIDER_TOKEN
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        tools = {entry['name']: entry for entry in payload['tools']}
        # This consumer calls read/write below; unrelated catalog order is not a contract.
        assert 'read_exec' not in tools
        for name in ('read', 'write'):
            assert 'filePath' in tools[name]['parameters']['required']
        input_text = json.dumps(payload['input'], ensure_ascii=False)
        with REQUEST_LOCK:
            REQUESTS.append(payload)
        if 'beta first' in input_text:
            B_REQUEST_SEEN.set()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'close')
        self.end_headers()

        def event(data):
            self.wfile.write(b'data: ' + json.dumps(data, ensure_ascii=False).encode() + b'\n\n')
            self.wfile.flush()

        if 'alpha stop' in input_text:
            HELD_REQUEST.set()
            # Remain in an accepted, open SSE body until Stop closes the client socket.
            self.connection.settimeout(15)
            try:
                while self.connection.recv(4096):
                    pass
            except (ConnectionResetError, OSError):
                pass
            HELD_CLOSED.set()
            return
        if 'alpha first' in input_text and 'alpha second' not in input_text:
            event({'type': 'response.output_item.added', 'output_index': 0,
                   'item': {'type': 'message', 'role': 'assistant', 'content': []}})
            event({'type': 'response.output_text.delta', 'output_index': 0, 'content_index': 0,
                   'delta': 'alp'})
            ALPHA_RELEASE.wait(10)
            event({'type': 'response.output_text.delta', 'output_index': 0, 'content_index': 0,
                   'delta': 'ha'})
            event(text_response('alpha'))
            return
        if 'alpha second' in input_text:
            event(text_response('alpha again'))
            return
        calls = [entry for entry in payload['input'] if entry.get('type') == 'function_call']
        if 'beta resume' in input_text:
            if not any(call['call_id'] == 'beta-no-overwrite' for call in calls):
                event(call_response('beta-no-overwrite', 'write', {'filePath': 'note.txt', 'content': 'wrong'}))
            elif not any(call['call_id'] == 'beta-outside' for call in calls):
                event(call_response('beta-outside', 'read', {'filePath': '../outside.txt'}))
            elif not any(call['call_id'] == 'beta-overwrite' for call in calls):
                event(call_response('beta-overwrite', 'write', {'filePath': 'note.txt', 'content': 'updated', 'overwrite': True}))
            else:
                event(text_response('beta resumed'))
            return
        if not any(call['call_id'] == 'beta-write' for call in calls):
            event(call_response('beta-write', 'write', {'filePath': 'note.txt', 'content': 'héllo'}))
        elif not any(call['call_id'] == 'beta-read' for call in calls):
            event(call_response('beta-read', 'read', {'filePath': 'note.txt'}))
        else:
            event(text_response('beta done'))


def open_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def call(port, method, path, data=None, timeout=10):
    body = None if data is None else json.dumps(data).encode()
    req = Request(f'http://127.0.0.1:{port}{path}', data=body, method=method,
                  headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
    try:
        with urlopen(req, timeout=timeout) as response_file:
            raw = response_file.read()
            return response_file.status, json.loads(raw) if raw else None
    except HTTPError as error:
        return error.code, error.read().decode()


def state(port, sid):
    code, body = call(port, 'GET', f'/api/sessions/{sid}/state')
    assert code == 200, body
    return body['session']


def history(port, sid):
    code, body = call(port, 'GET', f'/api/sessions/{sid}/history')
    assert code == 200, body
    return body['messages']


def send(port, sid, text):
    code, body = call(port, 'POST', f'/api/sessions/{sid}/message', {'text': text})
    assert code == 202 and body['accepted'] is True, (code, body)


def start_host(dotnet, dll, env, port, log_dir, label):
    stdout = open(log_dir / f'{label}.out', 'w')
    stderr = open(log_dir / f'{label}.err', 'w')
    config = pathlib.Path(env['FOXWARM_DATA_DIR']) / 'state/config.yaml'
    config.write_text(f'bot: {{httpPort: {port}}}\n')
    process = subprocess.Popen([dotnet, str(dll)], env=env, stdout=stdout, stderr=stderr,
                               start_new_session=True)
    stdout.close()
    stderr.close()
    def ready():
        if process.poll() is not None:
            raise AssertionError(f'host {label} exited: {(log_dir / f"{label}.err").read_text()}')
        try:
            return call(port, 'GET', '/health')[0] == 200
        except (URLError, ConnectionError):
            return False
    try:
        wait_until(ready, f'host {label} readiness', 15)
    except BaseException:
        cleanup_process(process)
        raise
    assert process.poll() is None, (label, (log_dir / f'{label}.err').read_text())
    return process


def stop_host(process, port):
    code, _ = call(port, 'POST', '/admin/shutdown')
    assert code == 202, code
    assert process.wait(timeout=20) == 0, 'host did not cleanly stop'


def cleanup_process(process):
    if process is not None and process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def main():
    sdk = os.environ['DOTNET_ROOT']
    dotnet = str(pathlib.Path(sdk) / 'dotnet')
    dll = pathlib.Path(__file__).resolve().parent / 'Foxwarm/bin/Debug/net10.0/Foxwarm.dll'
    assert dll.is_file(), 'Build the host solution before running this driver.'
    base = pathlib.Path(tempfile.mkdtemp(prefix='foxwarm-dotnet-host-e2e-'))
    data = base / 'data'
    tools = base / 'workspace'
    logs = base / 'logs'
    data.mkdir()
    tools.mkdir()
    logs.mkdir()
    provider = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
    provider.daemon_threads = True
    server_thread = threading.Thread(target=provider.serve_forever, daemon=True)
    server_thread.start()
    port = open_port()
    (data / 'state').mkdir()
    (data / 'state/models.yaml').write_text(json.dumps({'default': 'local-script', 'providers': {
        'local-script': {'providerType': 'openai-responses', 'baseUrl': f'http://127.0.0.1:{provider.server_port}',
                         'apiKey': PROVIDER_TOKEN, 'models': ['local-script']}}}) + '\n')
    (data / 'state/token').write_text(TOKEN + '\n')
    env = dict(os.environ)
    for key in list(env):
        if key.startswith('FOXWARM_EXPERIMENT_') or key in (
                'FOXWARM_APP_ROOT', 'FOXWARM_MAIN_LIFETIME_PIPE',
                'FOXWARM_WINDOWS_CONTROL_PIPE', 'FOXWARM_CLI_LIFETIME_PIPE',
                'ASPNETCORE_URLS'):
            del env[key]
    env.update(FOXWARM_DATA_DIR=str(data), FOXWARM_CONFIG_PATH='', CONFIG_PATH='',
               MCP_CONFIG_PATH='', FOXWARM_AGENT_DIR='', FOXWARM_AGENTS_DIR=str(data / 'agents'),
               FOXWARM_EXPERIMENT_TOOL_ROOT=str(tools))
    first = second = None
    try:
        first = start_host(dotnet, dll, env, port, logs, 'first')
        assert call(port, 'GET', '/api/sessions', timeout=4)[1]['sessions'] == []
        code, alpha = call(port, 'POST', '/api/sessions', {})
        assert code == 200, alpha
        code, beta = call(port, 'POST', '/api/sessions', {})
        assert code == 200, beta
        a, b = alpha['sessionId'], beta['sessionId']
        assert a != b
        progress = []
        stream = http.client.HTTPConnection('127.0.0.1', port, timeout=15)
        stream.request('GET', f'/api/sessions/{a}/stream', headers={'Authorization': 'Bearer ' + TOKEN})
        sse = stream.getresponse()
        assert sse.status == 200
        def collect_sse():
            try:
                for line in sse:
                    if line.startswith(b'data: '):
                        event = json.loads(line[6:])
                        progress.append(event)
                        if event['type'] == 'session-event' and 'alp' in event['event'].get('textDelta', {}).get('text', ''):
                            PROGRESS_SEEN.set()
            except (OSError, ValueError):
                pass
        listener = threading.Thread(target=collect_sse, daemon=True)
        listener.start()
        send(port, a, 'alpha first')
        assert PROGRESS_SEEN.wait(10), 'no SSE text increment before completion'
        send(port, b, 'beta first')
        assert B_REQUEST_SEEN.wait(10), 'beta provider request did not arrive while alpha was held'
        send(port, a, 'alpha second')  # Same-session input while first provider body is held.
        ALPHA_RELEASE.set()
        wait_until(lambda: not state(port, a)['busy'] and len(history(port, a)) >= 4, 'alpha queued second turn')
        wait_until(lambda: not state(port, b)['busy'] and len(history(port, b)) >= 6, 'beta write/read/final tool loop')
        ah, bh = history(port, a), history(port, b)
        assert [row['role'] for row in ah] == ['user', 'model', 'user', 'model']
        assert [row['role'] for row in bh] == ['user', 'model', 'tool', 'model', 'tool', 'model']
        assert [row['__meta']['seq'] for row in bh] == list(range(1, 7))
        assert bh[4]['parts'][0]['functionResponse']['response']['output'] == 'héllo\n---\nFile has 1 line.\nFile size: 6 bytes.\nFile has no trailing newline.'
        assert (tools / 'note.txt').read_bytes() == 'héllo'.encode()
        assert any(event['type'] == 'session-event' and event['event'].get('textDelta', {}).get('text') == 'alp' for event in progress)
        assert any(event['type'] == 'message' for event in progress)
        send(port, a, 'alpha stop')
        assert HELD_REQUEST.wait(10), 'held provider never accepted request'
        code, stopped = call(port, 'POST', f'/api/sessions/{a}/stop', {})
        assert code == 200 and stopped['abortedInFlight'], (code, stopped)
        assert HELD_CLOSED.wait(10), 'Stop did not close held provider connection'
        wait_until(lambda: not state(port, a)['busy'], 'alpha stopped idle')
        stop_host(first, port)
        prior_pid = first.pid
        first = None
        second = start_host(dotnet, dll, env, port, logs, 'second')
        assert second.pid != prior_pid
        resumed_pid = second.pid
        assert len(history(port, a)) == 5
        assert len(history(port, b)) == 6
        send(port, b, 'beta resume')
        wait_until(lambda: len(history(port, b)) == 14, 'beta restart continuation')
        result = history(port, b)
        assert [row['__meta']['seq'] for row in result] == list(range(1, 15))
        assert result[7]['role'] == 'model' and result[8]['role'] == 'tool'
        assert result[8]['parts'][0]['functionResponse']['response']['error']['type'] == 'file_exists'
        # This ordinary, non-isolated owner may resolve a parent-relative path.
        # The owned sibling is absent; path validity is not a workspace-root fence.
        assert not (tools.parent / 'outside.txt').exists()
        assert result[10]['parts'][0]['functionResponse']['response']['error']['type'] == 'not_file'
        assert (tools / 'note.txt').read_text() == 'updated'
        assert state(port, b)['messageCount'] == 14 and not state(port, b)['busy']
        assert state(port, a)['queueLength'] == 0
        with sqlite3.connect(data / 'state/archive-store.sqlite') as conn:
            assert conn.execute('SELECT session_id, COUNT(*), MIN(seq), MAX(seq) '
                                'FROM archive_messages GROUP BY session_id ORDER BY session_id').fetchall() == sorted([
                                    (a, 5, 1, 5), (b, 14, 1, 14)])
        with REQUEST_LOCK:
            count = len(REQUESTS)
        assert count == 10, ('request count', count)
        stop_host(second, port)
        second = None
        for kind in ('missing', 'corrupt'):
            case_root = base / f'case-{kind}'
            shutil.copytree(data, case_root)
            authority = case_root / 'state/sessions' / f'{b}.json'
            if kind == 'missing':
                authority.unlink()
            else:
                authority.write_text('{invalid')
            case_env = dict(env, FOXWARM_DATA_DIR=str(case_root), FOXWARM_AGENTS_DIR=str(case_root / 'agents'))
            (case_root / 'state/config.yaml').write_text(f'bot: {{httpPort: {open_port()}}}\n')
            with open(logs / f'{kind}.out', 'w') as out, open(logs / f'{kind}.err', 'w') as err:
                candidate = subprocess.Popen([dotnet, str(dll)], env=case_env, stdout=out, stderr=err,
                                             start_new_session=True)
            try:
                assert candidate.wait(timeout=8) != 0, f'{kind}: missing/corrupt authority launched successfully'
                assert 'InvalidDataException' in (logs / f'{kind}.err').read_text(), kind
            finally:
                cleanup_process(candidate)
        with REQUEST_LOCK:
            assert len(REQUESTS) == count, 'fail-closed startup made a provider request'
        print(json.dumps({'result': 'ok', 'firstPid': prior_pid, 'secondPid': resumed_pid,
                          'sessions': [a, b], 'providerRequests': count, 'alphaHistory': 5,
                          'betaHistory': 14, 'betaNextSeq': 15, 'stopClosedProvider': HELD_CLOSED.is_set(),
                          'incrementSeen': PROGRESS_SEEN.is_set(), 'concurrentProviderRequests': B_REQUEST_SEEN.is_set(),
                          'workspaceFile': 'updated',
                          'missingAndCorruptStartup': 'fail-closed'}))
    finally:
        cleanup_process(first)
        cleanup_process(second)
        provider.shutdown()
        provider.server_close()
        server_thread.join(timeout=5)
        shutil.rmtree(base)


if __name__ == '__main__':
    main()
