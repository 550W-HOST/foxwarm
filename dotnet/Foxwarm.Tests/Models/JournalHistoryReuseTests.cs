using System.Net;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests.Models;

public sealed class JournalHistoryReuseTests
{
    [Fact]
    public async Task Normal_turn_path_reuses_immutable_records_after_real_append_and_captures_its_own_input()
    {
        using var temp = new TempDirectory();
        await using var journal = new LlmRequestJournalStore(temp.Path);
        using var http = new HttpClient(new Handler());
        var models = Catalog();
        var requests = Owner(http, journal);
        var hosted = new SessionOwner("s", "main", models);
        var agents = new AgentCatalog(temp.Path, Path.Combine(temp.Path, "work"));
        var chat = new SessionChatService(
            requests,
            Defaults(),
            hosted,
            models,
            new AgentMemory(agents, new Skills(agents, Path.Combine(temp.Path, "skills"))),
            (_, _) => { }
        );
        var wrapped = new RequestChatService(chat, hosted);
        var store = new InMemorySessionAuthorityStore();
        hosted.Registry = new SessionRegistry(store, wrapped);
        var entry = hosted.Registry.Add("s");
        entry.State.AuthorityEnvelope["persistentMemorySnapshot"] =
            ConditionalMemory.BuildCurrentModelSnapshot("a/m", "prompt");
        var initial = SessionHistory.FromJson([User("captured")]);
        entry.State.History.Reset(initial);
        var host = new LocalSessionTurnHost(entry, store, wrapped);
        await host.ChatAsync("turn-one");
        var prepared = Cached(initial[0]);
        Assert.NotNull(prepared);
        Assert.Equal(2, entry.Snapshot().History.Count);
        await host.ChatAsync("turn-two");
        Assert.Same(prepared, Cached(initial[0]));
        Assert.NotNull(Cached(entry.Snapshot().History[1]));

        // An older captured request must not acquire provenance from today's live owner state.
        entry.State.History.Clear();
        entry.State.History.Add(User("new live history"));
        var result = await chat.ChatAsync("s", initial, _ => Task.FromResult(false), default);
        var restored = await journal.ReconstructAsync(result.JournalRequestId!);
        Assert.Equal(
            "captured",
            restored["messages"]![0]!["parts"]![0]!["text"]!.GetValue<string>()
        );
        Assert.Single(restored["messages"]!.AsArray());
        Assert.Same(prepared, Cached(initial[0]));
    }

