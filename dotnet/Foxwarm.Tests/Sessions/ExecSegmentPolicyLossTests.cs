using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

// A trusted policy-unavailable fatal in a parallel exec segment: siblings that start after the
// fatal is latched are skipped without starting; a sibling that already started settles with its
// own result. Driven through the actual turn scheduler with held calls, so the interleaving is
// fixed rather than timed.
public sealed class ExecSegmentPolicyLossTests
{
    private static readonly TimeSpan Deadline = TimeSpan.FromSeconds(5);

    private static TaskCompletionSource Signal() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    // held1-held4 fill the four slots; `fatal` is the fifth call and fails authorization with the
    // trusted fatal when released; `queued` is the sixth; `later` is a serial call after the segment.
    private static readonly string[] Held = ["held1", "held2", "held3", "held4"];

    private static JsonObject Call(string id, string name = "exec") =>
        new()
        {
            ["id"] = id,
            ["name"] = name,
            ["args"] = new JsonObject { ["command"] = id },
        };

    private sealed class BatchChat : IChatService
    {
        internal int Invocations;

        public Task<ChatResult> ChatAsync(
            string id,
            IReadOnlyList<JsonObject> history,
            CancellationToken token
        )
        {
            Invocations++;
            string[] parallel = [.. Held, "fatal", "queued"];
            var calls = parallel.Select(call => Call(call)).Append(Call("later", "write"));
            return Task.FromResult(
                new ChatResult(
                    new JsonObject
                    {
                        ["role"] = "model",
                        ["parts"] = new JsonArray(
                            calls
                                .Select(call => (JsonNode)new JsonObject { ["functionCall"] = call })
                                .ToArray()
                        ),
                    }
                )
            );
        }
    }

    // A held call waits for its release; any other call completes at once. `fatal` stands for a
    // call whose authorization reads an unavailable policy: released, it latches the fatal and
    // returns it, as SessionToolExecutor does.
    private sealed class HeldTools(IReadOnlySet<string> held) : ITurnToolExecutor, ITurnToolControl
    {
        private int latched;
        internal readonly ConcurrentDictionary<string, TaskCompletionSource> Started = new(),
            Release = new();
        internal readonly ConcurrentDictionary<string, int> Invocations = new();
        internal readonly TaskCompletionSource Latched = Signal();

        internal TaskCompletionSource Of(
            ConcurrentDictionary<string, TaskCompletionSource> signals,
            string id
        ) => signals.GetOrAdd(id, _ => Signal());

        public bool PolicyUnavailable => Volatile.Read(ref latched) != 0;

        public void BeginTurn() { }

        public bool ConsumeFinishAfterBatch() => false;

        public Task<TurnBatchEnding> CompleteBatchAsync(JsonObject toolMessage, bool stopping) =>
            PolicyUnavailable
                ? throw new ToolAuthorizationUnavailableException()
                : Task.FromResult(TurnBatchEnding.Continue);

        public async Task<JsonNode?> ExecuteAsync(JsonObject call, CancellationToken token)
        {
            var id = SessionWait.Text(call["id"])!;
            Invocations.AddOrUpdate(id, 1, (_, count) => count + 1);
            Of(Started, id).TrySetResult();
            if (held.Contains(id))
                await Of(Release, id).Task.WaitAsync(token);
            if (id != "fatal")
                return new JsonObject { ["output"] = "ran " + id };
            Interlocked.Exchange(ref latched, 1);
            Latched.TrySetResult();
            return UnsupportedTurnToolExecutor.ToolError(
                ToolAuthorizationUnavailableException.Code,
                "policy unavailable"
            );
        }
    }

    private static async Task<(
        HeldTools Tools,
        InMemorySessionAuthorityStore Store,
        BatchChat Chat,
        Task Processing,
        SessionEntry Entry
    )> StartAsync(params string[] alsoHeld)
    {
        var tools = new HeldTools(new HashSet<string>([.. Held, "fatal", .. alsoHeld]));
        var chat = new BatchChat();
        var store = new InMemorySessionAuthorityStore();
        var registry = new SessionRegistry(store, chat, tools);
        registry.TriggerOverride = _ => Task.CompletedTask;
        var entry = registry.Add("s");
        await registry.Ingress.EnqueueAsync("s", QueueItem.UserText("batch"));
        var processing = registry.Runner.ProcessQueueAsync("s");
        foreach (var id in Held)
            await tools.Of(tools.Started, id).Task.WaitAsync(Deadline);
        Assert.False(tools.Started.ContainsKey("fatal"));
        return (tools, store, chat, processing, entry);
    }

