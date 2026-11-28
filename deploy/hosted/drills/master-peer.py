"""Local stdio MCP fixture. Replies on stdout; performs no I/O outside the protocol."""
import json
import sys

for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request.get('method')
    response = {'jsonrpc': '2.0', 'id': request['id']}
    if method == 'initialize':
        response['result'] = {'protocolVersion': request['params']['protocolVersion'], 'capabilities': {'tools': {}},
                              'serverInfo': {'name': 'master-acceptance', 'version': '1'}}
    elif method == 'tools/list':
        response['result'] = {'tools': [{'name': 'receipt', 'description': 'Return a receipt from the local stdio peer.',
                                         'inputSchema': {'type': 'object', 'properties': {}}}]}
    elif method == 'tools/call' and request['params']['name'] == 'receipt':
        response['result'] = {'content': [{'type': 'text', 'text': 'stdio-transport-ok'}]}
    else:
        response['error'] = {'code': -32601, 'message': 'Method not found'}
    print(json.dumps(response), flush=True)
