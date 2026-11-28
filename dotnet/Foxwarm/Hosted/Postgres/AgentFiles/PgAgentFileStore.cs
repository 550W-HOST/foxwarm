using System.Security.Cryptography;
using System.Text;
using Foxwarm.Sessions;
using Foxwarm.Storage;
using Npgsql;

namespace Foxwarm.Hosted.Postgres;

/// <summary>
/// The hosted Agent store: one tenant's Agent files in <c>agent_files</c> (migration 1100).
/// Content of up to <see cref="InlineBytes"/> is inline; larger content is a blob of the
/// tenant's <c>agent-files</c> blob store under <c>&lt;agent&gt;/&lt;sha256&gt;</c>, created
/// before the row that references it. Directories are implicit in file paths; a <c>dir</c> row
/// exists for an empty directory and for each Agent's root (path <c>""</c>), which only the
/// Agent lifecycle (<see cref="CreateAgentAsync"/>, <see cref="DeleteAgentAsync"/>) writes.
/// Every write is one fenced transaction in the Agent's write lane; it first locks the tenant's
/// <c>agent_file_usage</c> row, which serializes the tenant's writes, allocates generations and
/// makes the <see cref="AgentStoreLimits"/> checks exact.
/// </summary>
internal sealed partial class PgAgentFileStore : IAgentStore
{
    internal const int InlineBytes = 256 * 1024;
    internal const string BlobStoreName = "agent-files";

    private const string Columns = "kind, generation, size, updated_at";

    private readonly TenantDb database;
    private readonly IBlobStore blobs;
    private readonly Func<AgentStoreLimits> limits;

    public AgentStoreLimits Limits => limits();
    private readonly AgentWriteLanes lanes = new();

    internal PgAgentFileStore(TenantDb database, IBlobStore blobs, Func<AgentStoreLimits>? limits = null)
    {
        this.database = database;
        this.blobs = blobs;
        this.limits = limits ?? (() => AgentStoreLimits.Default);
    }

    /// <summary>Where content above <see cref="InlineBytes"/> lives.</summary>
    internal IBlobStore Blobs => blobs;

    /// <summary>Runs inside a write transaction before COMMIT; for tests.</summary>
    internal Action? BeforeCommit { get; set; }

    internal static string BlobKey(string agent, ReadOnlySpan<byte> sha256) =>
        (agent.Length == 0 ? ".root" : agent) + "/" + Convert.ToHexStringLower(sha256);

    public string Locator(string? agent, string path) =>
        "agents/" + (agent is null ? "" : agent + "/") + path;

    public bool FileExists(string? agent, string path)
    {
        if (AgentFilePaths.Problem(path) is not null)
            return false;
        var key = Key(agent);
        return database.Read(tx =>
            tx.Scalar(
                "SELECT 1 FROM agent_files WHERE agent = $1 AND path = $2 AND kind = 'file'",
                key,
                path
            )
                is not null
        );
    }

    public async Task<string> ReadTextAsync(string? agent, string path, CancellationToken token)
    {
        var content = await ReadAsync(agent, path, token).ConfigureAwait(false);
        // As File.ReadAllText: UTF-8 unless a byte order mark says otherwise, which is dropped.
        using var reader = new StreamReader(
            new MemoryStream(content.Bytes),
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: true
        );
        return await reader.ReadToEndAsync(token).ConfigureAwait(false);
    }

    public IReadOnlyList<AgentFileEntry> List(string? agent, string directory, string? filePattern = null)
    {
        AgentFilePaths.Require(directory, allowRoot: true);
        var key = Key(agent);
        var (range, parameters) = Below(directory, 3);
        var rows = database.Read(tx =>
        {
            using var command = tx.Command(
                "SELECT split_part(rest, '/', 1), bool_or(kind = 'dir' OR strpos(rest, '/') > 0),"
                    + " max(size), max(updated_at) FROM (SELECT substr(path, char_length($2) + 1) AS rest,"
                    + " kind, size, updated_at FROM agent_files WHERE agent = $1 AND "
                    + range
                    + ") AS below GROUP BY 1",
                [key, Prefix(directory), .. parameters]
            );
            using var reader = command.ExecuteReader();
            var result = new List<(string Name, bool Directory, long Size, DateTime Updated)>();
            while (reader.Read())
                result.Add(
                    (reader.GetString(0), reader.GetBoolean(1), reader.GetInt64(2), reader.GetDateTime(3))
                );
            return result;
        });
        var prefix = Prefix(directory);
        return rows.Where(row =>
                filePattern is null
                || !row.Directory
                    && System.IO.Enumeration.FileSystemName.MatchesWin32Expression(
                        System.IO.Enumeration.FileSystemName.TranslateWin32Expression(filePattern),
                        row.Name,
                        ignoreCase: false
                    )
            )
            .Select(row => new AgentFileEntry(
                row.Name,
                Locator(agent, prefix + row.Name),
                row.Directory,
                false,
                filePattern is null && !row.Directory ? row.Size : null,
                filePattern is null && !row.Directory
                    ? DateTime.SpecifyKind(row.Updated, DateTimeKind.Utc)
                    : null
            ))
            .OrderBy(entry => entry.Name, StringComparer.Ordinal)
            .ToArray();
    }

    public AgentFileStat? Stat(string? agent, string path)
    {
        AgentFilePaths.Require(path, allowRoot: true);
        var key = Key(agent);
        return database.Read(tx => StatIn(tx, key, path));
    }

