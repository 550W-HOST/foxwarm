using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed class HandoffConfirmationTests
{
    private static JsonObject Obj(string raw) => JsonNode.Parse(raw)!.AsObject();

    private static string Review(
        string middle = "The recipient needs this result to complete the assigned work."
    ) => HandoffConfirmation.Prefix + middle + HandoffConfirmation.Suffix;

    private static JsonObject Args(JsonNode? review) =>
        new()
        {
            ["sessionId"] = "target",
            ["message"] = "task",
            ["confirmation"] = review,
        };

    private static JsonObject SyntheticDefinition =>
        Obj(
            """{"name":"send_to_session","description":"Synthetic handoff operation.","parameters":{"type":"object","properties":{"sessionId":{"type":"string"},"message":{"type":"string"},"afterSend":{"type":"string"}},"required":["sessionId","message"]}}"""
        );

    [Fact]
    public async Task Actual_source_protocol_startup_normalizer_schema_order_and_child_instruction_are_preserved()
    {
        var args = new JsonArray(
            Args(null),
            Args(true),
            Args(1),
            Args(""),
            Args(Review()),
            Args(Review("\nOriginal review.\n")),
            Args(Review("\r\nOriginal review.\r\n")),
            Args(Review(" Original review. ")),
            Args(Review("")),
            Args(Review(" \r\n\ufeff")),
            Args(Review(HandoffConfirmation.Placeholder)),
            Args(Review(" \n" + HandoffConfirmation.Placeholder + "\n ")),
            Args(Review("Original review. " + HandoffConfirmation.Placeholder)),
            Args(" " + Review()),
            Args(Review() + "\n"),
            Args(Review().ToLowerInvariant()),
            Args(Review("\u0085"))
        );
        var wrongOrder = Args(Review());
        wrongOrder["messageAfter"] = "later";
        args.Add(wrongOrder);
        var flags = new JsonArray(
            new JsonObject(),
            Obj("""{"handoffConfirmation":false}"""),
            Obj("""{"handoffConfirmation":true}"""),
            Obj("""{"handoffConfirmation":null}"""),
            Obj("""{"handoffConfirmation":"true"}"""),
            Obj("""{"handoffConfirmation":0}"""),
            Obj("""{"handoffConfirmation":[]}"""),
            Obj("""{"handoffConfirmation":{}}""")
        );
        var input = new JsonObject
        {
            ["args"] = args.DeepClone(),
            ["flags"] = flags.DeepClone(),
            ["definition"] = SyntheticDefinition,
        };
        var repo =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException("Owned source fixture root is required.");
        using var process = Process.Start(
            new ProcessStartInfo("node")
            {
                WorkingDirectory = repo,
                ArgumentList =
                {
                    Path.Combine(repo, "dotnet", "handoff-confirmation-fixture-ts.mjs"),
                },
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }
        )!;
        await process.StandardInput.WriteAsync(input.ToJsonString());
        process.StandardInput.Close();
        var output = await process.StandardOutput.ReadToEndAsync();
        var error = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, error);
        var expected = Obj(output);
        var actualErrors = new JsonArray(
            args.Select(value =>
                {
                    try
                    {
                        HandoffConfirmation.Validate(value!.AsObject());
                        return (JsonNode?)null;
                    }
                    catch (InvalidDataException exception)
                    {
                        return (JsonNode?)JsonValue.Create(exception.Message);
                    }
                })
                .ToArray()
        );
        Assert.True(JsonNode.DeepEquals(expected["validations"], actualErrors));
        var actualFlags = new JsonArray(
            flags
                .Select(value =>
                {
                    try
                    {
                        return (JsonNode?)
                            JsonValue.Create(HandoffConfirmation.Enabled(value!.AsObject()));
                    }
                    catch (InvalidDataException exception)
                    {
                        return new JsonObject { ["error"] = exception.Message };
                    }
                })
                .ToArray()
        );
        Assert.True(JsonNode.DeepEquals(expected["flags"], actualFlags));
        var actualSchemas = new JsonArray();
        foreach (var enabled in new[] { false, true })
        {
            var concrete = HandoffConfirmation.Definition(SyntheticDefinition, enabled);
            var model = ToolCallControls.ForModel(concrete);
            JsonObject Shape(JsonObject definition) =>
                new()
                {
                    ["properties"] = new JsonArray(
                        definition["parameters"]!["properties"]!
                            .AsObject()
                            .Select(pair => (JsonNode?)JsonValue.Create(pair.Key))
                            .ToArray()
                    ),
                    ["required"] =
                        definition["parameters"]!["required"]?.DeepClone() ?? new JsonArray(),
                };
            actualSchemas.Add(
                new JsonObject { ["concrete"] = Shape(concrete), ["model"] = Shape(model) }
            );
        }
        Assert.True(JsonNode.DeepEquals(expected["schemas"], actualSchemas));
        Assert.Equal(
            expected["instructions"]![0]!.GetValue<string>(),
            SessionBoundary.Completion("source-parent", false)
        );
        Assert.Equal(
            expected["instructions"]![1]!.GetValue<string>(),
            SessionBoundary.Completion("source-parent", true)
        );
    }

    [Fact]
    public void Cancellation_precedes_direct_review_and_strips_only_outer_controls_without_mutating_canonical_calls()
    {
        JsonObject Call(string name, JsonObject args, bool malformed = false)
        {
            var call = new JsonObject
            {
                ["id"] = name,
                ["name"] = name,
                ["args"] = args.DeepClone(),
            };
            if (malformed)
                call["argsParseError"] = "Malformed arguments.";
            return call;
        }
        var missing = Obj("""{"sessionId":"target","message":"task"}""");
        var good = Args(Review());
        good["__cancelTool"] = true;
        var malformed = Call(
            "create_child_session",
            Obj("""{"__cancelAllToolsThisTurn":true}"""),
            true
        );
        var direct = ToolCallControls.Plan(
            [Call("send_to_session", missing), Call("create_child_session", good), malformed],
            true
        );
        Assert.Equal(
            HandoffConfirmation.ErrorCode,
            direct[0].Preset!["error"]!["type"]!.GetValue<string>()
        );
        Assert.True(direct[1].Preset!["canceled"]!.GetValue<bool>());
        Assert.Null(direct[2].Preset);
        Assert.True(good.ContainsKey("__cancelTool"));
        Assert.False(direct[1].Call["args"]!.AsObject().ContainsKey("__cancelTool"));
        var all = Call("exec", Obj("""{"command":"unused","__cancelAllToolsThisTurn":true}"""));
        Assert.All(
            ToolCallControls.Plan([Call("send_to_session", missing), all, malformed], true),
            item => Assert.True(item.Preset!["canceled"]!.GetValue<bool>())
        );
        Assert.Null(ToolCallControls.Plan([Call("send_to_session", missing)], false)[0].Preset);
        var unified = Call(
            "call_tool",
            new JsonObject { ["toolId"] = "builtin:send_to_session", ["args"] = Args(Review()) }
        );
        Assert.Null(ToolCallControls.Plan([unified], true)[0].Preset);
        unified["args"]!["args"]!["__cancelTool"] = true;
        Assert.True(
            ToolCallControls.Plan([unified], true)[0].Call["args"]!["args"]!
                .AsObject()
                .ContainsKey("__cancelTool")
        );
    }

    [Fact]
    public async Task Startup_configuration_is_strict_captured_once_and_model_save_preserves_the_separate_app_file()
    {
        using var temp = new TempDirectory();
        var root = Path.Combine(temp.Path, "data");
        Directory.CreateDirectory(Path.Combine(root, "state"));
        var appPath = Path.Combine(root, "state", "config.yaml");
        var modelPath = Path.Combine(root, "state", "models.yaml");
        var modelRaw =
            "default: a\nproviders: {a: {providerType: openai-responses, baseUrl: 'http://127.0.0.1:1', models: [wire]}}\n";
        await File.WriteAllTextAsync(modelPath, modelRaw);
        await File.WriteAllTextAsync(appPath, "# startup-only\nhandoffConfirmation: true\n");
        var previous = Environment.GetEnvironmentVariable("FOXWARM_CONFIG_PATH");
        Environment.SetEnvironmentVariable("FOXWARM_CONFIG_PATH", appPath);
        try
        {
            var current = new ModelConfiguration(root);
            Assert.True(current.HandoffConfirmationEnabled);
            Assert.True(current.Models.HandoffConfirmationEnabled);
            const string edited = "# retained app bytes\nhandoffConfirmation: false\n";
            await File.WriteAllTextAsync(appPath, edited);
            await current.SaveAsync(new JsonObject { ["yaml"] = modelRaw });
            Assert.True(current.HandoffConfirmationEnabled);
            Assert.True(current.Models.HandoffConfirmationEnabled);
            Assert.Equal(edited, await File.ReadAllTextAsync(appPath));
            Assert.False(new ModelConfiguration(root).HandoffConfirmationEnabled);
            foreach (var invalid in new[] { "null", "'true'", "0", "[]", "{}" })
            {
                await File.WriteAllTextAsync(appPath, "handoffConfirmation: " + invalid);
                Assert.Throws<InvalidDataException>(() => new ModelConfiguration(root));
            }
        }
        finally
        {
            Environment.SetEnvironmentVariable("FOXWARM_CONFIG_PATH", previous);
        }
    }

    [Fact]
    public async Task Concrete_handler_checks_no_message_child_and_default_mode_accepts_old_and_ignored_confirmation_calls()
    {
        foreach (var enabled in new[] { false, true })
        {
            using var temp = new TempDirectory();
            var data = Path.Combine(temp.Path, "data");
            var work = Path.Combine(temp.Path, "work");
            Directory.CreateDirectory(work);
            var options = new ResponsesClientOptions(
                new Uri("http://127.0.0.1:1"),
                "wire",
                "a",
                "",
                "",
                713
            );
            var models = HostModels.Parse(
                Obj(
                    """{"default":"a","providers":{"a":{"providerType":"openai-responses","baseUrl":"http://127.0.0.1:1","models":["wire"]}}}"""
                ),
                new JsonObject { ["handoffConfirmation"] = enabled }
            );
            await using var manager = new SessionManager(data, work, options, models);
            await manager.LoadAsync();
            var parent = await manager.CreateNamedAsync("main", "parent", null, null);
            var input = Obj("""{"suffix":"empty-child"}""");
            var rejected = await manager.ExecuteAgentToolAsync(
                parent,
                "create_child_session",
                input
            );
            if (enabled)
            {
                Assert.NotNull(rejected.Response["error"]);
                Assert.Null(manager.Catalog.Get("parent_empty-child"));
                input["confirmation"] = Review();
            }
            else
            {
                Assert.Null(rejected.Response["error"]);
                input["suffix"] = "ignored-review-child";
                input["confirmation"] = 123;
            }
            var created = await manager.ExecuteAgentToolAsync(
                parent,
                "create_child_session",
                input
            );
            Assert.Null(created.Response["error"]);
            var definition = manager
                .ModelDefinitions(parent)
                .OfType<JsonObject>()
                .Single(item => item["name"]!.GetValue<string>() == "create_child_session");
            Assert.Equal(
                enabled,
                definition["parameters"]!["properties"]!.AsObject().ContainsKey("confirmation")
            );
            var rows = manager
                .Catalog.List()
                .Where(row => row["parentSessionId"]?.GetValue<string>() == parent.Id)
                .ToArray();
            Assert.NotEmpty(rows);
            foreach (var row in rows)
            {
                var child = await manager.RequiredAsync(row["id"]!.GetValue<string>());
                var text = child
                    .Entry.Snapshot()
                    .History.SelectMany(message => message["parts"]!.AsArray())
                    .Select(part => part?["system"]?.GetValue<string>())
                    .Where(value => value is not null);
                Assert.Equal(
                    enabled,
                    string.Join('\n', text)
                        .Contains(HandoffConfirmation.Prefix, StringComparison.Ordinal)
                );
            }
        }
    }
}
