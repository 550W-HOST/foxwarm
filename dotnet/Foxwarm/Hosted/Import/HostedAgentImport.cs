using System.Text.Json.Nodes;
using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Hosted.Schema;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Import;

/// <summary>Migrates a stopped hosted tenant's separate Agents volume, without changing its other data.</summary>
internal static class HostedAgentImport
{
    internal static async Task<int> RunAsync(PgDatabase app, PgDatabase owner, string tenant, string? from,
        bool abandon, string reportPath, BlobSettings? blobs, TextWriter output, CancellationToken token = default)
    {
        if (File.Exists(reportPath))
            throw new HostedBootstrapException("The import report already exists: " + reportPath);
        var report = new ImportReport();
        report.Root["tool"] = "foxwarm hosted agents import";
        report.Root["tenant"] = new JsonObject { ["name"] = tenant };
        report.Root["source"] = from is null ? null : new JsonObject { ["agentsDirectory"] = Path.GetFullPath(from) };
        var work = Path.Combine(Path.GetTempPath(), "foxwarm-agents-import-" + Guid.NewGuid().ToString("N"));
        HostedImport.CreatePrivateDirectory(work);
        int exit;
        try
        {
            await SchemaMigrator.RequireCompatibleAsync(app, token: token);
            var (tenantId, expectedEpoch) = new TenantDb(owner, 0, 0).Read(tx =>
            {
                using var command = tx.Command("SELECT t.state, t.profile, l.epoch, (l.state = 'released' OR l.expires_at <= now()), t.tenant_id"
                    + " FROM tenants t JOIN tenant_leases l USING (tenant_id) WHERE t.name = $1", tenant);
                using var reader = command.ExecuteReader();
                if (!reader.Read())
                    throw new ImportRefusedException("The Agent-only import needs an existing tenant: " + tenant);
                var state = reader.GetString(0);
                if (state == "importing")
                    throw new ImportRefusedException("A full installation import is in progress for tenant " + tenant + ". The Agent-only command cannot complete or abandon it.");
                if (reader.GetString(1) != "hosted")
                    throw new ImportRefusedException("The tenant keeps its Agent files on master: " + tenant);
                if (state != "importing-agents" && (abandon || state != "active"))
                    throw new ImportRefusedException($"Tenant {tenant} is {state}; " + (abandon ? "only an incomplete Agent-only import can be abandoned." : "stop an active tenant or retry its incomplete Agent-only import."));
                if (!reader.GetBoolean(3))
                    throw new ImportRefusedException("The tenant lease is held. Stop the tenant before importing Agent files.");
                return (reader.GetInt32(4), reader.GetInt64(2));
            });
            if (!abandon && (!Directory.Exists(from!) || new DirectoryInfo(from!).LinkTarget is not null))
                throw new ImportRefusedException("The source must be an existing, ordinary Agents directory: " + from);
            var plan = abandon ? null : AgentFolderImport.Scan(from!,
                (await TenantPolicy.ReadAsync(new TenantDb(app, tenantId, 0), token)).Limits.AgentStore.FileBytes,
                report, required: true);
            exit = await LeasedImport.RunAsync(app, owner, tenant, expectedEpoch, abandon ? ImportKind.AbandonAgents : ImportKind.Agents,
                LeaseTimings.Default, blobs, work, report, async (storage, _, ct) =>
                {
                    var store = storage.AgentFiles;
                    if (abandon)
                    {
                        var files = new JsonArray();
                        foreach (var agent in store.Agents().Prepend((string?)null))
                            foreach (var file in store.Tree(agent, "").Where(file => !file.IsDirectory))
                                files.Add((JsonNode?)((agent is null ? "" : agent + "/") + file.Path));
                        report.Root["filesInPlace"] = files;
                        // Report the inventory to the operator before reactivating the tenant.
                        await output.WriteLineAsync("Agent files in place: " + files.ToJsonString());
                    }
                    else
                    {
                        await report.PhaseAsync("agent files", () => plan!.WriteAsync(store, ct), count => count);
                        await report.PhaseAsync("verify Agent files", () => plan!.VerifyAsync(store, report, ct), count => count);
                    }
                }, token, plan?.Summary().ToJsonString(), writesAgentBlobs: plan?.WritesBlobs == true);
            if (abandon && exit == HostedImport.Imported)
                report.Outcome = "abandoned";
        }
        catch (Exception error) when (error is ImportRefusedException or SchemaIncompatibleException)
        {
            report.Refuse(error is SchemaIncompatibleException ? "The hosted schema isn't compatible with this build: " + error.Message : error.Message);
            report.Outcome = "refused";
            exit = HostedImport.Refused;
        }
        finally
        {
            Directory.Delete(work, recursive: true);
        }
        report.Finish();
        report.Save(reportPath);
        await output.WriteAsync(report.Summary(Path.GetFullPath(reportPath)));
        return exit;
    }
}
