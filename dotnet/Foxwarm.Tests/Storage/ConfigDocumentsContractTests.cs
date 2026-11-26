using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Hosted;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Models;
using Foxwarm.Storage;
using Foxwarm.Tests.Hosted;
using Foxwarm.Tools;

namespace Foxwarm.Tests;

/// <summary>
/// Observable behavior every <see cref="IConfigDocumentStore"/> shares, and the owners that
/// read and install through it: verbatim text, live application of an installation, the first
/// run, and the tool-authorization guarantees. The file backend is file mode; the PostgreSQL
/// backend is hosted mode, whose app configuration is split from the deployment configuration.
/// File-only rules (paths, modes, hand edits) stay in the existing configuration tests.
/// </summary>
public abstract class ConfigDocumentsContractTests
{
    private protected const string LocalModels =
        "default: local/wire\nproviders:\n  local:\n    providerType: openai-responses\n    baseUrl: http://127.0.0.1:1\n    models: [wire]\n";

    private protected abstract Task<Backend> CreateAsync();

    private protected sealed class Backend(
        IConfigDocumentStore documents,
        Func<ModelConfiguration> open,
        string root,
        Func<ValueTask> dispose
    ) : IAsyncDisposable
    {
        internal IConfigDocumentStore Documents { get; } = documents;

        /// <summary>A configuration owner over the store, as a fresh start builds it.</summary>
        internal ModelConfiguration Open() => open();

        /// <summary>The data root (file mode) or the replica's scratch directory (hosted).</summary>
        internal string Root { get; } = root;

        public ValueTask DisposeAsync() => dispose();
    }

    [Fact]
    public async Task Every_document_reads_absent_then_returns_the_replaced_bytes_verbatim()
    {
        await using var backend = await CreateAsync();
        var store = backend.Documents;
        foreach (var name in Enum.GetValues<ConfigDocumentName>())
        {
            Assert.False(store.Exists(name));
            Assert.Null(store.Read(name));
            Assert.Null(store.ReadBounded(name, 1024));
            // A byte order mark, CRLF, comments and non-ASCII text survive unchanged.
            byte[] first = [0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes("# Grüße 🦊\r\nkey:  value \r\n")];
            await store.ReplaceAsync(name, first, CancellationToken.None);
            Assert.True(store.Exists(name));
            Assert.Equal(first, store.Read(name));
            Assert.Equal(first, store.ReadBounded(name, 1024));
            Assert.Equal("# Grüße 🦊\r\nkey:  value \r\n", ConfigDocumentText.Decode(store.Read(name)!));
            var second = Encoding.UTF8.GetBytes("{\"version\":2}");
            await store.ReplaceAsync(name, second, CancellationToken.None);
            Assert.Equal(second, store.Read(name));
        }
    }

    [Fact]
    public async Task Documents_are_independent_and_have_distinct_locators()
    {
        await using var backend = await CreateAsync();
        var store = backend.Documents;
        await store.ReplaceAsync(ConfigDocumentName.Models, [0x61], CancellationToken.None);
        Assert.Null(store.Read(ConfigDocumentName.Config));
        var names = Enum.GetValues<ConfigDocumentName>();
        Assert.Equal(names.Length, names.Select(store.Locator).Distinct().Count());
        foreach (var name in names)
            Assert.Equal(store.DirectEdits, store.PhysicalPath(name) is not null);
    }

    [Fact]
    public async Task Create_if_absent_keeps_an_existing_document()
    {
        await using var backend = await CreateAsync();
        var store = backend.Documents;
        Assert.True(await store.TryCreateAsync(ConfigDocumentName.Config, [0x61], CancellationToken.None));
        Assert.False(await store.TryCreateAsync(ConfigDocumentName.Config, [0x62], CancellationToken.None));
        Assert.Equal([0x61], store.Read(ConfigDocumentName.Config));
    }

    [Fact]
    public async Task A_bounded_read_over_the_limit_throws_instead_of_reading_absent()
    {
        await using var backend = await CreateAsync();
        var store = backend.Documents;
        await store.ReplaceAsync(
            ConfigDocumentName.ToolAuthorization,
            Encoding.UTF8.GetBytes(new string('#', 100)),
            CancellationToken.None
        );
        Assert.Throws<InvalidDataException>(() =>
            store.ReadBounded(ConfigDocumentName.ToolAuthorization, 99)
        );
        Assert.Equal(100, store.ReadBounded(ConfigDocumentName.ToolAuthorization, 100)!.Length);
    }

