using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class SeparateImageGenerationTests
{
    private const string Png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    private static HostModels Catalog(
        Uri uri,
        bool websocket,
        bool enabled = true,
        string mode = "separate",
        string? route = null,
        string? secondaryMode = null
    )
    {
        var config = new JsonObject
        {
            ["default"] = "p/m",
            ["providers"] = new JsonObject
            {
                ["p"] = new JsonObject
                {
                    ["providerType"] = websocket ? "openai-ws" : "openai-responses",
                    ["baseUrl"] = uri.ToString(),
                    ["models"] = new JsonArray("m"),
                    ["imageGeneration"] = new JsonObject { ["enabled"] = enabled, ["mode"] = mode },
                    ["webSearch"] = true,
                    ["extraFields"] = new JsonObject
                    {
                        ["reasoning"] = new JsonObject
                        {
                            ["effort"] = "high",
                            ["summary"] = "auto",
                        },
                        ["include"] = new JsonArray("reasoning.encrypted_content"),
                        ["parallel_tool_calls"] = true,
                    },
                },
            },
        };
        if (route is not null)
        {
            config["default"] = "route";
            config["providers"]!["p"]!["models"] = new JsonArray(
                "m",
                new JsonObject
                {
                    ["id"] = "n",
                    ["imageGeneration"] = new JsonObject { ["mode"] = secondaryMode ?? mode },
                }
            );
            config["providers"]!["route"] = new JsonObject
            {
                ["providerType"] = route,
                ["targets"] = new JsonArray("p/m", "p/n"),
                ["retryIntervalsMs"] = new JsonArray(0),
            };
            if (route == "failover")
                config["providers"]!["route"]!["failureThreshold"] = 1;
        }
        return HostModels.Parse(config, new JsonObject());
    }

    private static JsonObject Complete(params JsonObject[] output) =>
        new()
        {
            ["type"] = "response.completed",
            ["response"] = new JsonObject
            {
                ["id"] = "resp_" + Guid.NewGuid().ToString("N"),
                ["status"] = "completed",
                ["output"] = new JsonArray(output.Select(item => (JsonNode?)item).ToArray()),
            },
        };

    [Theory]
    [InlineData(false, null)]
    [InlineData(true, null)]
    [InlineData(false, "failover")]
    [InlineData(true, "failover")]
    [InlineData(false, "session-hash")]
    [InlineData(true, "session-hash")]
    public async Task Real_tool_loop_keeps_chat_high_but_omits_image_reasoning_and_returns_owned_image(
        bool websocket,
        string? route
    )
    {
        using var temp = new TempDirectory();
        string? toolModel = null;
        var failover = route == "failover";
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                var body = context.Request;
                if (failover && number == 1)
                {
                    Assert.Equal("m", body["model"]!.GetValue<string>());
                    Assert.Contains(
                        body["tools"]!.AsArray(),
                        tool => tool?["name"]?.GetValue<string>() == "generate_image"
                    );
                    await context.Send(
                        new JsonObject
                        {
                            ["type"] = "response.failed",
                            ["response"] = new JsonObject
                            {
                                ["id"] = "fail-primary",
                                ["status"] = "failed",
                                ["error"] = new JsonObject
                                {
                                    ["code"] = "server_error",
                                    ["message"] = "synthetic primary failure",
                                },
                            },
                        }
                    );
                    return;
                }
                if (failover)
                    number--;
                if (number == 2)
                {
                    Assert.Equal(toolModel, body["model"]!.GetValue<string>());
                    if (failover)
                        Assert.Equal("n", toolModel);
                    Assert.Null(body["reasoning"]);
                    Assert.Null(body["include"]);
                    Assert.Null(body["previous_response_id"]);
                    Assert.Null(body["prompt_cache_key"]);
                    Assert.False(body["parallel_tool_calls"]!.GetValue<bool>());
                    Assert.Equal(
                        "image_generation",
                        body["tool_choice"]!["type"]!.GetValue<string>()
                    );
                    Assert.Equal(
                        "image_generation",
                        Assert.Single(body["tools"]!.AsArray())!["type"]!.GetValue<string>()
                    );
                    Assert.DoesNotContain("ordinary conversation sentinel", body.ToJsonString());
                    Assert.DoesNotContain("function_call_output", body.ToJsonString());
                    Assert.Contains("input_image", body.ToJsonString());
                    await context.Send(
                        Complete(
                            new JsonObject
                            {
                                ["type"] = "image_generation_call",
                                ["id"] = "image_result",
                                ["status"] = "completed",
                                ["output_format"] = "png",
                                ["result"] = Png,
                            }
                        )
                    );
                    return;
                }
                Assert.Equal("high", body["reasoning"]!["effort"]!.GetValue<string>());
                Assert.DoesNotContain(
                    body["tools"]!.AsArray(),
                    tool => tool?["type"]?.GetValue<string>() == "image_generation"
                );
                Assert.Contains(
                    body["tools"]!.AsArray(),
                    tool => tool?["name"]?.GetValue<string>() == "generate_image"
                );
                if (number == 1)
                {
                    toolModel = body["model"]!.GetValue<string>();
                    await context.Send(
                        Complete(
                            new JsonObject
                            {
                                ["type"] = "function_call",
                                ["id"] = "fc_image",
                                ["call_id"] = "call_image",
                                ["name"] = "generate_image",
                                ["arguments"] =
                                    "{\"prompt\":\"Draw a blue circle\",\"imageIds\":[\"source-image\"]}",
                            }
                        )
                    );
                }
                else
                {
                    Assert.Equal(3, number);
                    await context.Send(
                        Complete(
                            new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["phase"] = "final_answer",
                                ["content"] = new JsonArray(
                                    new JsonObject
                                    {
                                        ["type"] = "output_text",
                                        ["text"] = "Image generated.",
                                    }
                                ),
                            }
                        )
                    );
                }
            }
        );
        var catalog = Catalog(peer.Uri, websocket, route: route);
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(peer.Uri, "m", "p/m", "", "", 1000),
            catalog
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "image-loop", null, null);
        var reference = await manager.Images.PutAsync(
            Convert.FromBase64String(Png),
            "image/png",
            "source-image"
        );
        await ForkClearLifecycleTests.AppendAsync(
            owner,
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(
                    new JsonObject { ["text"] = "ordinary conversation sentinel" },
                    new JsonObject
                    {
                        ["inlineDataRef"] = reference,
                        ["imageMeta"] = new JsonObject { ["imageId"] = "source-image" },
                    }
                ),
            }
        );
        await owner.Registry.Ingress.EnqueueAsync(
            owner.Id,
            QueueItem.UserText("Generate an image")
        );
        await owner.DrainForegroundAsync();
        Assert.Equal(failover ? 4 : 3, peer.Requests.Count);
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        var parts = owner.History().SelectMany(row => row["parts"]!.AsArray()).ToArray();
        Assert.Contains(
            parts,
            part => part?["functionResponse"]?["name"]?.GetValue<string>() == "generate_image"
        );
        Assert.Contains(
            parts,
            part =>
                part?["toolUseId"]?.GetValue<string>() == "call_image"
                && part["inlineDataRef"] is not null
        );
        Assert.DoesNotContain(
            Png,
            string.Concat(owner.History().Select(row => row.ToJsonString()))
        );
        var imageJournal = Assert.Single(
            await manager.Journal.ListAsync(owner.Id, "image-generation", null, null, 10)
        );
        var record = await manager.Journal.ReconstructAsync(
            imageJournal!["requestId"]!.GetValue<string>()
        );
        Assert.Contains("inlineDataRef", record.ToJsonString());
        Assert.Equal(
            "high",
            owner.Entry.Snapshot().Meta["lastEffectiveRequest"]!["effort"]!.GetValue<string>()
        );
        var count = peer.Requests.Count;
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            manager.GenerateImageAsync(
                owner,
                new JsonObject
                {
                    ["prompt"] = "edit",
                    ["imageIds"] = new JsonArray("another-session-image"),
                },
                default
            )
        );
        Assert.Equal(count, peer.Requests.Count);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Separate_image_failure_is_not_retried(bool websocket)
    {
        using var temp = new TempDirectory();
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, _) =>
            {
                Assert.Null(context.Request["reasoning"]);
                await context.Send(
                    new JsonObject
                    {
                        ["type"] = "response.failed",
                        ["response"] = new JsonObject
                        {
                            ["id"] = "failed",
                            ["status"] = "failed",
                            ["error"] = new JsonObject
                            {
                                ["code"] = "server_error",
                                ["message"] = "synthetic generation failure",
                            },
                        },
                    }
                );
            }
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(peer.Uri, "m", "p/m", "", "", 1000),
            Catalog(peer.Uri, websocket)
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "image-error", null, null);
        var error = await Record.ExceptionAsync(() =>
            manager.GenerateImageAsync(owner, new JsonObject { ["prompt"] = "draw" }, default)
        );
        Assert.NotNull(error);
        Assert.Single(peer.Requests);
        Assert.Equal("high", manager.Models.Select(owner.Entry.Snapshot()).EffectiveEffort);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Cancellation_stops_the_image_request_without_retry(bool websocket)
    {
        using var temp = new TempDirectory();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, _) =>
            {
                await context.Send(
                    new JsonObject
                    {
                        ["type"] = "response.created",
                        ["response"] = new JsonObject { ["id"] = "cancel-image" },
                    }
                );
                reached.TrySetResult();
                await release.Task;
            }
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(peer.Uri, "m", "p/m", "", "", 1000),
            Catalog(peer.Uri, websocket)
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "image-cancel", null, null);
        using var stop = new CancellationTokenSource();
        var pending = manager.GenerateImageAsync(
            owner,
            new JsonObject { ["prompt"] = "draw" },
            stop.Token
        );
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(10));
            stop.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            Assert.Single(peer.Requests);
            Assert.Empty(owner.History());
        }
        finally
        {
            release.TrySetResult();
        }
    }

    [Fact]
    public void Hosted_mode_keeps_existing_native_tool_and_separate_mode_does_not()
    {
        var uri = new Uri("http://localhost");
        foreach (var mode in new[] { "hosted", "separate", "isolated" })
        {
            var model = Catalog(uri, false, mode: mode).Resolve("p/m");
            var options = ConfiguredModelRequests.Plan(
                model,
                new(uri, "m", "p/m", "", "", 1000),
                "high",
                "",
                "cache",
                "turn"
            );
            var body = ResponsesRequestPlan.Build([], options);
            Assert.Equal("high", body["reasoning"]!["effort"]!.GetValue<string>());
            Assert.Equal(
                mode == "hosted",
                body["tools"]!
                    .AsArray()
                    .Any(tool => tool?["type"]?.GetValue<string>() == "image_generation")
            );
        }
    }

    [Theory]
    [InlineData("hosted", true, false)]
    [InlineData("separate", false, false)]
    [InlineData("separate", true, true)]
    [InlineData("isolated", true, true)]
    public async Task Declaration_discovery_and_dispatch_share_capability_and_authorization(
        string mode,
        bool enabled,
        bool available
    )
    {
        using var temp = new TempDirectory();
        var uri = new Uri("http://127.0.0.1:1");
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(uri, "m", "p/m", "", "", 1000),
            Catalog(uri, false, enabled, mode)
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "gate", null, null);
        var executor = new SessionToolExecutor(
            new WorkspaceTools(Path.Combine(temp.Path, "work")),
            owner,
            manager,
            manager.ToolRegistry
        );
        executor.BeginTurn();
        async Task<JsonObject> Call(string name, JsonObject args) =>
            (
                await executor.ExecuteAsync(
                    new JsonObject
                    {
                        ["id"] = Guid.NewGuid().ToString("N"),
                        ["name"] = name,
                        ["args"] = args,
                    },
                    default
                )
            )!.AsObject();
        async Task Check(bool expected)
        {
            Assert.Equal(
                expected,
                manager
                    .ModelDefinitions(owner)
                    .Any(definition => definition?["name"]?.GetValue<string>() == "generate_image")
            );
            var discovery = await Call(
                "ctl",
                CtlTestArgs.Search(new JsonObject
                {
                    ["query"] = "generate_image",
                    ["sources"] = new JsonArray("builtin"),
                })
            );
            Assert.Equal(expected, discovery.ToJsonString().Contains("builtin:generate_image"));
            // An invalid owned image proves allowed dispatch reaches the effect owner, without I/O.
            var args = new JsonObject
            {
                ["prompt"] = "draw",
                ["imageIds"] = new JsonArray("unknown-image"),
            };
            foreach (var wrapped in new[] { false, true })
            {
                var result = await Call(
                    wrapped ? "ctl" : "generate_image",
                    wrapped
                        ? CtlTestArgs.Unified(new JsonObject
                        {
                            ["toolId"] = "builtin:generate_image",
                            ["args"] = args.DeepClone(),
                        })
                        : args
                );
                Assert.Contains(
                    expected ? "Image ID was not found" : "den",
                    result.ToJsonString(),
                    StringComparison.OrdinalIgnoreCase
                );
            }
        }
        await Check(available);
        await manager.SetAgentRulesAsync(
            "main",
            new JsonArray(
                new JsonObject
                {
                    ["tool"] = new JsonObject
                    {
                        ["source"] = "builtin",
                        ["name"] = "generate_image",
                    },
                    ["action"] = "deny",
                }
            )
        );
        await Check(false);
    }

    [Fact]
    public void Dedicated_policy_ignores_extra_fields_that_reintroduce_history_or_reasoning()
    {
        var uri = new Uri("http://localhost");
        var model = Catalog(uri, false).Resolve("p/m");
        var options = ConfiguredModelRequests.Plan(
            model,
            new(uri, "m", "p/m", "", "", 1000),
            "high",
            "image instructions",
            "cache",
            "turn",
            ImageGenerationRequests.Purpose
        );
        options = options with
        {
            ExtraFields = new JsonObject
            {
                ["reasoning"] = new JsonObject { ["effort"] = "high" },
                ["include"] = new JsonArray("reasoning.encrypted_content"),
                ["previous_response_id"] = "ordinary-response",
                ["prompt_cache_key"] = "ordinary-cache",
                ["conversation"] = "ordinary-conversation",
                ["input"] = new JsonArray("ordinary input"),
                ["instructions"] = "ordinary instructions",
                ["tools"] = new JsonArray(new JsonObject { ["type"] = "web_search" }),
                ["tool_choice"] = "auto",
                ["parallel_tool_calls"] = true,
                ["temperature"] = 0.5,
            },
        };
        var body = ResponsesRequestPlan.Build([], options);
        Assert.Null(body["reasoning"]);
        Assert.Null(body["include"]);
        Assert.Null(body["previous_response_id"]);
        Assert.Null(body["prompt_cache_key"]);
        Assert.Null(body["conversation"]);
        Assert.Empty(body["input"]!.AsArray());
        Assert.Equal("image instructions", body["instructions"]!.GetValue<string>());
        Assert.Equal(
            "image_generation",
            Assert.Single(body["tools"]!.AsArray())!["type"]!.GetValue<string>()
        );
        Assert.Equal("image_generation", body["tool_choice"]!["type"]!.GetValue<string>());
        Assert.False(body["parallel_tool_calls"]!.GetValue<bool>());
        Assert.Equal(0.5, body["temperature"]!.GetValue<double>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Failover_to_hosted_leaf_rejects_a_guessed_separate_tool_call(bool websocket)
    {
        using var temp = new TempDirectory();
        await using var peer = await StreamingModelPeer.StartAsync(
            websocket,
            async (context, number) =>
            {
                var body = context.Request;
                Assert.Equal("high", body["reasoning"]!["effort"]!.GetValue<string>());
                Assert.Equal(number == 1 ? "m" : "n", body["model"]!.GetValue<string>());
                Assert.Equal(
                    number == 1,
                    body["tools"]!
                        .AsArray()
                        .Any(tool => tool?["name"]?.GetValue<string>() == "generate_image")
                );
                Assert.Equal(
                    number != 1,
                    body["tools"]!
                        .AsArray()
                        .Any(tool => tool?["type"]?.GetValue<string>() == "image_generation")
                );
                if (number == 1)
                    await context.Send(
                        new JsonObject
                        {
                            ["type"] = "response.failed",
                            ["response"] = new JsonObject
                            {
                                ["id"] = "failed-primary",
                                ["status"] = "failed",
                                ["error"] = new JsonObject
                                {
                                    ["code"] = "server_error",
                                    ["message"] = "primary failed",
                                },
                            },
                        }
                    );
                else if (number == 2)
                    await context.Send(
                        Complete(
                            new JsonObject
                            {
                                ["type"] = "function_call",
                                ["id"] = "fc_guess",
                                ["call_id"] = "call_guess",
                                ["name"] = "generate_image",
                                ["arguments"] = "{\"prompt\":\"draw\"}",
                            }
                        )
                    );
                else
                {
                    Assert.Equal(3, number);
                    Assert.Contains("tool_authorization_denied", body.ToJsonString());
                    await context.Send(
                        Complete(
                            new JsonObject
                            {
                                ["type"] = "message",
                                ["role"] = "assistant",
                                ["content"] = new JsonArray(
                                    new JsonObject { ["type"] = "output_text", ["text"] = "Done." }
                                ),
                            }
                        )
                    );
                }
            }
        );
        await using var manager = new SessionManager(
            Path.Combine(temp.Path, "data"),
            Path.Combine(temp.Path, "work"),
            new(peer.Uri, "m", "p/m", "", "", 1000),
            Catalog(peer.Uri, websocket, route: "failover", secondaryMode: "hosted")
        );
        await manager.LoadMainHostAsync();
        var owner = await manager.CreateNamedAsync("main", "mixed-route", null, null);
        await owner.Registry.Ingress.EnqueueAsync(owner.Id, QueueItem.UserText("Draw"));
        await owner.DrainForegroundAsync();
        Assert.Null(owner.Entry.LastBackgroundProcessorFailure);
        Assert.Equal(3, peer.Requests.Count);
        Assert.Empty(await manager.Journal.ListAsync(owner.Id, "image-generation", null, null, 10));
    }
}