    // Only the requested bytes: an inline slice in SQL, or a ranged blob read. A range that
    // covers the whole file is digest-verified as a full read is; a partial one only has its
    // length checked against the row's size.
    public async Task<byte[]> ReadRangeAsync(string? agent, string path, long offset, int count, CancellationToken token)
    {
        AgentFilePaths.Require(path);
        var key = Key(agent);
        var row = await database
            .ReadAsync(
                async (tx, cancel) =>
                {
                    await using var command = tx.Command(
                        "SELECT kind, size, blob_key, sha256, CASE WHEN inline IS NULL THEN NULL"
                            + " ELSE substring(inline FROM $3 FOR $4) END FROM agent_files"
                            + " WHERE agent = $1 AND path = $2",
                        key,
                        path,
                        offset >= int.MaxValue ? int.MaxValue : (int)offset + 1,
                        Math.Max(count, 0)
                    );
                    await using var reader = await command.ExecuteReaderAsync(cancel).ConfigureAwait(false);
                    if (!await reader.ReadAsync(cancel).ConfigureAwait(false))
                    {
                        await reader.CloseAsync().ConfigureAwait(false);
                        return await HasChildrenAsync(tx, key, path, cancel).ConfigureAwait(false)
                            ? ("dir", 0L, (string?)null, (byte[]?)null, (byte[]?)null)
                            : default;
                    }
                    return (
                        reader.GetString(0),
                        reader.GetInt64(1),
                        reader.IsDBNull(2) ? null : reader.GetString(2),
                        reader.IsDBNull(3) ? null : reader.GetFieldValue<byte[]>(3),
                        reader.IsDBNull(4) ? null : reader.GetFieldValue<byte[]>(4)
                    );
                },
                snapshot: true,
                token: token
            )
            .ConfigureAwait(false);
        if (row.Item1 is null)
            throw AgentFileErrors.NotFound(path);
        if (row.Item1 == "dir")
            throw AgentFileErrors.IsDirectory(path);
        var (_, size, blobKey, sha256, slice) = row;
        var bytes = slice ?? (blobKey is null ? [] : await blobs.ReadRangeAsync(blobKey, offset, count, token).ConfigureAwait(false));
        var expected = offset >= size ? 0 : Math.Min(count, size - offset);
        if (
            bytes.Length != expected
            || offset == 0 && expected == size && !SHA256.HashData(bytes).AsSpan().SequenceEqual(sha256)
        )
            throw new IOException("Stored content of " + path + " doesn't match its digest.");
        return bytes;
    }

    public async Task<AgentFileContent> ReadAsync(string? agent, string path, CancellationToken token) =>
        (await ReadBoundedAsync(agent, path, long.MaxValue, token).ConfigureAwait(false))!;

    // One row: its content is fetched only when its size is within the bound.
    public async Task<AgentFileContent?> ReadBoundedAsync(string? agent, string path, long maxBytes, CancellationToken token)
    {
        var row = await LookupAsync(agent, path, token, maxBytes).ConfigureAwait(false);
        if (row.Size > maxBytes)
            return null;
        var bytes = row.Inline ?? await blobs.ReadAllAsync(row.BlobKey!, token).ConfigureAwait(false);
        if (bytes.Length != row.Size || !SHA256.HashData(bytes).AsSpan().SequenceEqual(row.Sha256))
            throw new IOException("Stored content of " + path + " doesn't match its digest.");
        return new(bytes, row.Generation);
    }

    // The file row at a path; a directory or a missing path fails as a file read does.
    private async Task<Row> LookupAsync(string? agent, string path, CancellationToken token, long maxBytes = long.MaxValue)
    {
        AgentFilePaths.Require(path);
        var key = Key(agent);
        var row = await database
            .ReadAsync(
                async (tx, cancel) =>
                {
                    await using var command = tx.Command(
                        "SELECT kind, generation, size, sha256, CASE WHEN size <= $3 THEN inline END, blob_key FROM agent_files"
                            + " WHERE agent = $1 AND path = $2",
                        key,
                        path,
                        maxBytes
                    );
                    await using var reader = await command.ExecuteReaderAsync(cancel).ConfigureAwait(false);
                    if (!await reader.ReadAsync(cancel).ConfigureAwait(false))
                    {
                        await reader.CloseAsync().ConfigureAwait(false);
                        return await HasChildrenAsync(tx, key, path, cancel).ConfigureAwait(false)
                            ? new Row("dir", 0, 0, null, null, null)
                            : null;
                    }
                    return new Row(
                        reader.GetString(0),
                        reader.GetInt64(1),
                        reader.GetInt64(2),
                        reader.IsDBNull(3) ? null : reader.GetFieldValue<byte[]>(3),
                        reader.IsDBNull(4) ? null : reader.GetFieldValue<byte[]>(4),
                        reader.IsDBNull(5) ? null : reader.GetString(5)
                    );
                },
                snapshot: true,
                token: token
            )
            .ConfigureAwait(false);
        if (row is null)
            throw AgentFileErrors.NotFound(path);
        if (row.Kind == "dir")
            throw AgentFileErrors.IsDirectory(path);
        return row;
    }