    [Fact]
    public async Task App_installation_stores_the_text_verbatim_and_applies_live_settings()
    {
        await using var backend = await CreateAsync();
        var configuration = backend.Open();
        const string raw = "# kept comment\nsessionAutoTitle: true   # inline\nagentDefaultNode: build-01\nllm:\n  compactThresholdPercent: 0.8\n";
        var installed = await configuration.SaveAppAsync(raw);
        Assert.Equal(Encoding.UTF8.GetBytes(raw), backend.Documents.Read(ConfigDocumentName.Config));
        Assert.Equal(raw, configuration.ReadCurrentAppRaw());
        Assert.Equal(raw, configuration.ConfigDiagnostics()["rawYaml"]!.GetValue<string>());
        // Live settings apply at once; startup snapshots report a restart.
        Assert.True(configuration.SessionAutoTitleEnabled);
        Assert.Equal("build-01", configuration.AgentDefaultNode);
        var applied = installed["applied"]!.AsArray().Select(item => item!.GetValue<string>()).ToArray();
        Assert.Contains("sessionAutoTitle", applied);
        Assert.Contains("agentDefaultNode", applied);
        Assert.Equal(
            ["llm"],
            installed["restartRequired"]!.AsArray().Select(item => item!.GetValue<string>())
        );
        // A later start reads the installed document.
        var reopened = backend.Open();
        Assert.Equal(raw, reopened.AppRaw);
        Assert.True(reopened.SessionAutoTitleEnabled);
        Assert.Equal(0.8, reopened.CompactThreshold);
    }

    [Fact]
    public async Task A_first_models_installation_ends_the_first_run_and_seeds_the_app_document()
    {
        await using var backend = await CreateAsync();
        var configuration = backend.Open();
        Assert.True(configuration.Diagnostics()["oobe"]!.GetValue<bool>());
        Assert.False(configuration.ModelsInstalled);
        Assert.False(backend.Documents.Exists(ConfigDocumentName.Config));
        await configuration.SaveAsync(new JsonObject { ["yaml"] = LocalModels });
        Assert.True(configuration.ModelsInstalled);
        Assert.False(configuration.Diagnostics()["oobe"]!.GetValue<bool>());
        Assert.Equal(Encoding.UTF8.GetBytes(LocalModels), backend.Documents.Read(ConfigDocumentName.Models));
        Assert.Equal("local/wire", configuration.Capture().DefaultKey);
        // The template seeds the app document once; it holds only tenant settings.
        var seeded = backend.Documents.Read(ConfigDocumentName.Config);
        Assert.NotNull(seeded);
        AppConfigurationSplit.RequireTenantDocument(
            ConfigurationYaml.Parse(ConfigDocumentText.Decode(seeded), "app config")
        );
        Assert.Equal("local/wire", backend.Open().Capture().DefaultKey);
    }

    [Fact]
    public async Task The_mcp_and_WebUI_documents_round_trip_through_their_owners()
    {
        await using var backend = await CreateAsync();
        var mcp = new McpConfiguration(backend.Documents);
        await mcp.UpdateAsync(
            "remote",
            new JsonObject { ["url"] = "https://mcp.example/mcp", ["transport"] = "streamable-http" },
            enabledOnly: false
        );
        Assert.Equal(
            "https://mcp.example/mcp",
            new McpConfiguration(backend.Documents).Snapshot()["remote"]!["url"]!.GetValue<string>()
        );
        Assert.StartsWith(
            "{",
            ConfigDocumentText.Decode(backend.Documents.Read(ConfigDocumentName.Mcp)!)
        );
    }

    [Fact]
    public async Task An_absent_policy_is_the_compatibility_policy_and_an_installation_applies_at_once()
    {
        await using var backend = await CreateAsync();
        var now = 0L;
        var authority = new ToolAuthorizationAuthority(backend.Documents, () => now);
        Assert.Equal("allow", authority.Load().Value["defaultAction"]!.GetValue<string>());
        await authority.InstallAsync(
            Encoding.UTF8.GetBytes("version: 1\ndefaultAction: deny\n"),
            CancellationToken.None
        );
        Assert.Equal("deny", authority.Load().Value["defaultAction"]!.GetValue<string>());
        Assert.Equal(
            "version: 1\ndefaultAction: deny\n",
            ConfigDocumentText.Decode(backend.Documents.Read(ConfigDocumentName.ToolAuthorization)!)
        );
    }

