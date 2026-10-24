using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class LegacyWaitAuthorityTests
{
    private static async Task<JsonObject> Source(string mode, string root)
    {
        var repo =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Owned source fixture root is required.");
        using var process = Process.Start(
            new ProcessStartInfo("node")
            {
                WorkingDirectory = repo,
                ArgumentList =
                {
                    Path.Combine(
                        repo,
                        "dotnet",
                        "Foxwarm.Tests",
                        "Fixtures",
                        "legacy-wait-fixture-ts.mjs"
                    ),
                    mode,
                    root,
                },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }
        )!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var text = await stdout;
        Assert.True(process.ExitCode == 0, text + await stderr);
        const string prefix = "LEGACY_WAIT_FIXTURE:";
        return JsonNode
            .Parse(
                text.Split('\n').Single(line => line.StartsWith(prefix, StringComparison.Ordinal))[
                    prefix.Length..
                ]
            )!
            .AsObject();
    }

    [Theory]
    [InlineData("matching")]
    [InlineData("input")]
    public async Task Source_single_target_legacy_wait_survives_cold_startup_save_reopen_and_ordinary_wake(
        string wake
    )
    {
        using var temp = new TempDirectory();
        var data = Path.Combine(temp.Path, "data");
        var work = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(work);
        var expected = await Source("seed", data);
        var id = expected["id"]!.GetValue<string>();
        var file = Path.Combine(data, "state", "sessions", id + ".json");
        var options = new ResponsesClientOptions(
            new Uri("http://127.0.0.1:1"),
            "wire",
            "a/wire",
            "",
            "",
            713
        );
        var models = HostModels.ForTest(options);
        await using (var manager = new SessionManager(data, work, options, models))
        {
            Assert.DoesNotContain(id, manager.Catalog.RestartIds());
            await manager.LoadMainHostAsync();
            Assert.Null(manager.Find(id));
            var owner = await manager.RequiredAsync(id);
            Assert.True(JsonNode.DeepEquals(expected["wait"], owner.Entry.Snapshot().Meta["wait"]));
            Assert.False(owner.Metadata().Busy);
            Assert.Empty(owner.Entry.Snapshot().Queue);
            await owner.Entry.SaveLane.SaveStrictAsync();
            Assert.True(
                JsonNode.DeepEquals(
                    expected["wait"],
                    JsonNode.Parse(await File.ReadAllTextAsync(file))!["meta"]!["wait"]
                )
            );
        }
        var sourceReopened = await Source("inspect", data);
        Assert.True(JsonNode.DeepEquals(expected["wait"], sourceReopened["wait"]));
        var sourceWake = await Source(wake, data);
        Assert.Null(sourceWake["currentWait"]);
        Assert.Equal("enqueue", SessionWait.Text(sourceWake["transition"]?["action"]));
        JsonArray queued;
        await using (var manager = new SessionManager(data, work, options, models))
        {
            Assert.DoesNotContain(id, manager.Catalog.RestartIds());
            await manager.LoadMainHostAsync();
            var owner = await manager.RequiredAsync(id);
            Assert.NotNull(owner);
            Assert.True(JsonNode.DeepEquals(expected["wait"], owner.Entry.Snapshot().Meta["wait"]));
            Assert.False(owner.WaitSnapshot()!.ContainsKey("declarationVersion"));
            var input = PersistentSessionAuthorityStore.FromQueueJson(
                sourceWake["item"]!.AsObject()
            );
            Assert.True(await owner.Entry.SaveLane.AdmitAsync(input, SaveKind.Strict));
            var snapshot = owner.Entry.Snapshot();
            Assert.Null(snapshot.Meta["wait"]);
            queued = new JsonArray(
                snapshot
                    .Queue.Select(row => (JsonNode)PersistentSessionAuthorityStore.ToQueueJson(row))
                    .ToArray()
            );
            var sourceItems = sourceWake["transition"]!["items"]!.AsArray();
            Assert.Equal(sourceItems.Count, queued.Count);
            Assert.True(JsonNode.DeepEquals(sourceItems[0], queued[0]));
            if (wake == "matching")
            {
                // The listed report is deferred and released by the existing all-report transition,
                // without being replaced by a fabricated wake or pending-source reminder.
                Assert.Single(queued);
                Assert.Equal("original-report", SessionWait.Text(queued[0]!["syntheticReceipt"]));
            }
            else
            {
                Assert.Equal(2, queued.Count);
                Assert.Contains("wait-all-pending", queued[1]!.ToJsonString());
                Assert.Contains("reporter", queued[1]!.ToJsonString());
                Assert.Contains("wait-all-pending", sourceItems[1]!.ToJsonString());
            }
            Assert.Null(JsonNode.Parse(await File.ReadAllTextAsync(file))!["meta"]!["wait"]);
        }
        await using (var reopened = new SessionManager(data, work, options, models))
        {
            var owner = await reopened.RequiredAsync(id);
            Assert.Null(owner.WaitSnapshot());
            Assert.True(
                JsonNode.DeepEquals(
                    queued,
                    new JsonArray(
                        owner
                            .Entry.Snapshot()
                            .Queue.Select(row =>
                                (JsonNode)PersistentSessionAuthorityStore.ToQueueJson(row)
                            )
                            .ToArray()
                    )
                )
            );
        }
    }

    [Fact]
    public async Task Current_wait_tool_still_requires_two_distinct_targets_without_mutating_an_existing_wait()
    {
        await using var f = await MainToolScriptTests.Fixture.Create();
        var first = await f.Manager.CreateNamedAsync("main", "first", null, null);
        var second = await f.Manager.CreateNamedAsync("main", "second", null, null);
        var definitions = new JsonArray(WaitToolDefinitions.Definition());
        var registry = SessionToolExecutor.CreateRegistry(definitions, f.Mcp, _ => f.Work);
        var tools = new SessionToolExecutor(
            new WorkspaceTools(f.Work),
            f.Owner,
            f.Manager,
            registry
        );
        tools.BeginTurn();
        async Task<JsonObject> Wait(JsonArray targets) =>
            (
                await tools.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = "current-wait",
                        ["name"] = "wait",
                        ["args"] = new JsonObject { ["waitAllSessions"] = targets },
                    },
                    default
                )
            )!.AsObject();
        await f.Manager.DeclareWaitAsync(f.Owner, new JsonObject { ["waitForInput"] = true });
        var before = f.Owner.WaitSnapshot()!.DeepClone();
        var file = Path.Combine(f.Data, "state", "sessions", f.Owner.Id + ".json");
        var persisted = await File.ReadAllTextAsync(file);
        foreach (
            var targets in new[] { new JsonArray(first.Id), new JsonArray(first.Id, first.Id) }
        )
        {
            var rejected = await Wait(targets);
            Assert.NotNull(rejected["error"]);
            Assert.True(JsonNode.DeepEquals(before, f.Owner.WaitSnapshot()));
            Assert.Equal(persisted, await File.ReadAllTextAsync(file));
            Assert.Empty(f.Owner.Entry.Snapshot().Queue);
        }
        var accepted = await Wait(new JsonArray(first.Id, second.Id));
        Assert.Null(accepted["error"]);
        var wait = f.Owner.WaitSnapshot()!;
        Assert.Equal(1, wait["declarationVersion"]!.GetValue<int>());
        Assert.Equal(
            new[] { first.Id, second.Id },
            SessionWait.Strings(wait["waitAll"]!["sessions"])
        );
    }
}
