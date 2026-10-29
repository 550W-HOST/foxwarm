using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class HandoffConfirmationTests
{
    [Fact]
    public void NoActionSignalUsesAnyTextPartAndAcceptsLegacyAndBracketedMarkers()
    {
        Assert.True(SessionBoundary.IsNoAction("NO_ACTION"));
        Assert.True(SessionBoundary.IsNoAction("[NO_ACTION]"));
        Assert.True(SessionBoundary.IsNoAction("summary\n[NO_ACTION]"));
        Assert.False(SessionBoundary.IsNoAction("summary only"));
    }

    private static JsonObject Obj(string raw) => JsonNode.Parse(raw)!.AsObject();

    private static string Review(
        string middle = "The recipient needs this result to complete the assigned work."
    ) => middle + "\nI confirm this handoff should proceed.";

    private static string Recall(
        string middle = "The recipient needs the applicable rules, request, and bounded scope."
    ) => middle;

    private static JsonObject Args(JsonNode? review) =>
        new()
        {
            ["sessionId"] = "target",
            ["handoffRecall"] = Recall(),
            ["message"] = "task",
            ["handoffConfirmation"] = review,
        };

    [Fact]
    public void Short_nonprefixed_content_requires_review_and_exact_terminal_consent()
    {
        foreach (
            var review in new[]
            {
                Review(),
                Review("\nOriginal review.\n"),
                Review(" Original review. "),
            }
        )
            HandoffConfirmation.Validate(Args(review));
        foreach (
            var invalid in new JsonNode?[]
            {
                null,
                JsonValue.Create(true),
                JsonValue.Create(1),
                JsonValue.Create(""),
                JsonValue.Create("Reviewed, but do not send."),
                JsonValue.Create("I confirm this handoff should proceed."),
                JsonValue.Create(Review(" \r\n\ufeff")),
                JsonValue.Create(Review(HandoffConfirmation.Placeholder)),
                JsonValue.Create(Review(" \n" + HandoffConfirmation.Placeholder + "\n ")),
                JsonValue.Create(Review() + "\n"),
                JsonValue.Create(Review() + " Actually, cancel this handoff."),
                JsonValue.Create(Review().ToLowerInvariant()),
                JsonValue.Create(
                    "Reviewed. I have completed the check, found no issue, and confirm this inter-agent handoff should proceed."
                ),
            }
        )
            Assert.Throws<InvalidDataException>(() => HandoffConfirmation.Validate(Args(invalid)));
        var missing = Args(Review());
        missing.Remove("handoffConfirmation");
        Assert.Throws<InvalidDataException>(() => HandoffConfirmation.Validate(missing));
        foreach (
            var recall in new JsonNode?[]
            {
                null,
                JsonValue.Create(true),
                JsonValue.Create(" \r\n\ufeff"),
                JsonValue.Create(HandoffConfirmation.RecallPlaceholder),
            }
        )
        {
            var args = Args(Review());
            args["handoffRecall"] = recall;
            Assert.Throws<InvalidDataException>(() => HandoffConfirmation.Validate(args));
        }
        var wrongOrder = Args(Review());
        wrongOrder["afterSend"] = "continue";
        Assert.Throws<InvalidDataException>(() => HandoffConfirmation.Validate(wrongOrder));
        var lateRecall = new JsonObject
        {
            ["sessionId"] = "target",
            ["message"] = "task",
            ["handoffRecall"] = Recall(),
            ["handoffConfirmation"] = Review(),
        };
        Assert.Throws<InvalidDataException>(() => HandoffConfirmation.Validate(lateRecall));
    }

    [Fact]
    public void Enabled_schemas_require_ordered_review_fields_and_disabled_schemas_omit_them()
    {
        Assert.False(HandoffConfirmation.Enabled(new JsonObject()));
        foreach (
            var definition in AgentToolDefinitions
                .Definitions()
                .Where(item => HandoffConfirmation.Handoff(SessionWait.Text(item["name"])))
        )
        foreach (var enabled in new[] { false, true })
        {
            var concrete = HandoffConfirmation.Definition(definition, enabled);
            var properties = concrete["parameters"]!["properties"]!.AsObject();
            var required = concrete["parameters"]!["required"]!
                .AsArray()
                .Select(SessionWait.Text)
                .ToArray();
            Assert.Equal(enabled, properties.ContainsKey("handoffRecall"));
            Assert.Equal(enabled, properties.ContainsKey("handoffConfirmation"));
            Assert.Equal(enabled, required.Contains("handoffRecall"));
            Assert.Equal(enabled, required.Contains("handoffConfirmation"));
            if (enabled)
            {
                var keys = properties.Select(pair => pair.Key).ToArray();
                Assert.True(Array.IndexOf(keys, "handoffRecall") < Array.IndexOf(keys, "message"));
                Assert.Equal("handoffConfirmation", keys.Last());
                var modelKeys = ToolCallControls.ForModel(concrete)["parameters"]!["properties"]!
                    .AsObject()
                    .Select(pair => pair.Key)
                    .ToArray();
                Assert.Equal(
                    new[] { "handoffConfirmation", "__cancelTool", "__cancelAllToolsThisTurn" },
                    modelKeys.TakeLast(3)
                );
            }
        }
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
                input["handoffRecall"] = Recall();
                input["handoffConfirmation"] = Review();
            }
            else
            {
                Assert.Null(rejected.Response["error"]);
                input["suffix"] = "ignored-review-child";
                input["handoffConfirmation"] = 123;
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
                definition["parameters"]!["properties"]!
                    .AsObject()
                    .ContainsKey("handoffConfirmation")
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
                    .History.Materialize()
                    .SelectMany(message => message["parts"]!.AsArray())
                    .Select(part => part?["system"]?.GetValue<string>())
                    .Where(value => value is not null);
                Assert.Equal(
                    enabled,
                    string.Join('\n', text).Contains("handoffRecall", StringComparison.Ordinal)
                );
            }
        }
    }
}
