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
internal sealed class PgAgentFileStore : IAgentFileStore
{
    internal const int InlineBytes = 256 * 1024;
    internal const string BlobStoreName = "agent-files";

    private const string Columns = "kind, generation, size, updated_at";

    private readonly TenantDb database;
    private readonly IBlobStore blobs;
    private readonly Func<AgentStoreLimits> limits;
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

    public async Task<AgentFileContent> ReadAsync(string? agent, string path, CancellationToken token)
    {
        AgentFilePaths.Require(path);
        var key = Key(agent);
        var row = await database
            .ReadAsync(
                async (tx, cancel) =>
                {
                    await using var command = tx.Command(
                        "SELECT kind, generation, size, sha256, inline, blob_key FROM agent_files"
                            + " WHERE agent = $1 AND path = $2",
                        key,
                        path
                    );
                    await using var reader = await command.ExecuteReaderAsync(cancel).ConfigureAwait(false);
                    if (!await reader.ReadAsync(cancel).ConfigureAwait(false))
                    {
                        await reader.CloseAsync().ConfigureAwait(false);
                        return HasChildren(tx, key, path) ? new Row("dir", 0, 0, null, null, null) : null;
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
        var bytes = row.Inline ?? await blobs.ReadAllAsync(row.BlobKey!, token).ConfigureAwait(false);
        if (bytes.Length != row.Size || !SHA256.HashData(bytes).AsSpan().SequenceEqual(row.Sha256))
            throw new IOException("Stored content of " + path + " doesn't match its digest.");
        return new(bytes, row.Generation);
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
        var limit = limits();
        if (content.Length > limit.FileBytes)
            throw FileTooLarge(limit);
        return lanes.RunAsync(
            key,
            async () =>
            {
                var sha256 = SHA256.HashData(content.Span);
                var blobKey = await StoreLargeAsync(key, content, sha256, token).ConfigureAwait(false);
                long generation = 0;
                return await database
                    .WriteAsync(
                        async (tx, cancel) =>
                        {
                            var usage = LockUsage(tx);
                            RequireAgent(tx, key, agent);
                            var current = RowAt(tx, key, path, forUpdate: true);
                            if (current?.Kind == "dir" || current is null && HasChildren(tx, key, path))
                                throw AgentFileErrors.IsDirectory(path);
                            Expect(current, path, expectedGeneration);
                            var entries = (current is null ? 1 : 0) - PrepareParents(tx, key, path);
                            var bytes = content.Length - (current?.Size ?? 0);
                            usage.Admit(limit, bytes, entries);
                            generation = AllocateGeneration(tx);
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
                                        : new NpgsqlParameter { Value = DBNull.Value, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Bytea },
                                    blobKey
                                )
                                .ConfigureAwait(false);
                            ApplyUsage(tx, bytes, entries);
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
                    (tx, cancel) =>
                    {
                        _ = LockUsage(tx);
                        RequireAgent(tx, key, agent);
                        var current = RowAt(tx, key, path, forUpdate: true);
                        var children = HasChildren(tx, key, path);
                        if (current is null && !children)
                            throw AgentFileErrors.NotFound(path);
                        long bytes;
                        long entries;
                        if (current?.Kind == "file")
                        {
                            Expect(current, path, expectedGeneration);
                            tx.Execute("DELETE FROM agent_files WHERE agent = $1 AND path = $2", key, path);
                            (bytes, entries) = (-current.Size, -1);
                        }
                        else
                        {
                            if (children && !recursive)
                                throw AgentFileErrors.NotEmpty(path);
                            var (range, parameters) = Below(path, 3);
                            (bytes, entries) = Removed(
                                tx,
                                "DELETE FROM agent_files WHERE agent = $1 AND (path = $2 OR " + range + ") RETURNING size",
                                [key, path, .. parameters]
                            );
                        }
                        entries += KeepParent(tx, key, path);
                        ApplyUsage(tx, bytes, entries);
                        BeforeCommit?.Invoke();
                        return Task.FromResult(true);
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
        return lanes.RunAsync(
            key,
            () =>
                database.WriteAsync(
                    (tx, cancel) =>
                    {
                        var usage = LockUsage(tx);
                        RequireAgent(tx, key, agent);
                        var source = RowAt(tx, key, from, forUpdate: true);
                        var directory = source?.Kind == "dir" || source is null && HasChildren(tx, key, from);
                        if (source is null && !directory)
                            throw AgentFileErrors.NotFound(from);
                        if (from == to)
                            return Task.FromResult(true);
                        if (directory && AgentFilePaths.Within(to, from))
                            throw AgentFileErrors.IntoItself(from);
                        var target = RowAt(tx, key, to, forUpdate: true);
                        if (target?.Kind == "dir" || target is null && HasChildren(tx, key, to))
                            throw directory ? AgentFileErrors.Exists(to) : AgentFileErrors.IsDirectory(to);
                        long bytes = 0;
                        long entries = 0;
                        if (target is not null)
                        {
                            if (directory || !overwrite)
                                throw AgentFileErrors.Exists(to);
                            tx.Execute("DELETE FROM agent_files WHERE agent = $1 AND path = $2", key, to);
                            (bytes, entries) = (-target.Size, -1);
                        }
                        entries -= PrepareParents(tx, key, to);
                        if (directory)
                        {
                            var (range, parameters) = Below(from, 4);
                            tx.Execute(
                                "UPDATE agent_files SET path = $3 || substr(path, char_length($2) + 1)"
                                    + " WHERE agent = $1 AND (path = $2 OR " + range + ")",
                                [key, from, to, .. parameters]
                            );
                        }
                        else
                            tx.Execute(
                                "UPDATE agent_files SET path = $3 WHERE agent = $1 AND path = $2",
                                key,
                                from,
                                to
                            );
                        entries += KeepParent(tx, key, from);
                        usage.Admit(limits(), bytes, entries);
                        ApplyUsage(tx, bytes, entries);
                        BeforeCommit?.Invoke();
                        return Task.FromResult(true);
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
        return lanes.RunAsync(
            key,
            () =>
                database.WriteAsync(
                    (tx, cancel) =>
                    {
                        var usage = LockUsage(tx);
                        RequireAgent(tx, key, agent);
                        var current = RowAt(tx, key, path, forUpdate: true);
                        if (current?.Kind == "file")
                            throw AgentFileErrors.NotDirectory(path);
                        if (current is not null || HasChildren(tx, key, path))
                            return Task.FromResult(true);
                        var entries = 1 - PrepareParents(tx, key, path);
                        usage.Admit(limits(), 0, entries);
                        tx.Execute(
                            "INSERT INTO agent_files (agent, path, kind, generation) VALUES ($1, $2, 'dir', 0)",
                            key,
                            path
                        );
                        ApplyUsage(tx, 0, entries);
                        BeforeCommit?.Invoke();
                        return Task.FromResult(true);
                    },
                    new PgWriteOptions(Verify: tx => StatIn(tx, key, path) is not null, Retryable: true),
                    token
                ),
            token
        );
    }

    /// <summary>Agents that exist (have a root row), in ordinal order.</summary>
    internal IReadOnlyList<string> Agents() =>
        database.Read(tx =>
        {
            using var command = tx.Command("SELECT agent FROM agent_files WHERE path = '' AND agent <> ''");
            using var reader = command.ExecuteReader();
            var names = new List<string>();
            while (reader.Read())
                names.Add(reader.GetString(0));
            return names.Order(StringComparer.Ordinal).ToArray();
        });

    internal bool AgentExists(string agent)
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
    internal Task CreateAgentAsync(
        string agent,
        IReadOnlyList<string> directories,
        IReadOnlyList<KeyValuePair<string, byte[]>> files,
        CancellationToken token
    )
    {
        AgentCatalog.ValidateName(agent);
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
        var limit = limits();
        if (files.Any(file => file.Value.Length > limit.FileBytes))
            throw FileTooLarge(limit);
        return lanes.RunAsync(
            agent,
            async () =>
            {
                var stored = new List<(string Path, byte[] Content, byte[] Sha256, string? BlobKey)>();
                foreach (var (path, content) in files)
                {
                    var sha256 = SHA256.HashData(content);
                    stored.Add((path, content, sha256, await StoreLargeAsync(agent, content, sha256, token).ConfigureAwait(false)));
                }
                // Only directories no file lies below need a row of their own.
                var empty = directories
                    .Where(directory => !paths.Any(other => other != directory && AgentFilePaths.Within(other, directory)))
                    .ToArray();
                return await database
                    .WriteAsync(
                        (tx, cancel) =>
                        {
                            var usage = LockUsage(tx);
                            if (RowAt(tx, agent, "", forUpdate: true) is not null)
                                throw new AgentFileConflictException($"Agent '{agent}' already exists.");
                            var bytes = stored.Sum(file => (long)file.Content.Length);
                            var entries = (long)stored.Count + empty.Length;
                            usage.Admit(limit, bytes, entries);
                            tx.Execute(
                                "INSERT INTO agent_files (agent, path, kind, generation) VALUES ($1, '', 'dir', 0)",
                                agent
                            );
                            foreach (var directory in empty)
                                tx.Execute(
                                    "INSERT INTO agent_files (agent, path, kind, generation) VALUES ($1, $2, 'dir', 0)",
                                    agent,
                                    directory
                                );
                            foreach (var file in stored)
                                tx.Execute(
                                    "INSERT INTO agent_files (agent, path, kind, size, sha256, generation, inline, blob_key)"
                                        + " VALUES ($1, $2, 'file', $3, $4, $5, $6, $7)",
                                    agent,
                                    file.Path,
                                    (long)file.Content.Length,
                                    file.Sha256,
                                    AllocateGeneration(tx),
                                    file.BlobKey is null
                                        ? file.Content
                                        : new NpgsqlParameter { Value = DBNull.Value, NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Bytea },
                                    file.BlobKey
                                );
                            ApplyUsage(tx, bytes, entries);
                            BeforeCommit?.Invoke();
                            return Task.FromResult(true);
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
    internal Task DeleteAgentAsync(string agent, CancellationToken token)
    {
        AgentCatalog.ValidateName(agent);
        return lanes.RunAsync(
            agent,
            () =>
                database.WriteAsync(
                    (tx, cancel) =>
                    {
                        _ = LockUsage(tx);
                        var (bytes, entries) = Removed(
                            tx,
                            "DELETE FROM agent_files WHERE agent = $1 AND path <> '' RETURNING size",
                            [agent]
                        );
                        tx.Execute("DELETE FROM agent_files WHERE agent = $1 AND path = ''", agent);
                        ApplyUsage(tx, bytes, entries);
                        BeforeCommit?.Invoke();
                        return Task.FromResult(true);
                    },
                    new PgWriteOptions(
                        Verify: tx => tx.Scalar("SELECT 1 FROM agent_files WHERE agent = $1", agent) is null,
                        Retryable: true
                    ),
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

    private async Task<string?> StoreLargeAsync(
        string agent,
        ReadOnlyMemory<byte> content,
        byte[] sha256,
        CancellationToken token
    )
    {
        if (content.Length <= InlineBytes)
            return null;
        var key = BlobKey(agent, sha256);
        // Content-addressed, so an existing blob already holds these bytes.
        await blobs.CreateAsync(key, content, keepExisting: true, token).ConfigureAwait(false);
        return key;
    }

    private static AgentStoreQuotaException FileTooLarge(AgentStoreLimits limit) =>
        new("fileBytes", $"The file is larger than the Agent store's limit of {Size(limit.FileBytes)} per file.");

    private static string Size(long bytes) =>
        bytes % (1L << 30) == 0 ? $"{bytes >> 30} GiB"
        : bytes % (1L << 20) == 0 ? $"{bytes >> 20} MiB"
        : $"{bytes} bytes";

    private sealed record Row(string Kind, long Generation, long Size, byte[]? Sha256, byte[]? Inline, string? BlobKey);

    private sealed record UsageRow(long Bytes, long Entries)
    {
        // Only growth is checked, so a tenant over a lowered limit can still delete and shrink.
        internal void Admit(AgentStoreLimits limit, long bytes, long entries)
        {
            if (bytes > 0 && Bytes + bytes > limit.TotalBytes)
                throw new AgentStoreQuotaException(
                    "totalBytes",
                    $"The Agent store is full: this write would exceed its limit of {Size(limit.TotalBytes)}."
                );
            if (entries > 0 && Entries + entries > limit.Files)
                throw new AgentStoreQuotaException(
                    "files",
                    $"The Agent store is full: this write would exceed its limit of {limit.Files} files."
                );
        }
    }

    private static UsageRow LockUsage(PgTx tx)
    {
        using var command = tx.Command(
            "INSERT INTO agent_file_usage (bytes, entries) VALUES (0, 0) ON CONFLICT (tenant_id)"
                + " DO UPDATE SET bytes = agent_file_usage.bytes RETURNING bytes, entries"
        );
        using var reader = command.ExecuteReader();
        reader.Read();
        return new(reader.GetInt64(0), reader.GetInt64(1));
    }

    private static long AllocateGeneration(PgTx tx) =>
        (long)tx.Scalar("UPDATE agent_file_usage SET generation = generation + 1 RETURNING generation")!;

    private static void ApplyUsage(PgTx tx, long bytes, long entries)
    {
        if (bytes != 0 || entries != 0)
            tx.Execute(
                "UPDATE agent_file_usage SET bytes = bytes + $1, entries = entries + $2",
                bytes,
                entries
            );
    }

    private static void RequireAgent(PgTx tx, string key, string? agent)
    {
        if (key.Length > 0 && tx.Scalar("SELECT 1 FROM agent_files WHERE agent = $1 AND path = ''", key) is null)
            throw AgentFileErrors.NoAgent(agent);
    }

    private static Row? RowAt(PgTx tx, string key, string path, bool forUpdate = false)
    {
        using var command = tx.Command(
            "SELECT kind, generation, size FROM agent_files WHERE agent = $1 AND path = $2"
                + (forUpdate ? " FOR UPDATE" : ""),
            key,
            path
        );
        using var reader = command.ExecuteReader();
        return reader.Read()
            ? new Row(reader.GetString(0), reader.GetInt64(1), reader.GetInt64(2), null, null, null)
            : null;
    }

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

    private static bool HasChildren(PgTx tx, string key, string path)
    {
        var (range, parameters) = Below(path, 2);
        return tx.Scalar("SELECT 1 FROM agent_files WHERE agent = $1 AND " + range + " LIMIT 1", [key, .. parameters])
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
    private static int PrepareParents(PgTx tx, string key, string path)
    {
        var ancestors = AgentFilePaths.Ancestors(path);
        if (ancestors.Length == 0)
            return 0;
        if (
            tx.Scalar(
                "SELECT path FROM agent_files WHERE agent = $1 AND path = ANY($2) AND kind = 'file' ORDER BY path LIMIT 1",
                key,
                ancestors
            )
            is string file
        )
            throw AgentFileErrors.NotDirectory(file);
        return tx.Execute(
            "DELETE FROM agent_files WHERE agent = $1 AND path = ANY($2) AND kind = 'dir'",
            key,
            ancestors
        );
    }

    // After the entry at path is gone, its parent directory stays: as file systems keep it.
    // Returns the rows added.
    private static int KeepParent(PgTx tx, string key, string path)
    {
        var parent = AgentFilePaths.Parent(path);
        if (parent.Length == 0 || RowAt(tx, key, parent) is not null || HasChildren(tx, key, parent))
            return 0;
        tx.Execute(
            "INSERT INTO agent_files (agent, path, kind, generation) VALUES ($1, $2, 'dir', 0)",
            key,
            parent
        );
        return 1;
    }

    private static (long Bytes, long Entries) Removed(PgTx tx, string sql, object?[] parameters)
    {
        using var command = tx.Command(sql, parameters);
        using var reader = command.ExecuteReader();
        long bytes = 0;
        long entries = 0;
        while (reader.Read())
        {
            bytes -= reader.GetInt64(0);
            entries--;
        }
        return (bytes, entries);
    }
}
