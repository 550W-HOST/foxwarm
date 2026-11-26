using System.Security.Cryptography;
using Foxwarm.Hosted.Blobs;
using Foxwarm.Storage;
using Npgsql;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The PostgreSQL blob backend: one tenant's blobs of one store (<c>images</c>,
/// <c>artifacts</c>) in <c>blob_objects</c> and <c>blob_chunks</c>. A create inserts the object
/// row and all of its 1 MiB chunks in one fenced transaction, so a key is visible only complete,
/// and a concurrent create of the same key waits for the first and then finds it existing.
/// Reads fetch one chunk per statement, so a stream holds at most one chunk in memory.
/// </summary>
internal sealed class PgBlobStore(TenantDb database, string store) : IBlobStore
{
    internal const int ChunkBytes = 1024 * 1024;

    internal string Store => store;

    private TenantDb Database => database;

    /// <summary>Runs at the end of a creating transaction, before COMMIT; for tests.</summary>
    internal Action? BeforeCommit { get; set; }

    public bool Exists(string key) =>
        database.Read(tx =>
            tx.Scalar("SELECT 1 FROM blob_objects WHERE store = $1 AND key = $2", store, key)
                is not null
        );

    public async Task<bool> CreateAsync(
        string key,
        ReadOnlyMemory<byte> content,
        bool keepExisting,
        CancellationToken token
    )
    {
        var sha256 = SHA256.HashData(content.Span);
        var chunks = (content.Length + ChunkBytes - 1) / ChunkBytes;
        var created = false;
        return await database
            .WriteAsync(
                async (tx, cancel) =>
                {
                    created = false;
                    var inserted = await tx.ExecuteAsync(
                            "INSERT INTO blob_objects (store, key, byte_length, chunk_count, sha256)"
                                + " VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
                            cancel,
                            store,
                            key,
                            (long)content.Length,
                            chunks,
                            sha256
                        )
                        .ConfigureAwait(false);
                    if (inserted == 0)
                        return keepExisting
                            ? false
                            : throw new IOException($"The blob {key} already exists.");
                    for (var index = 0; index < chunks; index++)
                    {
                        var start = index * ChunkBytes;
                        await tx.ExecuteAsync(
                                "INSERT INTO blob_chunks (store, key, chunk, data) VALUES ($1, $2, $3, $4)",
                                cancel,
                                store,
                                key,
                                index,
                                new NpgsqlParameter<ReadOnlyMemory<byte>>
                                {
                                    TypedValue = content.Slice(
                                        start,
                                        Math.Min(ChunkBytes, content.Length - start)
                                    ),
                                }
                            )
                            .ConfigureAwait(false);
                    }
                    created = true;
                    BeforeCommit?.Invoke();
                    return true;
                },
                // A lost COMMIT of a create is resolved by the object row: present with this
                // content means this write (or an identical one) committed it.
                new PgWriteOptions(Verify: tx =>
                    !created
                    || tx.Scalar(
                        "SELECT 1 FROM blob_objects WHERE store = $1 AND key = $2"
                            + " AND byte_length = $3 AND sha256 = $4",
                        store,
                        key,
                        (long)content.Length,
                        sha256
                    )
                        is not null
                ),
                token
            )
            .ConfigureAwait(false);
    }

    public Task<byte[]> ReadAllAsync(string key, CancellationToken token) =>
        database.ReadAsync(
            async (tx, cancel) =>
            {
                var (length, _) = await ObjectAsync(tx, key, cancel).ConfigureAwait(false);
                if (length > Array.MaxLength)
                    throw new IOException($"The blob {key} is too large to read at once.");
                var bytes = new byte[length];
                var position = 0;
                await using var command = tx.Command(
                    "SELECT data FROM blob_chunks WHERE store = $1 AND key = $2 ORDER BY chunk",
                    store,
                    key
                );
                await using var reader = await command
                    .ExecuteReaderAsync(System.Data.CommandBehavior.SequentialAccess, cancel)
                    .ConfigureAwait(false);
                while (await reader.ReadAsync(cancel).ConfigureAwait(false))
                {
                    var chunk = (byte[])reader.GetValue(0);
                    if (chunk.Length > bytes.Length - position)
                        throw Corrupt(key);
                    chunk.CopyTo(bytes, position);
                    position += chunk.Length;
                }
                return position == bytes.Length ? bytes : throw Corrupt(key);
            },
            token: token
        );

