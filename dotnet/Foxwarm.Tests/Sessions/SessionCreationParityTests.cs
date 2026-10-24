using System.Diagnostics;
using System.Text.Json.Nodes;
using Foxwarm.Channels;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

public sealed partial class SessionCreationParityTests
{
    private static readonly DateTimeOffset LocalTime = new(
        2030,
        12,
        31,
        16,
        30,
        0,
        TimeSpan.FromHours(-8)
    );

    private static async Task<JsonArray> SourceAsync(JsonArray cases)
    {
        var repository =
            Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT")
            ?? throw new InvalidOperationException(
                "FOXWARM_TS_ROOT is required for the Source allocator."
            );
        using var process = Process.Start(
            new ProcessStartInfo("node")
            {
                WorkingDirectory = repository,
                ArgumentList =
                {
                    Path.Combine(repository, "dotnet", "Foxwarm.Tests", "Fixtures", "session-creation-fixture-ts.mjs"),
                },
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            }
        )!;
        await process.StandardInput.WriteAsync(new JsonObject { ["cases"] = cases }.ToJsonString());
        process.StandardInput.Close();
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        Assert.True(process.ExitCode == 0, await error);
        return JsonNode.Parse(await output)!.AsArray();
    }

    private static JsonObject Case(
        double[] random,
        string? agent = null,
        string[]? reserved = null
    ) =>
        new()
        {
            ["zone"] = "America/Los_Angeles",
            ["time"] = LocalTime.ToString("O"),
            ["random"] = new JsonArray(
                random.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
            ["allocate"] = reserved is not null,
            ["agent"] = agent,
            ["reserved"] = new JsonArray(
                (reserved ?? []).Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
            ),
        };

    private static void RegisterAgentTools(ExternalChannelFixture f)
    {
        var definitions = WorkspaceTools.Definitions();
        foreach (
            var definition in AgentToolDefinitions
                .Definitions()
                .Concat(KnowledgeToolDefinitions.Definitions())
                .Concat(UnifiedToolDefinitions.All().OfType<JsonObject>())
        )
            definitions.Add(
                HandoffConfirmation.Definition(definition, f.Manager.HandoffConfirmationEnabled)
            );
        f.Registry = SessionToolExecutor.CreateRegistry(
            definitions,
            f.Manager.OutboundMcp,
            owner => f.Manager.IdentityWorkspace(owner).ToolDirectory,
            f.Manager.Nodes,
            f.Manager.NodeProviders
        );
    }

    [Fact]
    public async Task Local_date_and_base36_fraction_match_actual_Source_including_short_and_rounding_boundaries()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        var values = new List<double>
        {
            0,
            0.5,
            0.25,
            0.125,
            0.1,
            0.123456789,
            Math.BitDecrement(1),
            double.Epsilon,
        };
        for (var power = 1; power <= 5; power++)
        for (var numerator = 1; numerator <= 50; numerator++)
        {
            var value = numerator / Math.Pow(36, power);
            if (value >= 1)
                continue;
            values.AddRange([Math.BitDecrement(value), value, Math.BitIncrement(value)]);
        }
        var cases = new JsonArray(values.Select(value => (JsonNode?)Case([value])).ToArray());
        var expected = await SourceAsync(cases);
        f.Manager.SessionNameClock = () => LocalTime;
        for (var i = 0; i < values.Count; i++)
        {
            var value = values[i];
            f.Manager.SessionNameRandom = () => value;
            Assert.Equal(
                expected[i]!["allocated"]!.GetValue<string>(),
                f.Manager.GenerateSessionId()
            );
        }
        Assert.StartsWith("1231_", f.Manager.GenerateSessionId()); // UTC has already crossed into January.
    }