    public Task<long> WriteAsync(
        string? agent,
        string path,
        ReadOnlyMemory<byte> content,
        long? expectedGeneration,
        CancellationToken token
    )
    {
        AgentFilePaths.Require(path);
        expectedGeneration = AgentFileErrors.Normalize(expectedGeneration);
        var key = Key(agent);
        RequireKeyBytes(key, path);
        if (content.Length > limits().FileBytes)
            throw AgentFileErrors.FileTooLarge(path, limits());
        return lanes.RunAsync(
            key,
            async () =>
            {
                var sha256 = SHA256.HashData(content.Span);
                BlobReservation? reservation = null;
                if (content.Length > InlineBytes)
                {
                    var reservations = await ReserveAsync(key, [(sha256, content)], async (tx, usage, limit, cancel) =>
                    {
                        if (content.Length > limit.FileBytes) throw AgentFileErrors.FileTooLarge(path, limit);
                        var (bytes, entries) = await WriteAdmissionAsync(tx, key, agent, path, content.Length, expectedGeneration, cancel);
                        usage.Admit(limit, bytes, entries);
                    }, token);
                    reservation = reservations[BlobKey(key, sha256)];
                }
                long generation = 0;
                return await database
                    .WriteAsync(
                        async (tx, cancel) =>
                        {
                            var usage = await LockUsageAsync(tx, cancel).ConfigureAwait(false);
                            var limit = limits();
                            if (content.Length > limit.FileBytes)
                                throw AgentFileErrors.FileTooLarge(path, limit);
                            await RequireAgentAsync(tx, key, agent, cancel).ConfigureAwait(false);
                            var current = await RowAtAsync(tx, key, path, cancel).ConfigureAwait(false);
                            if (
                                current?.Kind == "dir"
                                || current is null && await HasChildrenAsync(tx, key, path, cancel).ConfigureAwait(false)
                            )
                                throw AgentFileErrors.IsDirectory(path);
                            Expect(current, path, expectedGeneration);
                            var entries =
                                (current is null ? 1 : 0)
                                - await PrepareParentsAsync(tx, key, path, cancel).ConfigureAwait(false);
                            var bytes = content.Length - (current?.Size ?? 0);
                            usage.Admit(limit, bytes, entries);
                            var blobKey = reservation is null ? null : await PublishBlobAsync(tx, reservation, content, sha256, cancel);
                            generation = await AllocateGenerationAsync(tx, cancel).ConfigureAwait(false);
                            await tx.ExecuteAsync(
                                    "INSERT INTO agent_files (agent, path, kind, size, sha256, generation, inline, blob_key)"
                                        + " VALUES ($1, $2, 'file', $3, $4, $5, $6, $7)"
                                        + " ON CONFLICT (tenant_id, agent, path) DO UPDATE SET kind = 'file',"
                                        + " size = excluded.size, sha256 = excluded.sha256,"
                                        + " generation = excluded.generation, inline = excluded.inline,"
                                        + " blob_key = excluded.blob_key, updated_at = now()",
                                    cancel,
                                    key,
                                    path,
                                    (long)content.Length,
                                    sha256,
                                    generation,
                                    blobKey is null
                                        ? new NpgsqlParameter<ReadOnlyMemory<byte>> { TypedValue = content }
                                        : NullBytes(),
                                    blobKey
                                )
                                .ConfigureAwait(false);
                            await ApplyUsageAsync(tx, bytes, entries, cancel).ConfigureAwait(false);
                            BeforeCommit?.Invoke();
                            return generation;
                        },
                        new PgWriteOptions(
                            Verify: tx =>
                                tx.Scalar(
                                    "SELECT 1 FROM agent_files WHERE agent = $1 AND path = $2 AND generation = $3",
                                    key,
                                    path,
                                    generation
                                )
                                    is not null,
                            Retryable: true
                        ),
                        token
                    )
                    .ConfigureAwait(false);
            },
            token
        );
    }

    public Task DeleteAsync(
        string? agent,
        string path,
        bool recursive,
        long? expectedGeneration,
        CancellationToken token
    )
    {
        AgentFilePaths.Require(path, allowRoot: true);
        if (path.Length == 0)
            throw AgentFileErrors.Root();
        expectedGeneration = AgentFileErrors.Normalize(expectedGeneration);
        var key = Key(agent);
        return lanes.RunAsync(
            key,
            () =>
                database.WriteAsync(
                    async (tx, cancel) =>
                    {
                        _ = await LockUsageAsync(tx, cancel).ConfigureAwait(false);
                        await RequireAgentAsync(tx, key, agent, cancel).ConfigureAwait(false);
                        var current = await RowAtAsync(tx, key, path, cancel).ConfigureAwait(false);
                        var children = await HasChildrenAsync(tx, key, path, cancel).ConfigureAwait(false);
                        if (current is null && !children)
                            throw AgentFileErrors.NotFound(path);
                        // A conditional delete removes the file it observed, never a directory.
                        if (expectedGeneration is not null && current?.Kind != "file")
                            throw AgentFileErrors.Changed(path);
                        long bytes;
                        long entries;
                        if (current?.Kind == "file")
                        {
                            Expect(current, path, expectedGeneration);
                            await tx.ExecuteAsync(
                                    "DELETE FROM agent_files WHERE agent = $1 AND path = $2",
                                    cancel,
                                    key,
                                    path
                                )
                                .ConfigureAwait(false);
                            (bytes, entries) = (-current.Size, -1);
                        }
                        else
                        {
                            if (children && !recursive)
                                throw AgentFileErrors.NotEmpty(path);
                            var (range, parameters) = Below(path, 3);
                            (bytes, entries) = await RemovedAsync(
                                    tx,
                                    "DELETE FROM agent_files WHERE agent = $1 AND (path = $2 OR " + range + ") RETURNING size",
                                    [key, path, .. parameters],
                                    cancel
                                )
                                .ConfigureAwait(false);
                        }
                        entries += await KeepParentAsync(tx, key, path, cancel).ConfigureAwait(false);
                        await ApplyUsageAsync(tx, bytes, entries, cancel).ConfigureAwait(false);
                        BeforeCommit?.Invoke();
                        return true;
                    },
                    new PgWriteOptions(Verify: tx => StatIn(tx, key, path) is null, Retryable: true),
                    token
                ),
            token
        );
    }

