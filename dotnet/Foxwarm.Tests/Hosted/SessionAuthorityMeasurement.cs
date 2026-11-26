using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Hosted.Postgres.Authority;
using Foxwarm.Sessions;
using Npgsql;

namespace Foxwarm.Tests.Hosted;

/// <summary>Runs only when <see cref="SessionAuthorityMeasurement.InputVariable"/> names a directory.</summary>
internal sealed class MeasurementFactAttribute : FactAttribute
{
    public MeasurementFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(SessionAuthorityMeasurement.InputVariable)))
            Skip = $"Set {SessionAuthorityMeasurement.InputVariable} to a directory of Session documents.";
    }
}

/// <summary>
/// The p1-plan §4.4 measurement: imports a directory of file-mode Session documents into a
/// scratch database, checks that each stored value equals its source, replays the commit shapes
/// (canonical append, a save without history change, a memory snapshot change, compaction),
/// and reports bytes and WAL per commit, the load time of the largest document and the storage
/// size against the source. It also builds documents scaled to a given size distribution by
/// cycling the source documents' own records. Only aggregates leave the process: the report
/// is JSON at <see cref="OutputVariable"/>. Run it alone, in its own test process, because
/// it reads cluster-wide WAL counters and turns full-page writes on.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class SessionAuthorityMeasurement
{
    internal const string InputVariable = "FOXWARM_SESSION_MEASURE_DIR";
    internal const string OutputVariable = "FOXWARM_SESSION_MEASURE_OUT";

    // Production distribution from p1-plan §4.4: p50, p90, p99 and maximum document size.
    private static readonly (string Name, long Bytes, int Count)[] Targets =
    [
        ("p50", 730_000, 6),
        ("p90", 1_490_000, 4),
        ("p99", 2_240_000, 3),
        ("max", 9_100_000, 1),
    ];

    // Idle backends report their WAL counters to pg_stat_wal after at most 10 s.
    private static readonly TimeSpan StatsFlush = TimeSpan.FromSeconds(11);

    private static readonly JsonSerializerOptions FileJson = new() { WriteIndented = true, Encoder = JsonText.Encoder };

    private sealed record Source(string Id, string Agent, long Bytes, JsonObject Document);

    [MeasurementFact]
    public async Task Measure_session_authority_storage_and_commits()
    {
        var directory = Environment.GetEnvironmentVariable(InputVariable)!;
        var output = Environment.GetEnvironmentVariable(OutputVariable) ?? Path.Combine(Path.GetTempPath(), "session-measure.json");
        using var scratch = new TempDirectory();
        await using var fixture = await PgAuthorityFixture.OpenAsync(scratch.Path);
        await using var admin = new NpgsqlConnection(fixture.Database.SuperuserConnectionString);
        await admin.OpenAsync();
        // The fixture turns full-page writes off for speed; production keeps them on.
        await Execute(admin, "ALTER SYSTEM SET full_page_writes = on");
        await Execute(admin, "SELECT pg_reload_conf()");
        await Task.Delay(500);
        var report = new JsonObject
        {
            ["fullPageWrites"] = (string?)await Scalar(admin, "SHOW full_page_writes"),
            ["server"] = (string?)await Scalar(admin, "SHOW server_version"),
            ["policy"] = new JsonObject
            {
                ["partBytes"] = PgSessionEnvelope.PartBytes,
                ["pieceBytes"] = SessionSegmentPlanner.PieceBytes,
                ["smallSegmentBytes"] = SessionSegmentPlanner.SmallSegmentBytes,
                ["mergeRunLength"] = SessionSegmentPlanner.MergeRunLength,
            },
        };

        var sources = Directory
            .GetFiles(directory, "*.json")
            .Where(path => !path.EndsWith(".frontier.json", StringComparison.Ordinal))
            .Select(path =>
            {
                var document = (JsonObject)JsonNode.Parse(File.ReadAllBytes(path))!;
                return new Source(
                    Path.GetFileNameWithoutExtension(path),
                    document["agent"] is JsonValue agent && agent.TryGetValue<string>(out var name) ? name : "main",
                    new FileInfo(path).Length,
                    document
                );
            })
            .OrderBy(source => source.Id, StringComparer.Ordinal)
            .ToList();

        var loadable = new HashSet<string>(StringComparer.Ordinal);
        report["real"] = await MeasureSetAsync(fixture, admin, sources, "real", loadable);
        await Execute(admin, "TRUNCATE session_heads, session_segments, session_envelope_parts, archive_messages, archive_blocks");

        var scaled = Scale(sources.Where(source => loadable.Contains(source.Id)).ToList());
        report["scaled"] = await MeasureSetAsync(fixture, admin, scaled, "scaled", []);
        report["scaledMethod"] =
            "Each scaled document takes the envelope of a large source document and cycles the history records"
            + " of that source (records with a context block dropped, sequence numbers renumbered, meta.messageCount"
            + " and nextMessageSeq adjusted) until its file-mode JSON size reaches the target.";
        report["scaledTargets"] = new JsonArray(
            Targets.Select(target => (JsonNode)new JsonObject { ["name"] = target.Name, ["bytes"] = target.Bytes, ["documents"] = target.Count }).ToArray()
        );
        await Execute(admin, "ALTER SYSTEM RESET full_page_writes");
        await Execute(admin, "SELECT pg_reload_conf()");
        await File.WriteAllTextAsync(output, report.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
    }

    private static async Task<JsonObject> MeasureSetAsync(
        PgAuthorityFixture fixture,
        NpgsqlConnection admin,
        IReadOnlyList<Source> sources,
        string label,
        HashSet<string> loadable
    )
    {
        var backend = fixture.Backend;
        var result = new JsonObject { ["documents"] = sources.Count };
        var sizes = sources.Select(source => source.Bytes).OrderBy(size => size).ToArray();
        result["sourceBytes"] = sizes.Sum();
        result["sourceSizes"] = Percentiles(sizes.Select(size => (double)size).ToArray());

        // Import: the stored value must equal the source document.
        var mismatched = 0;
        var importTime = Stopwatch.StartNew();
        foreach (var source in sources)
        {
            backend.ReplaceRaw(source.Id, source.Document);
            var stored = (await backend.ReadRawAsync(source.Id))!.Document;
            if (!JsonNode.DeepEquals(stored, source.Document))
                mismatched++;
        }
        result["importSeconds"] = importTime.Elapsed.TotalSeconds;
        result["valueMismatches"] = mismatched;
        result["storage"] = await StorageAsync(admin);

        // Loads, through the shared normalization; failures are counted by type.
        var loads = new Dictionary<string, SessionSnapshot>(StringComparer.Ordinal);
        var failures = new JsonObject();
        var failed = new List<(Source Source, string Type)>();
        foreach (var source in sources)
            try
            {
                var snapshot = await backend.Open(source.Id, source.Agent, new SessionAuthorityCallbacks()).LoadAsync(source.Id);
                loads[source.Id] = snapshot!;
            }
            catch (Exception error)
            {
                var key = error.GetType().Name;
                failures[key] = (failures[key]?.GetValue<int>() ?? 0) + 1;
                failed.Add((source, key));
            }
        result["loaded"] = loads.Count;
        // A document that doesn't load here must fail the same way in file mode.
        var parity = 0;
        foreach (var (source, key) in failed)
        {
            var root = Path.Combine(backend.ScratchRoot, "parity-" + label);
            Directory.CreateDirectory(Path.Combine(root, "state", "sessions"));
            File.WriteAllText(Path.Combine(root, "state", "sessions", source.Id + ".json"), source.Document.ToJsonString());
            var file = new Foxwarm.Storage.FileStorageContext(root).Authority;
            try
            {
                await file.Open(source.Id, source.Agent, new SessionAuthorityCallbacks()).LoadAsync(source.Id);
            }
            catch (Exception error) when (error.GetType().Name == key)
            {
                parity++;
            }
            Directory.Delete(root, true);
        }
        result["loadFailuresAlsoInFileMode"] = parity;
        loadable.UnionWith(loads.Keys);
        result["loadFailures"] = failures;

        var largest = sources.Where(source => loads.ContainsKey(source.Id)).MaxBy(source => source.Bytes)!;
        var loadTimes = new List<double>();
        var rawTimes = new List<double>();
        for (var attempt = 0; attempt < 7; attempt++)
        {
            var watch = Stopwatch.StartNew();
            await backend.ReadRawAsync(largest.Id);
            rawTimes.Add(watch.Elapsed.TotalMilliseconds);
            watch.Restart();
            await backend.Open(largest.Id, largest.Agent, new SessionAuthorityCallbacks()).LoadAsync(largest.Id);
            loadTimes.Add(watch.Elapsed.TotalMilliseconds);
        }
        var fileTimes = new List<double>();
        var fileRoot = Path.Combine(backend.ScratchRoot, "file-" + label);
        Directory.CreateDirectory(Path.Combine(fileRoot, "state", "sessions"));
        File.WriteAllText(Path.Combine(fileRoot, "state", "sessions", largest.Id + ".json"), largest.Document.ToJsonString());
        var fileAuthority = new Foxwarm.Storage.FileStorageContext(fileRoot).Authority;
        for (var attempt = 0; attempt < 7; attempt++)
        {
            var watch = Stopwatch.StartNew();
            await fileAuthority.Open(largest.Id, largest.Agent, new SessionAuthorityCallbacks()).LoadAsync(largest.Id);
            fileTimes.Add(watch.Elapsed.TotalMilliseconds);
        }
        Directory.Delete(fileRoot, true);
        result["largestLoad"] = new JsonObject
        {
            ["sourceBytes"] = largest.Bytes,
            ["records"] = loads[largest.Id].History.Count,
            ["segments"] = Convert.ToInt64(await Scalar(admin, "SELECT cardinality(segment_ids) FROM session_heads WHERE session_id = $1", largest.Id)),
            ["loadMsMedian"] = Median(loadTimes),
            ["rawReadMsMedian"] = Median(rawTimes),
            ["fileModeLoadMsMedian"] = Median(fileTimes),
        };

        // Commit shapes, each over every loaded document: first right after a checkpoint (every
        // page is touched for the first time since it, so full-page images are written), then
        // once more without one.
        var shapes = new JsonObject();
        foreach (var pass in new[] { "afterCheckpoint", "steady" })
        {
            var passResult = new JsonObject();
            foreach (var shape in new[] { "append", "headOnly", "memoryChange", "compaction" })
            {
                if (pass == "afterCheckpoint")
                    await Execute(admin, "CHECKPOINT");
                passResult[shape] = await ReplayAsync(fixture, admin, sources, loads, shape);
            }
            shapes[pass] = passResult;
        }
        result["commits"] = shapes;
        result["storageAfterCommits"] = await StorageAsync(admin);
        return result;
    }

    private static async Task<JsonObject> ReplayAsync(
        PgAuthorityFixture fixture,
        NpgsqlConnection admin,
        IReadOnlyList<Source> sources,
        Dictionary<string, SessionSnapshot> loads,
        string shape
    )
    {
        var backend = fixture.Backend;
        var wal = new List<double>();
        var segmentBytes = new List<double>();
        var envelopeBytes = new List<double>();
        var records = new List<double>();
        var partsWritten = 0;
        var skipped = 0;
        var failures = new JsonObject();
        await Task.Delay(StatsFlush);
        var statBefore = await WalStats(admin);
        foreach (var source in sources)
        {
            if (!loads.TryGetValue(source.Id, out var loaded))
                continue;
            var store = backend.Open(source.Id, source.Agent, new SessionAuthorityCallbacks());
            // A fresh owner, as after a cold start: the load gives it the committed root.
            loaded = (await store.LoadAsync(source.Id))!;
            Func<Task<SessionSnapshot>>? commit = shape switch
            {
                "append" => Append(store, loaded),
                "headOnly" => () => Commit(store, loaded with { Busy = !loaded.Busy, BusyStartedAt = loaded.Busy ? null : 1_700_000_000_000 }),
                "memoryChange" => MemoryChange(store, loaded),
                "compaction" => Compaction(store, loaded),
                _ => throw new ArgumentOutOfRangeException(nameof(shape)),
            };
            if (commit is null)
            {
                skipped++;
                continue;
            }
            fixture.Commits.Clear();
            var before = (string)(await Scalar(admin, "SELECT pg_current_wal_insert_lsn()::text"))!;
            try
            {
                loads[source.Id] = await commit();
            }
            catch (Exception error)
            {
                var key = error.GetType().Name;
                failures[key] = (failures[key]?.GetValue<int>() ?? 0) + 1;
                continue;
            }
            var bytes = (decimal)(await Scalar(admin, "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), $1::pg_lsn)", before))!;
            wal.Add((double)bytes);
            var stats = Assert.Single(fixture.Commits);
            segmentBytes.Add(stats.SegmentBytesWritten);
            envelopeBytes.Add(stats.EnvelopeBytes);
            records.Add(stats.RecordsWritten);
            partsWritten += stats.PartsWritten;
        }
        await Task.Delay(StatsFlush);
        var statAfter = await WalStats(admin);
        var commits = wal.Count;
        return new JsonObject
        {
            ["commits"] = commits,
            ["skipped"] = skipped,
            ["failures"] = failures,
            ["walBytesPerCommit"] = Percentiles(wal.ToArray()),
            ["segmentBytesPerCommit"] = Percentiles(segmentBytes.ToArray()),
            ["envelopeBytesPerCommit"] = Percentiles(envelopeBytes.ToArray()),
            ["recordsPerCommit"] = Percentiles(records.ToArray()),
            ["partsWritten"] = partsWritten,
            ["pgStatWal"] = new JsonObject
            {
                ["walBytesPerCommit"] = commits == 0 ? 0 : (statAfter.Bytes - statBefore.Bytes) / commits,
                ["walFpiPerCommit"] = commits == 0 ? 0 : (double)(statAfter.Fpi - statBefore.Fpi) / commits,
                ["walRecordsPerCommit"] = commits == 0 ? 0 : (double)(statAfter.Records - statBefore.Records) / commits,
            },
        };
    }

    private static async Task<SessionSnapshot> Commit(ISessionAuthority store, SessionSnapshot next)
    {
        await store.CommitAsync(next, SaveKind.Strict);
        return next;
    }

    // Appends a copy of the document's own latest model record (or its latest record).
    private static Func<Task<SessionSnapshot>>? Append(ISessionAuthority store, SessionSnapshot loaded)
    {
        if (loaded.History.Count == 0)
            return null;
        var template = loaded.History.Reverse().FirstOrDefault(message => message.Role == "model") ?? loaded.History[^1];
        var message = (JsonObject)template.ToJson().DeepClone();
        var meta = message["__meta"] as JsonObject ?? new JsonObject();
        meta.Remove("contextBlock");
        meta.Remove("preservedFromBlockId");
        meta["seq"] = loaded.NextMessageSeq;
        meta["timestamp"] = 1_700_000_000_000 + loaded.NextMessageSeq;
        message["__meta"] = meta;
        var next = loaded with
        {
            History = loaded.History.AppendJson([message]),
            NextMessageSeq = loaded.NextMessageSeq + 1,
        };
        return async () =>
        {
            await store.CommitCanonicalAppendAsync(next, [message]);
            return next;
        };
    }

    // Changes the memory snapshot slightly, as a memory edit does; only where it is a part.
    private static Func<Task<SessionSnapshot>>? MemoryChange(ISessionAuthority store, SessionSnapshot loaded)
    {
        if (
            loaded.AuthorityEnvelope["persistentMemorySnapshot"] is not JsonValue value
            || !value.TryGetValue<string>(out var memory)
            || Encoding.UTF8.GetByteCount(memory) < PgSessionEnvelope.PartBytes
        )
            return null;
        var envelope = (JsonObject)loaded.AuthorityEnvelope.DeepClone();
        envelope["persistentMemorySnapshot"] = memory + "\n- one more remembered line";
        return () => Commit(store, loaded with { AuthorityEnvelope = envelope });
    }

    // Replaces the older half of the history with a block, as compaction does.
    private static Func<Task<SessionSnapshot>>? Compaction(ISessionAuthority store, SessionSnapshot loaded)
    {
        var history = loaded.History;
        if (history.Count < 4)
            return null;
        var dropped = history.Take(history.Count / 2).Select(message => message.Sequence).OfType<long>().ToArray();
        if (dropped.Length == 0)
            return null;
        var envelope = (JsonObject)loaded.AuthorityEnvelope.DeepClone();
        var blockId = envelope["nextBlockId"] is JsonValue id && id.TryGetValue<long>(out var nextId) ? nextId : 1;
        envelope["nextBlockId"] = blockId + 1;
        var next = loaded with
        {
            History = SessionHistory.FromMessages(history.Skip(history.Count / 2).ToArray()),
            HistoryVersion = loaded.HistoryVersion + 1,
            AuthorityEnvelope = envelope,
        };
        var block = new ArchiveBlockRecord(
            loaded.Id,
            store.Agent,
            blockId,
            1,
            "message",
            dropped.Min(),
            dropped.Max(),
            null,
            dropped.Min(),
            dropped.Max(),
            null,
            null,
            "A summary of the compacted messages, about the size of a real one. " + new string('s', 1500),
            null,
            1_700_000_000_000
        );
        return async () =>
        {
            await store.CommitCompactionAsync(next, [block], []);
            return next;
        };
    }

    private static List<Source> Scale(IReadOnlyList<Source> sources)
    {
        // Shape sources: the largest documents with enough plain records to cycle.
        var candidates = sources
            .Select(source => (source, records: Plain(source.Document)))
            .Where(item => item.records.Count >= 20)
            .OrderByDescending(item => item.source.Bytes)
            .Take(8)
            .ToList();
        var scaled = new List<Source>();
        foreach (var (name, bytes, count) in Targets)
            for (var index = 0; index < count; index++)
            {
                var (source, records) = candidates[index % candidates.Count];
                var document = (JsonObject)source.Document.DeepClone();
                var history = new JsonArray();
                document["history"] = history;
                var size = (long)Encoding.UTF8.GetByteCount(document.ToJsonString(FileJson));
                var seq = 0L;
                while (size < bytes)
                {
                    var record = (JsonObject)records[(int)(seq % records.Count)].DeepClone();
                    seq++;
                    if (record["__meta"] is JsonObject meta)
                    {
                        meta["seq"] = seq;
                        meta["timestamp"] = 1_600_000_000_000 + seq;
                    }
                    size += Encoding.UTF8.GetByteCount(record.ToJsonString(FileJson)) + 8;
                    history.Add(record);
                }
                if (document["meta"] is JsonObject documentMeta)
                    documentMeta["messageCount"] = history.Count;
                document["nextMessageSeq"] = seq + 1;
                // File-mode size: the document as the file writer writes it, indented.
                var fileBytes = Encoding.UTF8.GetByteCount(document.ToJsonString(FileJson));
                scaled.Add(new Source($"scaled-{name}-{index}", source.Agent, fileBytes, document));
            }
        return scaled;

        static List<JsonObject> Plain(JsonObject document) =>
            (document["history"] as JsonArray ?? [])
                .OfType<JsonObject>()
                .Where(record => record["__meta"] is not JsonObject meta || !meta.ContainsKey("contextBlock"))
                .ToList();
    }

    private static async Task<JsonObject> StorageAsync(NpgsqlConnection admin)
    {
        async Task<long> Long(string sql) => Convert.ToInt64(await Scalar(admin, sql) ?? 0L);
        return new JsonObject
        {
            ["headsTotalRelationBytes"] = await Long("SELECT pg_total_relation_size('session_heads')"),
            ["segmentsTotalRelationBytes"] = await Long("SELECT pg_total_relation_size('session_segments')"),
            ["partsTotalRelationBytes"] = await Long("SELECT pg_total_relation_size('session_envelope_parts')"),
            ["segmentRawBytes"] = await Long("SELECT coalesce(sum(byte_length), 0) FROM session_segments"),
            ["segmentStoredBytes"] = await Long("SELECT coalesce(sum(pg_column_size(records)), 0) FROM session_segments"),
            ["envelopeRawBytes"] = await Long("SELECT coalesce(sum(octet_length(envelope)), 0) FROM session_heads"),
            ["envelopeStoredBytes"] = await Long("SELECT coalesce(sum(pg_column_size(envelope)), 0) FROM session_heads"),
            ["partRawBytes"] = await Long("SELECT coalesce(sum(octet_length(value)), 0) FROM session_envelope_parts"),
            ["partStoredBytes"] = await Long("SELECT coalesce(sum(pg_column_size(value)), 0) FROM session_envelope_parts"),
            ["segments"] = await Long("SELECT count(*) FROM session_segments"),
            ["parts"] = await Long("SELECT count(*) FROM session_envelope_parts"),
            ["archiveTotalRelationBytes"] = await Long(
                "SELECT pg_total_relation_size('archive_messages') + pg_total_relation_size('archive_blocks')"
            ),
        };
    }

    private static async Task<(long Bytes, long Fpi, long Records)> WalStats(NpgsqlConnection admin)
    {
        await Execute(admin, "SELECT pg_stat_clear_snapshot()");
        await using var command = new NpgsqlCommand("SELECT wal_bytes::bigint, wal_fpi, wal_records FROM pg_stat_wal", admin);
        await using var reader = await command.ExecuteReaderAsync();
        await reader.ReadAsync();
        return (reader.GetInt64(0), reader.GetInt64(1), reader.GetInt64(2));
    }

    private static JsonObject Percentiles(double[] values)
    {
        if (values.Length == 0)
            return new JsonObject { ["n"] = 0 };
        var sorted = values.OrderBy(value => value).ToArray();
        double At(double q) => sorted[Math.Min(sorted.Length - 1, (int)Math.Floor(q * (sorted.Length - 1) + 0.5))];
        return new JsonObject
        {
            ["n"] = sorted.Length,
            ["mean"] = Math.Round(sorted.Average(), 1),
            ["p50"] = At(0.5),
            ["p90"] = At(0.9),
            ["p99"] = At(0.99),
            ["max"] = sorted[^1],
            ["sum"] = sorted.Sum(),
        };
    }

    private static double Median(List<double> values) => Math.Round(values.OrderBy(value => value).ElementAt(values.Count / 2), 1);

    private static async Task Execute(NpgsqlConnection connection, string sql)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        await command.ExecuteNonQueryAsync();
    }

    private static async Task<object?> Scalar(NpgsqlConnection connection, string sql, params object[] values)
    {
        await using var command = new NpgsqlCommand(sql, connection);
        foreach (var value in values)
            command.Parameters.Add(new NpgsqlParameter { Value = value });
        var result = await command.ExecuteScalarAsync();
        return result is DBNull ? null : result;
    }
}
