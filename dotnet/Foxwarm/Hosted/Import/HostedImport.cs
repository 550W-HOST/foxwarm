using System.Text.Json.Nodes;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Foxwarm.Storage;

namespace Foxwarm.Hosted.Import;

/// <summary>Options of <c>foxwarm hosted import</c>.</summary>
internal sealed record HostedImportOptions(
    string DataRoot,
    string Tenant,
    bool Journal,
    bool DryRun,
    string ReportPath
)
{
    /// <summary>The draft deployment configuration, written beside the report.</summary>
    internal string DeploymentDraftPath =>
        Path.Combine(
            Path.GetDirectoryName(Path.GetFullPath(ReportPath))!,
            Path.GetFileNameWithoutExtension(ReportPath) + ".deployment.yaml"
        );

    internal LeaseTimings Timings { get; init; } = LeaseTimings.Default;

    /// <summary>
    /// Where the blobs go: the <c>blobs</c> block of the deployment configuration the replicas
    /// will use. Null is PostgreSQL. The draft deployment configuration records it.
    /// </summary>
    internal Foxwarm.Hosted.Blobs.BlobSettings? Blobs { get; init; }

    /// <summary>
    /// Test-only: imports an installation that has no <c>keys/secrets.key</c> under a newly
    /// generated key instead of refusing it. Only an installation without encrypted data can
    /// import this way. The command line never sets it.
    /// </summary>
    internal bool GenerateMissingSecretsKeyForTests { get; init; }


    /// <summary>Test seam: runs before each write phase with its name.</summary>
    internal Func<string, Task>? BeforePhase { get; init; }

    /// <summary>Where the import keeps its SQLite copies; default a new directory under the temporary directory.</summary>
    internal string? WorkParent { get; init; }
}

/// <summary>
/// The databases an import writes through: the runtime role for every tenant row (row-level
/// security and the fence trigger apply as for a replica), and the migrating role for what only
/// it may change: the tenant's state and the identity sequences the copied rows advance.
/// </summary>
internal sealed record ImportDatabases(PgDatabase App, PgDatabase Owner, KeyEncryptionKey Kek);

/// <summary>
/// <c>foxwarm hosted import</c>: copies a stopped file-mode installation into a hosted tenant,
/// verifies the copy against the source and only then marks the tenant <c>active</c>
/// (p1-plan §9). The tenant is <c>importing</c> while it runs, which no replica acquires, and the
/// import holds the tenant lease as <c>import:&lt;uuid&gt;</c>, so the fence applies to each of its
/// writes. A failed import leaves the tenant <c>importing</c>; a new import refuses a tenant
/// that holds rows, so the retry is a fresh tenant name. The source directory is never written.
/// </summary>
internal static class HostedImport
{
    internal const int Imported = 0;
    internal const int Failed = 1;
    internal const int Fenced = 75;
    internal const int Refused = 78;

    internal static async Task<int> RunAsync(
        HostedImportOptions options,
        ImportDatabases databases,
        TextWriter output,
        CancellationToken token = default
    )
    {
        var report = new ImportReport();
        report.Root["source"] = new JsonObject { ["dataRoot"] = Path.GetFullPath(options.DataRoot) };
        report.Root["tenant"] = new JsonObject { ["name"] = options.Tenant };
        report.Root["options"] = new JsonObject { ["journal"] = options.Journal, ["dryRun"] = options.DryRun };
        int exit;
        try
        {
            using var source = ImportSource.Open(options.DataRoot);
            var work = Path.Combine(
                options.WorkParent ?? Path.GetTempPath(),
                "foxwarm-import-" + Guid.NewGuid().ToString("N")
            );
            CreatePrivateDirectory(work);
            try
            {
                await using var run = new ImportRun(options, databases, source, work, report, token);
                exit = await run.RunAsync().ConfigureAwait(false);
            }
            finally
            {
                try
                {
                    Directory.Delete(work, recursive: true);
                }
                catch (IOException) { }
            }
        }
        catch (ImportRefusedException error)
        {
            report.Refuse(error.Message);
            report.Outcome = "refused";
            exit = Refused;
        }
        report.Finish();
        report.Save(options.ReportPath);
        await output.WriteAsync(report.Summary(Path.GetFullPath(options.ReportPath))).ConfigureAwait(false);
        return exit;
    }

