import json


def strict_equal(a, b):
    if isinstance(a, (int, float)) and not isinstance(a, bool) and isinstance(b, (int, float)) and not isinstance(b, bool):
        return a == b
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(strict_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(strict_equal(x, y) for x, y in zip(a, b))
    return a == b


def compare_case(case, left, right):
    if not isinstance(left, dict) or not isinstance(right, dict):
        raise AssertionError(f'runner result must be an object: left={left!r} right={right!r}')
    op = case['op']
    if left.get('kind') != right.get('kind'):
        raise AssertionError(f'kind mismatch: {case["name"]}: TS={left!r} C#={right!r}')
    if op == 'argsStringify':
        raw = case.get('rawArgsText')
        error = case.get('argsParseError')
        if error:
            a, b = json.loads(left['value']), json.loads(right['value'])
            if not strict_equal(a, b) or a.get('error') != error or b.get('error') != error:
                raise AssertionError(f'error wrapper mismatch: {case["name"]}: TS={a!r} C#={b!r}')
            expected_raw = raw if raw else None
            if a.get('rawArgsText') != expected_raw or b.get('rawArgsText') != expected_raw:
                raise AssertionError(f'error raw field mismatch: {case["name"]}')
            return 'strict-semantic-json'
        if raw is not None:
            if left['value'] != raw or right['value'] != raw:
                raise AssertionError(f'raw args mismatch: {case["name"]}')
            return 'raw-text-exact'
        if not strict_equal(json.loads(left['value']), json.loads(right['value'])):
            raise AssertionError(f'generated args semantic mismatch: {case["name"]}')
        return 'generated-json-semantic'
    if op == 'argsParse' and isinstance(left.get('value'), dict) and 'argsParseError' in left['value']:
        a, b = left['value'], right['value']
        try:
            json.loads(case.get('rawInput', ''))
            syntactically_valid = True
        except (TypeError, json.JSONDecodeError):
            syntactically_valid = False
        if syntactically_valid:
            if not strict_equal(a, b):
                raise AssertionError(f'valid-json classification mismatch: {case["name"]}: TS={a!r} C#={b!r}')
            return 'strict-semantic-json'
        if a.get('args') != b.get('args') or a.get('rawArgsText') != b.get('rawArgsText'):
            raise AssertionError(f'parse payload mismatch: {case["name"]}')
        suffix = b.get('argsParseError', '')
        if not suffix.startswith('Invalid tool arguments JSON:') or len(suffix) <= len('Invalid tool arguments JSON:'):
            raise AssertionError(f'native diagnostic invalid: {case["name"]}: {b!r}')
        if set(a) != set(b) or a.get('rawArgsText') != b.get('rawArgsText'):
            raise AssertionError(f'parse field presence mismatch: {case["name"]}')
        return 'native-diagnostic-compatible'
    if not strict_equal(left, right):
        raise AssertionError(f'value mismatch: {case["name"]}: TS={left!r} C#={right!r}')
    return 'strict-semantic-json'
