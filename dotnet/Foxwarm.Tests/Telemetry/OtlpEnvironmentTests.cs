using Foxwarm.Models;
using Foxwarm.Telemetry;

namespace Foxwarm.Tests;

[CollectionDefinition("OTLP process environment", DisableParallelization = true)]
public sealed class OtlpEnvironmentCollection;

[Collection("OTLP process environment")]
public sealed class OtlpEnvironmentTests
{
    [Theory]
    [InlineData(null, "disk", true)]
    [InlineData(null, "unknown", true)]
    [InlineData("true", "disk", false)]
    public async Task Unsupported_process_policies_disable_export_without_preventing_startup(
        string? disabled,
        string retry,
        bool warns
    )
    {
        using var temp = new TempDirectory();
        var state = Path.Combine(temp.Path, "state");
        Directory.CreateDirectory(state);
        File.WriteAllText(
            Path.Combine(state, "config.yaml"),
            "otlp: {endpoint: 'http://127.0.0.1:1/v1/traces'}"
        );
        var keys = new Dictionary<string, string?>
        {
            ["OTEL_SDK_DISABLED"] = disabled,
            ["OTEL_DOTNET_EXPERIMENTAL_OTLP_RETRY"] = retry,
            ["OTEL_DOTNET_EXPERIMENTAL_OTLP_DISK_RETRY_DIRECTORY_PATH"] = Path.Combine(
                temp.Path,
                "spool"
            ),
        };
        var previous = keys.ToDictionary(
            pair => pair.Key,
            pair => Environment.GetEnvironmentVariable(pair.Key)
        );
        var stderr = Console.Error;
        using var warnings = new StringWriter();
        try
        {
            foreach (var (key, value) in keys)
                Environment.SetEnvironmentVariable(key, value);
            Console.SetError(warnings);
            var config = new ModelConfiguration(temp.Path);
            await using var host = await MainHost.CreateAsync(
                [],
                config,
                new(
                    0,
                    "",
                    "127.0.0.1",
                    new("http://127.0.0.1", "", "/", false),
                    false,
                    HttpEnabled: false
                )
            );
            var owner = await host.Sessions.CreateNamedAsync("main", "trace", null, null);
            Assert.Null(owner.Registry.Traces);
            Assert.Equal(
                warns ? 1 : 0,
                warnings
                    .ToString()
                    .Split('\n')
                    .Count(line => line.Contains("OTLP tracing disabled"))
            );
            Assert.False(Directory.Exists(Path.Combine(temp.Path, "spool")));
        }
        finally
        {
            Console.SetError(stderr);
            foreach (var (key, value) in previous)
                Environment.SetEnvironmentVariable(key, value);
        }
    }
}
