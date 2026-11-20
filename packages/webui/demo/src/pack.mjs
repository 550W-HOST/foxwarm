// Snapshot storage format. Recorded responses repeat the same Session rows,
// messages and memory text many times, so every repeated object, array or long
// string is stored once in a pool and referenced by index. Unpacking restores
// exactly the recorded values.

const REF = '$demoRef'
const MIN_LENGTH = 64

const isRef = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === 1 && Object.prototype.hasOwnProperty.call(value, REF)

/** @param {unknown} data */
export function packSnapshot(data) {
  const counts = new Map()
  const keyOf = value => typeof value === 'string' ? `s${value}` : `j${JSON.stringify(value)}`
  const count = value => {
    if (typeof value === 'string') {
      if (value.length >= MIN_LENGTH) counts.set(keyOf(value), (counts.get(keyOf(value)) || 0) + 1)
      return
    }
    if (!value || typeof value !== 'object') return
    if (isRef(value)) throw new Error(`Recorded data already contains a ${REF} object`)
    const key = keyOf(value)
    if (key.length > MIN_LENGTH) counts.set(key, (counts.get(key) || 0) + 1)
    for (const item of Array.isArray(value) ? value : Object.values(value)) count(item)
  }
  count(data)

  const pool = []
  const indexes = new Map()
  const pack = value => {
    if (typeof value === 'string' || (value && typeof value === 'object')) {
      const key = keyOf(value)
      if ((counts.get(key) || 0) > 1) {
        let index = indexes.get(key)
        if (index === undefined) {
          index = pool.length
          indexes.set(key, index)
          pool.push(null)
          pool[index] = inner(value)
        }
        return { [REF]: index }
      }
    }
    return inner(value)
  }
  const inner = value => {
    if (Array.isArray(value)) return value.map(pack)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pack(item)]))
    return value
  }
  return { format: 2, pool, data: inner(data) }
}

/** @param {{ format: number, pool: unknown[], data: unknown }} packed */
export function unpackSnapshot(packed) {
  if (packed?.format !== 2 || !Array.isArray(packed.pool)) throw new Error('Unsupported demo snapshot format')
  const resolved = new Array(packed.pool.length)
  const done = new Array(packed.pool.length).fill(false)
  const unpack = value => {
    if (isRef(value)) {
      const index = value[REF]
      if (!done[index]) {
        resolved[index] = unpack(packed.pool[index])
        done[index] = true
      }
      return resolved[index]
    }
    if (Array.isArray(value)) return value.map(unpack)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unpack(item)]))
    return value
  }
  return unpack(packed.data)
}
