using System.Diagnostics;
using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;

namespace Foxwarm.DevTools;

// Measures the on-demand sequence projection against a disposable synthetic data root.
// Archive rows are inserted directly; the root is not a valid installation afterwards.
internal static class SequenceBenchCommand
{
    internal static async Task RunAsync(string[] args)
    {
        if (args.Length is < 1 or > 4)
            throw new ArgumentException("Usage: sequence-bench ROOT [SESSIONS] [ROWS] [DAYS]");
        var root = Path.GetFullPath(args[0]);
        var sessionCount = args.Length > 1 ? int.Parse(args[1], CultureInfo.InvariantCulture) : 100;
        var rowCount = args.Length > 2 ? int.Parse(args[2], CultureInfo.InvariantCulture) : 3000;
        var days = args.Length > 3 ? double.Parse(args[3], CultureInfo.InvariantCulture) : 7;
        if (Directory.Exists(root) && Directory.EnumerateFileSystemEntries(root).Any())
            throw new ArgumentException("ROOT must be a new or empty directory.");
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        var manager = new SessionManager(
            Path.Combine(root, "data"),
            Path.Combine(root, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadMainHostAsync();
        var ids = new List<string>();
        for (var index = 0; index < sessionCount; index++)
            ids.Add((await manager.CreateNamedAsync("main", $"bench-{index:D3}", null, null)).Id);
        var watch = Stopwatch.StartNew();
        var bytes = Populate(manager.ArchiveDatabase, ids, rowCount, days);
        Console.WriteLine(
            $"populated sessions={ids.Count} rowsPerSession={rowCount} days={days} payloadMiB={bytes / 1048576.0:F0} seconds={watch.Elapsed.TotalSeconds:F0} archiveMiB={new FileInfo(manager.ArchiveDatabase).Length / 1048576.0:F0}"
        );
        var projection = new SessionSequenceProjection(
            new SessionRuntime(manager),
            manager.ArchiveDatabase
        );
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var hours in new[] { 1, 6, 24, 72 })
        foreach (var (sessions, events) in new[] { (30, 400), (80, 2000) })
        {
            var samples = new List<double>();
            JsonObject? result = null;
            for (var run = 0; run < 5; run++)
            {
                var timer = Stopwatch.StartNew();
                result = projection.Build(
                    new(now - hours * 3_600_000.0, SessionLimit: sessions, EventLimit: events),
                    null
                );
                samples.Add(timer.Elapsed.TotalMilliseconds);
            }
            samples.Sort();
            Console.WriteLine(
                $"window={hours}h sessionLimit={sessions} eventLimit={events} lanes={result!["sessions"]!.AsArray().Count} events={result["events"]!.AsArray().Count} links={result["links"]!.AsArray().Count} jsonKiB={result.ToJsonString().Length / 1024} medianMs={samples[2]:F0} maxMs={samples[^1]:F0}"
            );
        }
        var focus = projection.Build(new(now - 24 * 3_600_000.0, FocusSessionId: ids[0]), null);
        Console.WriteLine(
            $"focus window=24h lanes={focus["sessions"]!.AsArray().Count} elapsedMs={focus["elapsedMs"]}"
        );
        await manager.ShutdownAsync();
    }

    private static long Populate(string database, List<string> ids, int rows, double days)
    {
        var random = new Random(7);
        var end = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 60_000;
        var span = days * 86_400_000;
        long total = 0;
        using var connection = new SqliteConnection($"Data Source={database};Pooling=False");
        connection.Open();
        using (var pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA busy_timeout=10000";
            pragma.ExecuteNonQuery();
        }
        var filler = new string('x', 200_000);
        foreach (var (id, sessionIndex) in ids.Select((id, index) => (id, index)))
        {
            using var transaction = connection.BeginTransaction();
            using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText =
                "INSERT INTO archive_messages(session_id,agent,seq,timestamp,role,message_json) VALUES($s,'main',$q,$t,$r,$m)";
            var session = insert.Parameters.Add("$s", SqliteType.Text);
            var seqParameter = insert.Parameters.Add("$q", SqliteType.Integer);
            var time = insert.Parameters.Add("$t", SqliteType.Real);
            var role = insert.Parameters.Add("$r", SqliteType.Text);
            var json = insert.Parameters.Add("$m", SqliteType.Text);
            session.Value = id;
            // Busy Sessions are dense near the present; quieter ones spread over the period.
            var density = sessionIndex % 5 == 0 ? 0.15 : 1.0;
            var at = end - span * density;
            var step = span * density / (rows / 3.0);
            var seq = 0L;
            var peer = ids[(sessionIndex + 1) % ids.Count];
            while (seq < rows)
            {
                at += step * (0.5 + random.NextDouble());
                var cycleAt = Math.Min(at, end);
                JsonObject[] cycle;
                var calls = 1 + random.Next(3);
                var model = new JsonObject
                {
                    ["role"] = "model",
                    ["parts"] = new JsonArray(
                        Enumerable
                            .Range(0, calls)
                            .Select(call =>
                                (JsonNode)
                                    new JsonObject
                                    {
                                        ["functionCall"] = new JsonObject
                                        {
                                            ["id"] = $"c{seq}_{call}",
                                            ["name"] =
                                                call == 0 && seq % 40 == 1
                                                    ? "send_to_session"
                                                    : "exec",
                                            ["args"] =
                                                call == 0 && seq % 40 == 1
                                                    ? new JsonObject
                                                    {
                                                        ["sessionId"] = peer,
                                                        ["message"] = "status update " + seq,
                                                    }
                                                    : new JsonObject
                                                    {
                                                        ["command"] = "make test " + seq,
                                                    },
                                        },
                                    }
                            )
                            .Prepend(new JsonObject { ["text"] = "Working on step " + seq })
                            .ToArray()
                    ),
                    ["__meta"] = new JsonObject
                    {
                        ["llmRequestTiming"] = new JsonObject
                        {
                            ["startedAt"] = cycleAt - 4000,
                            ["completedAt"] = cycleAt,
                            ["durationMs"] = 4000,
                        },
                    },
                };
                var responses = new JsonArray();
                for (var call = 0; call < calls; call++)
                {
                    var size =
                        random.NextDouble() < 0.05
                            ? 100_000 + random.Next(100_000)
                            : 500 + random.Next(6000);
                    var response = new JsonObject
                    {
                        ["tool_use_id"] = $"c{seq}_{call}",
                        ["name"] = call == 0 && seq % 40 == 1 ? "send_to_session" : "exec",
                        ["response"] = new JsonObject { ["output"] = filler[..size] },
                        ["executionTiming"] = new JsonObject
                        {
                            ["startedAt"] = cycleAt + 10,
                            ["completedAt"] = cycleAt + 900,
                            ["durationMs"] = 890,
                        },
                    };
                    if (call == 0 && seq % 40 == 1)
                        response["__meta"] = new JsonObject
                        {
                            ["sessionMessages"] = new JsonArray(
                                new JsonObject
                                {
                                    ["id"] = $"c{seq}_0",
                                    ["targetSessionId"] = peer,
                                    ["message"] = "status update " + seq,
                                    ["deliverySeq"] =
                                        (seq + 2).ToString(CultureInfo.InvariantCulture)
                                        + (calls > 1 ? ".1" : ""),
                                }
                            ),
                        };
                    responses.Add(new JsonObject { ["functionResponse"] = response });
                }
                var tool = new JsonObject { ["role"] = "tool", ["parts"] = responses };
                var user = new JsonObject
                {
                    ["role"] = "user",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["system"] =
                                seq % 40 == 0
                                    ? $"<foxwarm-message type=\"inter-agent\" sourceSessionId=\"{ids[(sessionIndex + ids.Count - 1) % ids.Count]}\" deliverySeq=\"{seq}\" time=\"{DateTimeOffset.FromUnixTimeMilliseconds((long)cycleAt - 3000):yyyy-MM-dd HH:mm:ss} +0000\" hint=\"inter-agent\">\nstatus update {seq}\n</foxwarm-message>"
                                    : "<foxwarm-system kind=\"session\" currentSessionId=\"x\" />",
                        },
                        new JsonObject { ["text"] = "continue " + seq }
                    ),
                };
                cycle = [user, model, tool];
                for (var index = 0; index < cycle.Length && seq < rows; index++)
                {
                    seq++;
                    var message = cycle[index];
                    var stamp = cycleAt - 4500 + index * 2000;
                    message["__meta"] ??= new JsonObject();
                    message["__meta"]!["timestamp"] = stamp;
                    message["__meta"]!["seq"] = seq;
                    seqParameter.Value = seq;
                    time.Value = stamp;
                    role.Value = message["role"]!.GetValue<string>();
                    var text = message.ToJsonString();
                    total += text.Length;
                    json.Value = text;
                    insert.ExecuteNonQuery();
                }
            }
            transaction.Commit();
        }
        return total;
    }
}
