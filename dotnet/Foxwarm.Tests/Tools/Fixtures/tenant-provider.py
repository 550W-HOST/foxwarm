"""Executable Provider fixture with separate tenant inventories and a persistent service."""
import json
import pathlib
import sys
import time

root, mode = pathlib.Path(sys.argv[1]), sys.argv[2]
root.mkdir(parents=True, exist_ok=True)
request = json.loads(sys.stdin.readline())
tenant = request.get('tenantId')
assert tenant is None or type(tenant) is int
operation = request['operation']
workspace = root / ('legacy' if tenant is None else str(tenant))
workspace.mkdir(exist_ok=True)

def record(message):
    with (root / 'calls.jsonl').open('a') as out:
        out.write(json.dumps(message) + '\n')

def send(value):
    print(json.dumps(value), flush=True)

def node(name):
    return dict(id=name, type='fixture', availability='ready', filesystem='read', defaultCwd='/work',
                exec=True, services={'vscode-fs': 1})

record(request)
notes = root / ('stderr-' + str(tenant) + '-' + operation)
if notes.exists():
    sys.stderr.buffer.write(notes.read_bytes())
    sys.stderr.buffer.flush()
identity = {key: request[key] for key in ('protocol', 'requestId', 'providerId', 'operation')}
if tenant is not None:
    identity['tenantId'] = tenant + 1 if (root / ('mismatch-' + operation)).exists() else tenant
body = request.get('request', {})
if operation == 'describe':
    if mode == 'broken':
        sys.exit(1)
    result = dict(label='fixture', description='tenant-aware fixture', lifecycle=['create', 'ensure', 'inspect', 'destroy'])
    if mode == 'extended':
        result['tenancy'] = 'per-tenant'
elif operation == 'list':
    result = dict(nodes=[node(p.stem) for p in sorted(workspace.glob('*.node'))])
elif operation in ('create', 'ensure', 'inspect', 'destroy'):
    name = body.get('nodeId', 'allocated')
    if operation == 'destroy':
        (workspace / (name + '.node')).unlink()
        result = {'nodeId': name}
    else:
        if operation != 'inspect':
            (workspace / (name + '.node')).touch()
        result = {'node': node(name)}
elif operation == 'connect':
    send(dict(identity, ok=True, result={'nodeId': body['nodeId'], 'services': {'vscode-fs': 1}}))
    for line in sys.stdin:
        frame = json.loads(line)
        record(frame)
        assert 'tenantId' not in frame
        if frame['type'] == 'node_service_request':
            reply = {'type': 'node_service_response', 'requestId': frame['requestId'], 'result': {'owner': tenant}}
            send(reply)
    sys.exit(0)
elif operation == 'exec-start':
    until = time.monotonic() + 5
    while (root / 'hold-start').exists() and time.monotonic() < until:
        time.sleep(0.015)
    result = dict(ref='opaque-job', cwd='/work', outputPath='/log')
elif operation == 'exec-poll':
    result = dict(state='running')
elif operation == 'filesystem':
    result = dict(type='file', size=0)
else:
    raise ValueError(operation)
if operation == 'describe':
    detail = root / ('diagnostic-' + str(tenant))
    print('fixture diagnostic' + (' ' + detail.read_text() if detail.exists() else ''), file=sys.stderr)
    if mode == 'duplicate':
        print(json.dumps(dict(identity, ok=True))[:-1] + ',"result":{"label":"first","label":"second"}}')
        sys.exit(0)
send(dict(identity, ok=True, result=result))