    [Fact]
    public async Task A_policy_over_the_byte_limit_is_refused_on_installation()
    {
        await using var backend = await CreateAsync();
        var authority = new ToolAuthorizationAuthority(backend.Documents);
        await authority.InstallAsync(
            Encoding.UTF8.GetBytes("version: 1\ndefaultAction: deny\n"),
            CancellationToken.None
        );
        var large = Encoding.UTF8.GetBytes(
            "version: 1\ndefaultAction: allow\n#" + new string('x', ToolAuthorizationPolicy.MaxBytes)
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            authority.InstallAsync(large, CancellationToken.None)
        );
        authority.Invalidate();
        Assert.Equal("deny", authority.Load().Value["defaultAction"]!.GetValue<string>());
    }

    [Fact]
    public async Task An_unparseable_policy_fails_closed()
    {
        await using var backend = await CreateAsync();
        var authority = new ToolAuthorizationAuthority(backend.Documents, retryDelay: _ => Task.CompletedTask);
        await backend.Documents.ReplaceAsync(
            ConfigDocumentName.ToolAuthorization,
            Encoding.UTF8.GetBytes("version: 1\nrules: null"),
            CancellationToken.None
        );
        Assert.Throws<ToolAuthorizationUnavailableException>(() => authority.Load());
        await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() => authority.LoadAsync());
    }
}

public sealed class FileConfigDocumentsContractTests : ConfigDocumentsContractTests
{
    private protected override Task<Backend> CreateAsync()
    {
        var temp = new TempDirectory();
        var paths = HostPaths.ForDataRoot(temp.Path);
        return Task.FromResult(
            new Backend(
                new FileConfigDocuments(paths),
                () => new ModelConfiguration(paths),
                temp.Path,
                () =>
                {
                    temp.Dispose();
                    return ValueTask.CompletedTask;
                }
            )
        );
    }

    [Fact]
    public async Task A_hand_edited_policy_is_read_again_after_the_fresh_read_interval()
    {
        await using var backend = await CreateAsync();
        var now = 0L;
        var authority = new ToolAuthorizationAuthority(backend.Documents, () => now);
        await authority.InstallAsync(
            Encoding.UTF8.GetBytes("version: 1\ndefaultAction: deny\n"),
            CancellationToken.None
        );
        Assert.Equal("deny", authority.Load().Value["defaultAction"]!.GetValue<string>());
        await File.WriteAllTextAsync(
            backend.Documents.PhysicalPath(ConfigDocumentName.ToolAuthorization)!,
            "version: 1\ndefaultAction: allow\n"
        );
        now = 10_000;
        Assert.Equal("allow", authority.Load().Value["defaultAction"]!.GetValue<string>());
    }
}

[Trait("Backend", "postgres")]
public sealed class PostgresConfigDocumentsContractTests : ConfigDocumentsContractTests
{
    internal const string Deployment =
        "url: https://fox.example\nbot:\n  httpPort: 3101\n  enableWebUI: true\nhealth:\n  port: 3181\nblobs:\n  backend: postgres\n";

    private static async Task<(HostedTestDatabase Database, TenantDb Tenant)> OpenAsync()
    {
        var server = await PostgresServer.SharedAsync();
        var database = await server.CreateDatabaseAsync();
        var tenantId = await database.TenantIdAsync();
        var epoch = await database.TakeLeaseAsync(tenantId);
        return (database, new TenantDb(database.OpenApp(), tenantId, epoch));
    }

    // The hosted configuration owner before the key ring exists: secrets and credentials stay
    // in the scratch directory.
    internal static ModelConfiguration Hosted(
        IConfigDocumentStore documents,
        string scratch,
        TenantProfile profile = TenantProfile.Hosted
    ) =>
        new(
            HostPaths.ForDataRoot(scratch),
            new ConfigurationSources(
                documents,
                DeploymentConfiguration.Parse(Deployment).Root,
                paths => new Foxwarm.Secrets.InstanceSecrets(paths.DataRoot),
                new FileInstanceCredentials(scratch)
            )
            {
                Profile = profile,
            }
        );