    internal static void CreatePrivateDirectory(string path)
    {
        if (OperatingSystem.IsWindows())
            Directory.CreateDirectory(path);
        else
            Directory.CreateDirectory(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }
}

/// <summary>One import: preflight, plan, the write phases in dependency order, verification and activation.</summary>
internal sealed partial class ImportRun : IAsyncDisposable
{
    private readonly HostedImportOptions options;
    private readonly ImportDatabases databases;
    private readonly ImportSource source;
    private readonly string work;
    private readonly ImportReport report;
    private readonly CancellationToken stop;
    private readonly Dictionary<string, Microsoft.Data.Sqlite.SqliteConnection> copies = new(StringComparer.Ordinal);
    private SessionCatalog? sourceCatalog;
    private ConfigSplitResult? config;
    private InstanceKeys? sourceKeys;
    private LeaseMonitor? monitor;
    private LeaseGrant? grant;
    private TenantLease? lease;
    private CancellationTokenSource? cancel;

    internal ImportRun(
        HostedImportOptions options,
        ImportDatabases databases,
        ImportSource source,
        string work,
        ImportReport report,
        CancellationToken stop
    )
    {
        this.options = options;
        this.databases = databases;
        this.source = source;
        this.work = work;
        this.report = report;
        this.stop = stop;
    }

    /// <summary>The tenant's rows, written by the runtime role at the import's epoch.</summary>
    internal TenantDb Db { get; private set; } = null!;

    /// <summary>The migrating role at the same epoch (identity sequences).</summary>
    internal TenantDb Owner { get; private set; } = null!;

    internal PostgresStorageContext Hosted { get; private set; } = null!;

    private CancellationToken Token => cancel?.Token ?? stop;

    internal async Task<int> RunAsync()
    {
        Preflight();
        report.Phase("snapshot", () =>
        {
            foreach (var file in ImportSource.SqliteFiles)
                if (source.Snapshot(file, work) is { } copy)
                    copies[file] = ImportSource.OpenCopy(copy);
            return copies.Count;
        }, count => count);
        CheckSourceContent();
        report.Phase("configuration split", () => config = SplitConfiguration(), _ => config!.Blocks.Count);
        var plan = report.Phase("plan", Plan, items => items.Count);
        report.Root["plan"] = plan;
        var target = await InspectTargetAsync().ConfigureAwait(false);
        if (report.Refusals.Count > 0)
        {
            report.Outcome = "refused";
            return HostedImport.Refused;
        }
        WriteDeploymentDraft();
        if (options.DryRun)
        {
            report.Outcome = "dry-run";
            return HostedImport.Imported;
        }
        return await ImportAsync(target).ConfigureAwait(false);
    }

