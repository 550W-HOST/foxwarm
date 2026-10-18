using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

// Startup identity reconciliation only. Ordinary readers consult committed SQLite rows without repairing them.
internal sealed partial class CommittedArchiveIdentity(string root)
{
    private readonly SemaphoreSlim initialization = new(1, 1);
    private bool initialized;
    private HashSet<string> reserved = new(StringComparer.Ordinal);
    private string DatabasePath => Path.Combine(root, "state", "archive-store.sqlite");
    private string LedgerPath => Path.Combine(root, "state", "session-id-reservations.jsonl");

    internal bool IsReserved(string id) => reserved.Contains(id);

    internal async Task InitializeAsync(SessionCatalog catalog)
    {
        await initialization.WaitAsync();
        try
        {
            if (initialized)
                return;
            ValidateStartupEvidence(root);
            catalog.Initialize();
            var mappings = ReadLedger(out var rewrite);
            if (File.Exists(DatabasePath))
            {
                using var connection = Open(DatabasePath, SqliteOpenMode.ReadOnly);
                if (SqliteArchiveMessageStore.HasReservationTable(connection))
                {
                    using var command = connection.CreateCommand();
                    command.CommandText =
                        "SELECT session_id,canonical_session_id FROM archive_session_id_reservations";
                    using var rows = command.ExecuteReader();
                    while (rows.Read())
                    {
                        var id = rows.GetString(0);
                        var canonical = rows.GetString(1);
                        ValidateIdentity(id);
                        ValidateIdentity(canonical);
                        if (mappings.TryGetValue(id, out var prior) && prior != canonical)
                            throw new InvalidDataException(
                                "Archive identity ledger and SQLite have conflicting committed mappings."
                            );
                        if (mappings.TryAdd(id, canonical))
                            rewrite = true;
                    }
                }
            }
            ValidateGraph(mappings);
            foreach (var row in catalog.List())
            {
                var canonical = SessionCatalog.Text(row["id"])!;
                foreach (
                    var alias in (row["aliases"] as JsonArray)
                        ?.Select(SessionCatalog.Text)
                        .OfType<string>()
                        .Reverse()
                        ?? []
                )
                {
                    // Presentation claims are proof only when Main's exact-first resolution uniquely selects this owner.
                    if (SessionCatalog.Text(catalog.Resolve(alias)["sessionId"]) != canonical)
                        continue;
                    if (mappings.TryGetValue(alias, out _))
                    {
                        if (Resolve(mappings, alias) != canonical)
                            throw new InvalidDataException(
                                "Proven Main alias conflicts with committed Archive identity."
                            );
                        continue;
                    }
                    mappings.Add(alias, canonical);
                    ValidateGraph(mappings);
                    rewrite = true;
                }
            }
            if (rewrite)
                WriteLedger(mappings);
            if (File.Exists(DatabasePath) || mappings.Count > 0)
                Mirror(mappings);
            reserved = mappings.Keys.Concat(mappings.Values).ToHashSet(StringComparer.Ordinal);
            initialized = true;
        }
        finally
        {
            initialization.Release();
        }
    }