    [Fact]
    public async Task Automatic_creation_skips_live_and_archive_ids_in_the_exact_Agent_namespace_and_saves_fresh_defaults()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        await File.WriteAllTextAsync(
            Path.Combine(f.Manager.AgentDirectory("main"), "memory", "CREATION.md"),
            "fresh creation memory"
        );
        var legacy = await f.Manager.CreateNamedAsync(
            "main",
            "s_0123456789abcdef0123456789abcdef",
            "Retained display",
            null
        );
        var live = await f.Manager.CreateNamedAsync("main", "1231_4i", null, null);
        var archived = await f.Manager.CreateNamedAsync("main", "1231_9", null, null);
        await f.Manager.DeleteAsync(archived.Id);
        var expected = await SourceAsync(
            new JsonArray(Case([0.125, 0.25, 0.5], reserved: [live.Id, archived.Id]))
        );
        var random = new Queue<double>([0.125, 0.25, 0.5]);
        f.Manager.SessionNameClock = () => LocalTime;
        f.Manager.SessionNameRandom = random.Dequeue;
        var created = await f.Manager.CreateAsync();
        Assert.Equal(expected[0]!["allocated"]!.GetValue<string>(), created.Id);
        Assert.Empty(random);
        Assert.Equal("main", created.Agent);
        Assert.Null(created.Metadata().ParentSessionId);
        Assert.Null(created.Metadata().DisplayName);
        Assert.Equal("master", f.Manager.CurrentNode(created));
        var snapshot = created.Entry.Snapshot();
        Assert.Null(snapshot.AuthorityEnvelope["cwd"]);
        Assert.Null(snapshot.AuthorityEnvelope["model"]);
        Assert.Null(snapshot.AuthorityEnvelope["effort"]);
        Assert.Empty(snapshot.History);
        Assert.Empty(snapshot.Queue);
        Assert.False(snapshot.Busy);
        Assert.Contains(
            "fresh creation memory",
            SessionWait.Text(snapshot.AuthorityEnvelope["persistentMemorySnapshot"])
        );
        Assert.True(File.Exists(Path.Combine(f.Data, "state", "sessions", created.Id + ".json")));
        await f.Manager.CreateAgentAsync("named", false);
        f.Manager.SessionNameRandom = () => 0.125;
        var scoped = await f.Manager.CreateNamedAsync("named", null, null, null);
        Assert.Equal("named/1231_4i", scoped.Id);
        Assert.Same(live, await f.Manager.GetExistingAsync(live.Id));
        Assert.Same(legacy, await f.Manager.GetExistingAsync("s_0123456789abcdef0123456789abcdef"));
        Assert.Equal("Retained display", legacy.Metadata().DisplayName);
        Assert.Null(await f.Manager.GetExistingAsync(archived.Id));
    }

    [Fact]
    public async Task Normal_tool_creation_uses_source_policy_but_only_records_the_requested_parent_and_keeps_display_name_separate()
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        f.Owner = await f.Manager.CreateNamedAsync(
            "main",
            "caller",
            null,
            null,
            initialNode: "caller-node"
        );
        await f.Owner.Entry.SaveLane.CommitSettingsAsync(
            new JsonObject
            {
                ["model"] = "local/wire",
                ["effort"] = "low",
                ["childModelDefault"] = "local/wire",
                ["childEffortDefault"] = "high",
            },
            f.Manager.Models
        );
        await f.Owner.UpdateCwdAsync("caller-cwd");
        var parent = await f.Manager.CreateNamedAsync(
            "main",
            "recorded-parent",
            null,
            null,
            initialNode: "parent-node"
        );
        await f.Manager.CreateAgentAsync("target", false);
        var selected = Path.Combine(f.Manager.AgentDirectory("target"), "selected.md");
        await File.WriteAllTextAsync(selected, "selected creation memory");
        var response = await f.ToolAsync(
            "create_session",
            new JsonObject
            {
                ["agentName"] = "target",
                ["sessionName"] = "Explicit_ID",
                ["displayName"] = "  readable / name  ",
                ["parentSessionId"] = parent.Id,
                ["systemPromptFiles"] = new JsonArray("selected.md"),
            }
        );
        Assert.True(response is JsonObject && response["error"] is null, response?.ToJsonString());
        var created = await f.Manager.RequiredAsync("target/Explicit_ID");
        Assert.Equal(parent.Id, created.Metadata().ParentSessionId);
        Assert.Equal("  readable / name  ", created.Metadata().DisplayName);
        Assert.Equal("caller-node", f.Manager.CurrentNode(created));
        var snapshot = created.Entry.Snapshot();
        Assert.Null(snapshot.AuthorityEnvelope["cwd"]);
        Assert.Equal("local/wire", SessionWait.Text(snapshot.AuthorityEnvelope["model"]));
        Assert.Equal("high", SessionWait.Text(snapshot.AuthorityEnvelope["effort"]));
        Assert.Null(snapshot.AuthorityEnvelope["childModelDefault"]);
        Assert.Null(snapshot.AuthorityEnvelope["childEffortDefault"]);
        Assert.Contains(
            "selected creation memory",
            SessionWait.Text(snapshot.AuthorityEnvelope["persistentMemorySnapshot"])
        );
        Assert.Equal(
            "selected.md",
            snapshot.AuthorityEnvelope["systemPromptFiles"]![0]!.GetValue<string>()
        );
        Assert.Empty(snapshot.History);
        Assert.Empty(snapshot.Queue);
        Assert.NotEqual(
            f.Owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.ToString(),
            snapshot.AuthorityEnvelope["promptCacheKey"]!.ToString()
        );
        response = await f.ToolAsync(
            "create_session",
            new JsonObject
            {
                ["agentName"] = "target",
                ["sessionName"] = "override",
                ["node"] = "explicit-node",
                ["systemPromptFiles"] = new JsonArray(),
                ["forceModel"] = new JsonObject { ["effort"] = "medium" },
            }
        );
        Assert.True(response is JsonObject && response["error"] is null, response?.ToJsonString());
        var overridden = await f.Manager.RequiredAsync("target/override");
        Assert.Equal("explicit-node", f.Manager.CurrentNode(overridden));
        Assert.Equal("medium", overridden.Metadata().Effort);
        Assert.DoesNotContain(
            "selected creation memory",
            SessionWait.Text(
                overridden.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]
            )
        );
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Child_tool_node_override_keeps_identity_parent_display_and_fork_lineage(
        bool fork
    )
    {
        await using var f = await ExternalChannelFixture.CreateAsync();
        RegisterAgentTools(f);
        await f.Owner.UpdateCwdAsync("do-not-copy");
        var response = await f.ToolAsync(
            "create_child_session",
            new JsonObject
            {
                ["suffix"] = "worker",
                ["displayName"] = "",
                ["node"] = "offline-child-node",
                ["fork"] = fork,
            }
        );
        Assert.True(response is JsonObject && response["error"] is null, response?.ToJsonString());
        var child = await f.Manager.RequiredAsync("source_worker");
        Assert.Equal("source", child.Metadata().ParentSessionId);
        Assert.Equal("", child.Metadata().DisplayName);
        Assert.Equal("offline-child-node", f.Manager.CurrentNode(child));
        Assert.Null(child.Entry.Snapshot().AuthorityEnvelope["cwd"]);
        Assert.Empty(child.Entry.Snapshot().Queue);
        var parentKey = f.Owner.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.ToString();
        var childKey = child.Entry.Snapshot().AuthorityEnvelope["promptCacheKey"]!.ToString();
        Assert.Equal(fork, parentKey == childKey);
        Assert.Equal(fork ? "source" : null, child.Archive.ReadBranch()!.ParentSessionId);
    }

    [Fact]
    public async Task Session_new_and_no_argument_fork_use_the_Source_allocator_without_changing_attachment_contracts()
    {
        await using var f = await ExternalChannelFixture.CreateAsync(
            new JsonObject { ["alpha"] = ExternalChannelFixture.Channel() }
        );
        var replies = new List<string>();
        var source = new ExternalChannelContext(
            "alpha",
            "telegram",
            "synthetic-create",
            "11",
            "operator",
            text =>
            {
                replies.Add(text);
                return Task.CompletedTask;
            }
        );
        f.Manager.AttachChannel(source.Target, f.Owner);
        f.Manager.SessionNameClock = () => LocalTime;
        f.Manager.SessionNameRandom = () => 0.5;
        await f.Router.HandleExternalMessageAsync(
            source,
            new([new JsonObject { ["text"] = "/session new" }])
        );
        Assert.Equal(
            "1231_i",
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
        Assert.Contains("1231_i", replies.Single());
        Assert.Null((await f.Manager.RequiredAsync("1231_i")).Metadata().ParentSessionId);
        f.Manager.AttachChannel(source.Target, f.Owner);
        replies.Clear();
        await f.Router.HandleExternalMessageAsync(
            source,
            new([new JsonObject { ["text"] = "/fork" }])
        );
        Assert.Equal(
            "source",
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
        Assert.Equal(
            "source",
            (await f.Manager.RequiredAsync("source_1231_i")).Metadata().ParentSessionId
        );
        Assert.Contains("source_1231_i", replies.Single());
        Assert.Empty((await f.Manager.RequiredAsync("source_1231_i")).Entry.Snapshot().Queue);
        await f.Router.HandleExternalMessageAsync(
            source,
            new([new JsonObject { ["text"] = "/session fork" }])
        );
        Assert.Equal(
            "source_fork",
            SessionWait.Text(f.Manager.ChannelBinding(source.Target)?["sessionId"])
        );
        await f.Router.HandleMessageAsync(new(f.Owner.Id, "webui"), new("/fork explicit", null));
        Assert.NotNull(await f.Manager.GetExistingAsync("source_explicit"));
    }
}
