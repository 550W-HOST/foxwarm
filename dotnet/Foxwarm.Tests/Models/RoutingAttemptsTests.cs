using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class RoutingAttemptsTests
{
    private static JsonObject Obj(string value) => JsonNode.Parse(value)!.AsObject();
    private static HostModels Catalog(int threshold = 5, string token = "old") => HostModels.Parse(Obj("""
    {"default":"route","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://localhost/a","apiKey":"TOKEN","effort":{"allowed":["none","low"],"default":"low"},"models":["m"]},"b":{"providerType":"anthropic","baseUrl":"http://localhost/b","effort":{"allowed":["high","max"],"default":"high"},"models":["m"]},"route":{"providerType":"failover","targets":["a","b/m"],"failureThreshold":THRESHOLD,"cooldownMs":1000},"pool":{"providerType":"session-hash","targets":["a/m","b"]}}}
    """.Replace("TOKEN", token).Replace("THRESHOLD", threshold.ToString(System.Globalization.CultureInfo.InvariantCulture))), new JsonObject());
    private static ResponsesClientOptions Defaults() => new(new Uri("http://localhost"), "m", "a/m", "", "", 50);

    [Fact]
    public void Source_HRW_vectors_and_real_generation_detachment_follow_independent_request_lifecycle()
    {
        string[] targets = ["a/model", "b/model", "c/model"];
        Assert.Equal("b/model", ModelRouting.Hash("pool", "11111111-2222-3333-4444-555555555555", targets).TargetKey);
        Assert.Equal("c/model", ModelRouting.Hash("pool", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", targets).TargetKey);
        Assert.Equal("a/model", ModelRouting.Hash("other", "11111111-2222-3333-4444-555555555555", targets).TargetKey);
        Assert.Equal("b/model", ModelRouting.Hash("pool", "11111111-2222-3333-4444-555555555555", targets.Reverse().ToArray()).TargetKey);
        long now = 100; var routing = new ModelRouting(() => now); var old = Catalog(1); var newer = Catalog(1, "new");
        var first = routing.Begin("route", old.Resolve("route")); var selected = routing.Select(first, "cache");
        Assert.True(routing.Failed(first, selected).EnteredCooldown); Assert.Equal("b/m", routing.Select(first, "cache").TargetKey);
        var active = routing.Begin("route", newer.Resolve("route"));
        Assert.False(routing.Failed(active, routing.Select(active, "cache")).Terminal); Assert.Equal("b/m", routing.Select(active, "cache").TargetKey);
        Assert.True(routing.Failed(first, routing.Select(first, "cache")).Terminal);
        Assert.Equal("b/m", routing.Select(routing.Begin("route", newer.Resolve("route")), "cache").TargetKey);
        now = 1200; Assert.Equal("a/m", routing.Select(active, "cache").TargetKey);
        var rollback = routing.Begin("route", old.Resolve("route")); Assert.NotEqual(first.Generation, rollback.Generation); Assert.Equal("a/m", routing.Select(rollback, "cache").TargetKey);
        var same = Catalog(); var parsed = Obj("""{"default":"route","providers":{"route":{"cooldownMs":1000,"failureThreshold":5,"targets":["a","b/m"],"providerType":"failover"},"b":{"models":["m"],"effort":{"default":"high","allowed":["high","max"]},"baseUrl":"http://localhost/b","providerType":"anthropic"},"a":{"models":["m"],"effort":{"default":"low","allowed":["none","low"]},"apiKey":"old","baseUrl":"http://localhost/a","providerType":"openai-responses"}}}""");
        Assert.Equal(same.Resolve("route").Configuration["fingerprint"]!.ToString(), HostModels.Parse(parsed, new JsonObject()).Resolve("route").Configuration["fingerprint"]!.ToString());
        Assert.Null(same.Resolve("route").DefaultEffort); Assert.Equal(new[] { "none", "low", "high", "max" }, same.Resolve("route").AllowedEfforts);
        parsed["providers"]!["a"]!["models"] = new JsonArray(new JsonObject { ["id"] = "m", ["asyncCompact"] = false });
        Assert.True(HostModels.Parse(parsed, new JsonObject()).Resolve("route").Configuration["asyncCompact"]!.GetValue<bool>());
        parsed["providers"]!["a"]!["asyncCompact"] = false;
        Assert.False(HostModels.Parse(parsed, new JsonObject()).Resolve("route").Configuration["asyncCompact"]!.GetValue<bool>());
    }

    [Fact]
    public async Task One_outer_six_attempts_rebuild_each_leaf_and_preserve_lineage_effort_and_success_attribution()
    {
        var calls = 0; var warnings = 0; var delays = new List<int>(); var prompts = new List<string>(); var events = new List<ModelRetryEvent>(); var catalog = Catalog();
        using var client = new HttpClient(new Handler(async (request, token) =>
        {
            calls++; var body = Obj(await request.Content!.ReadAsStringAsync(token));
            if (request.RequestUri!.AbsolutePath == "/a/responses")
            {
                Assert.Equal("low", body["reasoning"]!["effort"]!.GetValue<string>()); Assert.Contains("old", request.Headers.Authorization!.ToString());
                return new HttpResponseMessage(HttpStatusCode.TooManyRequests) { Content = new StringContent("synthetic limit") };
            }
            Assert.Equal(6, calls); Assert.Equal("/b/v1/messages", request.RequestUri.AbsolutePath); Assert.Equal("max", body["output_config"]!["effort"]!.GetValue<string>());
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}") };
        }));
        var owner = new ModelRequestOwner(client, Defaults(), new ModelRouting(), (milliseconds, _) => { delays.Add(milliseconds); return Task.CompletedTask; });
        var result = await owner.RequestAsync("session", catalog, "route", "max", "lineage", "turn", [], (leaf, _) => { prompts.Add(leaf.Key); return Task.FromResult("prompt " + leaf.Key); },
            value => { events.Add(value); if (value.Attempt == 2) throw new IOException("notification failed"); return Task.FromResult(false); }, null, null, _ => warnings++, CancellationToken.None);
        Assert.Equal(1, warnings); Assert.Equal(6, calls); Assert.Equal(new[] { 2000, 5000, 10000, 20000, 40000 }, delays); Assert.Equal(77000, delays.Sum());
        Assert.Equal(new[] { "a/m", "a/m", "a/m", "a/m", "a/m", "b/m" }, prompts); Assert.Equal(5, events.Count);
        Assert.All(events, value => Assert.Equal(6, value.MaxRetries)); Assert.Equal("b/m", result.AssistantMessage!["__meta"]!["modelId"]!.GetValue<string>());
        Assert.Equal("route", result.AssistantMessage["__meta"]!["virtualModelKey"]!.GetValue<string>());
    }

    [Fact]
    public async Task Local_snapshot_failure_does_not_become_provider_attempts_or_health()
    {
        var count = 0; var events = 0; using var client = new HttpClient(new Handler((_, _) => { count++; throw new InvalidOperationException("must not send"); }));
        var catalog = Catalog(1); var routing = new ModelRouting(); var owner = new ModelRequestOwner(client, Defaults(), routing, (_, _) => Task.CompletedTask);
        await Assert.ThrowsAsync<IOException>(() => owner.RequestAsync("session", catalog, "route", null, "lineage", "turn", [], (_, _) => throw new IOException("snapshot failed"),
            _ => { events++; return Task.FromResult(false); }, null, null, null, CancellationToken.None));
        Assert.Equal(0, count); Assert.Equal(0, events); Assert.Equal("a/m", routing.Select(routing.Begin("route", catalog.Resolve("route")), "lineage").TargetKey);
        Assert.Equal((true, true), ModelAttemptFailure.ClassifyHttp(400, "{\"error\":{\"details\":[{\"type\":\"model_not_found_error\"}]}}"));
        Assert.Equal((false, false), ModelAttemptFailure.ClassifyHttp(400, "invalid input")); Assert.Equal((true, false), ModelAttemptFailure.ClassifyHttp(418, "teapot"));
    }

    [Fact]
    public async Task Caller_stop_during_real_backoff_ends_without_another_provider_call_or_health_increment()
    {
        var calls = 0; using var stop = new CancellationTokenSource(); var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var client = new HttpClient(new Handler((_, _) => { calls++; return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = new StringContent("synthetic failure") }); }));
        var catalog = Catalog(2); var routing = new ModelRouting();
        var owner = new ModelRequestOwner(client, Defaults(), routing, async (milliseconds, token) => { reached.TrySetResult(); await Task.Delay(milliseconds, token); });
        var task = owner.RequestAsync("session", catalog, "route", null, "lineage", "turn", [], (_, _) => Task.FromResult("prompt"), null, null, null, null, stop.Token);
        await reached.Task.WaitAsync(TimeSpan.FromSeconds(2)); stop.Cancel(); await Assert.ThrowsAnyAsync<OperationCanceledException>(() => task);
        Assert.Equal(1, calls); var request = routing.Begin("route", catalog.Resolve("route")); Assert.Equal("a/m", routing.Select(request, "lineage").TargetKey);
        Assert.True(routing.Failed(request, routing.Select(request, "lineage")).EnteredCooldown);
    }

    [Fact]
    public async Task Same_configured_key_concrete_interlude_clears_prior_virtual_health()
    {
        var aCalls = 0; var routing = new ModelRouting();
        using var client = new HttpClient(new Handler((request, _) =>
        {
            if (request.RequestUri!.AbsolutePath == "/a/responses")
            {
                aCalls++;
                if (aCalls == 1) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) { Content = new StringContent("failure") });
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"done\"}]}]}}\n\n") });
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}") });
        }));
        var owner = new ModelRequestOwner(client, Defaults(), routing, (_, _) => Task.CompletedTask); var virtualCatalog = Catalog(1);
        Task<ChatResult> Send(HostModels catalog) => owner.RequestAsync("session", catalog, "route", null, "lineage", "turn", [], (_, _) => Task.FromResult("prompt"), null, null, null, null, CancellationToken.None);
        await Send(virtualCatalog); Assert.Equal(1, aCalls);
        var concrete = HostModels.Parse(Obj("""{"default":"route","providers":{"route":{"providerType":"anthropic","baseUrl":"http://localhost/concrete","models":["m"]}}}"""), new JsonObject());
        await Send(concrete); await Send(virtualCatalog); Assert.Equal(2, aCalls);
    }

    [Fact]
    public async Task Catalog_generation_activation_precedes_actual_queued_cache_save_await()
    {
        var root = Path.Combine(Path.GetTempPath(), "foxwarm-routing-activation-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(Path.Combine(root, "state"));
        string Configuration(string generation) => """{"default":"route","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://localhost/a","models":["m"],"extraHeaders":{"x-generation":"GEN"}},"b":{"providerType":"anthropic","baseUrl":"http://localhost/b","models":["m"],"extraHeaders":{"x-generation":"GEN"}},"route":{"providerType":"failover","targets":["a","b"],"failureThreshold":1}}}""".Replace("GEN", generation);
        try
        {
            await File.WriteAllTextAsync(Path.Combine(root, "state", "models.yaml"), Configuration("old"));
            var configuration = new ModelConfiguration(root); var routing = new ModelRouting(); var store = new HeldCacheStore(); var seen = new List<string>();
            using var client = new HttpClient(new Handler((request, _) =>
            {
                var generation = request.Headers.GetValues("x-generation").Single(); var leaf = request.RequestUri!.AbsolutePath.StartsWith("/a/") ? "a" : "b"; seen.Add(leaf + ":" + generation);
                return Task.FromResult(new HttpResponseMessage(leaf == "a" || generation == "old" ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK)
                { Content = new StringContent(leaf == "b" && generation == "new" ? "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}" : "provider unavailable") });
            }));
            var requests = new ModelRequestOwner(client, Defaults(), routing, (_, _) => Task.CompletedTask);
            var agents = new AgentCatalog(root, Path.Combine(root, "work")); var memory = new AgentMemory(agents, new Skills(agents, Path.Combine(root, "skills")));
            var hosted = new SessionOwner("old-session", "main", configuration.Models); hosted.Registry = new SessionRegistry(store, new OwnedChat(requests, Catalog()));
            var entry = hosted.Registry.Add(hosted.Id); entry.State.AuthorityEnvelope["model"] = "route";
            entry.State.AuthorityEnvelope["persistentMemorySnapshot"] = ConditionalMemory.BuildCurrentModelSnapshot("a/m", "source prompt");
            var chat = new SessionChatService(requests, Defaults(), hosted, configuration.Models, memory, (_, _) => { });
            var oldRequest = chat.ChatAsync(hosted.Id, [], CancellationToken.None); await store.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await configuration.SaveAsync(new JsonObject { ["yaml"] = Configuration("new") }); var newer = configuration.Models.Capture();
            Task<ChatResult> NewRequest() => requests.RequestAsync("new-session", newer, "route", null, "cache", "turn", [], (_, _) => Task.FromResult("prompt"), null, null, null, null, CancellationToken.None);
            await NewRequest(); store.Release.TrySetResult(); await Assert.ThrowsAsync<ModelRequestException>(() => oldRequest);
            await NewRequest(); Assert.Equal(new[] { "a:new", "b:new", "a:old", "b:old", "b:new" }, seen);
        }
        finally { Directory.Delete(root, recursive: true); }
    }
    private sealed class HeldCacheStore : ISessionAuthorityStore
    {
        internal TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int held;
        public async Task CommitAsync(SessionSnapshot snapshot, SaveKind kind, CancellationToken token = default)
        {
            if (snapshot.AuthorityEnvelope["promptCacheKey"] is not null && Interlocked.Exchange(ref held, 1) == 0)
            { Entered.TrySetResult(); await Release.Task.WaitAsync(token); }
        }
        public Task<SessionSnapshot?> LoadAsync(string id, CancellationToken token = default) => Task.FromResult<SessionSnapshot?>(null);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Successful_provider_is_not_reissued_when_strict_assistant_or_paired_save_fails(bool paired)
    {
        var calls = 0; var effects = new CountingTools();
        using var client = new HttpClient(new Handler((_, _) => { calls++; return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        { Content = new StringContent("{\"content\":[{\"type\":\"tool_use\",\"id\":\"call\",\"name\":\"write\",\"input\":{}}]}") }); }));
        var requests = new ModelRequestOwner(client, Defaults(), new ModelRouting(), (_, _) => Task.CompletedTask);
        var registry = new SessionRegistry(new FailingAppendStore(paired), new OwnedChat(requests, Catalog()), effects);
        registry.TriggerOverride = _ => Task.CompletedTask; registry.Add("session");
        await registry.Ingress.EnqueueAsync("session", QueueItem.UserText("input"));
        await registry.Runner.ProcessQueueAsync("session");
        Assert.IsType<IOException>(registry.GetRequired("session").LastBackgroundProcessorFailure);
        Assert.Equal(1, calls); Assert.Equal(paired ? 1 : 0, effects.Count);
    }
    private sealed class OwnedChat(ModelRequestOwner requests, HostModels catalog) : IChatService
    {
        public Task<ChatResult> ChatAsync(string id, IReadOnlyList<JsonObject> history, CancellationToken token) =>
            requests.RequestAsync(id, catalog, "b", null, "lineage", "turn", history, (_, _) => Task.FromResult("prompt"), null, null, null, null, token);
    }
    private sealed class CountingTools : ITurnToolExecutor
    {
        internal int Count;
        public Task<JsonObject> ExecuteAsync(JsonObject call, CancellationToken token) { Count++; return Task.FromResult(new JsonObject { ["output"] = "effect" }); }
    }
    private sealed class FailingAppendStore(bool paired) : ISessionAuthorityStore, ICanonicalAppendAuthorityStore
    {
        public Task CommitAsync(SessionSnapshot snapshot, SaveKind kind, CancellationToken token = default) => Task.CompletedTask;
        public Task<SessionSnapshot?> LoadAsync(string id, CancellationToken token = default) => Task.FromResult<SessionSnapshot?>(null);
        public Task CommitCanonicalAppendAsync(SessionSnapshot snapshot, IReadOnlyList<JsonObject> messages, CancellationToken token = default)
        {
            if (messages.Any(message => message["role"]!.GetValue<string>() == (paired ? "tool" : "model"))) throw new IOException("strict owned append failed");
            return Task.CompletedTask;
        }
    }

    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => send(request, token);
    }
}