    [Fact]
    public async Task Current_repair_visibility_replacements_pruning_fork_and_clear_match_uncached_manifests()
    {
        using var temp = new TempDirectory();
        await using var journal = new LlmRequestJournalStore(temp.Path);
        using var http = new HttpClient(new Handler());
        var owner = Owner(http, journal);
        var user = HistoryMessage.FromJson(User("NBSP\u00a0😀"));
        var callJson = JsonNode
            .Parse(
                """
                {"role":"model","parts":[{"functionCall":{"id":"one","name":"read","args":{"10":1e-7,"2":-0}}}],"__meta":{"modelId":"a/m","seq":3},"compaction":{"diagnostic":true}}
                """
            )!
            .AsObject();
        var call = HistoryMessage.FromJson(callJson);
        var outputJson = JsonNode
            .Parse(
                """
                {"role":"tool","parts":[{"functionResponse":{"tool_use_id":"one","name":"read","response":{"output":"done"},"__meta":{"toolScriptSubCalls":[]}}}],"__meta":{"seq":4}}
                """
            )!
            .AsObject();
        var output = HistoryMessage.FromJson(outputJson);
        var hiddenJson = (JsonObject)outputJson.DeepClone();
        hiddenJson["modelVisible"] = false;
        var missing = SessionHistory.FromMessages([
            user,
            call,
            HistoryMessage.FromJson(hiddenJson),
        ]);
        var paired = SessionHistory.FromMessages([user, call, output]);
        var hiddenCall = (JsonObject)callJson.DeepClone();
        hiddenCall["modelVisible"] = false;
        var replacement = (JsonObject)callJson.DeepClone();
        replacement["parts"]![0]!["functionCall"]!["args"]!["changed"] = true;
        replacement["__meta"]!["modelId"] = "b/m";
        var replaced = HistoryMessage.FromJson(replacement);
        var histories = new[]
        {
            missing,
            paired,
            paired.AppendJson([User("appended")]),
            SessionHistory.FromMessages([user, HistoryMessage.FromJson(hiddenCall), output]),
            SessionHistory.FromMessages([user, call]), // pruned response needs a fresh synthetic row
            SessionHistory.FromMessages([user, replaced, output]),
            SessionHistory.FromMessages([user, output]), // compacted call leaves an orphan output
            SessionHistory.FromMessages(paired), // fork shares the same immutable records
            SessionHistory.Empty,
            paired, // clear does not retire a still-live fork/snapshot
        };
        LlmRequestJournalStore.PreparedObject? first = null;
        foreach (var history in histories)
        {
            var captured = RequestHistory.FromSnapshot(history);
            var result = await owner.RequestAsync(
                "s",
                owner.Capture(Catalog(), "a/m", null),
                "cache",
                "turn",
                captured,
                (_, _) => Task.FromResult("prompt"),
                null,
                null,
                null,
                null,
                default,
                ModelRequestScope.Canonical
            );
            var repaired = RequestHistoryRepair.SelectAndRepair(captured);
            var prepared = LlmRequestJournalStore.PrepareMessages(repaired);
            var uncached = LlmRequestJournalStore.PrepareMessages(
                RequestHistoryRepair.SelectAndRepair(
                    RequestHistory.FromMutable(history.Materialize())
                )
            );
            Assert.Equal(
                uncached.Select(row => (row.Id, row.Payload)),
                prepared.Select(row => (row.Id, row.Payload))
            );
            var restored = await journal.ReconstructAsync(result.JournalRequestId!);
            Assert.Equal(
                prepared.Select(row => row.Payload),
                restored["messages"]!
                    .AsArray()
                    .Select(row => LlmRequestJournalStore.EncodeCli(row!))
            );
            if (history.Count > 0)
            {
                first ??= prepared[0];
                Assert.Same(first, prepared[0]);
            }
        }
        Assert.NotSame(Cached(call), Cached(replaced));
        Assert.Null(Cached(missing[2])); // hidden records never acquire prepared payloads
        Assert.DoesNotContain("compaction", Cached(call)!.Payload);
        Assert.DoesNotContain("__meta", Cached(output)!.Payload);
        Assert.Equal(
            "done",
            JsonNode.Parse(Cached(output)!.Payload)!["parts"]![0]!["functionResponse"]![
                "response"
            ]!["output"]!.GetValue<string>()
        );
    }

    [Fact]
    public async Task Retry_reuses_neutral_records_but_current_reminders_start_the_correct_manifest_across_models()
    {
        using var temp = new TempDirectory();
        await using var journal = new LlmRequestJournalStore(temp.Path);
        var handler = new Handler(failures: 2);
        using var http = new HttpClient(handler);
        var owner = Owner(http, journal);
        var model = JsonNode
            .Parse(
                """
                {"role":"model","parts":[{"text":"answer","thinking":"private thought","providerMeta":{"signature":"signed"}}],"__meta":{"modelId":"a/m"}}
                """
            )!
            .AsObject();
        var snapshot = SessionHistory.FromJson([User("seed"), model]);
        var contexts = 0;
        var ids = new List<string>();
        await owner.RequestAsync(
            "s",
            owner.Capture(Catalog(), "route", null),
            "cache",
            "turn",
            RequestHistory.FromSnapshot(snapshot),
            (_, _) => Task.FromResult("prompt"),
            null,
            null,
            null,
            null,
            default,
            ModelRequestScope.Canonical,
            prepareRetry: _ => Task.FromResult<RequestHistory?>(null),
            journalRequestStarted: ids.Add,
            requestContext: () =>
                Task.FromResult<IReadOnlyList<JsonObject>>([
                    User(++contexts < 3 ? "reminder-one" : "reminder-two"),
                ])
        );
        Assert.Equal(3, contexts);
        Assert.Equal(ids[0], ids[1]);
        Assert.NotEqual(ids[1], ids[2]);
        var original = await journal.ReconstructAsync(ids[0]);
        var changed = await journal.ReconstructAsync(ids[2]);
        Assert.Equal(2, original["attempts"]!.AsArray().Count);
        Assert.Single(changed["attempts"]!.AsArray());
        Assert.Equal(
            "reminder-one",
            original["messages"]![2]!["parts"]![0]!["text"]!.GetValue<string>()
        );
        Assert.Equal(
            "reminder-two",
            changed["messages"]![2]!["parts"]![0]!["text"]!.GetValue<string>()
        );
        Assert.Equal(
            LlmRequestJournalStore.EncodeCli(original["messages"]![1]!),
            LlmRequestJournalStore.EncodeCli(changed["messages"]![1]!)
        );
        Assert.Contains("signed", Cached(snapshot[1])!.Payload);
        Assert.EndsWith("/a/v1/messages", handler.Paths[0]);
        Assert.EndsWith("/b/v1/messages", handler.Paths[2]);
        Assert.Contains("signed", handler.Bodies[0]);
        Assert.DoesNotContain("signed", handler.Bodies[2]);
    }

