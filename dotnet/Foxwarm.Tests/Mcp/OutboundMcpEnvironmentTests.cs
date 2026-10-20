using System.Text.Json.Nodes;

namespace Foxwarm.Tests;

public sealed class OutboundMcpEnvironmentTests
{
    [Fact]
    public async Task Actual_stdio_uses_platform_safe_defaults_then_explicit_overlay_without_full_Main_environment()
    {
        await using var fixture = await OutboundMcpFixture.CreateAsync();
        var inherited = OperatingSystem.IsWindows() ? "APPDATA" : "LOGNAME";
        var overlaid = OperatingSystem.IsWindows() ? "USERPROFILE" : "HOME";
        var secret = "FOXWARM_MCP_ENVIRONMENT_PRIVATE_SENTINEL";
        var filtered = OperatingSystem.IsWindows() ? "PROCESSOR_ARCHITECTURE" : "SHELL";
        var keys = new[] { inherited, overlaid, secret, filtered };
        var original = keys.ToDictionary(key => key, Environment.GetEnvironmentVariable);
        try
        {
            Environment.SetEnvironmentVariable(inherited, "safe-inherited-value");
            Environment.SetEnvironmentVariable(overlaid, "parent-value");
            Environment.SetEnvironmentVariable(secret, "must-not-be-inherited");
            Environment.SetEnvironmentVariable(filtered, "() { forbidden function; }");
            await fixture.Mcp.ConfigureAsync(new JsonObject
            {
                ["name"] = "peer", ["transport"] = "stdio", ["command"] = "node",
                ["args"] = new JsonArray(OutboundSdkPeer.Script, "stdio", Path.Combine(fixture.Temp.Path, "environment")),
                ["env"] = new JsonObject { [overlaid] = "explicit-overlay", ["FOXWARM_MCP_EXPLICIT"] = "configured-only" },
                ["stderr"] = "pipe",
            }, default);
            var result = await fixture.CallAsync(fixture.First, "result", new JsonObject
            {
                ["kind"] = "environment", ["names"] = new JsonArray(keys.Append("FOXWARM_MCP_EXPLICIT").Select(key => (JsonNode?)JsonValue.Create(key)).ToArray()),
            });
            Assert.Equal("safe-inherited-value", result![inherited]!.GetValue<string>());
            Assert.Equal("explicit-overlay", result[overlaid]!.GetValue<string>());
            Assert.Null(result[secret]);
            Assert.Null(result[filtered]);
            Assert.Equal("configured-only", result["FOXWARM_MCP_EXPLICIT"]!.GetValue<string>());
        }
        finally
        {
            foreach (var (key, value) in original)
                Environment.SetEnvironmentVariable(key, value);
        }
    }
}
