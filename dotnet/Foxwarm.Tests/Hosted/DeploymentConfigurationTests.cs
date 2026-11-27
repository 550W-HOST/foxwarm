using System.Net;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Blobs;
using Foxwarm.Models;

namespace Foxwarm.Tests.Hosted;

public sealed class DeploymentConfigurationTests
{
    [Fact]
    public void The_listener_uses_file_mode_rules_and_the_health_port_is_required()
    {
        var deployment = DeploymentConfiguration.Parse(
            "url: https://fox.example\nbot:\n  httpHost: '::'\n  httpPort: 3101\njournal:\n  retentionDays: 30\nhealth:\n  port: 3181\nblobs:\n  backend: postgres\n"
        );
        Assert.Equal(new IPEndPoint(IPAddress.IPv6Any, 3101), deployment.PublicEndpoint);
        Assert.Equal(new IPEndPoint(IPAddress.IPv6Any, 3181), deployment.HealthEndpoint);
        Assert.Equal(30d, deployment.Root["journal"]!["retentionDays"]!.GetValue<double>());
        // File mode's default port and wildcard address.
        Assert.Equal(
            new IPEndPoint(IPAddress.Any, 3001),
            DeploymentConfiguration.Parse("health: {port: 3081}\nblobs: {backend: postgres}\n").PublicEndpoint
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

    // Review 4b #7: a `url` template passes bootstrap, expands once per tenant, and a literal
    // URL stays as it is.
    [Fact]
    public void A_url_template_is_validated_by_its_expansion_and_expands_per_tenant()
    {
        var template = DeploymentConfiguration.Parse(
            "url: https://{slug}.tenants.example.com\nhealth: {port: 3081}\nblobs: {backend: postgres}\n"
        );
        Assert.True(template.UrlIsTemplate);
        Assert.Equal("https://alpha.tenants.example.com", template.ForTenant("alpha").Root["url"]!.GetValue<string>());
        Assert.Equal("https://beta.tenants.example.com", template.ForTenant("beta").Root["url"]!.GetValue<string>());
        // The shared document keeps the template.
        Assert.Equal("https://{slug}.tenants.example.com", template.Root["url"]!.GetValue<string>());
        var literal = DeploymentConfiguration.Parse("url: https://fox.example\nhealth: {port: 3081}\nblobs: {backend: postgres}\n");
        Assert.Same(literal, literal.ForTenant("alpha"));
        Assert.Equal("https://fox.example", literal.TenantOrigin("alpha"));
        // A template that doesn't expand to a valid URL still refuses.
        Assert.Contains(
            "url",
            Assert.Throws<HostedBootstrapException>(
                () => DeploymentConfiguration.Parse("url: https://{slug}.example.com?x=1\nhealth: {port: 3081}\nblobs: {backend: postgres}\n")
            ).Message
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
            .Parse("url: https://fox.example\nbot: {httpPort: 3101}\nhealth: {port: 3181}\nblobs: {backend: postgres}\n")
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
    private const string S3 =
        "blobs:\n  backend: s3\n  s3:\n    endpoint: http://versitygw:7070\n    region: us-east-1\n"
        + "    bucket: foxwarm-blobs\n    pathStyle: true\n"
        + "    accessKeyIdFile: /run/secrets/s3-access-key-id\n    secretAccessKeyFile: /run/secrets/s3-secret\n";

    [Fact]
    public void The_blob_backend_is_required_and_S3_names_its_connection_and_credential_files()
    {
        Assert.Equal(
            new BlobSettings(BlobBackend.Postgres, null),
            DeploymentConfiguration.Parse("health: {port: 3081}\nblobs: {backend: postgres}\n").Blobs
        );
        var s3 = DeploymentConfiguration.Parse("health: {port: 3081}\n" + S3).Blobs;
        Assert.Equal(BlobBackend.S3, s3.Backend);
        Assert.Equal(
            new S3BlobSettings(
                new Uri("http://versitygw:7070"),
                "us-east-1",
                "foxwarm-blobs",
                true,
                "/run/secrets/s3-access-key-id",
                "/run/secrets/s3-secret"
            ),
            s3.S3
        );
    }

    [Theory]
    [InlineData("", "`blobs.backend` is required")]
    [InlineData("blobs: {}\n", "`blobs.backend` is required")]
    [InlineData("blobs: postgres\n", "`blobs` must be a mapping")]
    [InlineData("blobs: {backend: files}\n", "`blobs.backend` must be `s3` or `postgres`")]
    [InlineData("blobs: {backend: postgres, cache: 1}\n", "`blobs.cache` isn't a setting")]
    [InlineData("blobs: {backend: postgres, s3: {}}\n", "`blobs.s3` applies only with `blobs.backend: s3`")]
    [InlineData("blobs: {backend: s3}\n", "`blobs.s3` is required")]
    [InlineData("blobs: {backend: s3, s3: {region: x}}\n", "`blobs.s3.endpoint` is required")]
    [InlineData("endpoint: ftp://x/", "`blobs.s3.endpoint` must be an http or https URL")]
    [InlineData("endpoint: http://x/bucket", "`blobs.s3.endpoint` must be an http or https URL")]
    [InlineData("region: ''", "`blobs.s3.region` must be a nonempty string")]
    [InlineData("bucket: Foxwarm_Blobs", "`blobs.s3.bucket` must be an S3 bucket name")]
    [InlineData("pathStyle: 'yes'", "`blobs.s3.pathStyle` must be true or false")]
    [InlineData("accessKeyIdFile: secrets/id", "`blobs.s3.accessKeyIdFile` must be an absolute path")]
    [InlineData("secretAccessKey: abc", "`blobs.s3.secretAccessKey` isn't a setting")]
    public void Invalid_or_missing_blob_settings_refuse_startup_naming_the_key(string change, string message)
    {
        var text = change.StartsWith("blobs", StringComparison.Ordinal) || change.Length == 0
            ? change
            : Replace(S3, change);
        Assert.Contains(
            message,
            Assert.Throws<HostedBootstrapException>(() =>
                DeploymentConfiguration.Parse("health: {port: 3081}\n" + text)
            ).Message
        );

        static string Replace(string yaml, string change)
        {
            var key = change[..change.IndexOf(':')];
            var lines = yaml.Split('\n').ToList();
            var index = lines.FindIndex(line => line.TrimStart().StartsWith(key + ":", StringComparison.Ordinal));
            if (index < 0)
                lines.Insert(lines.Count - 1, "    " + change);
            else
                lines[index] = "    " + change;
            return string.Join('\n', lines);
        }
    }

    [Fact]
    public void S3_credentials_come_from_the_named_files()
    {
        using var temp = new TempDirectory();
        var settings = DeploymentConfiguration
            .Parse("health: {port: 3081}\n" + S3.Replace("/run/secrets", temp.Path))
            .Blobs.S3!;
        File.WriteAllText(Path.Combine(temp.Path, "s3-access-key-id"), "AKID\n");
        File.WriteAllText(Path.Combine(temp.Path, "s3-secret"), " secret value \n");
        Assert.Equal(("AKID", "secret value"), settings.ReadCredentials());
        File.WriteAllText(Path.Combine(temp.Path, "s3-secret"), "\n");
        Assert.Contains(
            "`blobs.s3.secretAccessKeyFile` is empty",
            Assert.Throws<HostedBootstrapException>(() => settings.ReadCredentials()).Message
        );
        File.Delete(Path.Combine(temp.Path, "s3-access-key-id"));
        Assert.Contains(
            "`blobs.s3.accessKeyIdFile` can't be read",
            Assert.Throws<HostedBootstrapException>(() => settings.ReadCredentials()).Message
        );
    }

    private static string TenantRefusal(string text, TenantProfile profile) =>
        Assert.Throws<InvalidDataException>(() =>
            AppConfigurationSplit.RequireTenantDocument(ConfigurationYaml.Parse(text, "app config"), profile)
        ).Message;

    // P2 plan §6.1: the tenant document holds only its profile's paths, and a refusal names the
    // key in the shape P1 uses for unavailable features.
    [Fact]
    public void A_tenant_document_holds_only_its_profiles_paths_and_a_refusal_names_the_key()
    {
        const string Tenant =
            "access: {identities: {}}\nagentTree: {maxDepth: 3}\nnodeTree: {maxChildren: 8}\n"
            + "agentDefaultNode: devbox\nsessionAutoTitle: true\nchannels: {}\n"
            + "llm: {memoryWarningThresholdPercent: 0.2}\nbot: {name: Fox}\n";
        foreach (var profile in new[] { TenantProfile.Hosted, TenantProfile.Operator })
        {
            AppConfigurationSplit.RequireTenantDocument(ConfigurationYaml.Parse(Tenant, "app config"), profile);
            foreach (var (text, message) in new[]
            {
                // Unknown keys, top-level and under `bot`.
                ("handoff: true\n", "app config `handoff` isn't a tenant setting."),
                ("bot: {color: red}\n", "app config `bot.color` isn't a tenant setting."),
                // Operator settings: a tenant of either profile can't configure a Provider.
                ("nodeProviders: {extra: {type: executable, command: /bin/true}}\n",
                    "app config `nodeProviders` is a deployment setting; set it in the deployment configuration."),
                ("url: https://fox.example\n",
                    "app config `url` is a deployment setting; set it in the deployment configuration."),
                ("vector: false\n", "app config `vector` isn't available in hosted mode."),
                ("paths: {agentsDir: /srv}\n", "app config `paths` isn't available in hosted mode."),
            })
                Assert.Equal(message, TenantRefusal(text, profile));
        }
        // The Claude runtime's settings belong to the operator profile only.
        Assert.Equal(
            "app config `claudeCode` isn't available in hosted mode.",
            TenantRefusal("claudeCode: {executable: claude}\n", TenantProfile.Hosted)
        );
        AppConfigurationSplit.RequireTenantDocument(
            ConfigurationYaml.Parse("claudeCode: {executable: claude}\n", "app config"),
            TenantProfile.Operator
        );
        // The allowlists never overlap the deployment's paths.
        foreach (var profile in new[] { TenantProfile.Hosted, TenantProfile.Operator })
            Assert.Empty(AppConfigurationSplit.TenantPaths(profile).Intersect(AppConfigurationSplit.DeploymentPaths));
    }

    [Fact]
    public void Import_refuses_a_WeWork_callback_listener()
    {
        var refused = Assert.Throws<Foxwarm.Hosted.Import.ImportRefusedException>(() =>
            Foxwarm.Hosted.Import.ConfigSplit.Split(
                "channels:\n  wework:\n    token: synthetic\n    encodingAESKey: synthetic\n    listenPort: 18731\n    listenPath: /wework\n"
            )
        );
        Assert.Equal(
            "config.yaml: WeWork callback mode isn't available in this deployment; use WebSocket mode.",
            refused.Message
        );
        Foxwarm.Hosted.Import.ConfigSplit.Split(
            "channels:\n  wework:\n    aibot:\n      websocket: {enabled: true, botId: synthetic, secret: synthetic}\n"
        );
    }

    // Paths are key segments: a literal top-level key containing a dot is one unknown key, never
    // the nested setting it spells.
    [Fact]
    public void A_literal_dotted_key_is_not_the_nested_setting_it_spells()
    {
        var literal = Foxwarm.ConfigurationYaml.Parse("\"bot.name\": Fox\n", "app config");
        Assert.Equal(
            "app config `bot.name` isn't a tenant setting.",
            Assert.Throws<InvalidDataException>(() => AppConfigurationSplit.RequireTenantDocument(literal)).Message
        );
        var loaded = AppConfigurationSplit.LoadTenantDocument(
            Foxwarm.ConfigurationYaml.Parse("\"bot.name\": Fox\nbot:\n  name: Real\n", "app config"),
            TenantProfile.Hosted,
            out var ignored
        );
        Assert.Equal(["bot.name"], ignored);
        Assert.False(loaded.ContainsKey("bot.name"));
        Assert.Equal("Real", loaded["bot"]!["name"]!.GetValue<string>());
        // A literal `url.x` isn't a deployment setting either.
        Assert.Equal(
            "app config `url.x` isn't a tenant setting.",
            Assert.Throws<InvalidDataException>(() =>
                AppConfigurationSplit.RequireTenantDocument(Foxwarm.ConfigurationYaml.Parse("\"url.x\": 1\n", "app config"))
            ).Message
        );
    }

    [Fact]
    public void Import_drops_a_literal_dotted_key_and_splits_journal_at_its_deployment_child()
    {
        var split = Foxwarm.Hosted.Import.ConfigSplit.Split(
            "sessionAutoTitle: true\n\"bot.name\": Literal\nbot:\n  name: Fox\njournal:\n  retentionDays: 7\n  compress: true\n"
        );
        Assert.Equal(
            ["bot.name", "journal.compress"],
            split.Dropped.Select(item => item.Key).Order(StringComparer.Ordinal).ToArray()
        );
        Assert.Equal("Literal", split.Dropped.Single(item => item.Key == "bot.name").Value!.GetValue<string>());
        Assert.True(split.Dropped.Single(item => item.Key == "journal.compress").Value!.GetValue<bool>());
        Assert.Equal("Fox", split.Tenant["bot"]!["name"]!.GetValue<string>());
        Assert.False(split.Tenant.ContainsKey("bot.name"));
        Assert.False(split.Tenant.ContainsKey("journal"));
        Assert.Equal(7, split.Deployment["journal"]!["retentionDays"]!.GetValue<double>());
        Assert.False(split.Deployment["journal"]!.AsObject().ContainsKey("compress"));
    }
}