    public Task RenameAsync(string? agent, string from, string to, bool overwrite, CancellationToken token)
    {
        AgentFilePaths.Require(from, allowRoot: true);
        AgentFilePaths.Require(to, allowRoot: true);
        if (from.Length == 0 || to.Length == 0)
            throw AgentFileErrors.Root();
        var key = Key(agent);
        RequireKeyBytes(key, to);
        return lanes.RunAsync(
            key,
            () =>
                database.WriteAsync(
                    async (tx, cancel) =>
                    {
                        var usage = await LockUsageAsync(tx, cancel).ConfigureAwait(false);
                        await RequireAgentAsync(tx, key, agent, cancel).ConfigureAwait(false);
                        var source = await RowAtAsync(tx, key, from, cancel).ConfigureAwait(false);
                        var directory =
                            source?.Kind == "dir"
                            || source is null && await HasChildrenAsync(tx, key, from, cancel).ConfigureAwait(false);
                        if (source is null && !directory)
                            throw AgentFileErrors.NotFound(from);
                        if (from == to)
                            return true;
                        if (directory && AgentFilePaths.Within(to, from))
                            throw AgentFileErrors.IntoItself(from);
                        var target = await RowAtAsync(tx, key, to, cancel).ConfigureAwait(false);
                        if (
                            target?.Kind == "dir"
                            || target is null && await HasChildrenAsync(tx, key, to, cancel).ConfigureAwait(false)
                        )
                            throw directory ? AgentFileErrors.Exists(to) : AgentFileErrors.IsDirectory(to);
                        long bytes = 0;
                        long entries = 0;
                        if (target is not null)
                        {
                            if (directory || !overwrite)
                                throw AgentFileErrors.Exists(to);
                            await tx.ExecuteAsync(
                                    "DELETE FROM agent_files WHERE agent = $1 AND path = $2",
                                    cancel,
                                    key,
                                    to
                                )
                                .ConfigureAwait(false);
                            (bytes, entries) = (-target.Size, -1);
                        }
                        entries -= await PrepareParentsAsync(tx, key, to, cancel).ConfigureAwait(false);
                        if (directory)
                        {
                            await RequireMovedKeyBytesAsync(tx, key, from, key, to, cancel).ConfigureAwait(false);
                            var (range, parameters) = Below(from, 4);
                            await tx.ExecuteAsync(
                                    "UPDATE agent_files SET path = $3 || substr(path, char_length($2) + 1)"
                                        + " WHERE agent = $1 AND (path = $2 OR " + range + ")",
                                    cancel,
                                    [key, from, to, .. parameters]
                                )
                                .ConfigureAwait(false);
                        }
                        else
                            await tx.ExecuteAsync(
                                    "UPDATE agent_files SET path = $3 WHERE agent = $1 AND path = $2",
                                    cancel,
                                    key,
                                    from,
                                    to
                                )
                                .ConfigureAwait(false);
                        entries += await KeepParentAsync(tx, key, from, cancel).ConfigureAwait(false);
                        usage.Admit(limits(), bytes, entries);
                        await ApplyUsageAsync(tx, bytes, entries, cancel).ConfigureAwait(false);
                        BeforeCommit?.Invoke();
                        return true;
                    },
                    new PgWriteOptions(
                        Verify: tx => StatIn(tx, key, from) is null && StatIn(tx, key, to) is not null,
                        Retryable: true
                    ),
                    token
                ),
            token
        );
    }

    public Task MakeDirectoryAsync(string? agent, string path, CancellationToken token)
    {
        AgentFilePaths.Require(path);
        var key = Key(agent);
        RequireKeyBytes(key, path);
        return lanes.RunAsync(
            key,
            () =>
                database.WriteAsync(
                    async (tx, cancel) =>
                    {
                        var usage = await LockUsageAsync(tx, cancel).ConfigureAwait(false);
                        await RequireAgentAsync(tx, key, agent, cancel).ConfigureAwait(false);
                        var current = await RowAtAsync(tx, key, path, cancel).ConfigureAwait(false);
                        if (current?.Kind == "file")
                            throw AgentFileErrors.NotDirectory(path);
                        if (current is not null || await HasChildrenAsync(tx, key, path, cancel).ConfigureAwait(false))
                            return true;
                        var entries = 1 - await PrepareParentsAsync(tx, key, path, cancel).ConfigureAwait(false);
                        usage.Admit(limits(), 0, entries);
                        await InsertDirectoryAsync(tx, key, path, cancel).ConfigureAwait(false);
                        await ApplyUsageAsync(tx, 0, entries, cancel).ConfigureAwait(false);
                        BeforeCommit?.Invoke();
                        return true;
                    },
                    new PgWriteOptions(Verify: tx => StatIn(tx, key, path) is not null, Retryable: true),
                    token
                ),
            token
        );
    }

    /// <summary>Agents that exist (have a root row), in ordinal order.</summary>
    public IReadOnlyList<string> Agents() =>
        database.Read(tx =>
        {
            using var command = tx.Command("SELECT agent FROM agent_files WHERE path = '' AND agent <> ''");
            using var reader = command.ExecuteReader();
            var names = new List<string>();
            while (reader.Read())
                names.Add(reader.GetString(0));
            return names.Order(StringComparer.Ordinal).ToArray();
        });

    public bool AgentExists(string agent)
    {
        AgentCatalog.ValidateName(agent);
        return database.Read(tx =>
            tx.Scalar("SELECT 1 FROM agent_files WHERE agent = $1 AND path = ''", agent) is not null
        );
    }