    private async Task<int> ImportAsync(long? expectedEpoch)
    {
        lease = new TenantLease(databases.Owner, options.Tenant, AgentCatalog.ReaderVersion);
        var replica = "import:" + Guid.NewGuid().ToString("D");
        grant = await lease
            .TryAcquireForImportAsync(replica, expectedEpoch, options.Timings.Ttl, options.Timings.RenewInterval, stop)
            .ConfigureAwait(false);
        if (grant is null)
        {
            report.Refuse($"Tenant {options.Tenant} changed while the import was checking it, or its lease is held; run the import again.");
            report.Outcome = "refused";
            return HostedImport.Refused;
        }
        report.Root["tenant"]!["id"] = grant.TenantId;
        report.Root["tenant"]!["epoch"] = grant.Epoch;
        report.Root["tenant"]!["leaseOwner"] = replica;
        Db = new TenantDb(databases.App, grant.TenantId, grant.Epoch);
        Owner = new TenantDb(databases.Owner, grant.TenantId, grant.Epoch);
        monitor = new LeaseMonitor(lease, grant, options.Timings);
        monitor.Attach(Db);
        monitor.Attach(Owner);
        monitor.Start();
        cancel = CancellationTokenSource.CreateLinkedTokenSource(stop, monitor.Lost);
        Hosted = new PostgresStorageContext(Db, Path.Combine(work, "scratch"));
        await Hosted.OpenBlobsAsync(options.Blobs ?? new Foxwarm.Hosted.Blobs.BlobSettings(Foxwarm.Hosted.Blobs.BlobBackend.Postgres, null), options.Tenant, stop).ConfigureAwait(false);
        var activated = false;
        try
        {
            await WriteAsync().ConfigureAwait(false);
            await VerifyAsync().ConfigureAwait(false);
            if (report.Failures.Count > 0)
            {
                report.Outcome = "verification-failed";
                report.Root["tenant"]!["state"] = "importing";
                return HostedImport.Failed;
            }
            Token.ThrowIfCancellationRequested();
            await lease.ActivateImportAsync(grant, stop).ConfigureAwait(false);
            activated = true;
            report.Root["tenant"]!["state"] = "active";
            report.Outcome = "imported";
            return HostedImport.Imported;
        }
        catch (Exception error) when (Fence(error))
        {
            report.Outcome = "fenced";
            report.Root["tenant"]!["state"] = "importing";
            report.Root["error"] = "The import lost the tenant lease and stopped writing: " + error.Message;
            return HostedImport.Fenced;
        }
        catch (Exception error) when (error is not OperationCanceledException || !stop.IsCancellationRequested)
        {
            report.Outcome = "failed";
            report.Root["tenant"]!["state"] = "importing";
            report.Root["error"] = error.GetType().Name + ": " + error.Message;
            return HostedImport.Failed;
        }
        finally
        {
            await monitor.DisposeAsync().ConfigureAwait(false);
            if (!activated)
                try
                {
                    await lease.ReleaseAsync(grant, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception) { }
        }
    }

    private bool Fence(Exception error) =>
        error is TenantFencedException
        || monitor?.Lost.IsCancellationRequested == true && error is OperationCanceledException or InvalidOperationException
        || error.InnerException is { } inner && Fence(inner);

    // ---- Preflight (design §8.1 step 1) ----

    private void Preflight()
    {
        var state = source.State;
        if (File.Exists(Path.Combine(state, "session-id-move-pending.json")))
            report.Refuse(
                "A Session identity move is pending (state/session-id-move-pending.json). Start Main once so startup recovery completes it, stop it, then import."
            );
        var anyStore = new[] { "archive-store.sqlite", "llm-request-journal.sqlite" }.Any(file => File.Exists(Path.Combine(state, file)));
        var migration = source.ReadJson("state/migrationVersion.json");
        if (anyStore && SessionWait.Text(migration?["migrations"]?["sqlite-only-large-archives-v1"]?["status"]) != "completed")
            report.Refuse(
                "The data directory isn't at the current file format: the SQLite-only Archive migration hasn't completed. Start and stop Main once with this version, then import."
            );
        try
        {
            var installation = source.ReadJson("state/installation.json");
            var level = installation?["minimumReaderVersion"];
            report.Root["source"]!["minimumReaderVersion"] = level?.DeepClone();
            if (level is not null && (level is not JsonValue number || !number.TryGetValue<int>(out var required) || required < 1))
                report.Refuse("state/installation.json has an invalid minimumReaderVersion.");
            else if (level is not null && level.GetValue<int>() > AgentCatalog.ReaderVersion)
                report.Refuse(
                    $"The installation requires a reader of installation level {level.GetValue<int>()}; this binary reads level {AgentCatalog.ReaderVersion}. Import with a newer Foxwarm."
                );
        }
        catch (Exception error) when (error is System.Text.Json.JsonException or InvalidDataException)
        {
            report.Refuse("state/installation.json can't be read: " + error.Message);
        }
        var keyPath = InstanceKeys.DefaultPath(source.Root);
        if (File.Exists(keyPath))
        {
            try
            {
                sourceKeys = InstanceKeys.Read(keyPath);
                report.Root["source"]!["keyId"] = sourceKeys.KeyId;
            }
            catch (Exception error) when (error is InvalidDataException or IOException)
            {
                report.Refuse("keys/secrets.key can't be read: " + error.Message);
            }
        }
        else if (options.GenerateMissingSecretsKeyForTests)
        {
            if (source.Exists("state/secrets.json") || source.Exists("state/text-redaction.sqlite"))
                report.Refuse("keys/secrets.key is missing while the installation holds encrypted data.");
            sourceKeys = InstanceKeys.FromKey(InstanceKeys.NewKeyId(), System.Security.Cryptography.RandomNumberGenerator.GetBytes(InstanceKeys.KeyBytes), "generated");
            report.Warn("keys/secrets.key is missing; a generated key (test-only option) becomes the tenant data key.");
        }
        else
            report.Refuse(
                "keys/secrets.key is missing. The installation's key becomes the tenant data key (it decrypts the secrets, OAuth grants and the text-redaction cache), so the import needs it; restore it from the backup."
            );
        report.Root["source"]!["agentsDirectory"] = Path.Combine(source.Root, "agents");
    }

    // Checks that need the SQLite copies: the catalog schema, the documents of its members,
    // and that the identity ledger and its SQLite mirror agree.
    private void CheckSourceContent()
    {
        if (copies.TryGetValue("catalog.sqlite", out var catalog))
        {
            var version = ImportTables.Count(catalog, "PRAGMA user_version");
            if (version != SessionCatalogVersion)
                report.Refuse(
                    $"state/catalog.sqlite is at schema {version}, not {SessionCatalogVersion}. Start and stop Main once with this version, then import."
                );
            else
                sourceCatalog = new SessionCatalog(work);
        }
        var agents = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var row in sourceCatalog?.List() ?? [])
        {
            var id = SessionCatalog.Text(row["id"])!;
            agents.Add(SessionCatalog.Text(row["agent"])!);
            var path = Path.Combine(source.State, "sessions", id + ".json");
            if (!File.Exists(path))
            {
                report.Warn($"Catalog member {id} has no authority document; it is unavailable in file mode too.");
                continue;
            }
            try
            {
                using var stream = File.OpenRead(path);
                var document = JsonNode.Parse(stream) as JsonObject;
                if (SessionCatalog.Number(document?["sessionStateVersion"]) is not (1 or 2))
                    report.Refuse(
                        $"The authority document of {id} has no supported sessionStateVersion, so the catalog migration hasn't run. Start and stop Main once with this version, then import."
                    );
            }
            catch (System.Text.Json.JsonException error)
            {
                report.Refuse($"The authority document of {id} isn't valid JSON: {error.Message}");
            }
        }
        report.Root["source"]!["catalogAgents"] = new JsonArray(agents.Select(agent => (JsonNode?)agent).ToArray());
        if (copies.TryGetValue("archive-store.sqlite", out var archive) && ImportTables.SourceHas(archive, "archive_session_id_reservations"))
        {
            var mirror = new HashSet<string>(StringComparer.Ordinal);
            using (var command = archive.CreateCommand())
            {
                command.CommandText = "SELECT session_id, canonical_session_id FROM archive_session_id_reservations";
                using var rows = command.ExecuteReader();
                while (rows.Read())
                    mirror.Add(rows.GetString(0) + "\n" + rows.GetString(1));
            }
            var ledger = new HashSet<string>(StringComparer.Ordinal);
            foreach (var line in (source.ReadText("state/session-id-reservations.jsonl") ?? "").Split('\n'))
            {
                if (line.Trim().Length == 0)
                    continue;
                try
                {
                    if (JsonNode.Parse(line) is JsonObject entry && SessionCatalog.Number(entry["v"]) == 1)
                        ledger.Add(SessionCatalog.Text(entry["sessionId"]) + "\n" + SessionCatalog.Text(entry["canonicalSessionId"]));
                }
                catch (System.Text.Json.JsonException) { }
            }
            if (!ledger.SetEquals(mirror))
                report.Refuse(
                    "The Session identity ledger (state/session-id-reservations.jsonl) and its SQLite mirror differ; startup reconciles them. Start and stop Main once, then import."
                );
        }
    }

