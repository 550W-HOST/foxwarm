import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent))

from node_auth import NodeProtocolGate, parse_connection_config, resolve_master_node_protocol  # noqa: E402


class NodeConnectionConfigTest(unittest.TestCase):
    def test_reads_current_pairing_environment(self):
        config = parse_connection_config({
            'FOXWARM_HOST': 'http://localhost:3002/',
            'FOXWARM_NODE_ID': 'android-e2e',
            'FOXWARM_NODE_TOKEN': 'pairing-token',
            'FOXWARM_NODE_CREDENTIALS_FILE': './test-credentials.json',
        })

        self.assertIsNotNone(config)
        assert config is not None
        self.assertEqual(config.host, 'http://localhost:3002')
        self.assertEqual(config.requested_name, 'android-e2e')
        self.assertEqual(config.pairing_token, 'pairing-token')
        self.assertEqual(config.credentials_file, './test-credentials.json')

    def test_removed_environment_aliases_are_ignored(self):
        removed_prefix = 'ALPHA' + 'BOT_'
        removed_only = {
            f'{removed_prefix}URL': 'ws://localhost:3002/node_ws?token=old',
            f'{removed_prefix}HOST': 'http://localhost:3002',
        }
        self.assertIsNone(parse_connection_config(removed_only))

        config = parse_connection_config({
            'FOXWARM_HOST': 'http://localhost:3002',
            f'{removed_prefix}NODE_ID': 'removed-name',
            f'{removed_prefix}NODE_TOKEN': 'removed-pairing-token',
            f'{removed_prefix}NODE_AUTH_ID': 'removed-auth-id',
            f'{removed_prefix}NODE_AUTH_TOKEN': 'removed-auth-token',
            f'{removed_prefix}NODE_CREDENTIALS_FILE': './removed.json',
        })

        self.assertIsNotNone(config)
        assert config is not None
        self.assertEqual(config.requested_name, 'android-node')
        self.assertIsNone(config.pairing_token)
        self.assertIsNone(config.node_id)
        self.assertIsNone(config.auth_token)
        self.assertEqual(config.credentials_file, './node_credentials.json')


class NodeProtocolCompatibilityTest(unittest.TestCase):
    def test_accepts_valid_explicit_and_omitted_legacy_responses(self):
        self.assertEqual(resolve_master_node_protocol({
            'master': {'min': 1, 'max': 2},
            'negotiated': 2,
        }), {
            'master': {'min': 1, 'max': 2},
            'negotiated': 2,
            'legacy': False,
        })
        self.assertEqual(resolve_master_node_protocol({
            'master': {'min': 1, 'max': 1},
            'negotiated': 1,
        }), {
            'master': {'min': 1, 'max': 1},
            'negotiated': 1,
            'legacy': False,
        })
        self.assertEqual(resolve_master_node_protocol(), {
            'master': {'min': 1, 'max': 1},
            'negotiated': 1,
            'legacy': True,
        })

    def test_rejects_malformed_present_responses(self):
        invalid = [
            None,
            {},
            {'master': {'min': 1, 'max': 2}},
            {'master': {'min': 1, 'max': 2}, 'negotiated': 2, 'extra': True},
            {'master': {'min': 1, 'max': 2, 'extra': True}, 'negotiated': 2},
            {'master': {'min': 1, 'max': 1_000_001}, 'negotiated': 2},
            {'master': {'min': True, 'max': 2}, 'negotiated': 2},
            {'master': {'min': 1, 'max': 2}, 'negotiated': True},
            {'master': {'min': 1, 'max': 2}, 'negotiated': 1},
        ]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    resolve_master_node_protocol(value)

    def test_incompatible_gate_retains_quarantine_and_suppresses_reconnect(self):
        gate = NodeProtocolGate()
        self.assertTrue(gate.allows_application_work())
        gate.mark_incompatible()
        self.assertFalse(gate.allows_application_work())
        self.assertFalse(gate.should_reconnect())
        with self.assertRaises(ValueError):
            gate.accept_registered({'nodeProtocol': {'master': {'min': 3, 'max': 3}, 'negotiated': 3}})
        self.assertTrue(gate.incompatible)


if __name__ == '__main__':
    unittest.main()