    /// <summary>
    /// Creates an Agent's root with its first directories and files in one transaction. An
    /// existing Agent fails with <see cref="AgentFileConflictException"/>.
    /// </summary>
    public Task CreateAgentAsync(
        string agent,
        IReadOnlyList<string> directories,
        IReadOnlyList<KeyValuePair<string, byte[]>> files,
        CancellationToken token,
        bool restoration = false
    )
    {
        AgentCatalog.ValidateName(agent);
        if (!restoration)
            AgentCatalog.ValidateNewName(agent);
        foreach (var directory in directories)
            AgentFilePaths.Require(directory);
        foreach (var file in files)
            AgentFilePaths.Require(file.Key);
        var paths = directories.Concat(files.Select(file => file.Key)).ToArray();
        if (paths.Distinct(StringComparer.Ordinal).Count() != paths.Length)
            throw new ArgumentException("An Agent's initial paths must be distinct.");
        foreach (var file in files)
            if (paths.Any(other => other != file.Key && AgentFilePaths.Within(other, file.Key)))
                throw AgentFileErrors.NotDirectory(file.Key);
        foreach (var path in paths)
            RequireKeyBytes(agent, path);
        AdmitCreation(agent, directories, files);
        return lanes.RunAsync(
            agent,
            async () =>
            {
                // Only directories no file lies below need a row of their own.
                var empty = directories
                    .Where(directory => !paths.Any(other => other != directory && AgentFilePaths.Within(other, directory)))
                    .ToArray();
                var stored = files.Select(file => (Path: file.Key, Content: file.Value, Sha256: SHA256.HashData(file.Value))).ToArray();
                var largeFiles = stored.Where(file => file.Content.Length > InlineBytes)
                    .Select(file => (file.Sha256, (ReadOnlyMemory<byte>)file.Content)).ToArray();
                var reservations = await ReserveAsync(agent, largeFiles, async (tx, usage, limit, cancel) =>
                {
                    if (await RowAtAsync(tx, agent, "", cancel) is not null)
                        throw new AgentFileConflictException($"Agent '{agent}' already exists.");
                    if (stored.FirstOrDefault(file => file.Content.Length > limit.FileBytes) is { Path: not null } large)
                        throw AgentFileErrors.FileTooLarge(large.Path, limit);
                    usage.Admit(limit, files.Sum(file => (long)file.Value.Length), files.Count + empty.Length);
                }, token);
                return await database
                    .WriteAsync(
                        async (tx, cancel) =>
                        {
                            var usage = await LockUsageAsync(tx, cancel).ConfigureAwait(false);
                            if (await RowAtAsync(tx, agent, "", cancel).ConfigureAwait(false) is not null)
                                throw new AgentFileConflictException($"Agent '{agent}' already exists.");
                            var bytes = stored.Sum(file => (long)file.Content.Length);
                            var entries = (long)stored.Length + empty.Length;
                            var limit = limits();
                            if (stored.FirstOrDefault(file => file.Content.Length > limit.FileBytes) is { Path: not null } large)
                                throw AgentFileErrors.FileTooLarge(large.Path, limit);
                            usage.Admit(limit, bytes, entries);
                            await InsertDirectoryAsync(tx, agent, "", cancel).ConfigureAwait(false);
                            foreach (var directory in empty)
                                await InsertDirectoryAsync(tx, agent, directory, cancel).ConfigureAwait(false);
                            foreach (var file in stored)
                            {
                                var blobKey = file.Content.Length <= InlineBytes ? null : await PublishBlobAsync(tx,
                                    reservations[BlobKey(agent, file.Sha256)], file.Content, file.Sha256, cancel);
                                await tx.ExecuteAsync(
                                        "INSERT INTO agent_files (agent, path, kind, size, sha256, generation, inline, blob_key)"
                                            + " VALUES ($1, $2, 'file', $3, $4, $5, $6, $7)",
                                        cancel,
                                        agent,
                                        file.Path,
                                        (long)file.Content.Length,
                                        file.Sha256,
                                        await AllocateGenerationAsync(tx, cancel).ConfigureAwait(false),
                                        blobKey is null ? file.Content : NullBytes(),
                                        blobKey
                                    )
                                    .ConfigureAwait(false);
                            }
                            await ApplyUsageAsync(tx, bytes, entries, cancel).ConfigureAwait(false);
                            BeforeCommit?.Invoke();
                            return true;
                        },
                        new PgWriteOptions(
                            Verify: tx =>
                                tx.Scalar("SELECT 1 FROM agent_files WHERE agent = $1 AND path = ''", agent)
                                    is not null,
                            Retryable: true
                        ),
                        token
                    )
                    .ConfigureAwait(false);
            },
            token
        );
    }

    /// <summary>Removes an Agent's root and every file of it in one transaction; a missing Agent is a no-op.</summary>
    public Task DeleteAgentAsync(string agent, CancellationToken token) => RemoveAgentAsync(agent, keepRoot: false, token);

    public Task ClearAgentAsync(string agent, CancellationToken token) => RemoveAgentAsync(agent, keepRoot: true, token);

    private Task RemoveAgentAsync(string agent, bool keepRoot, CancellationToken token)
    {
        AgentCatalog.ValidateName(agent);
        return lanes.RunAsync(
            agent,
            () =>
                database.WriteAsync(
                    async (tx, cancel) =>
                    {
                        _ = await LockUsageAsync(tx, cancel).ConfigureAwait(false);
                        var (bytes, entries) = await RemovedAsync(
                                tx,
                                "DELETE FROM agent_files WHERE agent = $1 AND path <> '' RETURNING size",
                                [agent],
                                cancel
                            )
                            .ConfigureAwait(false);
                        if (!keepRoot)
                            await tx.ExecuteAsync(
                                    "DELETE FROM agent_files WHERE agent = $1 AND path = ''",
                                    cancel,
                                    agent
                                )
                                .ConfigureAwait(false);
                        await ApplyUsageAsync(tx, bytes, entries, cancel).ConfigureAwait(false);
                        BeforeCommit?.Invoke();
                        return true;
                    },
                    new PgWriteOptions(
                        Verify: tx =>
                            tx.Scalar("SELECT 1 FROM agent_files WHERE agent = $1 AND path <> ''", agent) is null
                            && (keepRoot || tx.Scalar("SELECT 1 FROM agent_files WHERE agent = $1", agent) is null),
                        Retryable: true
                    ),
                    token
                ),
            token
        );
    }

    public IReadOnlyList<AgentFileStat> Tree(string? agent, string path)
    {
        AgentFilePaths.Require(path, allowRoot: true);
        var key = Key(agent);
        var (range, parameters) = Below(path, 3);
        return database
            .Read(tx =>
            {
                using var command = tx.Command(
                    "SELECT path, " + Columns + " FROM agent_files WHERE agent = $1 AND path <> ''"
                        + " AND (path = $2 OR " + range + ")",
                    [key, path, .. parameters]
                );
                using var reader = command.ExecuteReader();
                var result = new List<AgentFileStat>();
                while (reader.Read())
                    result.Add(
                        new(
                            reader.GetString(0),
                            reader.GetString(1) == "dir",
                            reader.GetInt64(3),
                            reader.GetInt64(2),
                            DateTime.SpecifyKind(reader.GetDateTime(4), DateTimeKind.Utc)
                        )
                    );
                return result;
            })
            .OrderBy(entry => entry.Path, StringComparer.Ordinal)
            .ToArray();
    }