    /// <summary>The file catalog's schema version this build reads without migrating.</summary>
    internal const long SessionCatalogVersion = 3;

    private ConfigSplitResult? SplitConfiguration()
    {
        var text = source.ReadText("state/config.yaml");
        if (text is null)
        {
            report.Root["configuration"] = new JsonObject { ["source"] = "absent" };
            return null;
        }
        var split = ConfigSplit.Split(text, blobsBlock: BlobsYaml(options.Blobs));
        report.Root["configuration"] = new JsonObject
        {
            ["source"] = "state/config.yaml",
            ["deploymentDraft"] = options.DeploymentDraftPath,
            ["cutBlocks"] = new JsonArray(
                split.Blocks.Select(block => (JsonNode?)new JsonObject
                {
                    ["key"] = block.Key,
                    ["lines"] = $"{block.FirstLine}-{block.LastLine}",
                    ["to"] = block.Part,
                }).ToArray()
            ),
            ["droppedSettings"] = new JsonArray(
                split.Dropped.Select(item => (JsonNode?)new JsonObject { ["key"] = item.Key, ["value"] = item.Value?.DeepClone() }).ToArray()
            ),
        };
        return split;
    }

    // The `blobs` block for the draft, in the deployment configuration's own syntax.
    internal static string BlobsYaml(Foxwarm.Hosted.Blobs.BlobSettings? settings)
    {
        if (settings?.S3 is not { } s3)
            return "blobs:\n  backend: postgres\n";
        static string Quoted(string value) => System.Text.Json.JsonSerializer.Serialize(value);
        return "blobs:\n  backend: s3\n  s3:\n"
            + $"    endpoint: {Quoted(s3.Endpoint.ToString().TrimEnd('/'))}\n"
            + $"    region: {Quoted(s3.Region)}\n"
            + $"    bucket: {Quoted(s3.Bucket)}\n"
            + $"    pathStyle: {(s3.PathStyle ? "true" : "false")}\n"
            + $"    accessKeyIdFile: {Quoted(s3.AccessKeyIdFile)}\n"
            + $"    secretAccessKeyFile: {Quoted(s3.SecretAccessKeyFile)}\n";
    }

