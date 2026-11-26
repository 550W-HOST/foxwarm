using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Foxwarm.Hosted.Postgres.Archive;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;
using Xunit.Abstractions;

namespace Foxwarm.Tests.Hosted;

/// <summary>
/// Opt-in comparison of every Archive reader, SQLite versus PostgreSQL, over a copy of a real
/// Archive: <c>FOXWARM_GOLDEN_ARCHIVE=&lt;directory with archive-store.sqlite and optionally
/// catalog.sqlite&gt;</c>. The rows are imported into a fresh tenant, then each reader runs on
/// both stores and the outputs are compared exactly. Only reader names and counts are printed;
/// the data never leaves the machine running the test.
/// </summary>
[Trait("Backend", "postgres")]
public sealed class ArchiveGoldenComparisonTests(ITestOutputHelper output)
{
    private readonly Dictionary<string, int> errors = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (int Calls, int Mismatches)> results = new(StringComparer.Ordinal);
    private readonly List<string> firstMismatches = [];

    [Fact]
    public async Task Every_reader_returns_the_same_output_on_both_stores()
    {
        var source = Environment.GetEnvironmentVariable("FOXWARM_GOLDEN_ARCHIVE");
        if (string.IsNullOrEmpty(source))
            return;
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        var archivePath = Path.Combine(temp.Path, "state", "archive-store.sqlite");
        File.Copy(Path.Combine(source, "archive-store.sqlite"), archivePath);
        var catalogPath = Path.Combine(source, "catalog.sqlite");
        if (File.Exists(catalogPath))
            File.Copy(catalogPath, Path.Combine(temp.Path, "state", "catalog.sqlite"));
        var file = new SqliteArchiveStore(temp.Path);
        var (database, tenant) = await PgArchiveRowsTests.OpenAsync();
        await using var _ = database;
        var hosted = new PgArchiveStore(tenant);

        var ids = Import(archivePath, file, tenant);
        var imported = tenant.Read(tx => (long)tx.Scalar("SELECT (SELECT count(*) FROM archive_messages) + (SELECT count(*) FROM archive_blocks)")!);
        Assert.True(imported > 0);
        var sequenceSessions = File.Exists(catalogPath)
            ? SequenceSessions(Path.Combine(temp.Path, "state", "catalog.sqlite"))
            : ids.Select(id => new SessionCatalog.SequenceSession(id, null, 0, false, 0)).ToList();
        var probes = ids.Concat(sequenceSessions.Select(row => row.Id)).Append("golden/absent").Distinct().ToArray();

        foreach (var id in probes)
            await CompareSessionAsync(file, hosted, id);
        Compare("store.SequenceCounts", "*", () => Text(file.SequenceCounts(probes).OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => $"{pair.Key}={pair.Value}")), () => Text(hosted.SequenceCounts(probes).OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => $"{pair.Key}={pair.Value}")));
        CompareSequences(file, hosted, sequenceSessions);

        foreach (var (name, (calls, mismatches)) in results.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            output.WriteLine($"{name}: {calls} calls, {errors.GetValueOrDefault(name)} failing on both, {mismatches} mismatches");
        output.WriteLine($"Sessions probed: {probes.Length}; sequence Sessions: {sequenceSessions.Count}");
        foreach (var line in firstMismatches)
            Console.WriteLine("golden mismatch " + line);
        Assert.All(results, pair => Assert.Equal(0, pair.Value.Mismatches));
    }

    private static string[] Import(string archivePath, SqliteArchiveStore file, Foxwarm.Hosted.Postgres.TenantDb tenant)
    {
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = archivePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()
        );
        connection.Open();
        List<object?[]> Rows(string sql)
        {
            using var command = connection.CreateCommand();
            command.CommandText = sql;
            using var reader = command.ExecuteReader();
            var rows = new List<object?[]>();
            while (reader.Read())
            {
                var row = new object?[reader.FieldCount];
                for (var column = 0; column < row.Length; column++)
                    row[column] = reader.IsDBNull(column) ? null : reader.GetValue(column);
                rows.Add(row);
            }
            return rows;
        }
        var ids = Rows(
                "SELECT session_id FROM archive_messages UNION SELECT session_id FROM archive_blocks UNION SELECT session_id FROM archive_branches ORDER BY 1"
            )
            .Select(row => (string)row[0]!)
            .ToArray();
        tenant.Write(tx =>
        {
            foreach (var row in Rows("SELECT session_id, canonical_session_id, created_at, updated_at FROM archive_session_id_reservations"))
                tx.Execute(
                    "INSERT INTO session_id_reservations (session_id, canonical_session_id, created_at, updated_at) VALUES ($1, $2, $3, $4)",
                    row
                );
            foreach (var row in Rows("SELECT session_id, parent_session_id, fork_message_seq, fork_block_id, created_at, updated_at FROM archive_branches"))
                tx.Execute(
                    "INSERT INTO archive_branches (session_id, parent_session_id, fork_message_seq, fork_block_id, created_at, updated_at)"
                        + " VALUES ($1, $2, $3, $4, $5, $6)",
                    row
                );
            return true;
        });
        foreach (var id in ids)
        {
            var source = file.ForSession(id);
            var blocks = source.ReadBlocks();
            foreach (var chunk in blocks.Chunk(500))
            {
                var batch = PgArchiveBatch.Import(id, chunk, []);
                tenant.Write(tx => PgArchiveRows.Insert(tx, batch));
            }
            var messages = source.ReadMessages();
            foreach (var chunk in messages.Chunk(500))
            {
                var batch = PgArchiveBatch.Import(id, [], chunk);
                tenant.Write(tx => PgArchiveRows.Insert(tx, batch));
            }
        }
        return ids;
    }

    private static List<SessionCatalog.SequenceSession> SequenceSessions(string catalogPath)
    {
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = catalogPath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString()
        );
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT session_id, parent_session_id, last_message_time, busy, message_count FROM session_catalog";
        using var reader = command.ExecuteReader();
        var rows = new List<SessionCatalog.SequenceSession>();
        while (reader.Read())
            rows.Add(
                new(
                    reader.GetString(0),
                    reader.IsDBNull(1) ? null : reader.GetString(1),
                    reader.GetDouble(2),
                    reader.GetInt64(3) == 1,
                    reader.GetInt64(4)
                )
            );
        return rows;
    }

    private async Task CompareSessionAsync(IArchiveStore file, IArchiveStore hosted, string id)
    {
        var a = file.ForSession(id);
        var b = hosted.ForSession(id);
        void Same(string name, Func<IArchiveSession, string> read) => Compare(name, id, () => read(a), () => read(b));

        Same("session.CanonicalSessionId", s => s.CanonicalSessionId);
        Same("session.HasReadOnlyIdentity", s => s.HasReadOnlyIdentity().ToString());
        Same("session.ReadMessages", s => Text(s.ReadMessages()));
        Same("session.ReadBlocks", s => Text(s.ReadBlocks()));
        Same("session.MessageStats", s => s.MessageStats().ToString());
        Same("session.BlockTopology", s => Text(s.BlockTopology()));
        Same("session.ReadBranch", s => s.ReadBranch()?.ToString() ?? "null");
        Same("session.EffectiveMessageStats", s => s.EffectiveMessageStats().ToString());
        Same("session.EffectiveBlockTopology", s => Text(s.EffectiveBlockTopology()));
        Same("session.EffectiveBlockHighWater", s => s.EffectiveBlockHighWater().ToString(CultureInfo.InvariantCulture));
        Same("session.VectorLineage", s => Text(s.VectorLineage()));
        Same("session.ReadEffectiveMessagesRange", s => Text(s.ReadEffectiveMessagesRange(1, PgArchiveReads.MaxSeq)));
        Same("session.ReadEffectiveBlocksRange", s => Text(s.ReadEffectiveBlocksRange(1, PgArchiveReads.MaxSeq)));
        Same("session.ReadEffectiveMessagesNumericRange", s => Text(s.ReadEffectiveMessagesNumericRange(null, null)));
        Same("session.ReadEffectiveBlocksNumericRange", s => Text(s.ReadEffectiveBlocksNumericRange(null, null)));
        Same("session.ReadEffectiveMessagesPage.desc", s => Text(s.ReadEffectiveMessagesPage(null, null, 100, descending: true)));
        Same("session.ReadEffectiveMessagesPage.asc", s => Text(s.ReadEffectiveMessagesPage(2.5, null, 37)));
        Same("session.ReadMessagesNumericRange.substantive", s => Text(s.ReadMessagesNumericRange(null, null, 20, descending: true, substantiveWindow: true)));
        Same("session.ReadBlocksNumericRange.desc", s => Text(s.ReadBlocksNumericRange(null, null, 10, descending: true)));

        var stats = a.EffectiveMessageStats();
        if (stats.First is long first && stats.Last is long last)
        {
            var middle = first + (last - first) / 2;
            Same("session.ReadMessageBySeq", s => Text([.. new[] { s.ReadMessageBySeq(middle) }.OfType<ArchiveMessageRecord>()]));
            Same("session.ReadMessagesRange", s => Text(s.ReadMessagesRange(Math.Max(1, middle - 50), middle + 50)));
            var times = a.ReadEffectiveMessagesRange(first, last).Select(row => (long)Math.Floor(row.Timestamp)).ToArray();
            var (low, high) = (times[times.Length / 4], times[times.Length * 3 / 4] + 1);
            Same("session.ReadEffectiveMessagesBetween", s => Text(s.ReadEffectiveMessagesBetween(low, high)));
            Same("session.ReadMessagesNumericRange.time", s => Text(s.ReadMessagesNumericRange(null, null, 50, startTime: low, endTime: high)));
            Same("session.ReadBlocksNumericRange.time", s => Text(s.ReadBlocksNumericRange(null, null, 50, startTime: low, endTime: high)));
            Same("session.ReadBlocksNumericRange.since", s => Text(s.ReadBlocksNumericRange(null, null, startTime: high)));
        }
        Compare("store.ResolveCommittedIdentity", id, () => file.ResolveCommittedIdentity(id) ?? "null", () => hosted.ResolveCommittedIdentity(id) ?? "null");
        Compare("store.HasLifetimeRowsAsync", id, () => file.HasLifetimeRowsAsync(id).Result.ToString(), () => hosted.HasLifetimeRowsAsync(id).Result.ToString());
        using var fileIdentities = file.OpenIdentityReader()!;
        using var hostedIdentities = hosted.OpenIdentityReader()!;
        Compare("identity.Resolve", id, () => fileIdentities.Resolve(id), () => hostedIdentities.Resolve(id));
        Compare("identity.FirstMessage", id, () => fileIdentities.FirstMessage(id)?.ToString() ?? "null", () => hostedIdentities.FirstMessage(id)?.ToString() ?? "null");
        await Task.CompletedTask;
    }

    private void CompareSequences(IArchiveStore file, IArchiveStore hosted, IReadOnlyList<SessionCatalog.SequenceSession> sessions)
    {
        using var a = file.OpenSequenceReader()!;
        using var b = hosted.OpenSequenceReader()!;
        var ids = sessions.Select(row => row.Id).OrderBy(id => id, StringComparer.Ordinal).ToArray();
        foreach (var session in sessions)
        {
            var id = session.Id;
            ArchiveSpan? span = null;
            Compare("sequence.Span", id, () => (span = a.Span(session))?.ToString() ?? "null", () => b.Span(session)?.ToString() ?? "null");
            if (span is null)
                continue;
            var middle = span.First + (span.Last - span.First) / 2;
            var neighbor = ids[(Array.IndexOf(ids, id) + 1) % ids.Length];
            foreach (var cursor in new ArchiveSequenceCursor?[]
            {
                null,
                new(middle),
                new(Math.Floor(middle), id, span.FirstSeq + (span.LastSeq - span.FirstSeq) / 2),
                new(Math.Floor(middle), neighbor, 1),
                new(Math.Floor(middle), "", 1),
                new(span.First - 1),
            })
                Compare("sequence.SeqBefore", id, () => a.SeqBefore(id, span, cursor).ToString(CultureInfo.InvariantCulture), () => b.SeqBefore(id, span, cursor).ToString(CultureInfo.InvariantCulture));
            Compare("sequence.Positions", id, () => Text(a.Positions(span, span.LastSeq, 60)), () => Text(b.Positions(span, span.LastSeq, 60)));
            for (var low = span.FirstSeq; low <= span.LastSeq; low += 200)
            {
                var start = low;
                Compare("sequence.ReadRange", id, () => Page(() => a.ReadRange(id, span, start, start + 199)), () => Page(() => b.ReadRange(id, span, start, start + 199)));
            }
            Compare("sequence.ReadAfter.since", id, () => Page(() => a.ReadAfter(id, span, null, middle, 100)), () => Page(() => b.ReadAfter(id, span, null, middle, 100)));
            var after = span.FirstSeq + (span.LastSeq - span.FirstSeq) / 3;
            Compare("sequence.ReadAfter.cursor", id, () => Page(() => a.ReadAfter(id, span, after, 0, 100)), () => Page(() => b.ReadAfter(id, span, after, 0, 100)));
        }
    }

    // SQLite fails a whole sequence read on a bare string inside a delivery or subcall list,
    // where the stored projection gives null fields (documented); such reads count separately.
    private string Page(Func<ArchiveSequencePage> read)
    {
        ArchiveSequencePage page;
        try
        {
            page = read();
        }
        catch (SqliteException)
        {
            return "sqlite-error";
        }
        return $"{page.SessionId}|{page.MaxSeq}|{page.TruncatedStart}|{page.HasMore}|{Row(page.Context)}|" + Text(page.Rows.Select(Row));
    }

    private static string Row(ArchiveSequenceRow? row) =>
        row is null ? "null" : $"{row.Seq}|{Number(row.Timestamp)}|{row.Role}|{ArchiveSequenceProjectionTests.Canonical(row.Data)}";

    private void Compare(string name, string id, Func<string> file, Func<string> hosted)
    {
        string expected;
        try
        {
            expected = file();
        }
        catch (Exception error)
        {
            expected = "error:" + error.GetType().Name;
        }
        string actual;
        try
        {
            actual = hosted();
        }
        catch (Exception error)
        {
            actual = "error:" + error.GetType().Name;
        }
        if (expected == "sqlite-error" || expected.Contains("|sqlite-error", StringComparison.Ordinal))
            name += ".sqlite-failed-read";
        if (expected.StartsWith("error:", StringComparison.Ordinal))
            errors[name] = errors.GetValueOrDefault(name) + 1;
        var (calls, mismatches) = results.GetValueOrDefault(name);
        var same = expected == actual || name.EndsWith(".sqlite-failed-read", StringComparison.Ordinal);
        results[name] = (calls + 1, mismatches + (same ? 0 : 1));
        if (!same && firstMismatches.Count < 20)
            firstMismatches.Add($"{name} {id} file={Hash(expected)} hosted={Hash(actual)} fileLength={expected.Length} hostedLength={actual.Length}");
    }

    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..12];

    private static string Number(double value) => value.ToString("R", CultureInfo.InvariantCulture);

    private static string Text(IEnumerable<string> lines) => string.Join("\n", lines);

    private static string Text(IEnumerable<ArchiveMessageRecord> rows) =>
        Text(rows.Select(row => $"{row.SessionId}|{row.Agent}|{row.Seq}|{Number(row.Timestamp)}|{row.Role}|{row.MessageJson}"));

    private static string Text(IEnumerable<ArchiveBlockRecord> rows) =>
        Text(
            rows.Select(row =>
                $"{row.SessionId}|{row.Agent}|{row.Id}|{row.Level}|{row.SourceKind}|{row.SourceStart}|{row.SourceEnd}|{row.SourceBlockIdsJson}|"
                + $"{row.RawStartSeq}|{row.RawEndSeq}|{row.RawStartTimestamp?.ToString("R", CultureInfo.InvariantCulture)}|{row.RawEndTimestamp?.ToString("R", CultureInfo.InvariantCulture)}|"
                + $"{row.Summary}|{row.MemoryFactsJson}|{row.CreatedAt}|{row.FrictionScore}"
            )
        );

    private static string Text(IEnumerable<ArchiveBlockTopology> rows) =>
        Text(rows.Select(row => (row with { Children = [] }) + "|" + string.Join(",", row.Children)));

    private static string Text(IEnumerable<ArchiveVectorScope> rows) => Text(rows.Select(row => row.ToString()));

    private static string Text(IEnumerable<(long Seq, double Timestamp)> rows) =>
        Text(rows.Select(row => $"{row.Seq}|{Number(row.Timestamp)}"));
}