    public Stream OpenRead(string key)
    {
        var (length, chunks) = database.Read(tx => Object(tx, key));
        return new ChunkStream(this, key, length, chunks);
    }

    public IReadOnlyList<string> List(string prefix)
    {
        var start = prefix.Length == 0 ? "" : prefix + "/";
        return database.Read(tx =>
        {
            // '0' follows '/' in byte order, so the range holds exactly the keys below the prefix.
            using var command =
                prefix.Length == 0
                    ? tx.Command(
                        "SELECT key FROM blob_objects WHERE store = $1 ORDER BY key",
                        store
                    )
                    : tx.Command(
                        "SELECT key FROM blob_objects WHERE store = $1 AND key >= $2 AND key < $3"
                            + " ORDER BY key",
                        store,
                        start,
                        prefix + "0"
                    );
            using var reader = command.ExecuteReader();
            var names = new List<string>();
            while (reader.Read())
            {
                var name = reader.GetString(0)[start.Length..];
                if (name.Length > 0 && !name.Contains('/'))
                    names.Add(name);
            }
            return names;
        });
    }

    public string? LocalPath(string key) => null;

    private (long Length, int Chunks) Object(PgTx tx, string key)
    {
        using var command = tx.Command(
            "SELECT byte_length, chunk_count FROM blob_objects WHERE store = $1 AND key = $2",
            store,
            key
        );
        using var reader = command.ExecuteReader();
        return reader.Read() ? (reader.GetInt64(0), reader.GetInt32(1)) : throw Missing(key);
    }

    private async Task<(long Length, int Chunks)> ObjectAsync(
        PgTx tx,
        string key,
        CancellationToken token
    )
    {
        await using var command = tx.Command(
            "SELECT byte_length, chunk_count FROM blob_objects WHERE store = $1 AND key = $2",
            store,
            key
        );
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        return await reader.ReadAsync(token).ConfigureAwait(false)
            ? (reader.GetInt64(0), reader.GetInt32(1))
            : throw Missing(key);
    }

    private byte[] Chunk(PgTx tx, string key, int index) =>
        tx.Scalar(
            "SELECT data FROM blob_chunks WHERE store = $1 AND key = $2 AND chunk = $3",
            store,
            key,
            index
        ) as byte[]
        ?? throw Corrupt(key);

    private static FileNotFoundException Missing(string key) => new($"The blob {key} doesn't exist.");

    private static IOException Corrupt(string key) =>
        new($"The stored chunks of the blob {key} don't match its length.");

    // Fetches chunk after chunk in short read transactions; blobs never change once written.
    private sealed class ChunkStream(PgBlobStore owner, string key, long length, int chunks)
        : ForwardReadStream(length)
    {
        private byte[] current = [];
        private int offset;
        private int next;

        protected override int ReadSource(Span<byte> buffer)
        {
            if (offset == current.Length)
            {
                if (next == chunks)
                    return 0;
                Load(owner.Database.Read(tx => owner.Chunk(tx, key, next)));
            }
            return Copy(buffer);
        }

        protected override async ValueTask<int> ReadSourceAsync(
            Memory<byte> buffer,
            CancellationToken token
        )
        {
            if (offset == current.Length)
            {
                if (next == chunks)
                    return 0;
                var index = next;
                Load(
                    await owner
                        .Database.ReadAsync(
                            (tx, _) => Task.FromResult(owner.Chunk(tx, key, index)),
                            token: token
                        )
                        .ConfigureAwait(false)
                );
            }
            return Copy(buffer.Span);
        }

        private void Load(byte[] chunk)
        {
            if (chunk.Length == 0)
                throw Corrupt(key);
            current = chunk;
            offset = 0;
            next++;
        }

        private int Copy(Span<byte> buffer)
        {
            var count = Math.Min(buffer.Length, current.Length - offset);
            current.AsSpan(offset, count).CopyTo(buffer);
            offset += count;
            return count;
        }
    }
}
