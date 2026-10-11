using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class MainTimerToolsTests
{
    private sealed class Fixture : IAsyncDisposable
    {
        internal readonly TempDirectory Temp = new();
        internal string Data => Path.Combine(Temp.Path, "data");
        internal string Work => Path.Combine(Temp.Path, "work");
        internal SessionManager Manager = null!;
        internal SessionOwner Owner = null!;
        internal SessionToolExecutor Tools = null!;
        internal ToolRegistry Registry = null!;
        private Foxwarm.McpClient mcp = null!;

        internal static async Task<Fixture> Create(
            JsonObject? isolation = null,
            string? rawStore = null,
            ResponsesClientOptions? supplied = null
        )
        {
            var f = new Fixture();
            Console.WriteLine("Owned timer tools fixture=" + f.Temp.Path);
            try
            {
                Directory.CreateDirectory(Path.Combine(f.Data, "state"));
                if (rawStore is not null)
                    await File.WriteAllTextAsync(
                        Path.Combine(f.Data, "state", "timers.json"),
                        rawStore
                    );
                if (isolation is not null)
                    await File.WriteAllTextAsync(
                        Path.Combine(f.Data, "state", "agents.json"),
                        new JsonObject
                        {
                            ["version"] = 2,
                            ["agents"] = new JsonArray(),
                            ["metadata"] = new JsonObject { ["main"] = isolation },
                        }.ToJsonString()
                    );
                var options =
                    supplied
                    ?? new ResponsesClientOptions(
                        new Uri("http://127.0.0.1:1"),
                        "wire",
                        "a",
                        "",
                        "",
                        713
                    );
                var sourceRoot =
                    Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
                    ?? throw new InvalidOperationException("Source checkout is required.");
                f.Manager = new(
                    f.Data,
                    f.Work,
                    options,
                    HostModels.ForTest(options),
                    Path.Combine(sourceRoot, "skills")
                );
                await f.Manager.LoadMainHostAsync();
                f.Owner = await f.Manager.CreateNamedAsync("main", "source", null, null);
                f.mcp = new(f.Data);
                var definitions = TimerToolDefinitions.Definitions();
                foreach (var item in UnifiedToolDefinitions.All())
                    definitions.Add(item?.DeepClone());
                f.Registry = SessionToolExecutor.CreateRegistry(definitions, f.mcp, _ => f.Work);
                f.Tools = new(new WorkspaceTools(f.Work), f.Owner, f.Manager, f.Registry);
                f.Tools.BeginTurn();
                return f;
            }
            catch
            {
                await f.DisposeAsync();
                throw;
            }
        }

        internal async Task<JsonObject> Call(string name, JsonObject args) => (await Tools.ExecuteAsync(
                new JsonObject
                {
                    ["id"] = Guid.NewGuid().ToString("N"),
                    ["name"] = name,
                    ["args"] = args.DeepClone(),
                },
                default
            ))!.AsObject();

        public async ValueTask DisposeAsync()
        {
            if (Manager is not null)
            {
                await Manager.ShutdownAsync();
                await Manager.DisposeAsync();
            }
            if (mcp is not null)
                await mcp.DisposeAsync();
            Temp.Dispose();
        }
    }

    private sealed class LoopbackProvider : IAsyncDisposable
    {
        private readonly System.Net.HttpListener listener = new();
        private readonly CancellationTokenSource stop = new();
        private readonly Task loop;
        internal readonly TaskCompletionSource<JsonObject> Request = new(
            TaskCreationOptions.RunContinuationsAsynchronously
        );
        internal readonly Uri BaseUri;

        internal LoopbackProvider()
        {
            var reserve = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
            reserve.Start();
            var port = ((System.Net.IPEndPoint)reserve.LocalEndpoint).Port;
            reserve.Stop();
            BaseUri = new Uri("http://127.0.0.1:" + port);
            listener.Prefixes.Add(BaseUri + "/");
            listener.Start();
            loop = ServeAsync();
        }

        private async Task ServeAsync()
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    var context = await listener.GetContextAsync().WaitAsync(stop.Token);
                    var body = JsonNode
                        .Parse(
                            await new StreamReader(context.Request.InputStream).ReadToEndAsync()
                        )!
                        .AsObject();
                    var payload = new JsonObject
                    {
                        ["type"] = "response.completed",
                        ["response"] = new JsonObject
                        {
                            ["id"] = "allocator",
                            ["output"] = new JsonArray(
                                new JsonObject
                                {
                                    ["type"] = "message",
                                    ["role"] = "assistant",
                                    ["content"] = new JsonArray(
                                        new JsonObject
                                        {
                                            ["type"] = "output_text",
                                            ["text"] = "Allocator completed.",
                                        }
                                    ),
                                }
                            ),
                            ["usage"] = new JsonObject
                            {
                                ["input_tokens"] = 20,
                                ["output_tokens"] = 2,
                            },
                        },
                    };
                    context.Response.ContentType = "text/event-stream";
                    var bytes = System.Text.Encoding.UTF8.GetBytes(
                        "data: " + payload.ToJsonString() + "\n\n"
                    );
                    await context.Response.OutputStream.WriteAsync(bytes);
                    context.Response.Close();
                    Request.TrySetResult(body);
                }
            }
            catch (Exception error)
                when (stop.IsCancellationRequested
                    && error
                        is OperationCanceledException
                            or System.Net.HttpListenerException
                            or ObjectDisposedException
                ) { }
        }

        public async ValueTask DisposeAsync()
        {
            stop.Cancel();
            listener.Stop();
            await loop;
            listener.Close();
            stop.Dispose();
        }
    }

    [Fact]
    public async Task Scheduled_new_session_uses_real_reserved_allocator_and_fresh_history_before_real_loopback_provider_response()
    {
        await using var peer = new LoopbackProvider();
        var options = new ResponsesClientOptions(peer.BaseUri, "wire", "a", "", "", 713);
        await using var f = await Fixture.Create(supplied: options);
        await f.Manager.CreateNamedAsync("main", "live", null, null);
        await f.Manager.CreateNamedAsync("main", "retained", null, null);
        await f.Manager.DeleteAsync("retained", source: f.Owner);
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            f.Manager.CreateNamedAsync("main", "retained", null, null)
        );
        var names = new Queue<string>(["live", "retained", "available"]);
        f.Manager.TimerSessionName = _ => names.Dequeue();
        var args = Future("Real allocated timer.");
        args["newSession"] = true;
        args["afterSeconds"] = 0.1;
        Assert.Null(
            (
                await f.Call(
                    "call_tool",
                    new JsonObject { ["toolId"] = "builtin:create_timer", ["args"] = args }
                )
            )["error"]
        );
        var request = await peer.Request.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Contains("Real allocated timer.", request.ToJsonString());
        Assert.Empty(names);
        var target = await f.Manager.RequiredAsync("available");
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (target.Entry.Snapshot().Busy && DateTime.UtcNow < deadline)
            await Task.Delay(5);
        var state = target.Entry.Snapshot();
        Assert.False(state.Busy);
        Assert.Equal(2, state.History.Count);
        Assert.Null(state.AuthorityEnvelope["parentSessionId"]);
        Assert.NotEqual(
            f.Owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.GetValue<string>(),
            state.AuthorityEnvelope["promptCacheKey"]!.GetValue<string>()
        );
    }

    private static JsonObject Future(string text = " payload ") =>
        new() { ["message"] = text, ["afterSeconds"] = 600 };

    [Fact]
    public async Task Four_hidden_builtins_have_source_structure_normal_controls_and_real_neutral_dispatch()
    {
        await using var f = await Fixture.Create();
        var names = new[] { "create_timer", "list_timers", "update_timer", "delete_timer" };
        Assert.All(
            f.Registry.Entries.Where(entry =>
                names.Contains(SessionWait.Text(entry.Definition["name"]))
            ),
            entry =>
            {
                Assert.False(entry.DefaultInject);
                Assert.Equal("builtin", entry.Source);
            }
        );
        Assert.DoesNotContain(
            f.Registry.ModelDefinitions().OfType<JsonObject>(),
            row => names.Contains(SessionWait.Text(row["name"]))
        );
        foreach (var definition in TimerToolDefinitions.Definitions().OfType<JsonObject>())
        {
            var model = ToolCallControls.ForModel(definition);
            var properties = model["parameters"]!["properties"]!.AsObject();
            Assert.Equal(
                new[] { "__cancelTool", "__cancelAllToolsThisTurn" },
                properties.Select(pair => pair.Key).TakeLast(2)
            );
            Assert.DoesNotContain(
                new[]
                {
                    "timezone",
                    "model",
                    "effort",
                    "node",
                    "parent",
                    "enabled",
                    "confirmation",
                },
                key => properties.ContainsKey(key)
            );
        }
        var result = await f.Call(
            "call_tool",
            new JsonObject { ["toolId"] = "builtin:create_timer", ["args"] = Future() }
        );
        Assert.Null(result["error"]);
        var id = result["timer"]!["id"]!.GetValue<string>();
        Assert.Equal("payload", result["timer"]!["message"]!.GetValue<string>());
        var listed = await f.Call("list_timers", new());
        Assert.Single(listed["timers"]!.AsArray());
        var deleted = await f.Call(
            "call_tool",
            new JsonObject
            {
                ["source"] = "builtin",
                ["name"] = "delete_timer",
                ["argsJson"] = new JsonObject { ["timerId"] = id }.ToJsonString(),
            }
        );
        Assert.True(deleted["deleted"]!.GetValue<bool>());
    }

    [Fact]
    public async Task Real_source_schedule_placeholders_update_omissions_and_new_session_false_clear_only_target_settings()
    {
        await using var f = await Fixture.Create();
        var args = Future();
        args["at"] = "";
        args["cron"] = "";
        var created = await f.Call("create_timer", args);
        Assert.Null(created["error"]);
        var id = created["timer"]!["id"]!.GetValue<string>();
        var unchanged = await f.Call("update_timer", new JsonObject { ["timerId"] = id });
        Assert.NotNull(unchanged["error"]);
        var fresh = await f.Call(
            "update_timer",
            new JsonObject
            {
                ["timerId"] = id,
                ["newSession"] = true,
                ["sessionPrefix"] = "prefix",
            }
        );
        Assert.Null(fresh["error"]);
        var before = fresh["timer"]!;
        Assert.Equal("main", before["agentName"]!.GetValue<string>());
        Assert.Equal(created["timer"]!["at"]!.GetValue<double>(), before["at"]!.GetValue<double>());
        var changed = await f.Call(
            "update_timer",
            new JsonObject
            {
                ["timerId"] = id,
                ["afterSeconds"] = 0,
                ["message"] = " changed ",
                ["newSession"] = false,
            }
        );
        Assert.Null(changed["error"]);
        foreach (
            var key in new[] { "sessionPrefix", "agentName", "model", "effort", "currentNode" }
        )
            Assert.Null(changed["timer"]![key]);
        Assert.Equal("changed", changed["timer"]!["message"]!.GetValue<string>());
        Assert.Equal(before["at"]!.GetValue<double>(), changed["timer"]!["at"]!.GetValue<double>());
        var bad = Future();
        bad["cron"] = "@yearly";
        Assert.NotNull((await f.Call("create_timer", bad))["error"]);
        bad = Future();
        bad["afterSeconds"] = 0;
        Assert.NotNull((await f.Call("create_timer", bad))["error"]);
    }

    [Fact]
    public async Task Literal_owner_filter_survives_alias_moves_and_does_not_hydrate_unrelated_future_targets()
    {
        await using var f = await Fixture.Create();
        var target = await f.Manager.CreateNamedAsync("main", "target", null, null);
        var args = Future();
        args["sessionId"] = target.Id;
        var timer = (await f.Call("create_timer", args))["timer"]!.AsObject();
        await f.Manager.MoveIdentityAsync(
            f.Owner,
            new JsonObject { ["sessionId"] = target.Id, ["newSessionId"] = "renamed" }
        );
        Assert.Empty(
            (await f.Call("list_timers", new JsonObject { ["sessionId"] = "renamed" }))[
                "timers"
            ]!.AsArray()
        );
        Assert.Single(
            (await f.Call("list_timers", new JsonObject { ["sessionId"] = "target" }))[
                "timers"
            ]!.AsArray()
        );
        var updated = await f.Call(
            "update_timer",
            new JsonObject
            {
                ["sessionId"] = "target",
                ["timerId"] = timer["id"]!.DeepClone(),
                ["message"] = "alias",
            }
        );
        Assert.Null(updated["error"]);
        Assert.Equal("target", updated["timer"]!["sessionId"]!.GetValue<string>());
        Assert.NotNull(
            (
                await f.Call(
                    "delete_timer",
                    new JsonObject
                    {
                        ["sessionId"] = "renamed",
                        ["timerId"] = timer["id"]!.DeepClone(),
                    }
                )
            )["error"]
        );
    }

    [Fact]
    public async Task Independent_isolated_exact_self_and_same_Agent_bounds_survive_explicit_allow_rules()
    {
        var rules = new JsonArray(
            new JsonObject
            {
                ["source"] = "builtin",
                ["tool"] = "create_timer",
                ["effect"] = "allow",
            }
        );
        await using var f = await Fixture.Create(
            new JsonObject { ["isolated"] = true, ["toolRules"] = rules }
        );
        var args = Future();
        args["sessionId"] = "main";
        Assert.NotNull((await f.Call("create_timer", args))["error"]);
        args = Future();
        args["newSession"] = true;
        args["agentName"] = "different";
        Assert.NotNull((await f.Call("create_timer", args))["error"]);
        args = Future();
        args["agentName"] = "main";
        Assert.NotNull((await f.Call("create_timer", args))["error"]);
        args = Future();
        args["newSession"] = true;
        args["agentName"] = "main";
        Assert.Null((await f.Call("create_timer", args))["error"]);
    }

    [Fact]
    public async Task Malformed_store_returns_ordinary_paired_tool_error_without_poisoning_normal_host_or_authorization()
    {
        await using var f = await Fixture.Create(rawStore: "{broken");
        await f.Manager.CreateNamedAsync("main", "main", null, null);
        var result = await f.Call("create_timer", Future());
        Assert.NotNull(result["error"]);
        Assert.False(f.Tools.PolicyUnavailable);
        Assert.Equal(
            "{broken",
            await File.ReadAllTextAsync(Path.Combine(f.Data, "state", "timers.json"))
        );
        Assert.NotNull(f.Manager.Find("main"));
        Assert.Null(
            (
                await f.Call(
                    "search_tools",
                    new JsonObject { ["query"] = "timer", ["sources"] = new JsonArray("builtin") }
                )
            )["error"]
        );
    }
}
