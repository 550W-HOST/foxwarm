namespace Foxwarm.Limits;

/// <summary>
/// One tenant runtime's admission state for its <see cref="TenantLimits"/>: the queues and
/// counters each admission point takes from. Its <c>SessionManager</c> owns it; file mode has
/// none, and every admission point then admits as before.
/// </summary>
internal sealed class TenantAdmission : IDisposable
{
    internal TenantAdmission(
        TenantLimits limits,
        ReplicaLimits replica,
        IHotOwnerReleaser owners,
        Func<long>? clock = null
    )
    {
        Limits = limits;
        HotOwners = new HotOwnerBudget(limits.HotOwnerBytes, replica.HotOwners, owners);
        Turns = new AdmissionSlots(limits.BusyTurns);
        ToolScripts = new AdmissionSlots(limits.ToolScriptRuns, replica.ToolScripts);
        NodeExecs = new AdmissionSlots(limits.NodeExecs);
        Hydrations = new AdmissionSlots(HydrationSlots);
        Requests = new RequestRate(limits.RequestsPerSecond, limits.RequestBurst, clock);
        WebSockets = new OpenCount(limits.WebSockets);
    }

    internal TenantLimits Limits { get; }

    /// <summary>Resident Session owners' estimated bytes (owner admission).</summary>
    internal HotOwnerBudget HotOwners { get; }

    /// <summary>Turns running at once (the turn runner); more queue.</summary>
    internal AdmissionSlots Turns { get; }

    /// <summary>ToolScript runs at once, within the replica's slots; more queue.</summary>
    internal AdmissionSlots ToolScripts { get; }

    /// <summary>
    /// Tool calls in flight to resident Nodes through Main (<c>NodeConnectionHub.ExecuteAsync</c>);
    /// more queue. Provider Nodes keep their Provider's own limits.
    /// </summary>
    internal AdmissionSlots NodeExecs { get; }

    /// <summary>Owner loads reading their history at once; more queue, holding no history.</summary>
    internal AdmissionSlots Hydrations { get; }

    internal const int HydrationSlots = 4;

    /// <summary>HTTP requests of the tenant pipeline.</summary>
    internal RequestRate Requests { get; }

    /// <summary>Open WebSockets of the tenant pipeline.</summary>
    internal OpenCount WebSockets { get; }

    public void Dispose() => HotOwners.Dispose();
}
