# Unit: Text redaction persistence

Files: `dotnet/Foxwarm/Models/TextRedactionStore.cs`, `dotnet/Foxwarm/Models/TextRedactor.Persistence.cs`
Secondary files: `dotnet/Foxwarm/Models/TextRedactor.cs`, `dotnet/Foxwarm/Models/TextRedactionScope.cs`, `dotnet/Foxwarm/Models/TextRedactionView.cs`, `dotnet/Foxwarm/Secrets/InstanceSecrets.cs`, `dotnet/Foxwarm/Secrets/InstanceKeys.cs`, `dotnet/Foxwarm.Tests/Models/TextRedactionPersistenceTests.cs`

## Purpose

Keeps [reversible text redaction](./model-text-redaction.md) prefix-stable across a Main restart. Within one process an unchanged slot is sent exactly as before because its detection and memoized literal pass are cached and placeholders are deterministic. Re-processing the whole history after a restart would not reproduce the per-turn results: the literal pass would see later known values, and combined detection (`batchBytes`) would see different context. Without persistence every redacting Session therefore paid one uncached provider request per restart.

## D-model-text-redaction-persistence

[2026-11-10, user decision] Each slot's finished result (its replaced ranges) and the known originals are persisted, so the same history produces byte-identical provider input after a restart without detector calls, and literal masking of new slots, restoration and collision checks continue with the same known set. This replaces the earlier rule (2026-11-03) that the reverse map and detection cache are memory-only. Persisted results are never reused under other settings: a settings change is a new cache identity and re-processes everything.

- **Slot records** store only ranges: offset, length, labels and whether the range was detected or literal-masked. Detected offsets are in the slot text, literal offsets in its detected form, as in the memory cache. The slot text and placeholders are never stored; originals are substrings of the slot text and placeholders are recomputed with the placeholder HMAC. A record is keyed by a keyed hash of the slot's cache digest together with a keyed fingerprint of the cache identity (endpoint, API key, threshold, timeout, excluded labels and kept values, exactly the fields of in-memory identity).
- **A store hit is validated against the text.** Ranges out of range, empty, overlapping or out of order, splitting a surrogate pair, without labels, or a literal range over a detected placeholder make the record a miss; it is removed and the slot is detected again.
- **Known originals** are written when registered or when their labels grow and removed when the reverse map evicts them, so a restart restores the same bounded set, least recently used first. They are private values collected across Sessions, so every record payload (slot and known) is sealed with AES-GCM; associated data binds it to its table and record key.
- **Keys.** HKDF purpose `text-redaction-store` derives 64 bytes from the instance key (`<data root>/keys/secrets.key`): 32 for AES-GCM, 32 for HMAC-SHA256 record keys and identity fingerprints (truncated to 16 bytes). A store copied without the instance key cannot be read; a store whose key check does not match is emptied when opened.
- **The store is a cache.** A memory miss reads the slot record; a hit is cached in memory again and counted as a cached slot in statistics. Writes never fail or delay a request: they are queued, coalesced per record and written by a background flush in one transaction. A read or write failure is logged once and costs only a later miss. A store that cannot be opened leaves redaction memory-only; a file that is not a database is replaced. Deleting the file returns to memory-only behaviour; there is no migration.

**Write timing.** A slot record is queued when its literal pass is memoized, which happens before the provider send, mirroring the memory cache: a retry of an unsent attempt reuses the memoized result in memory anyway, so the disk record describes exactly what any later send of that slot carries. The record's content is fixed at memoization, so writing after the send would only add a completion hook to every transport. The flush runs right after queueing; a crash before it costs one later miss, as before this decision. The first record of a slot wins (`INSERT OR IGNORE`), like the memory cache; a record removed as invalid can be written again.

**Bounds.** Slot records are pruned least recently used first when their estimated size exceeds 64 MiB, down to 90%. Last use is kept per day: a record served from memory or disk is touched at most once a day, so steady requests do not write. Old cache identities are no longer touched and age out this way. Known records follow the reverse map, whose memory bound (16 MiB estimated) also bounds the table. Pending writes are bounded (65,536 records); beyond that new writes are dropped. There is no configuration.

## Storage

`<data root>/state/text-redaction.sqlite` (WAL, `synchronous=NORMAL`):

| Table | Columns | Notes |
| --- | --- | --- |
| `meta` | `key`, `value` | `check`: keyed check value of the format version under the store key. |
| `slots` | `identity`, `slot`, `data`, `used` | Primary key `(identity, slot)`, both 16-byte keyed hashes; `used` is the day of last use. |
| `known` | `id`, `data`, `seq` | `id` is a keyed hash of the placeholder; `seq` orders use for loading and pruning. |

`data` is a 12-byte nonce, the AES-GCM ciphertext and a 16-byte tag. Slot payload: format version, then ranges (`literal` byte, start, length, labels). Known payload: format version, original, labels. Integers are 7-bit encoded and strings length-prefixed UTF-8 (`BinaryWriter`), so no reflection-based serialization is involved.

## Ownership

`InstanceSecrets.TextRedactor()` creates the installation's one redactor on first use, opening the store and loading known originals, and disposes both with the secrets owner, which flushes pending writes. Requests reach it through `ResponsesClientOptions.TextRedactorSource`; the sent-version view uses the same redactor, and its `Peek` reads a store record without caching it or refreshing its use. A redactor created without a store (tests) behaves as before this decision.

## Tests

`TextRedactionPersistenceTests` covers the acceptance path through `ModelRequestOwner` with real HTTP detector and provider peers: several turns, then a new `InstanceSecrets` over the same data root sends a byte-identical provider body with zero detector calls, with and without `batchBytes`, although a later known value would otherwise mask the first message; a new slot missed by detection is literal-masked with the restored known set; the sent-version view is available after the restart; changed settings re-detect. It also covers that the file contains no originals or placeholders and a copy without the key yields nothing (with the key it is readable), invalid records, the slot LRU bound with day-granular use, known values mirroring the bounded reverse map with collision checks after reload, and an unusable or damaged store.
