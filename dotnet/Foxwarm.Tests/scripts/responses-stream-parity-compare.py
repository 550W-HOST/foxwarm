#!/usr/bin/env python3
import copy
import json
import subprocess
import sys
from pathlib import Path

from parity_compare import strict_equal

root = Path(__file__).resolve().parent
corpus = json.loads((root.parent / 'Fixtures' / 'responses-stream-corpus.json').read_text())
ts = json.loads(subprocess.check_output([sys.executable, str(root / 'run-responses-stream-ts.py')], text=True))
dotnet = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'dotnet'
cs = json.loads(subprocess.check_output([dotnet, 'run', '--project', str(root.parents[1] / 'Foxwarm.DevTools'), '--no-restore', '--', 'responses-stream', str(root.parent / 'Fixtures' / 'responses-stream-corpus.json')], text=True, cwd=root.parents[2]))
if not (len(corpus) == len(ts) == len(cs)):
    raise SystemExit(f'count mismatch: corpus={len(corpus)} TS={len(ts)} C#={len(cs)}')

def js_truthy(value):
    if value is None or value is False:
        return False
    if isinstance(value, (int, float)) and value == 0:
        return False
    if isinstance(value, str) and value == '':
        return False
    return True

def terminal_expectation(case):
    event = next((event for event in case.get('events', []) if event.get('type') in {'response.failed', 'response.incomplete', 'response.error', 'error'}), None)
    if event is None:
        return None
    kind = event['type']
    if kind in {'response.failed', 'response.incomplete'}:
        source = event.get('response') or {}
        label = 'OpenAI Responses request failed.' if kind == 'response.failed' else 'OpenAI Responses request was incomplete.'
    elif kind == 'response.error':
        source = event.get('error') or {}
        label = 'OpenAI Responses stream error.'
    else:
        source = event
        label = 'OpenAI Responses stream error.'
    detail = source.get('error') if isinstance(source.get('error'), dict) else source
    message = detail.get('message') if js_truthy(detail.get('message')) else source.get('message') if js_truthy(source.get('message')) else label
    status = detail.get('status') if js_truthy(detail.get('status')) else source.get('status') if js_truthy(source.get('status')) else None
    code = detail.get('code') if js_truthy(detail.get('code')) else source.get('code') if js_truthy(source.get('code')) else None
    return {'kind': kind, 'message': str(message), 'status': None if status is None else str(status), 'code': None if code is None else str(code)}

def expected_status(case):
    if terminal_expectation(case) is not None:
        return 'error'
    if any(event.get('type') == 'response.completed' for event in case.get('events', [])):
        return 'success'
    return 'error'

def compare(case, left, right):
    if case['name'] != left['name'] or case['name'] != right['name']:
        raise AssertionError(f"name mismatch: {case['name']}")
    a, b = left['observation'], right['observation']
    if a.get('status') != b.get('status'):
        raise AssertionError(f"{case['name']}: status mismatch {a.get('status')} != {b.get('status')}")
    if a.get('status') != expected_status(case):
        raise AssertionError(f"{case['name']}: unexpected status {a.get('status')}")
    common_keys = {'progress', 'meaningfulCount', 'safety', 'decodedRaw', 'blocks', 'status'}
    expected_observation_keys = common_keys | ({'final'} if a.get('status') == 'success' else {'error'})
    if set(a) != expected_observation_keys or set(b) != expected_observation_keys:
        raise AssertionError(f"{case['name']}: observation key presence mismatch: TS={set(a)!r} C#={set(b)!r} expected={expected_observation_keys!r}")
    for field in ('meaningfulCount', 'safety', 'decodedRaw', 'blocks', 'progress'):
        if not strict_equal(a[field], b[field]):
            raise AssertionError(f"{case['name']}: {field} mismatch\nTS={a[field]!r}\nC#={b[field]!r}")
    if a.get('status') == 'success':
        if 'final' not in a or 'final' not in b:
            raise AssertionError(f"{case['name']}: completion was not observed")
        if not strict_equal(a['final'], b['final']):
            raise AssertionError(f"{case['name']}: final semantic JSON mismatch")
    else:
        ae, be = a.get('error', {}), b.get('error', {})
        expectation = terminal_expectation(case)
        if expectation is not None:
            expected_message = expectation['message']
            suffix = ', '.join(part for part in (f"status={expectation['status']}" if expectation['status'] else '', f"code={expectation['code']}" if expectation['code'] else '') if part)
            if suffix:
                expected_message += f" ({suffix})"
            if set(ae) != {'category', 'message'} or ae.get('category') != 'provider-terminal' or ae.get('message') != expected_message:
                raise AssertionError(f"{case['name']}: actual TS terminal Error.message mismatch: {ae!r}; expected {expected_message!r}")
            expected_csharp_keys = {'category', 'kind', 'message'} | ({'status'} if expectation['status'] is not None else set()) | ({'code'} if expectation['code'] is not None else set())
            if set(be) != expected_csharp_keys or be.get('category') != 'provider-terminal' or be.get('kind') != expectation['kind'] or be.get('message') != expectation['message']:
                raise AssertionError(f"{case['name']}: C# typed terminal envelope mismatch: {be!r}; expected {expectation!r}")
            if expectation['status'] is not None and be.get('status') != expectation['status']:
                raise AssertionError(f"{case['name']}: terminal status mismatch")
            if expectation['code'] is not None and be.get('code') != expectation['code']:
                raise AssertionError(f"{case['name']}: terminal code mismatch")
        elif not strict_equal(ae, be):
            raise AssertionError(f"{case['name']}: normalized nonterminal error mismatch: {ae!r} != {be!r}")
    if len(a.get('progress', [])) != len(b.get('progress', [])):
        raise AssertionError(f"{case['name']}: progress event count mismatch")
    if len(a.get('blocks', [])) != len(b.get('blocks', [])):
        raise AssertionError(f"{case['name']}: SSE block count mismatch")

for case, left, right in zip(corpus, ts, cs):
    compare(case, left, right)
print(f'comparison ok: {len(corpus)} cases; strict semantic final/progress/safety/error/raw/block parity exact')

if '--self-test-negative' in sys.argv:
    def must_reject(mutator, case_index=0):
        left = copy.deepcopy(ts[case_index]); right = copy.deepcopy(cs[case_index]); mutator(left, right)
        try:
            compare(corpus[case_index], left, right)
        except AssertionError:
            return
        raise AssertionError('negative comparator case was accepted')
    terminal_index = next(i for i, case in enumerate(corpus) if case['name'] == 'terminal-failed')
    late_index = next(i for i, case in enumerate(corpus) if case['name'] == 'completed-then-late-error')
    must_reject(lambda left, right: left['observation']['error'].__setitem__('message', 'wrong actual message'), terminal_index)
    must_reject(lambda left, right: right['observation']['final']['output'][0]['unknown'].__setitem__('keep', 1))
    must_reject(lambda left, right: right['observation']['final']['output'][0]['unknown'].pop('nullable'), 0)
    must_reject(lambda left, right: right['observation'].pop('safety'))
    must_reject(lambda left, right: right['observation']['progress'].pop())
    must_reject(lambda left, right: right['observation']['blocks'].pop())
    must_reject(lambda left, right: right['observation'].__setitem__('status', 'error'))
    must_reject(lambda left, right: right['observation'].__setitem__('status', 'success'), late_index)
    print('negative comparator checks ok: wrong terminal message, bool-vs-number, absent-vs-null, missing common field, counts, unobserved completion, and late error rejected')
