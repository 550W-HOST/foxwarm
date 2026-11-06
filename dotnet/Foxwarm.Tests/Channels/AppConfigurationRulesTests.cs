using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class AppConfigurationRulesTests
{
    [Theory]
    [InlineData("null")]
    [InlineData("1000")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("[null]")]
    [InlineData("[-1]")]
    [InlineData("[0.5]")]
    [InlineData("[2147483648]")]
    [InlineData("[.inf]")]
    [InlineData("[.nan]")]
    [InlineData("['1000']")]
    [InlineData("[true]")]
    public void RejectsInvalidRetryIntervals(string value)
    {
        Assert.Throws<InvalidDataException>(() =>
            AppConfigurationRules.Validate(
                ConfigurationYaml.Parse("llm: { retryIntervalsMs: " + value + " }", "app config")
            )
        );
    }

    [Theory]
    [InlineData(new int[] { 0 })]
    [InlineData(new int[] { 17000, 25000 })]
    [InlineData(new int[] { int.MaxValue })]
    public async Task RetryIntervalSavesRequireRestartAndInvalidSavesPreserveConfiguration(
        int[] intervals
    )
    {
        using var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path, environment: _ => null);
        Directory.CreateDirectory(Path.GetDirectoryName(paths.ConfigPath)!);
        await File.WriteAllTextAsync(paths.ConfigPath, "llm: {}\n");
        await File.WriteAllTextAsync(
            paths.ModelsPath,
            "providers: { local: { baseUrl: 'http://localhost', models: [m] } }\n"
        );
        var configuration = new ModelConfiguration(paths);
        int[] defaults = [2000, 5000, 10000, 20000, 40000, 60000];
        Assert.Equal(defaults, configuration.Capture().RetryIntervalsMs);

        var yaml =
            "llm: { retryIntervalsMs: "
            + System.Text.Json.JsonSerializer.Serialize(intervals)
            + " }\n";
        var receipt = await configuration.SaveAppAsync(yaml);
        Assert.Contains(
            "llm",
            receipt["restartRequired"]!.AsArray().Select(value => value!.GetValue<string>())
        );
        Assert.Equal(yaml, await File.ReadAllTextAsync(paths.ConfigPath));
        Assert.Equal(defaults, configuration.Capture().RetryIntervalsMs);
        await configuration.SaveAsync(
            new JsonObject { ["yaml"] = await File.ReadAllTextAsync(paths.ModelsPath) }
        );
        Assert.Equal(defaults, configuration.Capture().RetryIntervalsMs);
        Assert.Equal(intervals, new ModelConfiguration(paths).Capture().RetryIntervalsMs);

        await Assert.ThrowsAsync<InvalidDataException>(() =>
            configuration.SaveAppAsync("llm: { retryIntervalsMs: [] }")
        );
        Assert.Equal(yaml, await File.ReadAllTextAsync(paths.ConfigPath));
        await configuration.SaveAppAsync("llm: {}\n");
        Assert.Equal(defaults, new ModelConfiguration(paths).Capture().RetryIntervalsMs);
    }

    [Fact]
    public void AcceptsExecutableProviderConfiguration()
    {
        var app = ConfigurationYaml.Parse(
            """
            url: http://127.0.0.1:3000/preview
            llm:
              compactPercent: 0.3
              compactThresholdPercent: 0.85
              ollamaBaseUrl: 42
            nodeProviders:
              external:
                type: executable
                command: /bin/echo
                args: []
                timeoutSeconds: 90
            vector: false
            access:
              identities:
                external:
                  token: opaque-token
                  surfaces: { mcp: {} }
            """,
            "app config"
        );

        AppConfigurationRules.Validate(app);
    }

    [Fact]
    public void RejectsSourceInvalidNullBoundsAndMcpIdentityRules()
    {
        var invalid = new[]
        {
            "sessionWorkers: { idleSeconds: null }",
            "nodeProviders: { p: { type: docker-worktree, command: /bin/echo } }",
            "vectorMaintenance: { retentionHours: null }",
            "nodeProviders: { p: { type: executable, command: /bin/echo, timeoutSeconds: null } }",
            "access: { identities: { a: { token: x, surfaces: {} } } }",
            "access: { identities: { "
                + new string('a', 129)
                + ": { token: x, surfaces: {mcp: {}} } } }",
            "access: { identities: { a: { token: same, surfaces: {mcp: {}} }, b: { token: same, surfaces: {mcp: {}} } } }",
        };

        foreach (var yaml in invalid)
        {
            var app = ConfigurationYaml.Parse(yaml, "app config");
            Assert.Throws<InvalidDataException>(() => AppConfigurationRules.Validate(app));
        }
    }

    [Fact]
    public void RejectsPublicUrlCharactersSourceRejects()
    {
        foreach (
            var url in new[]
            {
                "http://bad\\host",
                "http://bad/path?query",
                "http://bad/path#fragment",
            }
        )
        {
            var app = new JsonObject { ["url"] = url };
            Assert.Throws<InvalidDataException>(() => AppConfigurationRules.Validate(app));
        }
    }
}
