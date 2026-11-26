// TCP helpers of the process environment: a pass-through that can be cut off (a replica's
// route to PostgreSQL) and a round-robin front proxy over the replicas' public listeners.
import { createServer, connect } from 'node:net'
import { once } from 'node:events'

/**
 * A byte pipe to `target` that can be partitioned: while cut, bytes in both directions are
 * dropped and new connections hang, as on a dead network path; nothing is closed.
 */
export async function partitionableProxy(target) {
  const sockets = new Set()
  let cut = false
  const server = createServer(client => {
    const upstream = connect(target)
    sockets.add(client)
    sockets.add(upstream)
    const pipe = (from, to) =>
      from.on('data', chunk => {
        if (!cut) to.write(chunk)
      })
    pipe(client, upstream)
    pipe(upstream, client)
    const close = () => {
      if (cut) return // a partition doesn't deliver a close either
      client.destroy()
      upstream.destroy()
    }
    for (const socket of [client, upstream]) {
      socket.on('error', () => {})
      socket.on('close', () => {
        sockets.delete(socket)
        close()
      })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    cut() {
      cut = true
    },
    heal() {
      cut = false
      // Connections that lived through the partition are as good as dead: reset them, as the
      // peers' TCP stacks eventually would.
      for (const socket of sockets) socket.destroy()
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

/** A round-robin TCP proxy; a target that refuses the connection is skipped. */
export async function roundRobinProxy(targets) {
  let next = 0
  const sockets = new Set()
  const server = createServer(client => {
    client.pause()
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => {})
    const list = targets()
    let attempts = 0
    const tryNext = () => {
      if (attempts++ >= list.length) return client.destroy()
      const target = list[next++ % list.length]
      const upstream = connect(target)
      upstream.once('error', () => {
        upstream.destroy()
        tryNext()
      })
      upstream.once('connect', () => {
        upstream.removeAllListeners('error')
        upstream.on('error', () => client.destroy())
        sockets.add(upstream)
        upstream.on('close', () => sockets.delete(upstream))
        // pipe() ends the other side once a side ends, after its data is written.
        client.on('error', () => upstream.destroy())
        client.pipe(upstream)
        upstream.pipe(client)
        client.resume()
      })
    }
    tryNext()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    async close() {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

export async function freePort(host = '127.0.0.1') {
  const server = createServer()
  server.listen(0, host)
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}
