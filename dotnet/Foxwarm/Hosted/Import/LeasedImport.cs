using Foxwarm.Hosted.Blobs;
using Foxwarm.Hosted.Lease;
using Foxwarm.Hosted.Postgres;
using Foxwarm.Sessions;

namespace Foxwarm.Hosted.Import;

/// <summary>Runs and verifies an offline import while its lease fences every write.</summary>
internal static class LeasedImport
{
    internal static async Task<int> RunAsync(
        PgDatabase app, PgDatabase ownerDatabase, string tenant, long? expectedEpoch, ImportKind kind,
        LeaseTimings timings, BlobSettings? blobs, string work, ImportReport report,
        Func<PostgresStorageContext, TenantDb, CancellationToken, Task> run, CancellationToken stop, string? agentPlan = null,
        TenantProfile profile = TenantProfile.Hosted, Action? publish = null, bool writesAgentBlobs = false)
    {
        var state = kind == ImportKind.Full ? "importing" : "importing-agents";
        var lease = new TenantLease(ownerDatabase, tenant, AgentCatalog.ReaderVersion);
        var replica = "import:" + Guid.NewGuid().ToString("D");
        LeaseGrant? grant;
        try
        {
            grant = await lease.TryAcquireForImportAsync(replica, expectedEpoch, timings.Ttl, timings.RenewInterval, stop, kind, agentPlan, profile);
        }
        catch (LeaseRefusedException error)
        {
            report.Refuse(error.Message);
            report.Outcome = "refused";
            return HostedImport.Refused;
        }
        if (grant is null)
        {
            report.Refuse($"Tenant {tenant} changed while the import was checking it, or its lease is held; run the import again.");
            report.Outcome = "refused";
            return HostedImport.Refused;
        }
        report.Root["tenant"]!["id"] = grant.TenantId;
        report.Root["tenant"]!["epoch"] = grant.Epoch;
        report.Root["tenant"]!["leaseOwner"] = replica;
        var db = new TenantDb(app, grant.TenantId, grant.Epoch);
        var owner = new TenantDb(ownerDatabase, grant.TenantId, grant.Epoch);
        var monitor = new LeaseMonitor(lease, grant, timings);
        monitor.Attach(db);
        monitor.Attach(owner);
        monitor.Start();
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(stop, monitor.Lost);
        var activated = false;
        try
        {
            await using var storage = new PostgresStorageContext(db, Path.Combine(work, "scratch"));
            await storage.OpenBlobsAsync(blobs ?? new BlobSettings(BlobBackend.Postgres, null), tenant, cancel.Token);
            if (profile == TenantProfile.Hosted && kind != ImportKind.AbandonAgents)
            {
                var (limits, _) = await TenantPolicy.ReadAsync(db, cancel.Token);
                storage.AgentStoreLimits = () => limits.AgentStore;
                if (writesAgentBlobs && storage.AgentFileBlobs is S3BlobStore remote)
                    await WaitForInventoryAsync(db, remote.InventoryDestination, cancel.Token);
            }
            await run(storage, owner, cancel.Token);
            if (report.Failures.Count > 0)
            {
                report.Outcome = "verification-failed";
                report.Root["tenant"]!["state"] = state;
                return HostedImport.Failed;
            }
            cancel.Token.ThrowIfCancellationRequested();
            try
            {
                await lease.ActivateImportAsync(grant, cancel.Token, kind, publish).ConfigureAwait(false);
            }
            catch (CommitOutcomeUnknownException error)
            {
                report.Outcome = "activation-unknown";
                report.Root["tenant"]!["state"] = "unknown";
                report.Root["error"] = error.Message;
                return HostedImport.Failed;
            }
            activated = true;
            report.Root["tenant"]!["state"] = "active";
            report.Outcome = "imported";
            return HostedImport.Imported;
        }
        catch (ImportRefusedException error)
        {
            report.Refuse(error.Message);
            report.Outcome = "refused";
            report.Root["tenant"]!["state"] = state;
            return HostedImport.Refused;
        }
        catch (Exception error) when (Fence(error, monitor))
        {
            report.Outcome = "fenced";
            report.Root["tenant"]!["state"] = state;
            report.Root["error"] = "The import lost the tenant lease and stopped writing: " + error.Message;
            return HostedImport.Fenced;
        }
        catch (Exception error) when (error is not OperationCanceledException || !stop.IsCancellationRequested)
        {
            report.Outcome = "failed";
            report.Root["tenant"]!["state"] = state;
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

    // The operator scans active leases, including import leases. Never hold the usage or
    // lease lock while waiting: inventory and lease renewal must both be able to commit.
    private static async Task WaitForInventoryAsync(TenantDb db, string destination, CancellationToken token)
    {
        var announced = false;
        while (true)
        {
            var inventory = await db.WriteAsync(async (tx, ct) =>
            {
                using var command = tx.Command("SELECT blob_inventory FROM agent_file_usage");
                return await command.ExecuteScalarAsync(ct) as string;
            }, token: token);
            if (inventory == destination) return;
            if (inventory is not null)
                throw new ImportRefusedException("The recorded Agent blob inventory belongs to a different destination. Check the import and operator blob settings.");
            if (!announced)
            {
                Console.Error.WriteLine("[import] Waiting for the hosted operator to inventory this tenant's Agent files. Check that it is running with the same blob backend and destination.");
                announced = true;
            }
            await Task.Delay(TimeSpan.FromSeconds(1), token);
        }
    }

    private static bool Fence(Exception error, LeaseMonitor monitor) => error is TenantFencedException
        || monitor.Lost.IsCancellationRequested && error is OperationCanceledException or InvalidOperationException
        || error.InnerException is { } inner && Fence(inner, monitor);
}
