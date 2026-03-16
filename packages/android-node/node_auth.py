from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional
from urllib.parse import parse_qs, urlparse


@dataclass
class StoredNodeCredentials:
    node_id: str
    auth_token: str
    paired_at: int


@dataclass
class NodeConnectionConfig:
    host: str
    requested_name: str
    pairing_token: Optional[str] = None
    node_id: Optional[str] = None
    auth_token: Optional[str] = None
    credentials_file: Optional[str] = None


def _env(env: Mapping[str, str], *names: str) -> Optional[str]:
    for name in names:
        value = env.get(name)
        if value and value.strip():
            return value.strip()
    return None


def _normalize_host(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme in ('ws', 'wss'):
        scheme = 'https' if parsed.scheme == 'wss' else 'http'
        path = parsed.path or ''
        if path.endswith('/node_ws'):
            path = path[:-8] or '/'
        return f"{scheme}://{parsed.netloc}{path}".rstrip('/')
    return value.rstrip('/')


def build_node_ws_url(host: str, pairing_token: Optional[str] = None, node_id: Optional[str] = None, auth_token: Optional[str] = None) -> str:
    base = _normalize_host(host)
    parsed = urlparse(base)
    ws_scheme = 'wss' if parsed.scheme == 'https' else 'ws'
    root = f"{ws_scheme}://{parsed.netloc}"

    if node_id and auth_token:
        return f"{root}/node_ws?id={node_id}&auth={auth_token}"
    if pairing_token:
        return f"{root}/node_ws?token={pairing_token}"
    raise ValueError('Need either pairing token or node credentials')


def parse_connection_config(env: Optional[Mapping[str, str]] = None) -> Optional[NodeConnectionConfig]:
    source = env or os.environ

    raw_url = _env(source, 'FOXWARM_URL', 'ALPHABOT_URL')
    host = _env(source, 'FOXWARM_HOST', 'ALPHABOT_HOST')
    requested_name = _env(source, 'FOXWARM_NODE_ID', 'ALPHABOT_NODE_ID')
    pairing_token = _env(source, 'FOXWARM_NODE_TOKEN', 'ALPHABOT_NODE_TOKEN')
    auth_token = _env(source, 'FOXWARM_NODE_AUTH_TOKEN', 'ALPHABOT_NODE_AUTH_TOKEN')
    node_id = _env(source, 'FOXWARM_NODE_AUTH_ID', 'ALPHABOT_NODE_AUTH_ID')
    credentials_file = _env(source, 'FOXWARM_NODE_CREDENTIALS_FILE', 'ALPHABOT_NODE_CREDENTIALS_FILE')

    if raw_url:
        parsed = urlparse(raw_url)
        host = host or _normalize_host(raw_url)
        query = parse_qs(parsed.query)

        if not pairing_token and query.get('token'):
            pairing_token = query['token'][0]
        if not requested_name and query.get('id'):
            # Backward-compatible interpretation for old
            # `?token=...&id=requested-name` style examples.
            requested_name = query['id'][0]
        if not node_id and query.get('id') and query.get('auth'):
            node_id = query['id'][0]
        if not auth_token and query.get('auth'):
            auth_token = query['auth'][0]

    if not host:
        return None

    return NodeConnectionConfig(
        host=_normalize_host(host),
        requested_name=requested_name or 'android-node',
        pairing_token=pairing_token,
        node_id=node_id,
        auth_token=auth_token,
        credentials_file=credentials_file or './node_credentials.json',
    )


def load_stored_credentials(credentials_file: Optional[str]) -> Optional[StoredNodeCredentials]:
    if not credentials_file:
        return None
    path = Path(credentials_file)
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding='utf-8'))
    if not data.get('nodeId') or not data.get('authToken'):
        return None
    return StoredNodeCredentials(
        node_id=str(data['nodeId']),
        auth_token=str(data['authToken']),
        paired_at=int(data.get('pairedAt') or 0),
    )


def save_stored_credentials(credentials_file: Optional[str], node_id: str, auth_token: str, paired_at: int) -> None:
    if not credentials_file:
        return
    path = Path(credentials_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        'nodeId': node_id,
        'authToken': auth_token,
        'pairedAt': paired_at,
    }, indent=2), encoding='utf-8')


def clear_stored_credentials(credentials_file: Optional[str]) -> None:
    if not credentials_file:
        return
    path = Path(credentials_file)
    if path.exists():
        path.unlink()