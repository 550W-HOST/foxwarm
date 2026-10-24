using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class EffectiveSelectionTests
{
    private const string Done =
        "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n";

    private static Task Reply(System.Net.Sockets.NetworkStream stream, bool success) =>
        LoopbackResponsesServer.WriteResponseAsync(
            stream,
            success ? 200 : 503,
            success ? "text/event-stream" : "application/json",
            Encoding.UTF8.GetBytes(success ? Done : "unavailable")
        );

    private static HostModels Catalog(Uri uri) =>
        HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a",
                ["providers"] = new JsonObject
                {
                    ["a"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = uri.ToString(),
                        ["models"] = new JsonArray("wire-a"),
                        ["extraFields"] = new JsonObject
                        {
                            ["test_cache"] = "${SESSION_CACHE_KEY}",
                            ["test_turn"] = "${TURN_ID}",
                        },
                    },
                    ["b"] = new JsonObject
                    {
                        ["providerType"] = "openai-responses",
                        ["baseUrl"] = uri.ToString(),
                        ["models"] = new JsonArray("wire-b"),
                    },
                    ["route"] = new JsonObject
                    {
                        ["providerType"] = "failover",
                        ["targets"] = new JsonArray("a", "b"),
                        ["failureThreshold"] = 1,
                    },
                },
            },
            new JsonObject()
        );

    private static JsonObject[] Notices(SessionEntry entry) =>
        entry
            .Snapshot()
            .History.Materialize()
            .Where(row => row["parts"]!.ToJsonString().Contains("session-settings-changed"))
            .ToArray();

    [Fact]
    public async Task Normal_owner_adopts_concrete_leaf_and_Node_but_setters_aliases_effort_and_child_defaults_do_not_fabricate_switches()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            6,
            async (_, stream, _) => await Reply(stream, true)
        );
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713);
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            Catalog(peer.BaseUri)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "selection", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        var notifications = new List<SessionRuntimeEvent>();
        owner.Changed += notifications.Add;
        async Task Run()
        {
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("next"));
            await owner.Registry.Runner.ProcessQueueAsync(owner.Id);
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        }
        await Run();
        Assert.Empty(Notices(owner.Entry));
        Assert.Equal(
            "a/wire-a",
            owner.Entry.Snapshot().Meta["lastEffectiveRequest"]!["modelId"]!.GetValue<string>()
        );
        await owner.UpdateSettingsAsync(new JsonObject { ["model"] = "a/wire-a" }, false);
        await owner.UpdateSettingsAsync(new JsonObject { ["effort"] = "low" }, false);
        await owner.UpdateSettingsAsync(new JsonObject { ["model"] = "b" }, true);
        await owner.Entry.SaveLane.CommitNodeAsync("unattempted");
        await owner.Entry.SaveLane.CommitNodeAsync("master");
        await Run();
        Assert.Empty(Notices(owner.Entry));
        Assert.Equal(
            "low",
            owner.Entry.Snapshot().Meta["lastEffectiveRequest"]!["effort"]!.GetValue<string>()
        );
        await owner.UpdateSettingsAsync(new JsonObject { ["model"] = "b" }, false);
        Assert.Empty(Notices(owner.Entry));
        await Run();
        var notice = Assert.Single(Notices(owner.Entry));
        Assert.Contains(
            "oldModel=\"a/wire-a\"",
            notice["parts"]![0]!["system"]!.GetValue<string>()
        );
        Assert.Contains("session-settings-changed", (await peer.RequestAt(2)).Body);
        // Use the existing exact-owner placement save seam; online Node admission is qualified separately.
        await owner.Entry.SaveLane.CommitNodeAsync("owned-node");
        await Run();
        Assert.Contains(
            "newNode=\"owned-node\"",
            Notices(owner.Entry).Last()["parts"]![0]!["system"]!.GetValue<string>()
        );
        await Run();
        await Run();
        Assert.Equal(2, Notices(owner.Entry).Length);
        Assert.Equal(
            Notices(owner.Entry).Select(row => row.ToJsonString()),
            notifications
                .Where(value =>
                    value.Kind == SessionEventKind.MessageCommitted
                    && value.Data!["parts"]!.ToJsonString().Contains("session-settings-changed")
                )
                .Select(value => value.Data!.ToJsonString())
        );
        var persisted = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Path.Combine(temp.Path, "data/state/sessions/selection.json")
            )
        )!;
        Assert.Equal(
            "owned-node",
            persisted["meta"]!["lastEffectiveRequest"]!["nodeId"]!.GetValue<string>()
        );
        await manager.ShutdownAsync();
    }

    [Fact]
    public async Task Explicit_raw_model_change_during_backoff_recaptures_even_same_leaf_and_effort_only_edit_keeps_pair()
    {
        var first = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var second = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, _) =>
            {
                if (index == 0)
                    await first.Task;
                if (index == 1)
                    await second.Task;
                await Reply(stream, index == 2);
            }
        );
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713);
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            Catalog(peer.BaseUri)
        );
        await manager.LoadAsync();
        var owner = await manager.CreateNamedAsync("main", "recapture", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        try
        {
            await owner.UpdateSettingsAsync(
                new JsonObject { ["model"] = "a", ["effort"] = "high" },
                false
            );
            await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("seed"));
            var running = owner.Registry.Runner.ProcessQueueAsync(owner.Id);
            await peer.RequestAt(0).WaitAsync(TimeSpan.FromSeconds(5));
            var before = owner.DraftSnapshot()["llmRequestId"]!.GetValue<string>();
            await owner.UpdateSettingsAsync(
                new JsonObject { ["model"] = "a/wire-a", ["effort"] = "low" },
                false
            );
            var firstFailureReleasedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            first.TrySetResult();
            var next = await peer.RequestAt(1).WaitAsync(TimeSpan.FromSeconds(8));
            Assert.Equal(
                "low",
                JsonNode.Parse(next.Body)!["reasoning"]!["effort"]!.GetValue<string>()
            );
            Assert.NotEqual(before, owner.DraftSnapshot()["llmRequestId"]!.GetValue<string>());
            await owner.UpdateSettingsAsync(new JsonObject { ["effort"] = "max" }, false);
            second.TrySetResult();
            var third = await peer.RequestAt(2).WaitAsync(TimeSpan.FromSeconds(8));
            Assert.Equal(
                "low",
                JsonNode.Parse(third.Body)!["reasoning"]!["effort"]!.GetValue<string>()
            );
            await running.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Empty(Notices(owner.Entry));
            Assert.Equal(
                "low",
                owner.Entry.Snapshot().Meta["lastEffectiveRequest"]!["effort"]!.GetValue<string>()
            );
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
            var timing = owner.History().Last()["__meta"]!["llmRequestTiming"]!;
            Assert.True(timing["durationMs"]!.GetValue<double>() >= 4900);
            Assert.True(timing["startedAt"]!.GetValue<double>() >= firstFailureReleasedAt + 1900);
        }
        finally
        {
            first.TrySetResult();
            second.TrySetResult();
        }
        await manager.ShutdownAsync();
    }

    [Fact]
    public async Task Virtual_failover_notice_is_canonical_and_reaches_actual_next_provider_and_journal()
    {
        const string tools =
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"function_call\",\"call_id\":\"list-first\",\"name\":\"task\",\"arguments\":\"{\\\"action\\\":\\\"list\\\"}\"},{\"type\":\"function_call\",\"call_id\":\"list-second\",\"name\":\"task\",\"arguments\":\"{\\\"action\\\":\\\"list\\\"}\"}]}}\n\n";
        await using var peer = new ScriptedResponsesSequenceServer(
            4,
            async (index, stream, _) =>
            {
                if (index == 1)
                    await LoopbackResponsesServer.WriteResponseAsync(
                        stream,
                        200,
                        "text/event-stream",
                        Encoding.UTF8.GetBytes(tools)
                    );
                else
                    await Reply(stream, index > 0);
            }
        );
        using var temp = new TempDirectory();
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713);
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            options,
            Catalog(peer.BaseUri)
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "failover", null, null);
        owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        await owner.UpdateSettingsAsync(new JsonObject { ["model"] = "route" }, false);
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("seed"));
        await owner.Registry.Runner.ProcessQueueAsync(owner.Id);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        var notice = Assert.Single(Notices(owner.Entry))["parts"]![0]![
            "system"
        ]!.GetValue<string>();
        Assert.Contains("reason=\"failover\"", notice);
        Assert.Contains("newModel=\"b/wire-b\"", notice);
        Assert.Contains("session-settings-changed", (await peer.RequestAt(1)).Body);
        Assert.Equal(
            "b/wire-b",
            owner.Entry.Snapshot().Meta["lastEffectiveRequest"]!["modelId"]!.GetValue<string>()
        );
        var models = owner
            .History()
            .Where(row =>
                SessionWait.Text(row["role"]) == "model"
                && row["modelVisible"]?.GetValue<bool>() != false
            )
            .ToArray();
        Assert.Equal(2, models.Length);
        var call = models[0];
        var timing = call["__meta"]!["llmRequestTiming"]!.AsObject();
        Assert.True(timing["durationMs"]!.GetValue<double>() >= 1900, timing.ToJsonString());
        var tool = Assert.Single(owner.History(), row => SessionWait.Text(row["role"]) == "tool");
        var responses = tool["parts"]!
            .AsArray()
            .Select(part => part!["functionResponse"]!)
            .ToArray();
        Assert.All(responses, response => Assert.Null(response["response"]?["error"]));
        Assert.Equal(
            timing["durationMs"]!.GetValue<double>(),
            responses[0]["previousLlmRequest"]!["durationMs"]!.GetValue<double>()
        );
        Assert.Null(responses[1]["previousLlmRequest"]);
        var successId = call["__meta"]!["llmRequestId"]!.GetValue<string>();
        var success = await manager.Journal.ReconstructAsync(successId);
        var successAttempt = Assert.Single(success["attempts"]!.AsArray())!;
        Assert.Equal(1, call["__meta"]!["llmAttempt"]!.GetValue<int>());
        Assert.Equal("b/wire-b", successAttempt["start"]!["concreteModelId"]!.GetValue<string>());
        Assert.True(
            successAttempt["start"]!["startedAt"]!.GetValue<long>()
                >= timing["startedAt"]!.GetValue<double>() + 1900
        );
        Assert.Equal("success", successAttempt["result"]!["outcome"]!.GetValue<string>());
        Assert.True(
            JsonNode.DeepEquals(timing, successAttempt["result"]!["result"]!["previousLlmRequest"])
        );
        Assert.Contains("session-settings-changed", success["messages"]!.ToJsonString());
        var listed = await manager.Journal.ListAsync(owner.Id, "normal-turn", null, null, 10);
        Assert.Equal(3, listed.Count);
        var continuationId = models[1]["__meta"]!["llmRequestId"]!.GetValue<string>();
        var failureId = listed.Single(row =>
            SessionWait.Text(row!["requestId"]) is { } id && id != successId && id != continuationId
        )!["requestId"]!.GetValue<string>();
        var failed = await manager.Journal.ReconstructAsync(failureId);
        var failedAttempt = Assert.Single(failed["attempts"]!.AsArray())!;
        Assert.Equal("a/wire-a", failedAttempt["start"]!["concreteModelId"]!.GetValue<string>());
        Assert.Equal("failure", failedAttempt["result"]!["outcome"]!.GetValue<string>());
        Assert.Null(failedAttempt["result"]!["result"]);
        // Tool continuation and a later turn each start their own timing interval.
        Assert.NotEqual(successId, continuationId);
        Assert.True(
            models[1]["__meta"]!["llmRequestTiming"]!["startedAt"]!.GetValue<double>()
                >= timing["completedAt"]!.GetValue<double>() - 1
        );
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("next turn"));
        await owner.Registry.Runner.ProcessQueueAsync(owner.Id);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        var next = owner.History().Last();
        Assert.NotEqual(continuationId, next["__meta"]!["llmRequestId"]!.GetValue<string>());
        Assert.True(
            next["__meta"]!["llmRequestTiming"]!["startedAt"]!.GetValue<double>()
                >= models[1]["__meta"]!["llmRequestTiming"]!["completedAt"]!.GetValue<double>() - 1
        );
        var persisted = JsonNode.Parse(
            await File.ReadAllTextAsync(
                Path.Combine(temp.Path, "data/state/sessions/failover.json")
            )
        )!;
        Assert.Contains(timing.ToJsonString(), persisted.ToJsonString());
        Assert.Equal(4, peer.RequestCount);
        await manager.ShutdownAsync();
    }

    [Fact]
    public async Task Missing_fallback_warning_dedupes_and_baseline_changes_without_effort_notice()
    {
        var store = new InMemorySessionAuthorityStore();
        var entry = new SessionRegistry(store, new FakeChatService()).Add("owner");
        var missing = new EffectiveRequestSelection("a/wire", "master", "high", "removed");
        Assert.True(await entry.SaveLane.AdoptEffectiveSelectionAsync(missing, false));
        Assert.False(await entry.SaveLane.AdoptEffectiveSelectionAsync(missing, false));
        Assert.False(
            await entry.SaveLane.AdoptEffectiveSelectionAsync(
                missing with
                {
                    Effort = "low",
                },
                false
            )
        );
        Assert.Single(Notices(entry));
        Assert.True(
            await entry.SaveLane.AdoptEffectiveSelectionAsync(
                missing with
                {
                    MissingModelKey = "removed-again",
                },
                false
            )
        );
        Assert.Equal(2, Notices(entry).Length);
        Assert.Null(
            EffectiveRequestSelection.Read(JsonValue.Create("invalid historical metadata"))
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Selection_and_notice_publish_together_only_when_actual_authority_commits(
        bool committed
    )
    {
        using var temp = new TempDirectory();
        var fail = false;
        var store = new PersistentSessionAuthorityStore(
            temp.Path,
            "selection",
            authorityStageHook: stage =>
            {
                if (
                    fail
                    && stage
                        == (
                            committed
                                ? AtomicJsonWriteStage.AfterRenameBeforeDirectorySync
                                : AtomicJsonWriteStage.BeforeRename
                        )
                )
                    throw new IOException("owned adoption fault");
            }
        );
        var entry = new SessionRegistry(store, new FakeChatService()).Add("selection");
        var notifications = new List<JsonObject>();
        entry.HistoryAppended = rows => notifications.AddRange(rows);
        await entry.SaveLane.AdoptEffectiveSelectionAsync(new("a", "master", "high"), false);
        fail = true;
        var error = await Record.ExceptionAsync(() =>
            entry.SaveLane.AdoptEffectiveSelectionAsync(new("b", "master", "low"), false)
        );
        Assert.NotNull(error);
        Assert.Equal(committed, error is AuthorityCommittedException);
        Assert.Equal(
            committed ? "b" : "a",
            entry.Snapshot().Meta["lastEffectiveRequest"]!["modelId"]!.GetValue<string>()
        );
        Assert.Equal(committed ? 1 : 0, Notices(entry).Length);
        Assert.Equal(
            Notices(entry).Select(row => row.ToJsonString()),
            notifications.Select(row => row.ToJsonString())
        );
        var disk = (await store.LoadAsync("selection"))!;
        Assert.Equal(
            committed ? "b" : "a",
            disk.Meta["lastEffectiveRequest"]!["modelId"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Explicit_recaptures_preserve_six_physical_attempts_and_cache_lineage()
    {
        await using var peer = new ScriptedResponsesSequenceServer(
            6,
            async (_, stream, _) => await Reply(stream, false)
        );
        using var http = new HttpClient();
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713);
        var requests = new ModelRequestOwner(
            http,
            options,
            new ModelRouting(),
            (_, _) => Task.CompletedTask
        );
        var catalog = Catalog(peer.BaseUri);
        var recaptures = 0;
        var adoptions = 0;
        var failures = new List<ModelRetryEvent>();
        var error = await Assert.ThrowsAsync<ModelRequestException>(() =>
            requests.RequestAsync(
                "owner",
                requests.Capture(catalog, "a", "high"),
                "retained-cache",
                "retained-turn",
                RequestHistory.FromMutable([
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(new JsonObject { ["text"] = "seed" }),
                    },
                ]),
                (_, _) => Task.FromResult("prompt"),
                value =>
                {
                    failures.Add(value);
                    return Task.FromResult(false);
                },
                null,
                null,
                null,
                default,
                ModelRequestScope.Canonical,
                prepareRetry: _ => Task.FromResult<RequestHistory?>(null),
                recaptureSelection: () =>
                {
                    recaptures++;
                    return requests.Capture(catalog, recaptures % 2 == 0 ? "a" : "a/wire-a", "low");
                },
                adoptSelection: (_, effort, failover, _) =>
                {
                    Assert.False(failover);
                    Assert.Equal(adoptions++ == 0 ? "high" : "low", effort);
                    return Task.FromResult<RequestHistory?>(null);
                }
            )
        );
        Assert.Equal(6, peer.RequestCount);
        Assert.Equal(5, recaptures);
        Assert.Equal(6, adoptions);
        Assert.Equal(Enumerable.Range(1, 6), failures.Select(value => value.Attempt));
        Assert.All(failures, value => Assert.Equal(6, value.MaxRetries));
        Assert.Contains("after 6 attempts", error.Message);
        var keys = new List<string>();
        for (var index = 0; index < 6; index++)
            keys.Add(
                JsonNode.Parse((await peer.RequestAt(index)).Body)![
                    "test_cache"
                ]!.GetValue<string>()
            );
        Assert.Single(keys.Distinct());
    }
}
