using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foxwarm.Tests;

public sealed class ResponsesPrefixCommitTests
{
    private static JsonObject Commentary(string text, string phase = "commentary") =>
        new()
        {
            ["type"] = "message",
            ["role"] = "assistant",
            ["status"] = "completed",
            ["phase"] = phase,
            ["content"] = new JsonArray(
                new JsonObject { ["type"] = "output_text", ["text"] = text }
            ),
        };

    private static JsonObject Reasoning(string encrypted = "encrypted-replay") =>
        new()
        {
            ["type"] = "reasoning",
            ["status"] = "completed",
            ["encrypted_content"] = encrypted,
            ["summary"] = new JsonArray(
                new JsonObject { ["type"] = "summary_text", ["text"] = "summary" }
            ),
        };

    internal static JsonObject Done(int index, JsonObject item) =>
        new()
        {
            ["type"] = "response.output_item.done",
            ["output_index"] = index,
            ["item"] = item,
        };

    internal static JsonObject Completed(params JsonObject[] output) =>
        new()
        {
            ["type"] = "response.completed",
            ["response"] = new JsonObject
            {
                ["id"] = Guid.NewGuid().ToString("N"),
                ["status"] = "completed",
                ["output"] = new JsonArray(output.Select(item => item.DeepClone()).ToArray()),
                ["usage"] = new JsonObject { ["input_tokens"] = 7, ["output_tokens"] = 3 },
            },
        };

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Completed_ordered_commentary_is_durable_before_failure_and_the_real_retry_replays_it(
        bool websocket
    )
    {
        var delivered = new TaskCompletionSource<JsonObject>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        Owner? owner = null;
        var search = new JsonObject
        {
            ["type"] = "web_search_call",
            ["id"] = "search",
            ["status"] = "completed",
            ["action"] = new JsonObject { ["type"] = "search", ["query"] = "q" },
        };
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                if (number == 1)
                {
                    await context.Send(Done(2, Commentary("retained-prefix")));
                    await context.Send(Done(0, Reasoning()));
                    await context.Send(Done(1, (JsonObject)search.DeepClone()));
                    var row = await delivered.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    Assert.False(row["__meta"]!["llmSegment"]!["complete"]!.GetValue<bool>());
                    var disk = (await owner!.Store.LoadAsync("s"))!;
                    Assert.Contains(
                        "retained-prefix",
                        disk.History.Materialize().Last().ToJsonString()
                    );
                    context.Abort();
                }
                else
                {
                    Assert.Contains("retained-prefix", context.Request.ToJsonString());
                    Assert.Contains("encrypted-replay", context.Request.ToJsonString());
                    Assert.Contains("web_search_call", context.Request.ToJsonString());
                    await context.Send(Completed(Commentary("retry-final", "final_answer")));
                }
            }
        );
        await using var owned = owner = new Owner(
            peer.Uri,
            websocket,
            diagnostics: true,
            priced: true
        );
        owner.Entry.AssistantCommitted = row =>
        {
            delivered.TrySetResult(row);
            return Task.CompletedTask;
        };
        await owner.Run();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(2, peer.Requests.Count);
        // The ordinary Session retry recaptures its committed prefix and must
        // own a fresh raw pair, not only a new semantic journal identity.
        var rawRequests = Directory.GetFiles(owner.RecentLogs, "*_req.json");
        Assert.Equal(2, rawRequests.Length);
        var recaptured = Assert.Single(
            rawRequests,
            path => File.ReadAllText(path).Contains("retained-prefix", StringComparison.Ordinal)
        );
        var rawResponse = JsonNode.Parse(
            await File.ReadAllTextAsync(
                recaptured.Replace("_req.json", "_res.json", StringComparison.Ordinal)
            )
        )!;
        Assert.Contains("retry-final", rawResponse["body"]!.ToJsonString());
        Assert.Null(rawResponse["attempts"]);
        var rows = owner.Visible;
        Assert.Equal(3, rows.Count);
        Assert.Contains("retained-prefix", rows[1].ToJsonString());
        Assert.DoesNotContain("retained-prefix", rows[2].ToJsonString());
        Assert.Null(rows[1]["__meta"]?["usage"]);
        Assert.Equal(
            0.000023,
            SessionCatalog.Number(rows[2]["__meta"]?["usage"]?["cost"])!.Value,
            10
        );
        Assert.Equal(
            0.000023,
            SessionCatalog
                .Number(owner.Entry.Snapshot().AuthorityEnvelope["stats"]?["totalCost"])!
                .Value,
            10
        );
        Assert.Equal(0, rows[1]["__meta"]!["llmSegment"]!["outputStart"]!.GetValue<int>());
        Assert.Equal(3, rows[1]["__meta"]!["llmSegment"]!["outputEndExclusive"]!.GetValue<int>());
        Assert.Equal(
            3,
            owner.Entry.Snapshot().AuthorityEnvelope["stats"]![
                "totalOutputTokens"
            ]!.GetValue<double>()
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Successful_stream_commits_only_its_suffix_and_socket_reuse_contains_each_item_once(
        bool websocket
    )
    {
        var prefix = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                if (number == 1)
                {
                    await context.Send(Done(0, Reasoning()));
                    await context.Send(Done(1, Commentary("early")));
                    await prefix.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    await context.Send(Done(2, Commentary("late", "final_answer")));
                    await context.Send(
                        Completed(
                            Reasoning(),
                            Commentary("early"),
                            Commentary("late", "final_answer")
                        )
                    );
                }
                else
                    await context.Send(Completed(Commentary("next", "final_answer")));
            }
        );
        await using var owner = new Owner(peer.Uri, websocket);
        var events = new List<SessionRuntimeEvent>();
        owner.Hosted.Changed += events.Add;
        owner.Entry.AssistantCommitted = row =>
        {
            if (row["__meta"]?["llmSegment"]?["complete"]?.GetValue<bool>() == false)
                prefix.TrySetResult();
            return Task.CompletedTask;
        };
        await owner.Run();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        var rows = owner.Visible;
        Assert.Equal(3, rows.Count);
        Assert.DoesNotContain("early", rows[2].ToJsonString());
        Assert.Equal("late", rows[2]["parts"]![0]!["text"]!.GetValue<string>());
        Assert.Equal(2, rows[2]["__meta"]!["llmSegment"]!["outputStart"]!.GetValue<int>());
        Assert.True(rows[2]["__meta"]!["llmSegment"]!["complete"]!.GetValue<bool>());
        Assert.Contains(
            events,
            e =>
                e.Kind == SessionEventKind.ModelStream
                && e.Data?["trimBeforeOutputIndex"]?.GetValue<int>() == 2
        );
        var journalRow = Assert.Single(await owner.Journal.ListAsync("s", null, null, null, 10));
        var restored = await owner.Journal.ReconstructAsync(
            journalRow!["requestId"]!.GetValue<string>()
        );
        Assert.Contains("early", restored["attempts"]!.ToJsonString());
        Assert.Contains("late", restored["attempts"]!.ToJsonString());
        await owner.Run("second input");
        if (websocket)
        {
            Assert.True(peer.Requests[1].ContainsKey("previous_response_id"));
            Assert.Single(peer.Requests[1]["input"]!.AsArray());
        }
        else
        {
            var input = peer.Requests[1]["input"]!.AsArray();
            Assert.Single(
                input,
                item => item?["encrypted_content"]?.GetValue<string>() == "encrypted-replay"
            );
            Assert.Single(
                input,
                item =>
                    item?["content"]?.ToJsonString().Contains("early", StringComparison.Ordinal)
                    == true
            );
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stop_preserves_delivered_commentary_but_never_commits_a_later_reasoning_item(
        bool websocket
    )
    {
        var prefix = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var waiting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, _) =>
            {
                await context.Send(Done(0, Commentary("before-stop")));
                await prefix.Task.WaitAsync(TimeSpan.FromSeconds(5));
                await context.Send(Done(1, Reasoning("must-not-retain")));
                waiting.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, context.Token);
            }
        );
        await using var owner = new Owner(peer.Uri, websocket, keep: true);
        owner.Entry.AssistantCommitted = _ =>
        {
            prefix.TrySetResult();
            return Task.CompletedTask;
        };
        var processing = owner.Run();
        await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await owner.Hosted.Registry.Control.StopAsync("s");
        await processing.WaitAsync(TimeSpan.FromSeconds(5));
        var rows = (await owner.Store.LoadAsync("s"))!.History.Materialize();
        Assert.Contains(
            rows,
            row => row.ToJsonString().Contains("before-stop", StringComparison.Ordinal)
        );
        Assert.DoesNotContain(
            rows,
            row => row.ToJsonString().Contains("must-not-retain", StringComparison.Ordinal)
        );
        Assert.Single(peer.Requests);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, true)]
    [InlineData(false, false)]
    public async Task Reasoning_recovery_is_opt_in_and_requires_completed_encrypted_contiguous_output(
        bool websocket,
        bool keep
    )
    {
        var seen = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                if (number == 1)
                {
                    await context.Send(Done(0, Reasoning()));
                    await context.Send(Done(1, Reasoning("")));
                    await context.Send(Done(2, Reasoning("behind-barrier")));
                    await seen.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    context.Abort();
                }
                else
                    await context.Send(Completed(Commentary("recovered", "final_answer")));
            }
        );
        await using var owner = new Owner(
            peer.Uri,
            websocket,
            keep,
            observed: progress =>
            {
                if (progress.Parts?.Count == 3)
                    seen.TrySetResult();
            }
        );
        var deliveries = 0;
        owner.Entry.AssistantCommitted = _ =>
        {
            deliveries++;
            return Task.CompletedTask;
        };
        await owner.Run();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        var retry = peer.Requests[1].ToJsonString();
        Assert.Equal(keep, retry.Contains("encrypted-replay", StringComparison.Ordinal));
        Assert.DoesNotContain("behind-barrier", retry);
        Assert.Equal(1, deliveries); // reasoning has no channel presentation callback
        Assert.Equal(keep ? 3 : 2, owner.Visible.Count);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task Function_or_final_items_are_prefix_barriers_and_partial_tools_never_dispatch(
        bool websocket,
        bool final
    )
    {
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                if (number == 1)
                {
                    await context.Send(
                        Done(
                            0,
                            final
                                ? Commentary("not-a-prefix", "final_answer")
                                : new JsonObject
                                {
                                    ["type"] = "function_call",
                                    ["call_id"] = "never",
                                    ["name"] = "effect",
                                    ["arguments"] = "{}",
                                }
                        )
                    );
                    await context.Send(Done(1, Commentary("behind-barrier")));
                    context.Abort();
                }
                else
                    await context.Send(Completed(Commentary("safe", "final_answer")));
            }
        );
        await using var owner = new Owner(peer.Uri, websocket);
        await owner.Run();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.DoesNotContain("behind-barrier", peer.Requests[1].ToJsonString());
        Assert.Equal(0, owner.Tools.Count);
        Assert.Equal(2, owner.Visible.Count);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Failed_local_prefix_commit_is_not_a_provider_retry(bool websocket)
    {
        var sent = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, _) =>
            {
                await context.Send(Done(0, Commentary("cannot-save")));
                sent.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, context.Token);
            }
        );
        await using var owner = new Owner(peer.Uri, websocket, failCommit: true);
        await owner.Run().WaitAsync(TimeSpan.FromSeconds(5));
        await sent.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.IsType<ModelPreparationException>(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Single(peer.Requests);
        Assert.Equal(0, owner.Tools.Count);
        Assert.DoesNotContain(
            owner.Visible,
            row => row.ToJsonString().Contains("cannot-save", StringComparison.Ordinal)
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Completed_commentary_only_still_commits_the_empty_complete_suffix_and_usage_once(
        bool websocket
    )
    {
        var prefix = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, _) =>
            {
                await context.Send(Done(0, Commentary("only-commentary")));
                await prefix.Task.WaitAsync(TimeSpan.FromSeconds(5));
                await context.Send(Completed(Commentary("only-commentary")));
            }
        );
        await using var owner = new Owner(peer.Uri, websocket, priced: true);
        owner.Entry.AssistantCommitted = _ =>
        {
            prefix.TrySetResult();
            return Task.CompletedTask;
        };
        await owner.Run();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        var rows = owner.Visible;
        Assert.Equal(3, rows.Count);
        Assert.Empty(rows[2]["parts"]!.AsArray());
        Assert.True(rows[2]["__meta"]!["llmSegment"]!["complete"]!.GetValue<bool>());
        Assert.Equal(1, rows[2]["__meta"]!["llmSegment"]!["outputStart"]!.GetValue<int>());
        Assert.Equal(1, rows[2]["__meta"]!["llmSegment"]!["outputEndExclusive"]!.GetValue<int>());
        Assert.Equal(3, rows[2]["__meta"]!["usage"]!["outputTokens"]!.GetValue<long>());
        Assert.Null(rows[1]["__meta"]?["usage"]);
        Assert.Equal(
            0.000023,
            SessionCatalog.Number(rows[2]["__meta"]?["usage"]?["cost"])!.Value,
            10
        );
        Assert.Equal(
            0.000023,
            SessionCatalog
                .Number(owner.Entry.Snapshot().AuthorityEnvelope["stats"]?["totalCost"])!
                .Value,
            10
        );
    }

    [Fact]
    public async Task Interrupted_reasoning_is_not_retained_after_a_local_progress_callback_failure()
    {
        await using var peer = await StreamingModelPeer.StartAsync(
            false,
            async (context, number) =>
            {
                if (number == 1)
                {
                    await context.Send(Done(0, Reasoning()));
                    await context.Send(Done(1, Commentary("fail-progress")));
                }
                else
                    await context.Send(Completed(Commentary("retry-safe", "final_answer")));
            }
        );
        await using var owner = new Owner(peer.Uri, false, keep: true, failProgress: true);
        await owner.Run();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.DoesNotContain("encrypted-replay", peer.Requests[1].ToJsonString());
        Assert.Equal(2, owner.Visible.Count);
    }

    [Fact]
    public async Task Hosted_image_before_commentary_is_committed_as_a_reference_and_replayed_from_its_blob_after_failure()
    {
        const string png =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        var committed = new TaskCompletionSource<JsonObject>(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        await using var peer = await StreamingModelPeer.StartAsync(
            false,
            async (context, number) =>
            {
                if (number == 1)
                {
                    await context.Send(
                        Done(
                            0,
                            new JsonObject
                            {
                                ["type"] = "image_generation_call",
                                ["id"] = "hosted",
                                ["status"] = "completed",
                                ["output_format"] = "png",
                                ["result"] = png,
                            }
                        )
                    );
                    await context.Send(Done(1, Commentary("image-ready")));
                    var row = await committed.Task.WaitAsync(TimeSpan.FromSeconds(5));
                    Assert.NotNull(row["parts"]![0]!["inlineDataRef"]);
                    Assert.DoesNotContain(png, row.ToJsonString());
                    context.Abort();
                }
                else
                {
                    Assert.Equal(
                        png,
                        Assert.Single(
                            context.Request["input"]!.AsArray().OfType<JsonObject>(),
                            item => item["type"]?.GetValue<string>() == "image_generation_call"
                        )["result"]!.GetValue<string>()
                    );
                    await context.Send(Completed(Commentary("after-image", "final_answer")));
                }
            }
        );
        await using var owner = new Owner(peer.Uri, false, generated: true);
        owner.Entry.AssistantCommitted = row =>
        {
            committed.TrySetResult(row);
            return Task.CompletedTask;
        };
        await owner.Run();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(2, peer.Requests.Count);
        Assert.DoesNotContain(png, string.Concat(owner.Visible.Select(row => row.ToJsonString())));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task Failed_image_suffix_uses_the_attempt_image_success_not_prior_commentary(
        bool websocket,
        bool successfulImage
    )
    {
        const string png =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        var committed = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        static JsonObject Image(string id, string data) =>
            new()
            {
                ["type"] = "image_generation_call",
                ["id"] = id,
                ["status"] = "completed",
                ["output_format"] = "png",
                ["result"] = data,
            };
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, _) =>
            {
                var output = new List<JsonObject>();
                if (successfulImage)
                    output.Add(Image("first", png));
                output.Add(Commentary("Generating images now"));
                for (var i = 0; i < output.Count; i++)
                    await context.Send(Done(i, (JsonObject)output[i].DeepClone()));
                await committed.Task.WaitAsync(TimeSpan.FromSeconds(5));
                output.Add(Image("failed-suffix", "invalid-base64!"));
                await context.Send(Done(output.Count - 1, (JsonObject)output[^1].DeepClone()));
                await context.Send(Completed(output.ToArray()));
            }
        );
        await using var owner = new Owner(peer.Uri, websocket, generated: true);
        owner.Entry.AssistantCommitted = _ =>
        {
            committed.TrySetResult();
            return Task.CompletedTask;
        };
        await owner.Run();
        Assert.Single(peer.Requests); // A failed, possibly billed generation must never retry.
        var rows = (await owner.Store.LoadAsync("s"))!
            .History.Materialize()
            .Where(row => row["modelVisible"]?.GetValue<bool>() != false)
            .ToArray();
        var images = rows.SelectMany(row => row["parts"]!.AsArray())
            .Where(part => part?["inlineDataRef"] is not null)
            .ToArray();
        Assert.Equal(successfulImage ? 1 : 0, images.Length);
        Assert.DoesNotContain(png, string.Concat(rows.Select(row => row.ToJsonString())));
        if (successfulImage)
        {
            Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
            Assert.Equal(3, rows.Length);
            Assert.Contains("failed-suffix", rows[2].ToJsonString());
            Assert.Contains(
                "image generation did not produce a usable image",
                rows[2].ToJsonString()
            );
            Assert.DoesNotContain("inlineDataRef", rows[2].ToJsonString());
            Assert.Equal(
                3,
                owner.Entry.Snapshot().AuthorityEnvelope["stats"]![
                    "totalOutputTokens"
                ]!.GetValue<double>()
            );
            Assert.Equal(3, rows[2]["__meta"]!["usage"]!["outputTokens"]!.GetValue<long>());
        }
        else
        {
            Assert.Equal(2, rows.Length); // Retain commentary, not a false empty success.
            var journal = Assert.Single(await owner.Journal.ListAsync("s", null, null, null, 10));
            var restored = await owner.Journal.ReconstructAsync(
                journal!["requestId"]!.GetValue<string>()
            );
            Assert.Contains("failed-suffix", restored.ToJsonString());
            Assert.Contains("\"retryable\":false", restored.ToJsonString());
            Assert.Contains("\"countable\":false", restored.ToJsonString());
        }
    }

    private sealed class Owner : IAsyncDisposable
    {
        private readonly TempDirectory temp = new();
        private readonly HttpClient http = ProviderHttpRequest.CreateClient();
        private readonly ResponsesWsTransport transport = new(diagnostics: _ => { });
        internal readonly LlmRequestJournalStore Journal;
        internal readonly PersistentSessionAuthorityStore Store;
        internal readonly SessionOwner Hosted;
        internal SessionEntry Entry => Hosted.Entry;
        internal IReadOnlyList<JsonObject> Visible =>
            Hosted.History().Where(row => row["modelVisible"]?.GetValue<bool>() != false).ToArray();
        internal readonly Effects Tools = new();
        internal string RecentLogs => Path.Combine(temp.Path, "state", "logs", "recent");

        internal Owner(
            Uri uri,
            bool websocket,
            bool keep = false,
            bool failCommit = false,
            bool failProgress = false,
            bool generated = false,
            Action<ResponsesStreamProgress>? observed = null,
            bool diagnostics = false,
            bool priced = false
        )
        {
            var catalog = HostModels.Parse(
                new JsonObject
                {
                    ["default"] = "a/m",
                    ["providers"] = new JsonObject
                    {
                        ["a"] = new JsonObject
                        {
                            ["providerType"] = websocket ? "openai-ws" : "openai-responses",
                            ["baseUrl"] = uri.ToString(),
                            ["models"] = priced
                                ? new JsonArray(
                                    new JsonObject
                                    {
                                        ["id"] = "m",
                                        ["tokenPricesPerMillion"] = new JsonObject
                                        {
                                            ["cached"] = 1,
                                            ["input"] = 2,
                                            ["output"] = 3,
                                        },
                                    }
                                )
                                : new JsonArray("m"),
                            ["keepReasoningOnError"] = keep,
                            ["imageGeneration"] = new JsonObject { ["enabled"] = generated },
                        },
                    },
                },
                new JsonObject()
            );
            var defaults = new ResponsesClientOptions(uri, "m", "a/m", "", "", 713);
            Journal = new(temp.Path);
            Store = new(temp.Path, "s");
            Hosted = new("s", "main", catalog);
            var agents = new AgentCatalog(temp.Path, Path.Combine(temp.Path, "work"));
            var requests = new ModelRequestOwner(
                http,
                defaults,
                new ModelRouting(),
                (_, _) => Task.CompletedTask,
                transport,
                images: Store.Images,
                journal: Journal,
                diagnostics: diagnostics ? new(temp.Path) : null
            );
            var chat = new RequestChatService(
                new SessionChatService(
                    requests,
                    defaults,
                    Hosted,
                    catalog,
                    new AgentMemory(agents, new Skills(agents, Path.Combine(temp.Path, "skills"))),
                    (_, update) =>
                    {
                        Hosted.PublishDraftProgress(update);
                        observed?.Invoke(update);
                        if (
                            failProgress
                            && update.Text.Contains("fail-progress", StringComparison.Ordinal)
                        )
                            throw new InvalidOperationException("owned progress callback failure");
                    }
                ),
                Hosted
            );
            Hosted.Registry = new SessionRegistry(
                failCommit ? new FailedPrefixStore(Store) : Store,
                chat,
                Tools
            );
            Hosted.Registry.TriggerOverride = _ => Task.CompletedTask;
            Hosted.Registry.Add("s");
            Hosted.EnableCommittedNotifications();
            Entry.State.AuthorityEnvelope["persistentMemorySnapshot"] =
                ConditionalMemory.BuildCurrentModelSnapshot("a/m", "prompt");
        }

        internal async Task Run(string text = "input")
        {
            await Hosted.Registry.Ingress.EnqueueAsync("s", QueueItem.UserText(text));
            await Hosted.Registry.Runner.ProcessQueueAsync("s");
        }

        public async ValueTask DisposeAsync()
        {
            await transport.DisposeAsync();
            await Journal.DisposeAsync();
            http.Dispose();
            temp.Dispose();
        }
    }

    private sealed class FailedPrefixStore(PersistentSessionAuthorityStore inner)
        : ISessionAuthorityStore,
            ICanonicalAppendAuthorityStore
    {
        public Task CommitAsync(
            SessionSnapshot snapshot,
            SaveKind kind,
            CancellationToken token = default
        ) => inner.CommitAsync(snapshot, kind, token);

        public Task<SessionSnapshot?> LoadAsync(string id, CancellationToken token = default) =>
            inner.LoadAsync(id, token);

        public Task CommitCanonicalAppendAsync(
            SessionSnapshot snapshot,
            IReadOnlyList<JsonObject> rows,
            CancellationToken token = default
        ) =>
            rows.Any(row => row["__meta"]?["llmSegment"]?["complete"]?.GetValue<bool>() == false)
                ? Task.FromException(new IOException("owned prefix failure"))
                : inner.CommitCanonicalAppendAsync(snapshot, rows, token);
    }

    private sealed class Effects : ITurnToolExecutor
    {
        internal int Count;

        public Task<JsonNode?> ExecuteAsync(JsonObject call, CancellationToken token)
        {
            Count++;
            return Task.FromResult<JsonNode?>(new JsonObject());
        }
    }
}