    private protected override async Task<Backend> CreateAsync()
    {
        var (database, tenant) = await OpenAsync();
        var temp = new TempDirectory();
        var documents = new PgConfigDocuments(tenant, "test-replica");
        return new Backend(
            documents,
            () => Hosted(documents, temp.Path),
            temp.Path,
            async () =>
            {
                temp.Dispose();
                await database.DisposeAsync();
            }
        );
    }

    [Fact]
    public async Task The_installer_refuses_deployment_and_unavailable_settings_naming_the_key()
    {
        await using var backend = await CreateAsync();
        var configuration = backend.Open();
        await configuration.SaveAppAsync("sessionAutoTitle: true\n");
        foreach (
            var (raw, key) in new[]
            {
                ("bot:\n  name: Fox\n  httpPort: 4000\n", "bot.httpPort"),
                ("url: https://other.example\n", "url"),
                ("nodeProviders: {}\n", "nodeProviders"),
                ("health: {port: 1}\n", "health"),
                ("claudeCode: {enabled: true}\n", "claudeCode"),
                ("vector: {enabled: false}\n", "vector"),
                ("bot:\n  enableTrigger: true\n", "bot.enableTrigger"),
                ("paths:\n  agentsDir: /x\n", "paths"),
                // Not a tenant setting of any profile.
                ("handoff: true\n", "handoff"),
                ("bot:\n  color: red\n", "bot.color"),
            }
        )
        {
            var error = await Assert.ThrowsAsync<InvalidDataException>(() =>
                configuration.SaveAppAsync(raw)
            );
            Assert.Contains("`" + key + "`", error.Message);
            Assert.Equal("sessionAutoTitle: true\n", configuration.ReadCurrentAppRaw());
        }
        // Tenant settings under `bot` stay tenant settings.
        await configuration.SaveAppAsync("bot:\n  name: Fox\n");
        Assert.Equal(
            "app config `handoff` isn't a tenant setting.",
            (await Assert.ThrowsAsync<InvalidDataException>(() => configuration.SaveAppAsync("handoff: true\n"))).Message
        );

        // The operator profile also has the Claude runtime's settings, and nothing else more.
        var operatorProfile = Hosted(backend.Documents, backend.Root, TenantProfile.Operator);
        await operatorProfile.SaveAppAsync("claudeCode: {credentialLifetimeSeconds: 600}\n");
        await Assert.ThrowsAsync<InvalidDataException>(() => operatorProfile.SaveAppAsync("url: https://other.example\n"));
        await Assert.ThrowsAsync<InvalidDataException>(() => operatorProfile.SaveAppAsync("handoff: true\n"));
        // That stored document refuses a hosted runtime's startup, naming the key.
        Assert.Contains(
            "`claudeCode`",
            Assert.Throws<InvalidDataException>(() => Hosted(backend.Documents, backend.Root)).Message
        );
    }