    public Task CopyTreeAsync(
        string sourceAgent,
        string sourcePath,
        string targetAgent,
        string targetPath,
        CancellationToken token
    )
    {
        AgentCatalog.ValidateName(sourceAgent);
        AgentCatalog.ValidateName(targetAgent);
        AgentFilePaths.Require(sourcePath, allowRoot: true);
        AgentFilePaths.Require(targetPath, allowRoot: true);
        if (sourceAgent == targetAgent && (AgentFilePaths.Within(targetPath, sourcePath) || AgentFilePaths.Within(sourcePath, targetPath)))
            throw AgentFileErrors.IntoItself(sourcePath);
        RequireKeyBytes(targetAgent, targetPath);
        return lanes.RunAsync(
            targetAgent,
            () =>
                database.WriteAsync(
                    async (tx, cancel) =>
                    {
                        var usage = await LockUsageAsync(tx, cancel).ConfigureAwait(false);
                        var limit = limits();
                        await RequireAgentAsync(tx, targetAgent, targetAgent, cancel).ConfigureAwait(false);
                        await RequireMovedKeyBytesAsync(tx, sourceAgent, sourcePath, targetAgent, targetPath, cancel)
                            .ConfigureAwait(false);
                        // Metadata only: contents are copied inside the database, row by row.
                        var (range, parameters) = Below(sourcePath, 3);
                        var rows = new List<(string Path, string Kind, long Size)>();
                        await using (
                            var command = tx.Command(
                                "SELECT path, kind, size FROM agent_files"
                                    + " WHERE agent = $1 AND path <> '' AND (path = $2 OR " + range + ")",
                                [sourceAgent, sourcePath, .. parameters]
                            )
                        )
                        await using (var reader = await command.ExecuteReaderAsync(cancel).ConfigureAwait(false))
                            while (await reader.ReadAsync(cancel).ConfigureAwait(false))
                                rows.Add((reader.GetString(0), reader.GetString(1), reader.GetInt64(2)));
                        rows.Sort((left, right) => string.CompareOrdinal(left.Path, right.Path));
                        string Target(string path)
                        {
                            var rest = path.Length == sourcePath.Length ? "" : path[(sourcePath.Length == 0 ? 0 : sourcePath.Length + 1)..];
                            return rest.Length == 0 ? targetPath : targetPath.Length == 0 ? rest : targetPath + "/" + rest;
                        }
                        // Admission before any content moves: the per-file limit for every copied
                        // file and the byte growth. Entries are exact only after the parents are
                        // settled, so they are checked with the rest at the end.
                        long bytes = 0;
                        foreach (var row in rows.Where(row => row.Kind == "file"))
                        {
                            if (row.Size > limit.FileBytes)
                                throw AgentFileErrors.FileTooLarge(Target(row.Path), limit);
                            var current = await RowAtAsync(tx, targetAgent, Target(row.Path), cancel).ConfigureAwait(false);
                            bytes += row.Size - (current?.Kind == "file" ? current.Size : 0);
                        }
                        usage.Admit(limit, bytes, 0);
                        bytes = 0;
                        long entries = 0;
                        foreach (var row in rows)
                        {
                            var target = Target(row.Path);
                            if (target.Length == 0)
                                continue;
                            var current = await RowAtAsync(tx, targetAgent, target, cancel).ConfigureAwait(false);
                            var children = current is null && await HasChildrenAsync(tx, targetAgent, target, cancel).ConfigureAwait(false);
                            if (row.Kind == "dir")
                            {
                                if (current?.Kind == "file")
                                    throw AgentFileErrors.NotDirectory(target);
                                if (current is not null || children)
                                    continue;
                                entries += 1 - await PrepareParentsAsync(tx, targetAgent, target, cancel).ConfigureAwait(false);
                                await InsertDirectoryAsync(tx, targetAgent, target, cancel).ConfigureAwait(false);
                                continue;
                            }
                            if (current?.Kind == "dir" || children)
                                throw AgentFileErrors.IsDirectory(target);
                            entries += (current is null ? 1 : 0) - await PrepareParentsAsync(tx, targetAgent, target, cancel).ConfigureAwait(false);
                            bytes += row.Size - (current?.Size ?? 0);
                            await tx.ExecuteAsync(
                                    "INSERT INTO agent_files (agent, path, kind, size, sha256, generation, inline, blob_key)"
                                        + " SELECT $1, $2, 'file', size, sha256, $3, inline, blob_key FROM agent_files"
                                        + " WHERE agent = $4 AND path = $5"
                                        + " ON CONFLICT (tenant_id, agent, path) DO UPDATE SET kind = 'file',"
                                        + " size = excluded.size, sha256 = excluded.sha256,"
                                        + " generation = excluded.generation, inline = excluded.inline,"
                                        + " blob_key = excluded.blob_key, updated_at = now()",
                                    cancel,
                                    targetAgent,
                                    target,
                                    await AllocateGenerationAsync(tx, cancel).ConfigureAwait(false),
                                    sourceAgent,
                                    row.Path
                                )
                                .ConfigureAwait(false);
                        }
                        usage.Admit(limit, bytes, entries);
                        await ApplyUsageAsync(tx, bytes, entries, cancel).ConfigureAwait(false);
                        BeforeCommit?.Invoke();
                        return true;
                    },
                    // A lost COMMIT stays unknown (CommitOutcomeUnknownException); repeating the
                    // copy is harmless.
                    new PgWriteOptions(Retryable: true),
                    token
                ),
            token
        );
    }

    /// <summary>The tenant's measured usage: content bytes and entries (files and empty directories).</summary>
    internal (long Bytes, long Entries) Usage() =>
        database.Read(tx =>
        {
            using var command = tx.Command("SELECT bytes, entries FROM agent_file_usage");
            using var reader = command.ExecuteReader();
            return reader.Read() ? (reader.GetInt64(0), reader.GetInt64(1)) : (0L, 0L);
        });

    private static string Key(string? agent)
    {
        if (agent is null)
            return "";
        AgentCatalog.ValidateName(agent);
        return agent;
    }

    private static NpgsqlParameter NullBytes() =>
        new() { Value = DBNull.Value, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Bytea };

    private sealed record Row(string Kind, long Generation, long Size, byte[]? Sha256, byte[]? Inline, string? BlobKey);

