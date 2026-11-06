using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Tests;

public sealed class MemorySizeTests
{
    private static HostModels Models(double? limit = null, double? fraction = null)
    {
        var app = new JsonObject();
        if (fraction is not null)
            app["llm"] = new JsonObject { ["memoryWarningThresholdPercent"] = fraction };
        AppConfigurationRules.Validate(app);
        var provider = new JsonObject
        {
            ["providerType"] = "anthropic",
            ["baseUrl"] = "http://localhost",
            ["extraFields"] = new JsonObject { ["stream"] = false },
            ["models"] = new JsonArray("m"),
        };
        if (limit is not null)
            provider["contextLimit"] = limit;
        return HostModels.Parse(
            new JsonObject
            {
                ["default"] = "a/m",
                ["providers"] = new JsonObject { ["a"] = provider },
            },
            app
        );
    }

    [Fact]
    public void Threshold_uses_the_existing_estimator_effective_window_and_strict_comparison()
    {
        var snapshot = ConditionalMemory.BuildCurrentModelSnapshot("a/m", "lasting rules 中文 😀");
        var tokens = CompactCandidateBuilder.Tokens(snapshot);
        var atLimit = MemorySize.Measure(snapshot, Models(tokens * 10, .1));
        Assert.Equal(tokens, atLimit.EstimatedTokens);
        Assert.Equal(Encoding.UTF8.GetByteCount(snapshot), atLimit.Bytes);
        Assert.False(atLimit.OverThreshold);
        Assert.True(MemorySize.Measure(snapshot, Models((int)(tokens / .15))).OverThreshold);
        Assert.False(MemorySize.Measure(snapshot, Models((int)(tokens / .15), .5)).OverThreshold);
        Assert.Equal(tokens / 200000d, MemorySize.Measure(snapshot, Models()).ContextFraction);
        Assert.Null(MemorySize.Measure(snapshot, null).ContextFraction);
        Assert.False(MemorySize.Measure(snapshot, null).OverThreshold);
        Assert.Null(MemorySize.Measure("markerless snapshot", Models()).ContextFraction);
    }

    [Theory]
    [InlineData("llm: {}", .15)]
    [InlineData("llm:\n  memoryWarningThresholdPercent: 0.25", .25)]
    public void Configuration_parses_default_and_override(string yaml, double expected)
    {
        using var temp = new TempDirectory();
        Directory.CreateDirectory(Path.Combine(temp.Path, "state"));
        File.WriteAllText(Path.Combine(temp.Path, "state", "config.yaml"), yaml);
        File.WriteAllText(
            Path.Combine(temp.Path, "state", "models.yaml"),
            "providers:\n  a:\n    providerType: anthropic\n    models: [m]\n"
        );
        var configuration = new ModelConfiguration(temp.Path);
        Assert.Equal(expected, configuration.Models.Capture().MemoryWarningThresholdFraction);
    }

    [Theory]
    [InlineData("0")]
    [InlineData("1.1")]
    [InlineData("null")]
    [InlineData("\"0.15\"")]
    public void Configuration_rejects_invalid_fractions(string value)
    {
        var app = JsonNode
            .Parse("{\"llm\":{\"memoryWarningThresholdPercent\":" + value + "}}")!
            .AsObject();
        Assert.Throws<InvalidDataException>(() => AppConfigurationRules.Validate(app));
    }

    [Fact]
    public async Task Snapshot_warning_is_built_once_and_reused_byte_for_byte_by_chat()
    {
        using var temp = new TempDirectory();
        var work = Path.Combine(temp.Path, "work");
        var agents = new AgentCatalog(temp.Path, work);
        var dir = Path.Combine(work, "memory");
        Directory.CreateDirectory(Path.Combine(dir, "reference"));
        var source = Path.Combine(dir, "RULES.md");
        await File.WriteAllTextAsync(source, new string('x', 10000));
        await File.WriteAllTextAsync(
            Path.Combine(dir, "reference", "LARGE.md"),
            new string('z', 100000)
        );
        var warnings = new List<string>();
        var models = Models(1000);
        var memory = new AgentMemory(
            agents,
            new Skills(agents, Path.Combine(temp.Path, "skills")),
            models: models,
            warning: warnings.Add
        );
        var baseline = await new AgentMemory(
            agents,
            new Skills(agents, Path.Combine(temp.Path, "skills"))
        ).BuildAsync("main", "s", "a/m");
        var snapshot = await memory.BuildAsync("main", "s", "a/m");
        Assert.StartsWith(baseline + "\n\nMemory notice:", snapshot);
        Assert.DoesNotContain(new string('z', 100), snapshot);
        Assert.Equal(1, snapshot.Split('\n').Count(line => line.StartsWith("Memory notice:")));
        Assert.Equal("a/m", ConditionalMemory.ReadCurrentModelSnapshotId(snapshot));
        Assert.Contains("Agent=main Session=s", Assert.Single(warnings));

        using var http = new HttpClient(new Peer());
        var options = new ResponsesClientOptions(
            new Uri("http://localhost"),
            "m",
            "a/m",
            "",
            "base",
            100
        );
        var requests = new ModelRequestOwner(http, options, new ModelRouting());
        var owner = new SessionOwner("s", "main", models);
        var chat = new SessionChatService(requests, options, owner, models, memory, (_, _) => { });
        owner.Registry = new SessionRegistry(new InMemorySessionAuthorityStore(), chat);
        owner.Registry.Add("s");
        await owner.Entry.SaveLane.CommitMemorySnapshotAsync(snapshot);
        await chat.ChatAsync("s", [], CancellationToken.None);
        await chat.ChatAsync("s", [], CancellationToken.None);
        Assert.Single(warnings);
        Assert.Equal(
            snapshot,
            owner.Entry.Snapshot().AuthorityEnvelope["persistentMemorySnapshot"]!.GetValue<string>()
        );

        await File.WriteAllTextAsync(source, "Keep lasting rules.");
        var largeWindow = Models(200000);
        var quiet = new AgentMemory(
            agents,
            new Skills(agents, Path.Combine(temp.Path, "skills")),
            models: largeWindow,
            warning: warnings.Add
        );
        var unchanged = await new AgentMemory(
            agents,
            new Skills(agents, Path.Combine(temp.Path, "skills"))
        ).BuildAsync("main", "s", "a/m");
        Assert.Equal(unchanged, await quiet.BuildAsync("main", "s", "a/m"));
        Assert.Single(warnings);
    }

    private sealed class Peer : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken
        ) =>
            Task.FromResult(
                new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}"
                    ),
                }
            );
    }
}
