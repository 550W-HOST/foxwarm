import unittest
from parity_compare import compare_case


class ComparatorTests(unittest.TestCase):
    def test_rejects_short_runner_output(self):
        with self.assertRaises(AssertionError):
            compare_case({'name': 'x', 'op': 'filter'}, {'kind': 'value', 'value': 'x'}, None)

    def test_error_precedence_and_empty_error_cases(self):
        case = {'name': 'stored', 'op': 'argsStringify', 'rawArgsText': 'raw', 'argsParseError': 'bad'}
        result = {'kind': 'value', 'value': '{"error":"bad","rawArgsText":"raw"}'}
        self.assertEqual(compare_case(case, result, result), 'strict-semantic-json')
        empty = {'name': 'empty', 'op': 'argsStringify', 'rawArgsText': 'raw', 'argsParseError': ''}
        passthrough = {'kind': 'value', 'value': 'raw'}
        self.assertEqual(compare_case(empty, passthrough, passthrough), 'raw-text-exact')

    def test_rejects_valid_json_classification_as_native_diagnostic(self):
        case = {'name': 'array', 'op': 'argsParse', 'rawInput': '[]'}
        left = {'kind': 'value', 'value': {'args': {}, 'rawArgsText': '[]', 'argsParseError': 'Invalid tool arguments JSON: expected top-level object but received array'}}
        right = {'kind': 'value', 'value': {'args': {}, 'rawArgsText': '[]', 'argsParseError': 'Invalid tool arguments JSON: native'}}
        with self.assertRaises(AssertionError): compare_case(case, left, right)

    def test_rejects_missing_supported_null_as_unsupported(self):
        for raw in (None,):
            case = {'name': 'null', 'op': 'argsParse', 'rawInput': raw}
            with self.assertRaises(AssertionError): compare_case(case, {'kind': 'value', 'value': {'args': {}}}, {'kind': 'unsupported', 'value': 'x'})


if __name__ == '__main__':
    unittest.main()