    [Fact]
    public async Task Direct_mutable_callers_observe_current_rows_and_schemas_without_reuse()
    {
        using var temp = new TempDirectory();
        await using var journal = new LlmRequestJournalStore(temp.Path);
        using var http = new HttpClient(new Handler());
        var owner = Owner(http, journal);
        var history = new[] { User("before") };
        var tools = JsonNode
            .Parse("""[{"name":"before","parameters":{"type":"object"}}]""")!
            .AsArray();
        async Task<JsonObject> Send()
        {
            var result = await owner.RequestAsync(
                "s",
                Catalog(),
                "a/m",
                null,
                "cache",
                "turn",
                history,
                (_, _) => Task.FromResult("prompt"),
                null,
                null,
                null,
                null,
                default,
                definitions: () => tools
            );
            return await journal.ReconstructAsync(result.JournalRequestId!);
        }
        var first = await Send();
        history[0]["parts"]![0]!["text"] = "after";
        tools[0]!["name"] = "after";
        var second = await Send();
        Assert.Contains("before", first["messages"]!.ToJsonString());
        Assert.Contains("after", second["messages"]!.ToJsonString());
        Assert.Contains("before", first["toolDefinitions"]!.ToJsonString());
        Assert.Contains("after", second["toolDefinitions"]!.ToJsonString());
        var input = RequestHistory.FromMutable(history);
        Assert.NotSame(
            LlmRequestJournalStore.PrepareMessages(input)[0],
            LlmRequestJournalStore.PrepareMessages(input)[0]
        );
    }

    [Fact]
    public void Prepared_payload_does_not_keep_retired_records_alive()
    {
        var retired = PrepareRetired();
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        Assert.False(retired.IsAlive);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static WeakReference PrepareRetired()
    {
        var history = SessionHistory.FromJson([User(new string('x', 10000))]);
        _ = LlmRequestJournalStore.PrepareMessages(RequestHistory.FromSnapshot(history));
        return new WeakReference(history[0]);
    }

    private static LlmRequestJournalStore.PreparedObject? Cached(HistoryMessage message)
    {
        var table =
            (ConditionalWeakTable<HistoryMessage, LlmRequestJournalStore.PreparedObject>)
                typeof(LlmRequestJournalStore)
                    .GetField("preparedHistory", BindingFlags.NonPublic | BindingFlags.Static)!
                    .GetValue(null)!;
        return table.TryGetValue(message, out var prepared) ? prepared : null;
    }

    private static JsonObject User(string text) =>
        new() { ["role"] = "user", ["parts"] = new JsonArray(new JsonObject { ["text"] = text }) };

    private static ResponsesClientOptions Defaults() =>
        new(new Uri("http://localhost"), "m", "a/m", "token", "", 50);

    private static ModelRequestOwner Owner(HttpClient http, LlmRequestJournalStore journal) =>
        new(http, Defaults(), new ModelRouting(), (_, _) => Task.CompletedTask, journal: journal);

    private static HostModels Catalog() =>
        HostModels.Parse(
            JsonNode
                .Parse(
                    """
                    {"default":"a/m","providers":{"a":{"providerType":"anthropic","baseUrl":"http://localhost/a","apiKey":"token","models":["m"],"extraFields":{"stream":false}},"b":{"providerType":"anthropic","baseUrl":"http://localhost/b","apiKey":"token","models":["m"],"extraFields":{"stream":false}},"route":{"providerType":"failover","targets":["a/m","b/m"],"failureThreshold":2}}}
                    """
                )!
                .AsObject(),
            new JsonObject()
        );

    private sealed class Handler(int failures = 0) : HttpMessageHandler
    {
        internal List<string> Bodies { get; } = [];
        internal List<string> Paths { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        )
        {
            Paths.Add(request.RequestUri!.AbsolutePath);
            Bodies.Add(await request.Content!.ReadAsStringAsync(cancellationToken));
            var fail = Bodies.Count <= failures;
            return new HttpResponseMessage(
                fail ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK
            )
            {
                Content = new StringContent(
                    fail ? "unavailable" : "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}"
                ),
            };
        }
    }
}
