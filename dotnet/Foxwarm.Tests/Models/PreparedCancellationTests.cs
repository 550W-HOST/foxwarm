using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Models;

public sealed class PreparedCancellationTests(Xunit.Abstractions.ITestOutputHelper output)
{
    [Fact]
    public async Task Stop_after_retry_payload_is_complete_keeps_start_and_abort_without_another_send()
    {
        using var temp = new TempDirectory();
        await using var journal = new LlmRequestJournalStore(temp.Path);
        using var cancel = new CancellationTokenSource();
        var sends = 0;
        using var http = new HttpClient(new Handler(() => ++sends));
        var warnings = new List<Exception>();
        var retries = new List<ModelRetryEvent>();
        var completedPayload = false;
        var owner = Owner(http, journal);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => owner.RequestAsync(
            "s", Catalog(), "a/m", null, "cache", "turn", History(),
            (_, _) => Task.FromResult("prompt"),
            value => { retries.Add(value); return Task.FromResult(false); },
            null, null, warnings.Add, cancel.Token, ModelRequestScope.Canonical,
            prepareRetry: _ =>
            {
                // The failure result is already durable. The next writer command is the
                // serializer's attempt start, admitted only after its complete body exists.
                journal.Writer.BeforeBatch = () =>
                {
                    journal.Writer.BeforeBatch = null;
                    completedPayload = true;
                    cancel.Cancel();
                    return Task.CompletedTask;
                };
                return Task.FromResult<IReadOnlyList<JsonObject>?>(null);
            }));
        var restored = await Reconstruct(journal);
        output.WriteLine($"payload-queued: sends={sends}, retries={retries.Count}, warnings={warnings.Count}, outcomes={string.Join(',', restored["attempts"]!.AsArray().Select(row => row!["result"]?["outcome"]?.GetValue<string>()))}");
        Assert.True(completedPayload);
        Assert.Equal(1, sends);
        Assert.Single(retries);
        Assert.Empty(warnings);
        Assert.Equal("complete", restored["completeness"]!.GetValue<string>());
        var attempts = restored["attempts"]!.AsArray();
        Assert.Equal(new[] { "failure", "abort" }, attempts.Select(row => row!["result"]!["outcome"]!.GetValue<string>()));
        Assert.Equal(new[] { 1, 2 }, attempts.Select(row => row!["start"]!["attempt"]!.GetValue<int>()));
        Assert.Equal(attempts[0]!["start"]!["semanticPayloadSha256"]!.GetValue<string>(), attempts[1]!["start"]!["semanticPayloadSha256"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("payload", 1, true)]
    [InlineData("attempt", 2, true)]
    [InlineData("draft", 1, false)]
    [InlineData("notification-error", 2, false)]
    [InlineData("serialization-error", 1, false)]
    [InlineData("fallback-draft", 2, true)]
    public async Task Normal_owner_distinguishes_preparation_complete_payload_and_notice_cancellation(
        string boundary, int expectedNotices, bool expectedAbort)
    {
        using var temp = new TempDirectory();
        await using var journal = new LlmRequestJournalStore(temp.Path);
        using var cancel = new CancellationTokenSource();
        var sends = 0;
        using var http = new HttpClient(new Handler(() => ++sends));
        var models = Catalog();
        var hosted = new SessionOwner("s", "main", models);
        var agents = new AgentCatalog(temp.Path, Path.Combine(temp.Path, "work"));
        var resets = 0;
        var notices = 0;
        var serializedRetry = false;
        var localError = new IOException("Local attempt notification failed.");
        var converter = new BoundaryConverter(() =>
        {
            // Neutral schema encoding happens before BeginDraft. The next clone is
            // inside the real concrete serializer, not prompt/hydration preparation.
            if (resets == 2)
            {
                serializedRetry = true;
                if (boundary == "serialization-error") throw localError;
                cancel.Cancel();
            }
        });
        var jsonOptions = new JsonSerializerOptions { TypeInfoResolver = new System.Text.Json.Serialization.Metadata.DefaultJsonTypeInfoResolver() };
        jsonOptions.Converters.Add(converter);
        JsonArray? tools = null;
        JsonArray Definitions() => tools = [new JsonObject
        {
            ["name"] = "example", ["description"] = "Fixture tool.",
            ["parameters"] = new JsonObject
            {
                ["type"] = "object",
                ["additionalProperties"] = true,
            },
        }];
        var chat = new SessionChatService(Owner(http, journal), Defaults(), hosted, models,
            new AgentMemory(agents, new Skills(agents, Path.Combine(temp.Path, "skills"))),
            (_, _) => { }, Definitions);
        var wrapped = new RequestChatService(chat, hosted);
        var store = new InMemorySessionAuthorityStore();
        hosted.Registry = new SessionRegistry(store, wrapped);
        var entry = hosted.Registry.Add("s");
        entry.State.AuthorityEnvelope["persistentMemorySnapshot"] =
            ConditionalMemory.BuildCurrentModelSnapshot("a/m", "prompt");
        var snapshot = SessionHistory.FromJson(History());
        entry.State.History.Reset(snapshot);
        var turnHost = new LocalSessionTurnHost(entry, store, wrapped);
        Assert.True(await turnHost.TryClaimBusyAsync());
        hosted.Changed += value =>
        {
            if (value.Kind == SessionEventKind.ModelStream && value.Data?["type"]?.GetValue<string>() == "model-stream-reset")
            {
                resets++;
                if (resets == 2 && boundary is "payload" or "serialization-error")
                    // Neutral tools are already encoded. Inject a serializer barrier that
                    // clones to the identical JSON value while cancelling the outer caller.
                    tools![0]!["parameters"]!["additionalProperties"] = JsonValue.Create(new BoundaryValue(),
                        (System.Text.Json.Serialization.Metadata.JsonTypeInfo<BoundaryValue>)jsonOptions.GetTypeInfo(typeof(BoundaryValue)));
                if (resets == 2 && boundary == "draft" || resets == 3 && boundary == "fallback-draft") cancel.Cancel();
            }
            var runtime = hosted.RuntimeSnapshot();
            if (value.Kind == SessionEventKind.StateChanged && runtime["active"]?["phase"]?.GetValue<string>() == "normal-turn" && runtime["retry"] is null)
            {
                notices++;
                if (notices == 2 && boundary == "attempt") cancel.Cancel();
                if (notices == 2 && boundary == "notification-error") throw localError;
            }
        };
        var error = await Record.ExceptionAsync(() => boundary == "fallback-draft"
            ? chat.ChatAsync("s", History(), cancel.Token)
            : chat.ChatAsync("s", snapshot, _ => Task.FromResult(false), cancel.Token));
        var restored = await Reconstruct(journal);
        output.WriteLine($"{boundary}: sends={sends}, resets={resets}, active={notices}, warnings={entry.BestEffortFailureCount}, outcomes={string.Join(',', restored["attempts"]!.AsArray().Select(row => row!["result"]?["outcome"]?.GetValue<string>()))}");
        if (boundary is "notification-error" or "serialization-error") Assert.Same(localError, Assert.IsType<ModelPreparationException>(error).InnerException);
        else Assert.IsAssignableFrom<OperationCanceledException>(error);
        Assert.Equal(1, sends);
        Assert.Equal(boundary == "fallback-draft" ? 3 : 2, resets);
        Assert.Equal(expectedNotices, notices);
        Assert.Equal(boundary is "payload" or "serialization-error", serializedRetry);
        Assert.Equal(0, entry.BestEffortFailureCount);
        Assert.Same(snapshot[0], entry.Snapshot().History[0]);
        Assert.Equal("hello", snapshot[0].ToJson()["parts"]![0]!["text"]!.GetValue<string>());
        var attempts = restored["attempts"]!.AsArray();
        Assert.Equal(expectedAbort ? new[] { "failure", "abort" } : new[] { "failure" },
            attempts.Select(row => row!["result"]!["outcome"]!.GetValue<string>()));
        if (expectedAbort)
            Assert.Equal(attempts[0]!["start"]!["semanticPayloadSha256"]!.GetValue<string>(), attempts[1]!["start"]!["semanticPayloadSha256"]!.GetValue<string>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Cancellation_before_complete_preparation_never_records_an_attempt(bool afterManifest)
    {
        using var temp = new TempDirectory();
        await using var journal = new LlmRequestJournalStore(temp.Path);
        using var cancel = new CancellationTokenSource();
        var sends = 0;
        var notices = 0;
        using var http = new HttpClient(new Handler(() => ++sends));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Owner(http, journal).RequestAsync(
            "s", Catalog(), "a/m", null, "cache", "turn", History(),
            (_, _) => { if (!afterManifest) cancel.Cancel(); return Task.FromResult("prompt"); },
            null, () => notices++, null, null, cancel.Token,
            journalRequestStarted: _ => cancel.Cancel()));
        Assert.Equal(0, sends);
        Assert.Equal(0, notices);
        var rows = await journal.ListAsync("s", null, null, null, 10);
        if (!afterManifest) Assert.Empty(rows);
        else Assert.Empty((await Reconstruct(journal))["attempts"]!.AsArray());
    }

    [Fact]
    public async Task Real_toolscript_one_shot_preserves_prepared_abort_and_does_not_publish_normal_notices()
    {
        using var temp = new TempDirectory();
        using var cancel = new CancellationTokenSource();
        SessionManager? manager = null;
        var completedPayload = false;
        await using var peer = new ScriptedResponsesSequenceServer(1, async (_, stream, _) =>
        {
            manager!.Journal.Writer.BeforeBatch = () =>
            {
                // The first command after this provider response is its failure result.
                // The next batch is the fully serialized retry's attempt start.
                manager.Journal.Writer.BeforeBatch = () =>
                {
                    manager.Journal.Writer.BeforeBatch = null;
                    completedPayload = true;
                    cancel.Cancel();
                    return Task.CompletedTask;
                };
                return Task.CompletedTask;
            };
            await LoopbackResponsesServer.WriteResponseAsync(stream, 503, "application/json",
                System.Text.Encoding.UTF8.GetBytes("unavailable"));
        });
        var catalog = HostModels.Parse(new JsonObject
        {
            ["default"] = "a/m", ["providers"] = new JsonObject
            {
                ["a"] = new JsonObject { ["providerType"] = "anthropic", ["baseUrl"] = peer.BaseUri.ToString(),
                    ["models"] = new JsonArray("m"), ["extraFields"] = new JsonObject { ["stream"] = false } },
            },
        }, new JsonObject());
        await using var ownedManager = manager = new SessionManager(Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"), Defaults(), catalog);
        await manager.LoadMainHostAsync();
        var hosted = await manager.CreateNamedAsync("main", "one-shot", null, null);
        hosted.Registry.TriggerOverride = _ => Task.CompletedTask;
        var events = new List<SessionRuntimeEvent>();
        hosted.Changed += events.Add;
        var history = hosted.History().Select(row => row.ToJsonString()).ToArray();
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => manager.RequestToolScriptModelAsync(
                hosted, "hello", null, new Foxwarm.ToolScript.ToolScriptDataBudget(), cancel.Token));
            Assert.True(completedPayload);
            Assert.Equal(1, peer.RequestCount);
            Assert.Equal(0, hosted.Entry.BestEffortFailureCount);
            Assert.Equal(history, hosted.History().Select(row => row.ToJsonString()));
            Assert.DoesNotContain(events, value => value.Kind is SessionEventKind.ModelStream);
            var row = Assert.Single(await manager.Journal.ListAsync(hosted.Id, "toolscript-one-shot", null, null, 10));
            var restored = await manager.Journal.ReconstructAsync(row!["requestId"]!.GetValue<string>());
            Assert.Equal("complete", restored["completeness"]!.GetValue<string>());
            Assert.Equal(new[] { "failure", "abort" }, restored["attempts"]!.AsArray()
                .Select(item => item!["result"]!["outcome"]!.GetValue<string>()));
        }
        finally { await manager.ShutdownAsync(); }
    }

    private sealed record BoundaryValue;

    private sealed class BoundaryConverter(Action clone) : JsonConverter<BoundaryValue>
    {
        public override BoundaryValue Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) => throw new NotSupportedException();
        public override void Write(Utf8JsonWriter writer, BoundaryValue value, JsonSerializerOptions options)
        {
            clone();
            writer.WriteBooleanValue(true);
        }
    }

    private static async Task<JsonObject> Reconstruct(LlmRequestJournalStore journal)
    {
        var row = Assert.Single(await journal.ListAsync("s", null, null, null, 10));
        return await journal.ReconstructAsync(row!["requestId"]!.GetValue<string>());
    }

    private static ResponsesClientOptions Defaults() => new(new Uri("http://localhost"), "m", "a/m", "", "", 50);

    private static ModelRequestOwner Owner(HttpClient http, LlmRequestJournalStore journal) =>
        new(http, Defaults(), new ModelRouting(), (_, _) => Task.CompletedTask, journal: journal);

    private static IReadOnlyList<JsonObject> History() => [new JsonObject { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = "hello" }) }];

    private static HostModels Catalog() => HostModels.Parse(JsonNode.Parse("""
        {"default":"a/m","providers":{"a":{"providerType":"anthropic","extraFields":{"stream":false},"baseUrl":"http://localhost","models":["m"]}}}
        """)!.AsObject(), new JsonObject());

    private sealed class Handler(Func<int> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            send();
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = new StringContent("unavailable") });
        }
    }
}
