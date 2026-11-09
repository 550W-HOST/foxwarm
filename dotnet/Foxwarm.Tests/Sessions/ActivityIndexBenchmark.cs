using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.Data.Sqlite;
using Xunit.Abstractions;

namespace Foxwarm.Tests;

// Opt-in measurement of the activity index on a large synthetic Archive:
// FOXWARM_ACTIVITY_BENCH=<tool rows> dotnet test --filter ActivityIndexBenchmark
public sealed class ActivityIndexBenchmark(ITestOutputHelper output)
{
    [Fact]
    public async Task First_start_and_backfill_do_not_stall_archive_writes()
    {
        if (
            !int.TryParse(
                Environment.GetEnvironmentVariable("FOXWARM_ACTIVITY_BENCH"),
                out var toolRows
            )
            || toolRows <= 0
        )
            return;
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(data, "state"));
        var archive = Path.Combine(data, "state", "archive-store.sqlite");
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a",
            "",
            "",
            713
        );
        // An ordinary installation first, so the catalog exists before its Archive grows.
        await using (
            var first = new SessionManager(
                data,
                Path.Combine(temp.Path, "work"),
                options,
                HostModels.ForTest(options)
            )
        )
        {
            await first.LoadAsync();
            await first.ShutdownAsync();
        }
        var generate = Stopwatch.StartNew();
        Generate(archive, toolRows);
        output.WriteLine(
            $"generated {toolRows} tool rows ({new FileInfo(archive).Length / 1048576} MiB) in {generate.Elapsed.TotalSeconds:F1}s"
        );
        // A database from before the index: no activity tables.
        using (var connection = Open(archive))
        using (var drop = connection.CreateCommand())
        {
            drop.CommandText =
                $"DROP TABLE IF EXISTS {ArchiveToolEffects.Table};DROP TABLE IF EXISTS {ArchiveToolEffects.DirectTable};DROP TABLE IF EXISTS {ArchiveToolEffects.MetadataTable}";
            drop.ExecuteNonQuery();
        }
        var start = Stopwatch.StartNew();
        await using var manager = new SessionManager(
            data,
            Path.Combine(temp.Path, "work"),
            options,
            HostModels.ForTest(options)
        );
        await manager.LoadAsync();
        output.WriteLine($"first start with index schema: {start.ElapsedMilliseconds} ms");

        // Probe writer latency (a minimal Archive write transaction) while the backfill runs.
        var probes = new List<double>();
        using var stop = new CancellationTokenSource();
        var backfillWatch = Stopwatch.StartNew();
        var backfill = manager.Activity.BackfillAsync(CancellationToken.None);
        var probing = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                var watch = Stopwatch.StartNew();
                var receipt = await SqliteArchiveMessageStore.EnqueueWriteAsync(
                    archive,
                    (_, _) => true
                );
                await receipt.Completion;
                probes.Add(watch.Elapsed.TotalMilliseconds);
                await Task.Delay(20);
            }
        });
        await backfill;
        var backfillSeconds = backfillWatch.Elapsed.TotalSeconds;
        stop.Cancel();
        await probing;
        probes.Sort();
        output.WriteLine(
            $"backfill: {backfillSeconds:F1}s ({toolRows / backfillSeconds:F0} tool rows/s); writer probe n={probes.Count} p50={probes[probes.Count / 2]:F1}ms p99={probes[(int)(probes.Count * 0.99)]:F1}ms max={probes[^1]:F1}ms"
        );
        using (var connection = Open(archive))
        using (var size = connection.CreateCommand())
        {
            size.CommandText = $"SELECT count(*) FROM {ArchiveToolEffects.Table}";
            output.WriteLine($"index rows: {size.ExecuteScalar()}");
            size.CommandText = "SELECT sum(pgsize) FROM dbstat WHERE name LIKE '%tool_effects%'";
            try
            {
                output.WriteLine($"index bytes: {size.ExecuteScalar()}");
            }
            catch (SqliteException)
            {
                output.WriteLine("index bytes: dbstat unavailable");
            }
        }
        foreach (
            var query in new[]
            {
                new ActivityQuery(Kind: "all"),
                new ActivityQuery(),
                new ActivityQuery(Node: "worker-3"),
                new ActivityQuery(Tool: "write", Kind: "all"),
                new ActivityQuery(Outcome: "problems"),
                new ActivityQuery(Text: "needle-7"),
                new ActivityQuery(Sessions: ["s-11"]),
                new ActivityQuery(Sessions: Enumerable.Range(0, 5).Select(i => "s-" + i).ToArray()),
                new ActivityQuery(
                    Sessions: Enumerable.Range(0, 50).Select(i => "s-" + i).ToArray()
                ),
                new ActivityQuery(
                    Sessions: Enumerable.Range(0, 200).Select(i => "s-" + i).ToArray()
                ),
            }
        )
        {
            var watch = Stopwatch.StartNew();
            var page = manager.Activity.Query(query);
            output.WriteLine(
                $"query {query with { Sessions = null }} sessions={query.Sessions?.Count}: {watch.ElapsedMilliseconds} ms, {page["items"]!.AsArray().Count} items"
            );
        }
        Assert.True(manager.Activity.Coverage()["complete"]!.GetValue<bool>());
    }

    private static SqliteConnection Open(string path)
    {
        var connection = new SqliteConnection($"Data Source={path};Pooling=False");
        connection.Open();
        return connection;
    }

    private static void Generate(string path, int toolRows)
    {
        SqliteArchiveMessageStore.InitializeDatabase(path);
        using var connection = Open(path);
        using var transaction = connection.BeginTransaction();
        using var insert = connection.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText =
            "INSERT INTO archive_messages(session_id,agent,seq,timestamp,role,message_json) VALUES($s,'main',$q,$t,$r,$j)";
        var session = insert.Parameters.Add("$s", SqliteType.Text);
        var seq = insert.Parameters.Add("$q", SqliteType.Integer);
        var time = insert.Parameters.Add("$t", SqliteType.Real);
        var role = insert.Parameters.Add("$r", SqliteType.Text);
        var json = insert.Parameters.Add("$j", SqliteType.Text);
        var output = new string('x', 2000);
        var sessions = 200;
        var next = new long[sessions];
        var clock = 1_700_000_000_000L;
        void Row(int s, string r, JsonObject message)
        {
            var n = ++next[s];
            clock += 7;
            message["__meta"] = message["__meta"] ?? new JsonObject();
            message["__meta"]!["seq"] = n;
            message["__meta"]!["timestamp"] = clock;
            session.Value = "s-" + s;
            seq.Value = n;
            time.Value = (double)clock;
            role.Value = r;
            json.Value = message.ToJsonString();
            insert.ExecuteNonQuery();
        }
        string[] tools = ["exec", "write", "read", "edit"];
        for (var index = 0; index < toolRows; index++)
        {
            var s = index % sessions;
            // Each Session gets a new input every ten calls.
            if (index / sessions % 10 == 0)
                Row(
                    s,
                    "user",
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(new JsonObject { ["text"] = "please continue" }),
                        ["__meta"] = new JsonObject { ["sender"] = InputSender.Administrator() },
                    }
                );
            var tool = tools[index % tools.Length];
            var id = "call_" + index;
            var args =
                tool == "exec"
                    ? new JsonObject { ["command"] = "echo needle-" + index % 1000 }
                    : new JsonObject
                    {
                        ["filePath"] = "f" + index % 1000 + ".txt",
                        ["content"] = "c",
                    };
            Row(
                s,
                "model",
                new JsonObject
                {
                    ["role"] = "model",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["functionCall"] = new JsonObject
                            {
                                ["id"] = id,
                                ["name"] = tool,
                                ["args"] = args,
                            },
                        }
                    ),
                }
            );
            Row(
                s,
                "tool",
                new JsonObject
                {
                    ["role"] = "tool",
                    ["parts"] = new JsonArray(
                        new JsonObject
                        {
                            ["functionResponse"] = new JsonObject
                            {
                                ["tool_use_id"] = id,
                                ["name"] = tool,
                                ["response"] =
                                    index % 50 == 0
                                        ? new JsonObject
                                        {
                                            ["error"] = new JsonObject
                                            {
                                                ["type"] = "tool_error",
                                                ["message"] = "no",
                                            },
                                        }
                                        : new JsonObject { ["output"] = output },
                                ["__meta"] = new JsonObject
                                {
                                    ["target"] = new JsonObject
                                    {
                                        ["source"] = "node",
                                        ["name"] = tool,
                                        ["node"] = "worker-" + index % 10,
                                    },
                                },
                            },
                        }
                    ),
                }
            );
        }
        transaction.Commit();
    }
}