    private void WriteDeploymentDraft()
    {
        if (config is not null)
            ImportReport.WritePrivate(options.DeploymentDraftPath, config.DeploymentText);
    }

    // ---- Target tenant ----

    // The tenant must be new, or exist without any rows (`db migrate` creates the configured
    // tenant). Returns the epoch to expect at acquisition, null for a new tenant.
    private async Task<long?> InspectTargetAsync()
    {
        try
        {
            await SchemaMigrator.RequireCompatibleAsync(databases.App, token: stop).ConfigureAwait(false);
        }
        catch (SchemaIncompatibleException error)
        {
            report.Refuse("The hosted schema isn't compatible with this build: " + error.Message);
            return null;
        }
        var probe = new TenantDb(databases.App, 0, 0);
        var id = probe.Read(tx => tx.Scalar("SELECT tenant_id FROM tenants WHERE name = $1", options.Tenant) as int?);
        if (id is null)
        {
            report.Root["tenant"]!["existed"] = false;
            return null;
        }
        report.Root["tenant"]!["existed"] = true;
        var tenant = new TenantDb(databases.App, id.Value, 0);
        var (state, epoch, free, owner, tables) = tenant.Read(
            tx =>
            {
                string tenantState;
                long leaseEpoch;
                bool leaseFree;
                string? leaseOwner;
                using (var command = tx.Command(
                    "SELECT t.state, l.epoch, (l.state = 'released' OR l.expires_at <= now()), l.owner_replica"
                        + " FROM tenants t JOIN tenant_leases l USING (tenant_id) WHERE t.tenant_id = $1",
                    id.Value
                ))
                using (var reader = command.ExecuteReader())
                {
                    reader.Read();
                    tenantState = reader.GetString(0);
                    leaseEpoch = reader.GetInt64(1);
                    leaseFree = reader.GetBoolean(2);
                    leaseOwner = reader.IsDBNull(3) ? null : reader.GetString(3);
                }
                var names = new List<string>();
                using (var command = tx.Command(
                    "SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace"
                        + " WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relforcerowsecurity ORDER BY 1"
                ))
                using (var reader = command.ExecuteReader())
                    while (reader.Read())
                        names.Add(reader.GetString(0));
                var filled = names
                    .Where(name => tx.Scalar($"SELECT 1 FROM {ImportTables.Quote(name)} LIMIT 1") is not null)
                    .ToList();
                return (tenantState, leaseEpoch, leaseFree, leaseOwner, filled);
            },
            snapshot: true
        );
        report.Root["tenant"]!["previousState"] = state;
        if (tables.Count > 0)
            report.Refuse(
                $"Tenant {options.Tenant} ({state}) already holds data in {string.Join(", ", tables)}. An import only writes into an empty tenant."
                    + (state == "importing"
                        ? " It is left over from a failed import, which no replica acquires; import again under a new --tenant name, or drop and recreate the database (`foxwarm db migrate`) if it holds no other tenant."
                        : " Import under a new --tenant name.")
            );
        else if (!free)
            report.Refuse($"Tenant {options.Tenant}'s lease is held by {owner}. Stop its replicas before importing.");
        else if (state is not ("active" or "importing"))
            report.Refuse($"Tenant {options.Tenant} is {state}; an import needs a new or empty tenant.");
        return epoch;
    }

    public async ValueTask DisposeAsync()
    {
        sourceCatalog?.Dispose();
        foreach (var connection in copies.Values)
            await connection.DisposeAsync().ConfigureAwait(false);
        cancel?.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
    }
}
