using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed partial class AnthropicHostedSearchTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Pending_native_search_defers_queued_input_retry_reminders_and_ready_compaction(
        bool readyCompact
    )
    {
        AdmissionFixture? fixture = null;
        var normal = 0;
        JsonObject? continuation = null;
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var failures = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedResponsesSequenceServer(
            readyCompact ? 5 : 4,
            async (_, stream, request) =>
            {
                try
                {
                    var body = Obj(request.Body);
                    if (request.Body.Contains("COMPACTION STARTED:"))
                    {
                        var candidates = Regex.Matches(
                            request.Body.Replace("\\n", "\n"),
                            "^- M#(\\d+)(?:-#(\\d+))?\\s",
                            RegexOptions.Multiline
                        );
                        Assert.NotEmpty(candidates);
                        var last = candidates[^1];
                        var plan = new JsonObject
                        {
                            ["replaceAsBlocks"] = new JsonArray(
                                new JsonObject
                                {
                                    ["level"] = 1,
                                    ["sourceKind"] = "message",
                                    ["sourceStart"] = long.Parse(candidates[0].Groups[1].Value),
                                    ["sourceEnd"] = long.Parse(
                                        last.Groups[2].Success
                                            ? last.Groups[2].Value
                                            : last.Groups[1].Value
                                    ),
                                    ["summary"] = "Earlier work compacted.",
                                }
                            ),
                        };
                        await Respond(
                            stream,
                            Reply(
                                "tool_use",
                                new JsonObject
                                {
                                    ["type"] = "tool_use",
                                    ["id"] = "plan",
                                    ["name"] = "submit_compact_plan",
                                    ["input"] = plan,
                                }
                            ),
                            false
                        );
                        return;
                    }
                    var index = normal++;
                    if (index == 0)
                    {
                        Assert.DoesNotContain("Continue the active tasks:", request.Body);
                        await Respond(stream, Reply("tool_use", Search(), LocalTask()), false);
                        return;
                    }
                    if (index is 1 or 2)
                    {
                        Assert.DoesNotContain("queued-followup", request.Body);
                        Assert.DoesNotContain("Continue the active tasks:", request.Body);
                        Assert.DoesNotContain("Earlier work compacted.", request.Body);
                        var last = body["messages"]!.AsArray()[^1]!;
                        Assert.Equal("user", last["role"]!.ToString());
                        Assert.All(
                            last["content"]!.AsArray(),
                            block => Assert.Equal("tool_result", block!["type"]!.ToString())
                        );
                        Assert.Single(
                            fixture!.Owner.Entry.Snapshot().Queue,
                            SessionCompactor.Ordinary
                        );
                        if (readyCompact)
                        {
                            Assert.True(fixture.Owner.Compactor.HasCompletedJob);
                            Assert.Equal(0, fixture.Owner.Entry.Snapshot().HistoryVersion);
                        }
                        if (index == 1)
                        {
                            continuation = body;
                            await LoopbackResponsesServer.WriteResponseAsync(
                                stream,
                                503,
                                "application/json",
                                Encoding.UTF8.GetBytes(
                                    "{\"error\":{\"message\":\"temporary peer failure\"}}"
                                )
                            );
                            return;
                        }
                        Assert.True(
                            JsonNode.DeepEquals(continuation!["messages"], body["messages"])
                        );
                        await Respond(stream, Reply("end_turn", Sources(), Cited()), false);
                        return;
                    }
                    Assert.Equal(3, index);
                    Assert.Contains("queued-followup", request.Body);
                    if (readyCompact)
                    {
                        Assert.Contains("Earlier work compacted.", request.Body);
                        Assert.Equal(1, fixture!.Owner.Entry.Snapshot().HistoryVersion);
                    }
                    else
                        Assert.Contains("Continue the active tasks:", request.Body);
                    await Respond(stream, Reply("end_turn", Text("Handled queued input.")), false);
                }
                catch (Exception error)
                {
                    failures.TrySetException(error);
                    throw;
                }
            }
        );
        await using var owned = new AdmissionFixture(peer.BaseUri);
        fixture = owned;
        await fixture.Tasks.MigrateLegacyGoalAsync("s", "Finish assigned work", 0);
        var host = fixture.Owner.Registry.HostFor("s");
        for (var index = 0; index < 28; index++)
            await host.AppendHistoryMessageStrictAsync(
                Obj(
                    $$"""{"role":"{{(index % 2 == 0 ? "user" : "model")}}","parts":[{"text":"seed {{index}} {{new string('x', 1000)}}"}]}"""
                )
            );
        fixture.Owner.Entry.Committed = _ =>
        {
            if (fixture.Owner.Compactor.HasCompletedJob)
                ready.TrySetResult();
        };
        await fixture.Enqueue("start search");
        var processing = fixture.Owner.Registry.Runner.ProcessQueueAsync("s");
        try
        {
            await fixture.Tool.Started.WaitAsync(TimeSpan.FromSeconds(8));
            await fixture.Enqueue("queued-followup");
            if (readyCompact)
            {
                Assert.True((await fixture.Owner.Compactor.StartManualAsync()).Started);
                await Task.WhenAny(ready.Task, failures.Task).WaitAsync(TimeSpan.FromSeconds(8));
                if (failures.Task.IsCompleted)
                    await failures.Task;
            }
            fixture.Tool.Release();
            await Task.WhenAny(processing, failures.Task).WaitAsync(TimeSpan.FromSeconds(15));
            if (failures.Task.IsCompleted)
                await failures.Task;
            await processing;
            Assert.Equal(4, normal);
            Assert.Equal(1, fixture.Tool.Invocations);
            var history = fixture.Owner.Entry.Snapshot().History.Materialize();
            Assert.Single(
                history,
                row => SessionWait.Text(row["__meta"]?["clientMessageId"]) == "queued-followup"
            );
            if (!readyCompact)
                Assert.Single(
                    history,
                    row => row["__meta"]?[TaskReminder.MetaKey]?.GetValue<bool>() == true
                );
            Assert.False(fixture.Owner.Entry.ProviderContinuationPending);
            Assert.Empty(fixture.Owner.Entry.Snapshot().Queue);
        }
        finally
        {
            fixture.Tool.Release();
        }
    }

    [Fact]
    public async Task Stop_then_new_input_repairs_only_abandoned_search_and_old_bound_thinking()
    {
        var before = Obj(
            """{"type":"thinking","thinking":"Before the interrupted call.","signature":"before-signature"}"""
        );
        var after = Obj(
            """{"type":"thinking","thinking":"After the interrupted call.","signature":"invalid-after-signature"}"""
        );
        var recovered = Obj(
            """{"type":"thinking","thinking":"Generated against the repaired prefix.","signature":"recovered-signature"}"""
        );
        var failures = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = new ScriptedResponsesSequenceServer(
            3,
            async (index, stream, request) =>
            {
                try
                {
                    if (index == 0)
                    {
                        await Respond(
                            stream,
                            Reply(
                                "tool_use",
                                before,
                                Search("completed"),
                                Sources("completed"),
                                Text("Keep this readable answer."),
                                Search("abandoned"),
                                after,
                                LocalTask()
                            ),
                            false
                        );
                        return;
                    }
                    Assert.DoesNotContain("\"id\":\"abandoned\"", request.Body);
                    Assert.DoesNotContain("invalid-after-signature", request.Body);
                    Assert.Contains("before-signature", request.Body);
                    Assert.Contains("completed", request.Body);
                    Assert.Contains("encrypted_content", request.Body);
                    Assert.Contains("Keep this readable answer.", request.Body);
                    if (index == 1)
                    {
                        Assert.Contains("resume after stop", request.Body);
                        await Respond(
                            stream,
                            Reply("end_turn", recovered, Text("Recovered.")),
                            false
                        );
                    }
                    else
                    {
                        Assert.Contains("recovered-signature", request.Body);
                        await Respond(stream, Reply("end_turn", Text("Still usable.")), false);
                    }
                }
                catch (Exception error)
                {
                    failures.TrySetException(error);
                    throw;
                }
            }
        );
        await using var fixture = new AdmissionFixture(peer.BaseUri);
        await fixture.Enqueue("start interrupted search");
        var processing = fixture.Owner.Registry.Runner.ProcessQueueAsync("s");
        await fixture.Tool.Started.WaitAsync(TimeSpan.FromSeconds(8));
        await fixture.Owner.Registry.Control.StopAsync("s");
        await processing.WaitAsync(TimeSpan.FromSeconds(8));
        Assert.False(fixture.Owner.Entry.ProviderContinuationPending);
        foreach (var input in new[] { "resume after stop", "use the recovered history" })
        {
            await fixture.Enqueue(input);
            processing = fixture.Owner.Registry.Runner.ProcessQueueAsync("s");
            await Task.WhenAny(processing, failures.Task).WaitAsync(TimeSpan.FromSeconds(8));
            if (failures.Task.IsCompleted)
                await failures.Task;
            await processing;
        }
        Assert.Equal(1, fixture.Tool.Invocations);
        var snapshot = fixture.Owner.Entry.Snapshot();
        Assert.Contains(
            "invalid-after-signature",
            new JsonArray(
                snapshot.History.Materialize().Select(row => (JsonNode)row.DeepClone()).ToArray()
            ).ToJsonString()
        );
        var repaired = RequestHistoryRepair.SelectAndRepair(
            RequestHistory.FromSnapshot(snapshot.History)
        );
        var altered = Assert.Single(
            repaired.Rows,
            row => row.Message["parts"]!.ToJsonString().Contains("before-signature")
        );
        Assert.Null(altered.Origin);
        Assert.DoesNotContain("invalid-after-signature", altered.Message.ToJsonString());
    }

    private static JsonObject LocalTask() =>
        Obj("""{"type":"tool_use","id":"local","name":"task","input":{"action":"list"}}""");

    private sealed class AdmissionFixture : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        private readonly HttpClient http = new() { Timeout = Timeout.InfiniteTimeSpan };
        private readonly SessionManager authorization;
        internal readonly SessionOwner Owner;
        internal readonly BarrierToolExecutor Tool = new();
        internal readonly TaskService Tasks;

        internal AdmissionFixture(Uri address)
        {
            var data = Path.Combine(temp.Path, "data");
            var work = Path.Combine(temp.Path, "work");
            Directory.CreateDirectory(work);
            var configuration = Obj(
                """{"default":"a/wire","providers":{"a":{"providerType":"anthropic","webSearch":true,"asyncCompact":true,"contextLimit":200000,"extraFields":{"stream":false},"models":["wire"]}}}"""
            );
            configuration["providers"]!["a"]!["baseUrl"] = new Uri(address, "/").ToString();
            var catalog = HostModels.Parse(configuration, new JsonObject());
            var options = new ResponsesClientOptions(address, "wire", "a/wire", "", "", 1000);
            var store = new PersistentSessionAuthorityStore(data, "s");
            Owner = new SessionOwner("s", "main", catalog) { Archive = store.Archive };
            var agents = new AgentCatalog(data, work);
            var memory = new AgentMemory(
                agents,
                new Skills(agents, Path.Combine(temp.Path, "skills"))
            );
            var requests = TestModelOwners.Create(
                http,
                options,
                new ModelRouting(),
                (_, _) => Task.CompletedTask,
                images: store.Images
            );
            Tasks = new TaskService(
                null!,
                new SqliteTaskRowStore(data),
                id => id,
                _ => [],
                _ => null,
                _ => "main"
            );
            var chat = new SessionChatService(
                requests,
                options,
                Owner,
                catalog,
                memory,
                (_, _) => { },
                tasks: Tasks
            );
            Owner.Registry = new SessionRegistry(store, chat, Tool);
            Owner.Registry.Add("s");
            authorization = new SessionManager(
                Path.Combine(temp.Path, "authorization"),
                work,
                options,
                catalog
            );
            Owner.Compactor = new SessionCompactor(
                Owner,
                authorization,
                store,
                catalog,
                options,
                requests,
                memory
            );
            Owner.Registry.OnSafePoint = _ => Owner.Compactor.SafePointAsync();
            Owner.Registry.OnRetrySafePoint = _ =>
                Owner.Compactor.SafePointAsync(propagateFailure: true);
            Owner.Registry.OnBeforeContinuation = (_, result, consume, token) =>
                Owner.Compactor.BeforeContinuationAsync(result, consume, token);
            Owner.Registry.OnTurnCompleted = (_, result) =>
                Owner.Compactor.AutoAfterTurnAsync(result);
            Owner.Registry.HasCompletedCompact = _ => Owner.Compactor.HasCompletedJob;
            Owner.Registry.TriggerOverride = _ => Task.CompletedTask;
        }

        internal Task Enqueue(string text) =>
            Owner.Registry.Ingress.EnqueueAsync(
                "s",
                QueueItem.UserText(text, clientMessageId: text)
            );

        public async ValueTask DisposeAsync()
        {
            Tool.Release();
            if (Owner.Compactor.Active)
                await Owner.Compactor.StopAsync();
            await Owner.Registry.Runner.ShutdownAsync(
                TimeSpan.FromSeconds(2),
                TimeSpan.FromSeconds(2)
            );
            await authorization.DisposeAsync();
            Tasks.Dispose();
            http.Dispose();
            temp.Dispose();
        }
    }
}