    private sealed record UsageRow(long Bytes, long Entries)
    {
        // Only growth is checked, so a tenant over a lowered limit can still delete and shrink.
        internal void Admit(AgentStoreLimits limit, long bytes, long entries)
        {
            if (bytes > 0 && Bytes + bytes > limit.TotalBytes)
                throw AgentFileErrors.TotalTooLarge(limit);
            if (entries > 0 && Entries + entries > limit.Files)
                throw AgentFileErrors.TooManyFiles(limit);
        }
    }

    private static async Task<object?> ScalarAsync(PgTx tx, string sql, CancellationToken token, params object?[] parameters)
    {
        await using var command = tx.Command(sql, parameters);
        var value = await command.ExecuteScalarAsync(token).ConfigureAwait(false);
        return value is DBNull ? null : value;
    }

    // Locks the tenant's usage row, creating it on the first write. Every write takes this lock
    // first, so writes of one tenant (across all of its Agents) run one at a time.
    /// <summary>
    /// The longest key the store indexes: the Agent name and the path in UTF-8, sized below
    /// PostgreSQL's 2,704-byte btree row limit with room for the tenant key and row overhead.
    /// </summary>
    internal const int KeyBytes = 2_560;

    private static void RequireKeyBytes(string key, string path)
    {
        if (KeySizeProblem(key, path) is { } error)
            throw error;
    }

    internal static AgentFilePathTooLongException? KeySizeProblem(string key, string path)
    {
        var limit = KeyBytes - Encoding.UTF8.GetByteCount(key);
        var bytes = Encoding.UTF8.GetByteCount(path);
        return bytes > limit ? AgentFileErrors.PathTooLong(bytes, limit) : null;
    }

    // A tree moved or copied from `from` to `to`: its longest resulting path must fit as well.
    private static async Task RequireMovedKeyBytesAsync(
        PgTx tx,
        string sourceKey,
        string from,
        string targetKey,
        string to,
        CancellationToken token
    )
    {
        var (range, parameters) = Below(from, 3);
        var longest = await ScalarAsync(
                tx,
                "SELECT max(octet_length(path)) FROM agent_files WHERE agent = $1 AND (path = $2 OR " + range + ")",
                token,
                [sourceKey, from, .. parameters]
            )
            .ConfigureAwait(false);
        if (longest is not int and not long)
            return;
        var bytes =
            Convert.ToInt64(longest)
            - Encoding.UTF8.GetByteCount(from)
            + Encoding.UTF8.GetByteCount(to)
            + (from.Length == 0 && to.Length > 0 ? 1 : 0)
            - (to.Length == 0 && from.Length > 0 ? 1 : 0);
        var limit = KeyBytes - Encoding.UTF8.GetByteCount(targetKey);
        if (bytes > limit)
            throw AgentFileErrors.PathTooLong(bytes, limit);
    }

    // The checks of a file write's commit, without its effects: membership, the target's and
    // its parents' shape and the expected generation. Returns the usage the write adds.
    private static async Task<(long Bytes, long Entries)> WriteAdmissionAsync(
        PgTx tx,
        string key,
        string? agent,
        string path,
        long length,
        long? expectedGeneration,
        CancellationToken token
    )
    {
        await RequireAgentAsync(tx, key, agent, token).ConfigureAwait(false);
        var current = await RowAtAsync(tx, key, path, token).ConfigureAwait(false);
        if (current?.Kind == "dir" || current is null && await HasChildrenAsync(tx, key, path, token).ConfigureAwait(false))
            throw AgentFileErrors.IsDirectory(path);
        Expect(current, path, expectedGeneration);
        var ancestors = AgentFilePaths.Ancestors(path);
        long implicitDirectories = 0;
        if (ancestors.Length > 0)
        {
            if (
                await ScalarAsync(
                        tx,
                        "SELECT path FROM agent_files WHERE agent = $1 AND path = ANY($2) AND kind = 'file' ORDER BY path LIMIT 1",
                        token,
                        key,
                        ancestors
                    )
                    .ConfigureAwait(false)
                is string file
            )
                throw AgentFileErrors.NotDirectory(file);
            implicitDirectories = Convert.ToInt64(
                await ScalarAsync(
                        tx,
                        "SELECT count(*) FROM agent_files WHERE agent = $1 AND path = ANY($2) AND kind = 'dir'",
                        token,
                        key,
                        ancestors
                    )
                    .ConfigureAwait(false)
            );
        }
        return (length - (current?.Size ?? 0), (current is null ? 1 : 0) - implicitDirectories);
    }

    /// <summary>
    /// Whether a new Agent with these initial entries fits the limits now: the check a
    /// creation runs before anything about it is committed. The creation checks again.
    /// </summary>
    public void AdmitCreation(
        string agent,
        IReadOnlyList<string> directories,
        IReadOnlyList<KeyValuePair<string, byte[]>> files
    )
    {
        var limit = limits();
        if (files.FirstOrDefault(file => file.Value.Length > limit.FileBytes) is { Key: not null } large)
            throw AgentFileErrors.FileTooLarge(large.Key, limit);
        foreach (var path in directories.Concat(files.Select(file => file.Key)))
            RequireKeyBytes(agent, path);
        var empty = directories.Count(directory =>
            !directories.Concat(files.Select(file => file.Key))
                .Any(other => other != directory && AgentFilePaths.Within(other, directory))
        );
        var (bytes, entries) = Usage();
        new UsageRow(bytes, entries).Admit(limit, files.Sum(file => (long)file.Value.Length), files.Count + empty);
    }

    private static async Task<UsageRow> LockUsageAsync(PgTx tx, CancellationToken token)
    {
        await using var command = tx.Command(
            "INSERT INTO agent_file_usage (bytes, entries) VALUES (0, 0) ON CONFLICT (tenant_id)"
                + " DO UPDATE SET bytes = agent_file_usage.bytes RETURNING bytes, entries"
        );
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        await reader.ReadAsync(token).ConfigureAwait(false);
        return new(reader.GetInt64(0), reader.GetInt64(1));
    }

    private static async Task<long> AllocateGenerationAsync(PgTx tx, CancellationToken token) =>
        (long)(
            await ScalarAsync(
                    tx,
                    "UPDATE agent_file_usage SET generation = generation + 1 RETURNING generation",
                    token
                )
                .ConfigureAwait(false)
        )!;