    [Fact]
    public async Task The_effective_app_configuration_is_the_tenant_document_with_the_deployment_settings()
    {
        await using var backend = await CreateAsync();
        var configuration = backend.Open();
        var installed = await configuration.SaveAppAsync("bot:\n  name: Fox\nsessionAutoTitle: false\n");
        // Deployment settings are equal on both sides and never report a restart; the tenant's
        // `bot.name` is a startup setting.
        Assert.Equal(
            ["bot"],
            installed["restartRequired"]!.AsArray().Select(item => item!.GetValue<string>())
        );
        var effective = backend.Open().AppConfiguration;
        Assert.Equal("https://fox.example", effective["url"]!.GetValue<string>());
        Assert.Equal("Fox", effective["bot"]!["name"]!.GetValue<string>());
        Assert.Equal(3101d, effective["bot"]!["httpPort"]!.GetValue<double>());
        Assert.False(effective["sessionAutoTitle"]!.GetValue<bool>());
        // Setup shows and edits the tenant document only.
        Assert.DoesNotContain("httpPort", configuration.ConfigDiagnostics()["rawYaml"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_stored_tenant_document_with_a_deployment_setting_refuses_startup()
    {
        await using var backend = await CreateAsync();
        await backend.Documents.ReplaceAsync(
            ConfigDocumentName.Config,
            Encoding.UTF8.GetBytes("url: https://other.example\n"),
            CancellationToken.None
        );
        var error = Assert.Throws<InvalidDataException>(() => backend.Open());
        Assert.Contains("`url`", error.Message);
    }

    [Fact]
    public async Task A_policy_changed_without_an_installation_stays_cached_until_invalidated()
    {
        await using var backend = await CreateAsync();
        var now = 0L;
        var authority = new ToolAuthorizationAuthority(backend.Documents, () => now);
        await authority.InstallAsync(
            Encoding.UTF8.GetBytes("version: 1\ndefaultAction: deny\n"),
            CancellationToken.None
        );
        Assert.Equal("deny", authority.Load().Value["defaultAction"]!.GetValue<string>());
        await backend.Documents.ReplaceAsync(
            ConfigDocumentName.ToolAuthorization,
            Encoding.UTF8.GetBytes("version: 1\ndefaultAction: allow\n"),
            CancellationToken.None
        );
        now = 3_600_000;
        Assert.Equal("deny", authority.Load().Value["defaultAction"]!.GetValue<string>());
        authority.Invalidate();
        Assert.Equal("allow", authority.Load().Value["defaultAction"]!.GetValue<string>());
        Assert.Null(authority.PolicyPath);
        Assert.Equal("config_documents/tool-authorization", authority.PolicyLocator);
    }

    [Fact]
    public async Task A_policy_read_failure_fails_closed()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var documents = new PgConfigDocuments(tenant);
        var authority = new ToolAuthorizationAuthority(documents, retryDelay: _ => Task.CompletedTask);
        Assert.Equal("allow", authority.Load().Value["defaultAction"]!.GetValue<string>());
        // The runtime role loses read access: the policy can't be read, which is never absent.
        await database.ExecuteOwnerAsync(
            $"REVOKE SELECT ON config_documents FROM {PostgresServer.AppRole}"
        );
        authority.Invalidate();
        Assert.Throws<ToolAuthorizationUnavailableException>(() => authority.Load());
        await Assert.ThrowsAsync<ToolAuthorizationUnavailableException>(() => authority.LoadAsync());
    }

    [Fact]
    public async Task A_stored_policy_over_the_byte_limit_fails_closed_on_read()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var authority = new ToolAuthorizationAuthority(
            new PgConfigDocuments(tenant),
            retryDelay: _ => Task.CompletedTask
        );
        var text = "version: 1\ndefaultAction: allow\n#" + new string('x', ToolAuthorizationPolicy.MaxBytes);
        // Written past the store's own check, as only a direct database edit could.
        await database.ExecuteOwnerAsync(
            "SET foxwarm.tenant = '" + tenant.TenantId + "'; SET foxwarm.epoch = '" + tenant.Epoch
                + "'; INSERT INTO config_documents (name, text, sha256) VALUES"
                + " ('tool-authorization', '" + text + "', sha256('x'))"
        );
        Assert.Throws<ToolAuthorizationUnavailableException>(() => authority.Load());
    }

    [Fact]
    public async Task Documents_that_are_not_UTF8_text_are_refused()
    {
        await using var backend = await CreateAsync();
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            backend.Documents.ReplaceAsync(ConfigDocumentName.Models, [0xC3, 0x28], CancellationToken.None)
        );
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            backend.Documents.ReplaceAsync(ConfigDocumentName.Models, [0x61, 0x00], CancellationToken.None)
        );
        Assert.False(backend.Documents.Exists(ConfigDocumentName.Models));
    }

    [Fact]
    public async Task Fenced_writes_leave_nothing_behind()
    {
        var (database, tenant) = await OpenAsync();
        await using var _ = database;
        var documents = new PgConfigDocuments(tenant);
        await documents.ReplaceAsync(ConfigDocumentName.Config, [0x61], CancellationToken.None);
        await database.TakeLeaseAsync(tenant.TenantId, "other");
        await Assert.ThrowsAsync<TenantFencedException>(() =>
            documents.ReplaceAsync(ConfigDocumentName.Config, [0x62], CancellationToken.None)
        );
        await Assert.ThrowsAsync<TenantFencedException>(() =>
            documents.TryCreateAsync(ConfigDocumentName.Models, [0x62], CancellationToken.None)
        );
        var reader = new PgConfigDocuments(
            new TenantDb(database.OpenApp(), tenant.TenantId, tenant.Epoch)
        );
        Assert.Equal([0x61], reader.Read(ConfigDocumentName.Config));
        Assert.False(reader.Exists(ConfigDocumentName.Models));
    }
}
