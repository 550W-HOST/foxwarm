using System.Net;
using Foxwarm.Hosted;
using Foxwarm.Models;

namespace Foxwarm.Tests.Hosted;

public sealed class DeploymentConfigurationTests
{
    [Fact]
    public void The_listener_uses_file_mode_rules_and_the_health_port_is_required()
    {
        var deployment = DeploymentConfiguration.Parse(
            "url: https://fox.example\nbot:\n  httpHost: '::'\n  httpPort: 3101\njournal:\n  retentionDays: 30\nhealth:\n  port: 3181\n"
        );
        Assert.Equal(new IPEndPoint(IPAddress.IPv6Any, 3101), deployment.PublicEndpoint);
        Assert.Equal(new IPEndPoint(IPAddress.IPv6Any, 3181), deployment.HealthEndpoint);
        Assert.Equal(30d, deployment.Root["journal"]!["retentionDays"]!.GetValue<double>());
        // File mode's default port and wildcard address.
        Assert.Equal(
            new IPEndPoint(IPAddress.Any, 3001),
            DeploymentConfiguration.Parse("health: {port: 3081}\n").PublicEndpoint
        );
        foreach (
            var (text, message) in new[]
            {
                ("url: https://fox.example\n", "`health.port` is required"),
                ("health: {port: 0}\n", "`health.port` must be a port number"),
                ("health: {port: 3081, path: /x}\n", "`health.path`"),
                ("bot: {httpHost: localhost}\nhealth: {port: 3081}\n", "bot.httpHost"),
                ("bot: {httpPort: 70000}\nhealth: {port: 3081}\n", "bot.httpPort"),
            }
        )
            Assert.Contains(
                message,
                Assert.Throws<HostedBootstrapException>(() => DeploymentConfiguration.Parse(text)).Message
            );
    }

    [Theory]
    [InlineData("access: {}\n", "access", "isn't a deployment setting")]
    [InlineData("bot: {name: Fox}\n", "bot.name", "isn't a deployment setting")]
    [InlineData("channels: {}\n", "channels", "isn't a deployment setting")]
    [InlineData("journal: {enabled: false}\n", "journal.enabled", "isn't a deployment setting")]
    [InlineData("sessionWorkers: {}\n", "sessionWorkers", "isn't available in hosted mode")]
    [InlineData("dbWorkers: true\n", "dbWorkers", "isn't available in hosted mode")]
    [InlineData("vector: {enabled: false}\n", "vector", "isn't available in hosted mode")]
    [InlineData("claudeCode: {}\n", "claudeCode", "isn't available in hosted mode")]
    [InlineData("bot: {enableTUI: false}\n", "bot.enableTUI", "isn't available in hosted mode")]
    [InlineData("bot: {enableTrigger: true}\n", "bot.enableTrigger", "isn't available in hosted mode")]
    [InlineData("paths: {agentsDir: /x}\n", "paths", "isn't available in hosted mode")]
    public void Startup_refuses_every_setting_but_the_deployment_paths_naming_it(
        string text,
        string key,
        string reason
    )
    {
        var error = Assert.Throws<HostedBootstrapException>(() =>
            DeploymentConfiguration.Parse(text + "health: {port: 3081}\n")
        );
        Assert.Contains("`" + key + "`", error.Message);
        Assert.Contains(reason, error.Message);
    }

    [Fact]
    public void The_deployment_and_tenant_key_sets_are_disjoint_and_the_merge_overlays_deployment_values()
    {
        var deployment = DeploymentConfiguration
            .Parse("url: https://fox.example\nbot: {httpPort: 3101}\nhealth: {port: 3181}\n")
            .Root;
        var tenant = ConfigurationYaml.Parse("bot: {name: Fox}\nsessionAutoTitle: false\n", "app config");
        AppConfigurationSplit.RequireTenantDocument(tenant);
        var effective = AppConfigurationSplit.Merge(deployment, tenant);
        Assert.Equal("Fox", effective["bot"]!["name"]!.GetValue<string>());
        Assert.Equal(3101d, effective["bot"]!["httpPort"]!.GetValue<double>());
        Assert.Equal("https://fox.example", effective["url"]!.GetValue<string>());
        Assert.False(tenant["bot"]!.AsObject().ContainsKey("httpPort"));
        foreach (var path in AppConfigurationSplit.DeploymentPaths)
            Assert.DoesNotContain(path, AppConfigurationSplit.UnavailablePaths);
        foreach (
            var (text, key) in new[]
            {
                ("journal: {retentionDays: 3}\n", "journal"),
                ("journal: {enabled: false}\n", "journal"),
                ("health: {port: 1}\n", "health"),
                ("bot: {httpHost: 0.0.0.0}\n", "bot.httpHost"),
                ("asrService: {}\n", "asrService"),
            }
        )
            Assert.Contains(
                "`" + key + "`",
                Assert.Throws<InvalidDataException>(() =>
                    AppConfigurationSplit.RequireTenantDocument(ConfigurationYaml.Parse(text, "app config"))
                ).Message
            );
    }
}
