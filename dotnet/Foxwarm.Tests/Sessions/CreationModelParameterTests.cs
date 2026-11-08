using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class CreationModelParameterTests
{
    private static JsonObject Provider(params object[] models) =>
        new()
        {
            ["providerType"] = "openai-responses",
            ["baseUrl"] = "http://127.0.0.1:1/v1/",
            ["models"] = new JsonArray(
                models.Select(model => (JsonNode?)JsonSerializer.SerializeToNode(model)).ToArray()
            ),
        };

    private static async Task ConfigureAsync(ExternalChannelFixture f)
    {
        var root = new JsonObject
        {
            ["default"] = "fast",
            ["providers"] = new JsonObject
            {
                ["fast"] = Provider(new { id = "f1" }),
                ["strong"] = Provider(new { id = "a" }, new { id = "b" }),
                ["narrow"] = new JsonObject
                {
                    ["providerType"] = "openai-responses",
                    ["baseUrl"] = "http://127.0.0.1:1/v1/",
                    ["models"] = new JsonArray("n1"),
                    ["effort"] = new JsonObject
                    {
                        ["allowed"] = new JsonArray("low", "high"),
                        ["default"] = "low",
                    },
                },
            },
        };
        await File.WriteAllTextAsync(
            Path.Combine(f.Data, "state", "models.yaml"),
            root.ToJsonString()
        );
    }

    private static async Task SetSourceAsync(
        ExternalChannelFixture f,
        string? model,
        string? effort,
        string? childModel = null,
        string? childEffort = null
    )
    {
        await f.Owner.Entry.SaveLane.CommitSettingsAsync(
            new JsonObject
            {
                ["model"] = model,
                ["effort"] = effort,
                ["childModelDefault"] = childModel,
                ["childEffortDefault"] = childEffort,
            },
            f.Manager.Models
        );
    }

    private static int counter;

    private static async Task<(string? Model, string? Effort, string Output)> CreateAsync(
        ExternalChannelFixture f,
        string tool,
        JsonObject args
    )
    {
        var name = "case" + Interlocked.Increment(ref counter);
        string id;
        if (tool == "create_session")
        {
            args["agentName"] = "main";
            args["sessionName"] = name;
            id = name;
        }
        else
        {
            args["suffix"] = name;
            if (tool == "create_child_fork")
            {
                args["fork"] = true;
                tool = "create_child_session";
            }
            id = "source_" + name;
        }
        var response = await f.ToolAsync(tool, args);
        var error = response?["error"]?["message"]?.GetValue<string>();
        if (error is not null)
            throw new InvalidDataException(error);
        var created = await f.Manager.RequiredAsync(id);
        var envelope = created.Entry.Snapshot().AuthorityEnvelope;
        return (
            SessionWait.Text(envelope["model"]),
            SessionWait.Text(envelope["effort"]),
            response!["output"]!.GetValue<string>()
        );
    }

    private static JsonObject Model(string? modelId, string? effort = null)
    {
        var value = new JsonObject();
        if (modelId is not null)
            value["modelId"] = modelId;
        if (effort is not null)
            value["effort"] = effort;
        return value;
    }

    public static IEnumerable<object[]> Tools() =>
        [
            ["create_session"],
            ["create_child_session"],
            ["create_child_fork"],
        ];

    [Theory]
    [MemberData(nameof(Tools))]
    public async Task Model_precedence_and_pair_rule_resolve_each_field_with_its_source(string tool)
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        SessionCreationParityTests.RegisterAgentTools(f);
        await ConfigureAsync(f);

        // No child settings: model sits above the source's own selection.
        await SetSourceAsync(f, "strong/b", "low");
        var plain = await CreateAsync(f, tool, new JsonObject());
        Assert.Equal(("strong/b", "low"), (plain.Model, plain.Effort));
        Assert.Contains("Model: strong/b (inherited); effort: low (inherited).", plain.Output);

        var suggested = await CreateAsync(
            f,
            tool,
            new JsonObject { ["model"] = Model("strong/a", "high") }
        );
        Assert.Equal(("strong/a", "high"), (suggested.Model, suggested.Effort));
        Assert.Contains("Model: strong/a (model); effort: high (model).", suggested.Output);

        // An effort-only model applies to the otherwise selected model.
        var effortOnly = await CreateAsync(
            f,
            tool,
            new JsonObject { ["model"] = Model(null, "high") }
        );
        Assert.Equal(("strong/b", "high"), (effortOnly.Model, effortOnly.Effort));
        Assert.Contains("Model: strong/b (inherited); effort: high (model).", effortOnly.Output);

        // A child model default supersedes the suggested model, so its effort is ignored too.
        await SetSourceAsync(f, "strong/b", "low", childModel: "fast");
        var pair = await CreateAsync(
            f,
            tool,
            new JsonObject { ["model"] = Model("strong/a", "high") }
        );
        Assert.Equal(("fast", "low"), (pair.Model, pair.Effort));
        Assert.Contains("Model: fast (child setting); effort: low (inherited).", pair.Output);

        // A child effort default supersedes only the effort; the suggested model stays.
        await SetSourceAsync(f, "strong/b", "low", childEffort: "medium");
        var childEffort = await CreateAsync(
            f,
            tool,
            new JsonObject { ["model"] = Model("strong/a", "high") }
        );
        Assert.Equal(("strong/a", "medium"), (childEffort.Model, childEffort.Effort));
        Assert.Contains(
            "Model: strong/a (model); effort: medium (child setting).",
            childEffort.Output
        );

        // forceModel beats child settings and model; a model superseded by it loses its effort.
        await SetSourceAsync(f, "strong/b", "low", childModel: "fast", childEffort: "medium");
        var forced = await CreateAsync(
            f,
            tool,
            new JsonObject
            {
                ["forceModel"] = Model("strong/a", "max"),
                ["model"] = Model("fast", "none"),
            }
        );
        Assert.Equal(("strong/a", "max"), (forced.Model, forced.Effort));
        Assert.Contains("Model: strong/a (forceModel); effort: max (forceModel).", forced.Output);
        var forcedModelOnly = await CreateAsync(
            f,
            tool,
            new JsonObject { ["forceModel"] = Model("strong/a"), ["model"] = Model("fast", "none") }
        );
        Assert.Equal(("strong/a", "medium"), (forcedModelOnly.Model, forcedModelOnly.Effort));
        var forcedEffortOnly = await CreateAsync(
            f,
            tool,
            new JsonObject
            {
                ["forceModel"] = Model(null, "xhigh"),
                ["model"] = Model("strong/a", "none"),
            }
        );
        Assert.Equal(("fast", "xhigh"), (forcedEffortOnly.Model, forcedEffortOnly.Effort));
        Assert.Contains(
            "Model: fast (child setting); effort: xhigh (forceModel).",
            forcedEffortOnly.Output
        );

        // Nothing selected anywhere: global default and unset effort.
        await SetSourceAsync(f, null, null);
        var defaults = await CreateAsync(f, tool, new JsonObject());
        Assert.Equal((null, null), (defaults.Model, defaults.Effort));
        Assert.Contains("Model: fast (global default); effort: default.", defaults.Output);
        var onlyEffort = await CreateAsync(
            f,
            tool,
            new JsonObject { ["model"] = Model(null, "low") }
        );
        Assert.Equal((null, "low"), (onlyEffort.Model, onlyEffort.Effort));
        Assert.Contains("Model: fast (global default); effort: low (model).", onlyEffort.Output);
    }

    [Theory]
    [MemberData(nameof(Tools))]
    public async Task Model_is_validated_like_forceModel_only_when_it_takes_effect(string tool)
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        SessionCreationParityTests.RegisterAgentTools(f);
        await ConfigureAsync(f);
        await SetSourceAsync(f, "strong/b", "low");

        // An effort the selected model does not allow is rejected when the model applies...
        var rejected = await Assert.ThrowsAsync<InvalidDataException>(() =>
            CreateAsync(f, tool, new JsonObject { ["model"] = Model("narrow/n1", "xhigh") })
        );
        Assert.Contains("effort", rejected.Message);
        // ...but a superseded pair is ignored silently.
        await SetSourceAsync(f, "strong/b", "low", childModel: "strong/a");
        var ignored = await CreateAsync(
            f,
            tool,
            new JsonObject { ["model"] = Model("narrow/n1", "xhigh") }
        );
        Assert.Equal(("strong/a", "low"), (ignored.Model, ignored.Effort));
        // Unknown model keys are always rejected, even when superseded.
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            CreateAsync(
                f,
                tool,
                new JsonObject { ["forceModel"] = Model("fast"), ["model"] = Model("missing/key") }
            )
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            CreateAsync(f, tool, new JsonObject { ["model"] = new JsonObject { ["extra"] = 1 } })
        );
    }

    [Fact]
    public async Task Claude_Code_Sessions_ignore_model_but_still_reject_unknown_keys()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        SessionCreationParityTests.RegisterAgentTools(f);
        await ConfigureAsync(f);
        var response = await f.ToolAsync(
            "create_session",
            new JsonObject
            {
                ["agentName"] = "main",
                ["sessionName"] = "claude-one",
                ["runtime"] = "claude-code",
                ["model"] = Model("strong/a", "high"),
            }
        );
        Assert.Null(response?["error"]);
        Assert.DoesNotContain("Model:", response!["output"]!.GetValue<string>());
        var created = await f.Manager.RequiredAsync("claude-one");
        Assert.Null(created.Entry.Snapshot().AuthorityEnvelope["model"]);
        response = await f.ToolAsync(
            "create_session",
            new JsonObject
            {
                ["agentName"] = "main",
                ["sessionName"] = "claude-two",
                ["runtime"] = "claude-code",
                ["model"] = Model("missing/key"),
            }
        );
        Assert.NotNull(response?["error"]);
    }
}
