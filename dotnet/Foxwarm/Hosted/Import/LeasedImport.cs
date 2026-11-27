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
        TenantProfile profile = TenantProfile.Hosted, Action? publish = null)
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
            await run(storage, owner, cancel.Token);
            if (report.Failures.Count > 0)
            {
                report.Outcome = "verification-failed";
                report.Root["tenant"]!["state"] = state;
                return HostedImport.Failed;
            }
            cancel.Token.ThrowIfCancellationRequested();
            await lease.ActivateImportAsync(grant, stop, kind, publish).ConfigureAwait(false);
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

    private static bool Fence(Exception error, LeaseMonitor monitor) => error is TenantFencedException
        || monitor.Lost.IsCancellationRequested && error is OperationCanceledException or InvalidOperationException
        || error.InnerException is { } inner && Fence(inner, monitor);
}