    private Dictionary<string, string> ReadLedger(out bool rewrite)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        string text;
        try
        {
            text = File.ReadAllText(LedgerPath);
            rewrite = false;
        }
        catch (FileNotFoundException)
        {
            rewrite = true;
            return result;
        }
        catch (DirectoryNotFoundException)
        {
            rewrite = true;
            return result;
        }
        foreach (var raw in text.Split('\n'))
        {
            var line = SessionGoal.Trim(raw);
            if (line.Length == 0)
                continue;
            JsonObject? row;
            try
            {
                row = JsonNode.Parse(line) as JsonObject;
            }
            catch (System.Text.Json.JsonException)
            {
                rewrite = true;
                continue;
            }
            if (
                row is null
                || SessionCatalog.Number(row["v"]) != 1
                || SessionCatalog.Text(row["sessionId"]) is not { Length: > 0 } id
                || SessionCatalog.Text(row["canonicalSessionId"]) is not { Length: > 0 } canonical
            )
            {
                rewrite = true;
                continue;
            }
            if (result.TryGetValue(id, out var prior) && prior != canonical)
                throw new InvalidDataException(
                    "Archive identity ledger has conflicting committed mappings."
                );
            result[id] = canonical;
        }
        return result;
    }

    private void WriteLedger(Dictionary<string, string> mappings, Action? afterRename = null)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(LedgerPath)!);
        var temp = LedgerPath + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            using (
                var stream = new FileStream(
                    temp,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None
                )
            )
            {
                if (!OperatingSystem.IsWindows())
                    File.SetUnixFileMode(temp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                foreach (
                    var (id, canonical) in mappings.OrderBy(
                        pair => pair.Key,
                        StringComparer.Ordinal
                    )
                )
                {
                    var line =
                        EcmaJson.Stringify(
                            new JsonObject
                            {
                                ["v"] = 1,
                                ["sessionId"] = id,
                                ["canonicalSessionId"] = canonical,
                                ["timestamp"] = now,
                            }
                        ) + "\n";
                    stream.Write(Encoding.UTF8.GetBytes(line));
                }
                stream.Flush(flushToDisk: true);
            }
            File.Move(temp, LedgerPath, overwrite: true);
            afterRename?.Invoke();
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(LedgerPath)!);
        }
        finally
        {
            File.Delete(temp);
        }
    }

    private void Mirror(Dictionary<string, string> mappings)
    {
        var ownedMappings = mappings.ToArray();
        var receipt = SqliteArchiveMessageStore
            .EnqueueWriteAsync(
                DatabasePath,
                (connection, transaction) =>
                {
                    using var command = connection.CreateCommand();
                    command.Transaction = transaction;
                    command.CommandText = """
                        INSERT INTO archive_session_id_reservations(session_id,canonical_session_id,created_at,updated_at)
                        VALUES($id,$canonical,$at,$at)
                        ON CONFLICT(session_id) DO UPDATE SET updated_at=excluded.updated_at
                        WHERE archive_session_id_reservations.canonical_session_id=excluded.canonical_session_id
                        """;
                    command.Parameters.Add("$id", SqliteType.Text);
                    command.Parameters.Add("$canonical", SqliteType.Text);
                    command.Parameters.AddWithValue(
                        "$at",
                        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    );
                    foreach (var (id, canonical) in ownedMappings)
                    {
                        command.Parameters["$id"].Value = id;
                        command.Parameters["$canonical"].Value = canonical;
                        if (command.ExecuteNonQuery() != 1)
                            throw new InvalidDataException(
                                "Archive identity mirror changed during initialization."
                            );
                    }
                    return true;
                }
            )
            .AsTask()
            .GetAwaiter()
            .GetResult();
        receipt.Completion.GetAwaiter().GetResult();
    }

    internal static string Resolve(IReadOnlyDictionary<string, string> mappings, string id)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        while (seen.Add(id))
        {
            if (!mappings.TryGetValue(id, out var next) || next == id)
                return id;
            id = next;
        }
        throw new InvalidDataException("Archive committed identity mappings contain a cycle.");
    }

    private static void ValidateGraph(Dictionary<string, string> mappings)
    {
        foreach (var id in mappings.Keys)
            _ = Resolve(mappings, id);
    }

    internal static void ValidateIdentity(string id)
    {
        if (id.Length == 0)
            throw new InvalidDataException(
                "Archive historical identity must be an exact nonempty string."
            );
    }

    private static SqliteConnection Open(string path, SqliteOpenMode mode)
    {
        var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = path,
                Mode = mode,
                Pooling = false,
                DefaultTimeout = 5,
            }.ToString()
        );
        try
        {
            connection.Open();
            return connection;
        }
        catch
        {
            connection.Dispose();
            throw;
        }
    }
}