    private static async Task<Dictionary<string, JsonObject>> ResponsesAsync(
        InMemorySessionAuthorityStore store
    )
    {
        var rows = (await store.LoadAsync("s"))!.History.Materialize();
        var tool = Assert.Single(rows, row => row["role"]?.GetValue<string>() == "tool");
        var responses = tool["parts"]!
            .AsArray()
            .Select(part => part!["functionResponse"]!.AsObject())
            .ToArray();
        Assert.Equal(
            [.. Held, "fatal", "queued", "later"],
            responses.Select(response => SessionWait.Text(response["tool_use_id"])!)
        );
        return responses.ToDictionary(
            response => SessionWait.Text(response["tool_use_id"])!,
            response => response["response"]!.AsObject()
        );
    }

    private static string? ErrorType(JsonObject response) =>
        SessionWait.Text(response["error"]?["type"]);

    [Fact]
    public async Task Siblings_dequeued_after_the_fatal_is_latched_are_skipped_without_starting()
    {
        var (tools, store, chat, processing, entry) = await StartAsync();
        // The freed slot takes the fifth call, never the sixth.
        tools.Of(tools.Release, "held4").SetResult();
        await tools.Of(tools.Started, "fatal").Task.WaitAsync(Deadline);
        Assert.False(tools.Started.ContainsKey("queued"));
        tools.Of(tools.Release, "fatal").SetResult();
        await tools.Latched.Task.WaitAsync(Deadline);
        foreach (var id in Held[..3])
            tools.Of(tools.Release, id).SetResult();
        await processing.WaitAsync(Deadline);

        Assert.False(tools.Invocations.ContainsKey("queued"));
        Assert.False(tools.Invocations.ContainsKey("later"));
        var responses = await ResponsesAsync(store);
        foreach (var id in Held)
            Assert.Equal("ran " + id, SessionWait.Text(responses[id]["output"]));
        Assert.Equal(ToolAuthorizationUnavailableException.Code, ErrorType(responses["fatal"]));
        Assert.Equal("tool_call_skipped", ErrorType(responses["queued"]));
        Assert.Equal("tool_call_skipped", ErrorType(responses["later"]));
        Assert.Equal(1, chat.Invocations);
        Assert.Equal(1, entry.BackgroundProcessorFailureCount);
    }

    // The CI interleaving of mainHostExecParallel's policy-loss phase: a held sibling finishes
    // while the fatal call is still authorizing, so its worker dequeues the sixth call before the
    // fatal is known. That call has started and settles with its own result (in the product, its
    // own authorization reads the same unavailable policy); calls after the fatal are skipped.
    [Fact]
    public async Task A_sibling_dequeued_while_the_fatal_call_is_authorizing_has_started_and_settles()
    {
        var (tools, store, chat, processing, entry) = await StartAsync("queued");
        tools.Of(tools.Release, "held4").SetResult();
        await tools.Of(tools.Started, "fatal").Task.WaitAsync(Deadline);
        tools.Of(tools.Release, "held1").SetResult();
        await tools.Of(tools.Started, "queued").Task.WaitAsync(Deadline);
        tools.Of(tools.Release, "fatal").SetResult();
        await tools.Latched.Task.WaitAsync(Deadline);
        foreach (var id in new[] { "queued", "held2", "held3" })
            tools.Of(tools.Release, id).SetResult();
        await processing.WaitAsync(Deadline);

        Assert.Equal(1, tools.Invocations["queued"]);
        Assert.False(tools.Invocations.ContainsKey("later"));
        var responses = await ResponsesAsync(store);
        Assert.Equal(ToolAuthorizationUnavailableException.Code, ErrorType(responses["fatal"]));
        Assert.Equal("ran queued", SessionWait.Text(responses["queued"]["output"]));
        Assert.Equal("tool_call_skipped", ErrorType(responses["later"]));
        Assert.Equal(1, chat.Invocations);
        Assert.Equal(1, entry.BackgroundProcessorFailureCount);
    }
}