    private static async Task ApplyUsageAsync(PgTx tx, long bytes, long entries, CancellationToken token)
    {
        if (bytes != 0 || entries != 0)
            await tx.ExecuteAsync(
                    "UPDATE agent_file_usage SET bytes = bytes + $1, entries = entries + $2",
                    token,
                    bytes,
                    entries
                )
                .ConfigureAwait(false);
    }

    private static async Task RequireAgentAsync(PgTx tx, string key, string? agent, CancellationToken token)
    {
        if (
            key.Length > 0
            && await ScalarAsync(tx, "SELECT 1 FROM agent_files WHERE agent = $1 AND path = ''", token, key)
                .ConfigureAwait(false)
                is null
        )
            throw AgentFileErrors.NoAgent(agent);
    }

    private static async Task<Row?> RowAtAsync(PgTx tx, string key, string path, CancellationToken token)
    {
        await using var command = tx.Command(
            "SELECT kind, generation, size FROM agent_files WHERE agent = $1 AND path = $2 FOR UPDATE",
            key,
            path
        );
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        return await reader.ReadAsync(token).ConfigureAwait(false)
            ? new Row(reader.GetString(0), reader.GetInt64(1), reader.GetInt64(2), null, null, null)
            : null;
    }

    private static async Task InsertDirectoryAsync(PgTx tx, string key, string path, CancellationToken token) =>
        await tx.ExecuteAsync(
                "INSERT INTO agent_files (agent, path, kind, generation) VALUES ($1, $2, 'dir', 0)",
                token,
                key,
                path
            )
            .ConfigureAwait(false);

    // Synchronous, for Stat and lost-COMMIT verification.
    private static AgentFileStat? StatIn(PgTx tx, string key, string path)
    {
        using (
            var command = tx.Command(
                "SELECT " + Columns + " FROM agent_files WHERE agent = $1 AND path = $2",
                key,
                path
            )
        )
        using (var reader = command.ExecuteReader())
            if (reader.Read())
                return new(
                    path,
                    reader.GetString(0) == "dir",
                    reader.GetInt64(2),
                    reader.GetInt64(1),
                    DateTime.SpecifyKind(reader.GetDateTime(3), DateTimeKind.Utc)
                );
        var (range, parameters) = Below(path, 2);
        return tx.Scalar("SELECT max(updated_at) FROM agent_files WHERE agent = $1 AND " + range, [key, .. parameters])
            is DateTime updated
            ? new(path, true, 0, 0, DateTime.SpecifyKind(updated, DateTimeKind.Utc))
            : null;
    }

    private static async Task<bool> HasChildrenAsync(PgTx tx, string key, string path, CancellationToken token)
    {
        var (range, parameters) = Below(path, 2);
        return await ScalarAsync(
                    tx,
                    "SELECT 1 FROM agent_files WHERE agent = $1 AND " + range + " LIMIT 1",
                    token,
                    [key, .. parameters]
                )
                .ConfigureAwait(false)
            is not null;
    }

    // Paths strictly below a directory, as an index range: after "dir/" and before "dir0"
    // ('0' follows '/' in byte order). The parameters are numbered from firstParameter.
    private static (string Sql, object?[] Parameters) Below(string directory, int firstParameter) =>
        directory.Length == 0
            ? ("path <> ''", [])
            : (
                $"path > ${firstParameter} AND path < ${firstParameter + 1}",
                [directory + "/", directory + "0"]
            );

    private static string Prefix(string directory) => directory.Length == 0 ? "" : directory + "/";

    private static void Expect(Row? current, string path, long? expected)
    {
        if (expected is null)
            return;
        if (current is null)
        {
            if (expected != 0)
                throw AgentFileErrors.Changed(path);
            return;
        }
        if (expected == 0)
            throw AgentFileErrors.Exists(path);
        if (current.Generation != expected)
            throw AgentFileErrors.Changed(path);
    }

    // Before an entry is created at path: no ancestor may be a file, and an ancestor's
    // empty-directory row goes, since the new entry makes it implicit. Returns the rows removed.
    private static async Task<int> PrepareParentsAsync(PgTx tx, string key, string path, CancellationToken token)
    {
        var ancestors = AgentFilePaths.Ancestors(path);
        if (ancestors.Length == 0)
            return 0;
        if (
            await ScalarAsync(
                    tx,
                    "SELECT path FROM agent_files WHERE agent = $1 AND path = ANY($2) AND kind = 'file' ORDER BY path LIMIT 1",
                    token,
                    key,
                    ancestors
                )
                .ConfigureAwait(false)
            is string file
        )
            throw AgentFileErrors.NotDirectory(file);
        return await tx.ExecuteAsync(
                "DELETE FROM agent_files WHERE agent = $1 AND path = ANY($2) AND kind = 'dir'",
                token,
                key,
                ancestors
            )
            .ConfigureAwait(false);
    }

    // After the entry at path is gone, its parent directory stays, as file systems keep it.
    // Returns the rows added.
    private static async Task<int> KeepParentAsync(PgTx tx, string key, string path, CancellationToken token)
    {
        var parent = AgentFilePaths.Parent(path);
        if (
            parent.Length == 0
            || await RowAtAsync(tx, key, parent, token).ConfigureAwait(false) is not null
            || await HasChildrenAsync(tx, key, parent, token).ConfigureAwait(false)
        )
            return 0;
        await InsertDirectoryAsync(tx, key, parent, token).ConfigureAwait(false);
        return 1;
    }

    private static async Task<(long Bytes, long Entries)> RemovedAsync(
        PgTx tx,
        string sql,
        object?[] parameters,
        CancellationToken token
    )
    {
        await using var command = tx.Command(sql, parameters);
        await using var reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
        long bytes = 0;
        long entries = 0;
        while (await reader.ReadAsync(token).ConfigureAwait(false))
        {
            bytes -= reader.GetInt64(0);
            entries--;
        }
        return (bytes, entries);
    }
}
