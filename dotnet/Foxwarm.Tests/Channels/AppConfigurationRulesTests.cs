using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Tests;

public sealed class AppConfigurationRulesTests
{
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
