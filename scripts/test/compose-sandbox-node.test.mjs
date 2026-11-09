// The public Compose file's sandbox Node needs only the pairing token from the Main data directory.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import yaml from 'js-yaml'

const compose = yaml.load(readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8'))
const node = compose.services['sandbox-node']

function mounts(service) {
  return service.volumes.map(volume => typeof volume === 'string'
    ? (([source, target, mode]) => ({ source, target, readOnly: mode === 'ro' }))(volume.split(':'))
    : { source: volume.source, target: volume.target, readOnly: volume.read_only === true, bind: volume.bind })
}

test('sandbox Node mounts only the pairing token file from the Main data directory', () => {
  const data = mounts(node).filter(mount => mount.source.startsWith('./foxwarm-data') || mount.target === '/data' || mount.target.startsWith('/data/'))
  assert.deepEqual(data.map(mount => [mount.source, mount.target, mount.readOnly]), [
    ['./foxwarm-data/state/node_token', '/data/state/node_token', true],
  ])
  assert.equal(data[0].bind?.create_host_path, false, 'a missing token must fail instead of creating a directory')
  assert.equal(node.environment.NODE_TOKEN_FILE, data[0].target)
})

test('the start script reads only the configured token file and the Node-local credentials file', () => {
  const script = readFileSync(new URL('../start-sandbox-node.sh', import.meta.url), 'utf8')
  assert.match(script, /NODE_TOKEN_PATH="\$\{NODE_TOKEN_FILE:-/)
  assert.match(script, /NODE_CREDENTIALS_PATH="\$\{NODE_CREDENTIALS_FILE:-\/app\/state\/node_credentials\.json\}"/)
  assert.equal(node.environment.NODE_CREDENTIALS_FILE, undefined, 'credentials stay inside the container, outside any data mount')
  assert.doesNotMatch(script, /\/data\b/)
})
