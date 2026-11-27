using System.Text.Json;
using System.Text.Json.Nodes;

namespace Foxwarm.Limits;

/// <summary>
/// A hosted tenant's limits (plan P2 §7.2), from the operator-owned <c>tenants.limits</c>
/// column over these defaults. File mode has none (<see cref="RuntimeCapabilities.Limits"/> is
/// null). Each limit is enforced at an existing admission point; where that point already
/// queues, the limit queues too.
/// </summary>
internal sealed record TenantLimits
{
    private const long MiB = 1024L * 1024;
    private const long GiB = 1024 * MiB;

    /// <summary>Estimated memory of the tenant's resident Session owners.</summary>
    internal long HotOwnerBytes { get; init; } = 512 * MiB;

    /// <summary>Turns running at once; more wait for a slot.</summary>
    internal int BusyTurns { get; init; } = 8;

    /// <summary>ToolScript runs (Monty processes) at once; more wait.</summary>
    internal int ToolScriptRuns { get; init; } = 2;

    /// <summary>Sustained HTTP requests per second, and the burst above it.</summary>
    internal int RequestsPerSecond { get; init; } = 50;

    internal int RequestBurst { get; init; } = 100;

    /// <summary>Open WebSockets of the tenant.</summary>
    internal int WebSockets { get; init; } = 64;

    /// <summary>One WebUI upload.</summary>
    internal long UploadBytes { get; init; } = 100 * MiB;

    /// <summary>Stored images and artifacts; a warning at 80%, refused above.</summary>
    internal long BlobBytes { get; init; } = 10 * GiB;

    /// <summary>Resident (paired) Nodes.</summary>
    internal int ResidentNodes { get; init; } = 10;

    /// <summary>Remote execs at once; more wait.</summary>
    internal int NodeExecs { get; init; } = 8;

    /// <summary>Configuration counts, checked when the configuration is saved.</summary>
    internal int McpServers { get; init; } = 16;

    internal int Channels { get; init; } = 8;

    internal int AccessIdentities { get; init; } = 32;

    internal int Webhooks { get; init; } = 16;

    internal static TenantLimits Defaults { get; } = new();

    /// <summary>A size for messages: whole GiB or MiB when exact, bytes otherwise.</summary>
    internal static string Size(long bytes) =>
        bytes % GiB == 0 ? $"{bytes / GiB} GiB"
        : bytes % MiB == 0 ? $"{bytes / MiB} MiB"
        : $"{bytes} bytes";

    private delegate TenantLimits Apply(TenantLimits limits, long value);

    // The column's keys, each with its range and setter.
    private static readonly Dictionary<string, (long Max, Apply Set)> Keys = new(StringComparer.Ordinal)
    {
        ["hotOwnerBytes"] = (long.MaxValue, (l, v) => l with { HotOwnerBytes = v }),
        ["busyTurns"] = (int.MaxValue, (l, v) => l with { BusyTurns = (int)v }),
        ["toolScriptRuns"] = (int.MaxValue, (l, v) => l with { ToolScriptRuns = (int)v }),
        ["requestsPerSecond"] = (int.MaxValue, (l, v) => l with { RequestsPerSecond = (int)v }),
        ["requestBurst"] = (int.MaxValue, (l, v) => l with { RequestBurst = (int)v }),
        ["webSockets"] = (int.MaxValue, (l, v) => l with { WebSockets = (int)v }),
        ["uploadBytes"] = (long.MaxValue, (l, v) => l with { UploadBytes = v }),
        ["blobBytes"] = (long.MaxValue, (l, v) => l with { BlobBytes = v }),
        ["residentNodes"] = (int.MaxValue, (l, v) => l with { ResidentNodes = (int)v }),
        ["nodeExecs"] = (int.MaxValue, (l, v) => l with { NodeExecs = (int)v }),
        ["mcpServers"] = (int.MaxValue, (l, v) => l with { McpServers = (int)v }),
        ["channels"] = (int.MaxValue, (l, v) => l with { Channels = (int)v }),
        ["accessIdentities"] = (int.MaxValue, (l, v) => l with { AccessIdentities = (int)v }),
        ["webhooks"] = (int.MaxValue, (l, v) => l with { Webhooks = (int)v }),
    };

    /// <summary>
    /// The column's value over the defaults: each key a positive whole number (sizes in bytes).
    /// Other limits in the column belong to other owners (the Agent store's, the database
    /// statement cap) and are left to them; a malformed known key is refused, naming it.
    /// </summary>
    internal static TenantLimits Parse(JsonObject? column)
    {
        var limits = Defaults;
        if (column is null)
            return limits;
        foreach (var (key, value) in column)
        {
            if (!Keys.TryGetValue(key, out var entry))
                continue;
            long whole = 0;
            if (
                value is not JsonValue number
                || number.GetValueKind() != JsonValueKind.Number
                || !long.TryParse(
                    number.ToJsonString(),
                    System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out whole
                )
                || whole < 1
                || whole > entry.Max
            )
                throw new InvalidDataException($"limits.{key} must be a positive whole number.");
            limits = entry.Set(limits, whole);
        }
        return limits;
    }
}

/// <summary>
/// A replica's budgets across the tenants it serves (plan P2 §7.2): resident Session owners'
/// estimated memory and ToolScript runs. One instance per replica process.
/// </summary>
internal sealed class ReplicaLimits
{
    /// <summary>Share of the container's memory resident owners may take.</summary>
    internal const double HotOwnerShare = 0.7;

    internal const int DefaultToolScriptRuns = 32;

    internal ReplicaLimits(long hotOwnerBytes, int toolScriptRuns = DefaultToolScriptRuns)
    {
        HotOwners = new HotOwnerPool(hotOwnerBytes);
        ToolScripts = new AdmissionSlots(toolScriptRuns);
    }

    internal HotOwnerPool HotOwners { get; }

    internal AdmissionSlots ToolScripts { get; }

    private static readonly Lazy<ReplicaLimits> process = new(() =>
        new ReplicaLimits((long)(ContainerMemory() * HotOwnerShare))
    );

    /// <summary>This process's budgets.</summary>
    internal static ReplicaLimits Process => process.Value;

    /// <summary>
    /// The memory the runtime may use: the GC's view, which follows the container's cgroup
    /// limit (or a configured <c>GCHeapHardLimit</c>) and is the machine's memory otherwise.
    /// </summary>
    internal static long ContainerMemory() => GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
}
